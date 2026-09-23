/**
 * @module voiceControl
 * @description Keyless voice control for God's Eye View, built on the Web
 * Speech API (SpeechRecognition + speechSynthesis) that ships in the browser.
 *
 * Deliberately SEPARATE from src/voice/ (the keyed realtime backend): this
 * module makes no network calls, uses no API keys, and runs entirely
 * client-side. App effects flow through injected `actions` callbacks so the
 * module stays dependency-light and unit-testable without Cesium or the app
 * shell. Wire it in one place (see buildAppVoiceActions + the mount note in
 * createVoiceControl) — nothing here edits existing files.
 *
 * Supported commands (fuzzy-matched, see parseCommand):
 *  - "show cyber layer" / "hide cyber layer"
 *  - "go live" / "back to simulation"
 *  - "zoom to <city>" — city names come from the app's CITY_POIS presets
 *  - "open panel" / "close panel" (the cyber intel panel by default)
 *  - "reset view"
 *  - "help" — speaks what it can hear
 */

import {
  CITY_POIS,
  flyToGlobeView,
  flyToPresetLocation,
} from '../locations.js';
import {
  DEFAULT_PERSONA_ID,
  PERSONA_NOTICE,
  listPersonas,
  pickPersonaVoice,
  resolvePersona,
} from './voicePersonas.js';

/** Mic-button lifecycle states. `unsupported` is terminal for the session. */
export const VOICE_STATES = Object.freeze([
  'idle',
  'listening',
  'processing',
  'error',
  'unsupported',
]);

/** Minimum parse score for a command to fire. */
export const MATCH_THRESHOLD = 0.72;

/** Layer + panel ids the voice commands drive. */
export const CYBER_LAYER_ID = 'cyber';
export const CYBER_PANEL_ID = 'cyber-intel-panel';
export const CYBER_PANEL_NAME = 'Cyber intel';

/**
 * Shell anchors tried in order when mounting. The command dock is the app's
 * persistent top tray (#command-dock, anchored near the top of the viewport);
 * the wrapper is position:fixed so the mount point only decides DOM order,
 * not layout. Falls back to document.body when no anchor exists.
 */
export const VOICE_ANCHOR_SELECTORS = Object.freeze([
  '#command-dock',
  '#display-controls',
  '[data-voice-anchor]',
]);

// ── text normalization + fuzzy matching ────────────────────────────────

/** Lowercase, strip punctuation, collapse whitespace. */
export function normalizeTranscript(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshtein(a, b) {
  if (a === b) return 0;
  const rows = a.length + 1;
  const cols = b.length + 1;
  const grid = new Array(rows * cols);
  for (let i = 0; i < rows; i++) grid[i * cols] = i;
  for (let j = 0; j < cols; j++) grid[j] = j;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      grid[i * cols + j] = Math.min(
        grid[(i - 1) * cols + j] + 1,
        grid[i * cols + j - 1] + 1,
        grid[(i - 1) * cols + j - 1] + cost,
      );
    }
  }
  return grid[(rows - 1) * cols + (cols - 1)];
}

/**
 * Token similarity in [0, 1]. Short tokens must match exactly (they carry no
 * room for error); longer tokens tolerate roughly one typo per four letters —
 * enough for ASR slips like "syber" → "cyber".
 */
export function tokenSimilarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const longest = Math.max(a.length, b.length);
  const shortest = Math.min(a.length, b.length);
  if (shortest < 4) return 0;
  const distance = levenshtein(a, b);
  const similarity = 1 - distance / longest;
  return similarity >= 0.7 ? similarity : 0;
}

/**
 * How well a pattern's tokens are covered by the transcript (order-free, so
 * "turn on the cyber layer" matches "turn on cyber layer").
 */
export function phraseScore(transcriptTokens, patternTokens) {
  if (!patternTokens.length) return 0;
  let sum = 0;
  for (const pattern of patternTokens) {
    let best = 0;
    for (const token of transcriptTokens) {
      const score = tokenSimilarity(pattern, token);
      if (score > best) best = score;
    }
    sum += best;
  }
  return sum / patternTokens.length;
}

// ── city index (from the app's existing presets) ───────────────────────

const DEFAULT_CITY_ALIASES = Object.freeze({
  austin: ['austin'],
  sf: ['san francisco', 'san fran'],
  nyc: ['new york', 'new york city'],
  tokyo: ['tokyo'],
  london: ['london'],
  paris: ['paris'],
  dubai: ['dubai'],
  dc: ['washington', 'washington dc'],
  tallinn: ['tallinn'],
});

/**
 * Flatten the app's CITY_POIS presets into a matchable alias list. Extra
 * aliases can be supplied for future presets without touching this module.
 */
export function buildCityIndex(
  cities = CITY_POIS,
  aliases = DEFAULT_CITY_ALIASES,
) {
  const index = [];
  for (const [id, city] of Object.entries(cities || {})) {
    const names = [id, city?.name, ...(aliases?.[id] || [])].filter(Boolean);
    const seen = new Set();
    for (const name of names) {
      const alias = normalizeTranscript(name);
      if (!alias || seen.has(alias)) continue;
      seen.add(alias);
      index.push({ id, name: city?.name || id, alias });
    }
  }
  return index;
}

/**
 * Best city match for a free-text query. Every alias token must be found
 * (fuzzily) in the query; extra query words cost a little. Returns
 * { id, name, score } or null.
 */
export function findCity(query, cityIndex = buildCityIndex()) {
  const norm = normalizeTranscript(query);
  if (!norm) return null;
  const queryTokens = norm.split(' ');
  let best = null;
  for (const entry of cityIndex) {
    const aliasTokens = entry.alias.split(' ');
    let hits = 0;
    for (const aliasToken of aliasTokens) {
      for (const queryToken of queryTokens) {
        if (tokenSimilarity(aliasToken, queryToken) >= 0.7) {
          hits++;
          break;
        }
      }
    }
    const coverage = hits / aliasTokens.length;
    if (coverage < 1) continue;
    const extra = Math.max(0, queryTokens.length - aliasTokens.length);
    const score = coverage - extra * 0.06;
    if (
      score >= 0.8 &&
      (!best ||
        score > best.score ||
        (score === best.score && aliasTokens.length > best.tokens))
    ) {
      best = { id: entry.id, name: entry.name, score, tokens: aliasTokens.length };
    }
  }
  return best && { id: best.id, name: best.name, score: best.score };
}

// ── command registry ──────────────────────────────────────────────────

/** Verbs that introduce the city slot ("zoom to …"). */
const CITY_VERBS = Object.freeze([
  'zoom to',
  'go to',
  'fly to',
  'take me to',
  'bring me to',
  'navigate to',
  'show me',
]);

function makeUnwired(label) {
  return () => ({ ok: false, reason: 'unwired', label });
}

/** Default no-op actions: the module works standalone and reports unwired. */
function defaultActions() {
  return {
    setCyberLayerVisible: makeUnwired('cyber layer'),
    setCyberFeedMode: makeUnwired('cyber feed mode'),
    zoomToCity: makeUnwired('city flight'),
    setPanelOpen: makeUnwired('panel'),
    resetView: makeUnwired('view reset'),
  };
}

/**
 * Extensible command registry. Each entry is
 * { id, label, patterns?, slot?, verbs?, run(ctx, slots) }.
 * Prepend custom commands via the `commands` option to createVoiceControl —
 * earlier entries win ties, so custom commands can override defaults.
 */
export function buildDefaultCommands() {
  return [
    {
      id: 'cyber.show',
      label: 'show cyber layer',
      patterns: [
        'show cyber layer',
        'turn on cyber layer',
        'enable cyber layer',
        'open cyber layer',
        'cyber layer on',
        'cyber on',
      ],
      run: (ctx) => ctx.actions.setCyberLayerVisible(true),
    },
    {
      id: 'cyber.hide',
      label: 'hide cyber layer',
      patterns: [
        'hide cyber layer',
        'turn off cyber layer',
        'disable cyber layer',
        'close cyber layer',
        'cyber layer off',
        'cyber off',
      ],
      run: (ctx) => ctx.actions.setCyberLayerVisible(false),
    },
    {
      id: 'cyber.live',
      label: 'go live',
      patterns: [
        'go live',
        'switch to live',
        'use live feed',
        'live feed',
        'live mode',
        'enable live feed',
      ],
      run: (ctx) => ctx.actions.setCyberFeedMode('live'),
    },
    {
      id: 'cyber.simulated',
      label: 'back to simulation',
      patterns: [
        'back to simulation',
        'go to simulation',
        'back to simulated',
        'simulated feed',
        'simulation mode',
        'use simulated feed',
        'use simulation',
      ],
      run: (ctx) => ctx.actions.setCyberFeedMode('simulated'),
    },
    {
      id: 'nav.zoomCity',
      label: 'zoom to city',
      slot: 'city',
      verbs: CITY_VERBS,
      run: (ctx, slots) => ctx.actions.zoomToCity(slots.cityId),
    },
    {
      id: 'panel.open',
      label: 'open panel',
      patterns: [
        'open panel',
        'show panel',
        'open the panel',
        'open cyber panel',
        'show cyber panel',
        'open cyber intel panel',
      ],
      run: (ctx) => ctx.actions.setPanelOpen(CYBER_PANEL_ID, true),
    },
    {
      id: 'panel.close',
      label: 'close panel',
      patterns: [
        'close panel',
        'hide panel',
        'close the panel',
        'close cyber panel',
        'hide cyber panel',
        'dismiss panel',
      ],
      run: (ctx) => ctx.actions.setPanelOpen(CYBER_PANEL_ID, false),
    },
    {
      id: 'view.reset',
      label: 'reset view',
      patterns: [
        'reset view',
        'reset the view',
        'reset camera',
        'home view',
        'go home',
      ],
      run: (ctx) => ctx.actions.resetView(),
    },
    {
      id: 'voice.help',
      label: 'help',
      patterns: ['help', 'what can you say', 'list commands', 'show commands'],
      run: () => ({ ok: true }),
    },
  ];
}

/** Match a slot command: fuzzy verb prefix + city match on the remainder. */
function matchSlotCommand(tokens, command, cityIndex) {
  for (const verb of command.verbs || []) {
    const verbTokens = verb.split(' ');
    if (verbTokens.length > tokens.length) continue;
    let verbScore = 0;
    let aligned = true;
    for (let i = 0; i < verbTokens.length; i++) {
      const score = tokenSimilarity(verbTokens[i], tokens[i]);
      if (score < 0.7) {
        aligned = false;
        break;
      }
      verbScore += score;
    }
    if (!aligned) continue;
    verbScore /= verbTokens.length;
    const remainder = tokens.slice(verbTokens.length).join(' ');
    const city = findCity(remainder, cityIndex);
    if (!city) continue;
    return {
      id: command.id,
      score: 0.55 * verbScore + 0.45 * Math.min(1, city.score),
      slots: { cityId: city.id, cityName: city.name },
    };
  }
  return null;
}

/**
 * Parse a transcript into { id, score, slots, transcript }.
 * Returns id: null when nothing clears MATCH_THRESHOLD.
 */
export function parseCommand(
  transcript,
  { commands = buildDefaultCommands(), cityIndex = buildCityIndex() } = {},
) {
  const norm = normalizeTranscript(transcript);
  if (!norm) return { id: null, score: 0, slots: {}, transcript: norm };
  const tokens = norm.split(' ');
  let best = { id: null, score: 0, slots: {} };
  for (const command of commands) {
    if (command.slot === 'city') {
      const hit = matchSlotCommand(tokens, command, cityIndex);
      if (hit && hit.score > best.score) best = hit;
      continue;
    }
    for (const pattern of command.patterns || []) {
      const score = phraseScore(tokens, pattern.split(' '));
      if (score > best.score) best = { id: command.id, score, slots: {} };
    }
  }
  if (best.score < MATCH_THRESHOLD) {
    return { id: null, score: best.score, slots: {}, transcript: norm };
  }
  return { ...best, transcript: norm };
}

/** Find a registry entry by id (custom commands included). */
function findCommand(commands, id) {
  return commands.find((command) => command.id === id) || null;
}

// ── browser API detection (injectable for tests) ──────────────────────

export function detectSpeechRecognition(scope = globalThis) {
  return (
    scope?.SpeechRecognition || scope?.webkitSpeechRecognition || null
  );
}

export function detectSpeechSynthesis(scope = globalThis) {
  return scope?.speechSynthesis || null;
}

// ── the controller ────────────────────────────────────────────────────

const MIC_GLYPHS = Object.freeze({
  idle: 'mic',
  listening: 'graphic_eq',
  processing: 'hourglass_top',
  error: 'mic_off',
  unsupported: 'mic_off',
});

const STATE_TITLES = Object.freeze({
  idle: 'Voice control — click, then speak a command',
  listening: 'Listening… speak now (click again to stop)',
  processing: 'Working on it…',
  error: 'Voice control hit a snag — click to try again',
  unsupported:
    'Voice recognition is not supported in this browser (needs Chrome or Edge with the Web Speech API). This button is intentionally disabled.',
});

const RECOGNITION_ERROR_COPY = Object.freeze({
  'no-speech': "Didn't hear anything — click the mic and try again.",
  'audio-capture': 'No microphone found. Check that one is connected.',
  'not-allowed': 'Microphone access was blocked. Allow it in the browser to use voice control.',
  'service-not-allowed': 'Speech recognition is not allowed in this browser.',
  aborted: 'Listening stopped.',
});

/**
 * Create a keyless voice controller.
 *
 * @param {object} options
 * @param {Document} [options.doc] — defaults to globalThis.document.
 * @param {Function|null} [options.SpeechRecognition] — recognition ctor;
 *   defaults to browser detection. Pass null to force the degraded path.
 * @param {object|null} [options.speechSynthesis] — defaults to detection.
 * @param {Function} [options.createUtterance] — (text) => utterance; defaults
 *   to SpeechSynthesisUtterance when available.
 * @param {object} [options.actions] — app wiring; see defaultActions().
 *   Each action should return { ok: true } or { ok: false, reason }.
 * @param {Array} [options.commands] — extra registry entries (take precedence).
 * @param {string} [options.personaId] — initial persona.
 * @param {number} [options.captionMs] — caption auto-clear delay.
 * @param {number} [options.listenMs] — safety cap per listening session.
 * @param {Function} [options.onStateChange] — (state, detail) listener.
 */
export function createVoiceControl(options = {}) {
  const doc = options.doc ?? globalThis.document ?? null;
  const Recognition =
    options.SpeechRecognition !== undefined
      ? options.SpeechRecognition
      : detectSpeechRecognition();
  const synth =
    options.speechSynthesis !== undefined
      ? options.speechSynthesis
      : detectSpeechSynthesis();
  const createUtterance =
    options.createUtterance ??
    ((text) => {
      const Ctor = globalThis.SpeechSynthesisUtterance;
      return typeof Ctor === 'function' ? new Ctor(text) : { text };
    });

  const actions = { ...defaultActions(), ...(options.actions || {}) };
  const commands = [...(options.commands || []), ...buildDefaultCommands()];
  const cityIndex = buildCityIndex(options.cities, options.cityAliases);
  const captionMs = options.captionMs ?? 6000;
  const listenMs = options.listenMs ?? 15000;
  const onStateChange =
    typeof options.onStateChange === 'function' ? options.onStateChange : null;

  let persona = resolvePersona(options.personaId ?? DEFAULT_PERSONA_ID);
  let state = Recognition ? 'idle' : 'unsupported';
  let recognition = null;
  let errorTimer = null;
  let listenTimer = null;
  let captionTimer = null;
  let destroyed = false;
  let mounted = null;
  let els = null;

  const runContext = () => ({ actions, persona, doc });

  function personaConfirm(id, slots = {}) {
    const confirm = persona.confirm || {};
    const phrase = confirm[id];
    if (typeof phrase === 'function') {
      try {
        return phrase(slots) || '';
      } catch {
        return '';
      }
    }
    return '';
  }

  function setState(next, detail = null) {
    if (destroyed || state === next) return;
    state = next;
    if (els?.button) {
      els.button.dataset.voiceState = next;
      if (els.glyph) els.glyph.textContent = MIC_GLYPHS[next] || 'mic';
      const title =
        next === 'error' && detail?.message
          ? detail.message
          : STATE_TITLES[next];
      els.button.setAttribute('title', title);
      els.button.setAttribute(
        'aria-label',
        `Voice control — ${next}${next === 'unsupported' ? ' (not supported in this browser)' : ''}`,
      );
    }
    try {
      onStateChange?.(next, detail);
    } catch {
      /* listener errors must not break the state machine */
    }
  }

  function showCaption(text) {
    if (!els?.caption || destroyed) return;
    clearTimeout(captionTimer);
    els.caption.textContent = String(text ?? '');
    els.caption.hidden = !text;
    if (text && captionMs > 0) {
      captionTimer = setTimeout(() => {
        if (!destroyed && els?.caption) {
          els.caption.textContent = '';
          els.caption.hidden = true;
        }
      }, captionMs);
    }
  }

  /** Speak a confirmation through the persona's voice; always captions. */
  function speak(text) {
    const clean = String(text ?? '').trim();
    showCaption(clean ? `“${clean}”` : '');
    if (!clean || !synth || typeof synth.speak !== 'function') return false;
    try {
      if (typeof synth.cancel === 'function') synth.cancel();
      const utterance = createUtterance(clean);
      const voices =
        typeof synth.getVoices === 'function' ? synth.getVoices() : [];
      const voice = pickPersonaVoice(persona, voices);
      if (voice) utterance.voice = voice;
      const prefs = persona.voicePrefs || {};
      if (Number.isFinite(prefs.rate)) utterance.rate = prefs.rate;
      if (Number.isFinite(prefs.pitch)) utterance.pitch = prefs.pitch;
      synth.speak(utterance);
      return true;
    } catch {
      return false;
    }
  }

  function clearTimers() {
    clearTimeout(errorTimer);
    clearTimeout(listenTimer);
    clearTimeout(captionTimer);
    errorTimer = listenTimer = captionTimer = null;
  }

  function stopRecognition() {
    clearTimeout(listenTimer);
    listenTimer = null;
    const active = recognition;
    recognition = null;
    try {
      active?.stop?.();
    } catch {
      /* stopping is best effort */
    }
  }

  function handleRecognitionError(event) {
    stopRecognition();
    const code = event?.error || 'unknown';
    const message =
      RECOGNITION_ERROR_COPY[code] ||
      `Speech recognition error (${code}). Click to try again.`;
    showCaption(message);
    if (code === 'no-speech' || code === 'aborted') {
      setState('idle');
      return;
    }
    setState('error', { message, code });
    clearTimeout(errorTimer);
    errorTimer = setTimeout(() => {
      if (!destroyed && state === 'error') setState('idle');
    }, 5000);
  }

  function handleFinalTranscript(transcript) {
    stopRecognition();
    setState('processing');
    const outcome = handleTranscript(transcript);
    setState('idle');
    return outcome;
  }

  function startListening() {
    if (destroyed) return false;
    if (!Recognition) {
      setState('unsupported');
      return false;
    }
    if (state === 'listening' || state === 'processing') return true;
    stopRecognition();
    let active;
    try {
      active = new Recognition();
    } catch {
      setState('error', { message: 'Could not start speech recognition.' });
      return false;
    }
    recognition = active;
    try {
      active.lang = 'en-US';
      active.interimResults = true;
      active.continuous = false;
      active.maxAlternatives = 1;
    } catch {
      /* vendor quirks: properties are best effort */
    }
    active.onresult = (event) => {
      const results = event?.results || [];
      let interim = '';
      for (const result of results) {
        const text = result?.[0]?.transcript || '';
        if (result?.isFinal && text.trim()) {
          handleFinalTranscript(text);
          return;
        }
        interim += text;
      }
      if (interim.trim()) showCaption(`…${interim.trim()}`);
    };
    active.onerror = handleRecognitionError;
    active.onend = () => {
      if (state === 'listening') setState('idle');
      if (recognition === active) recognition = null;
    };
    try {
      active.start();
    } catch {
      recognition = null;
      setState('error', { message: 'Could not start speech recognition.' });
      return false;
    }
    setState('listening');
    showCaption('Listening…');
    clearTimeout(listenTimer);
    listenTimer = setTimeout(() => {
      if (state === 'listening') {
        showCaption("Didn't hear anything — click the mic and try again.");
        stopRecognition();
        setState('idle');
      }
    }, listenMs);
    return true;
  }

  function stopListening() {
    stopRecognition();
    if (state === 'listening' || state === 'processing') setState('idle');
  }

  function toggleListening() {
    if (state === 'listening') stopListening();
    else startListening();
  }

  // ── DOM: mic button + local persona picker (lazy mount) ──────────────

  function el(tag, className) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    return node;
  }

  function buildDom() {
    const root = el('div', 'gev-voice');
    root.id = 'gev-voice';

    const button = el('button', 'gev-voice-mic');
    button.type = 'button';
    button.dataset.voiceState = state;
    const glyph = el('span', 'gev-voice-glyph material-symbols-outlined');
    glyph.textContent = MIC_GLYPHS[state] || 'mic';
    button.appendChild(glyph);
    button.setAttribute('title', STATE_TITLES[state]);
    button.setAttribute(
      'aria-label',
      `Voice control — ${state}${state === 'unsupported' ? ' (not supported in this browser)' : ''}`,
    );
    if (state === 'unsupported') {
      button.setAttribute('disabled', 'true');
      button.setAttribute('aria-disabled', 'true');
    }
    button.addEventListener('click', toggleListening);

    const personaLabel = el('label', 'gev-voice-persona-label');
    const personaCaption = el('span', 'gev-voice-persona-caption');
    personaCaption.textContent = 'Persona';
    const select = el('select', 'gev-voice-persona');
    select.setAttribute('aria-label', 'Local voice persona');
    select.setAttribute('title', PERSONA_NOTICE);
    for (const entry of listPersonas()) {
      const option = el('option', '');
      option.value = entry.id;
      option.textContent = `${entry.name} — local`;
      if (entry.id === persona.id) option.selected = true;
      select.appendChild(option);
    }
    select.addEventListener('change', () => {
      setPersona(select.value, { announce: true });
    });
    personaLabel.appendChild(personaCaption);
    personaLabel.appendChild(select);

    const localTag = el('span', 'gev-voice-local');
    localTag.textContent = 'LOCAL';
    localTag.setAttribute('title', PERSONA_NOTICE);

    const caption = el('div', 'gev-voice-caption');
    caption.setAttribute('aria-live', 'polite');
    caption.hidden = true;

    root.appendChild(button);
    root.appendChild(personaLabel);
    root.appendChild(localTag);
    root.appendChild(caption);
    return { root, button, glyph, select, caption };
  }

  function pickAnchor() {
    if (!doc) return null;
    for (const selector of VOICE_ANCHOR_SELECTORS) {
      if (selector.startsWith('#') && typeof doc.getElementById === 'function') {
        const found = doc.getElementById(selector.slice(1));
        if (found) return found;
      } else if (typeof doc.querySelector === 'function') {
        const found = doc.querySelector(selector);
        if (found) return found;
      }
    }
    return null;
  }

  /**
   * Lazily mount the mic button + persona picker into the shell (like
   * CyberIntelHud). Anchor: #command-dock first, then #display-controls,
   * then [data-voice-anchor], else document.body. Idempotent.
   */
  function mount(container = null) {
    if (destroyed || mounted) return mounted;
    if (!doc || typeof doc.createElement !== 'function') return null;
    const host = container || pickAnchor() || doc.body;
    if (!host || typeof host.appendChild !== 'function') return null;
    els = buildDom();
    host.appendChild(els.root);
    mounted = els.root;
    return mounted;
  }

  function setPersona(id, { announce = false } = {}) {
    const next = resolvePersona(id);
    const changed = next.id !== persona.id;
    persona = next;
    if (els?.select) {
      els.select.value = next.id;
      for (const option of els.select.children || []) {
        option.selected = option.value === next.id;
      }
    }
    if (announce && (changed || true)) {
      speak(next.greeting);
      showCaption(`${next.name} persona selected. ${PERSONA_NOTICE}`);
    }
    return next;
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    clearTimers();
    stopRecognition();
    try {
      mounted?.remove?.();
    } catch {
      /* removal is best effort */
    }
    mounted = null;
    els = null;
  }

  // ── command execution ────────────────────────────────────────────────

  function handleTranscript(raw) {
    const parsed = parseCommand(String(raw ?? ''), { commands, cityIndex });
    const slots = { ...(parsed.slots || {}) };
    let spoken;
    let result = null;
    if (!parsed.id) {
      spoken = personaConfirm('unheard', slots);
    } else {
      const command = findCommand(commands, parsed.id);
      if (command?.id === 'panel.open' || command?.id === 'panel.close') {
        slots.panelName = slots.panelName || CYBER_PANEL_NAME;
      }
      try {
        result = command?.run(runContext(), slots) ?? { ok: true };
      } catch (error) {
        result = { ok: false, reason: 'error', error };
      }
      if (result && result.ok === false && result.reason === 'unwired') {
        spoken = personaConfirm('notWired', {
          ...slots,
          label: command?.label || 'that command',
        });
      } else if (result && result.ok === false) {
        spoken = personaConfirm('failed', {
          ...slots,
          label: command?.label || 'that command',
        });
      } else {
        spoken = personaConfirm(parsed.id, slots);
      }
    }
    speak(spoken);
    return { parsed, spoken, result };
  }

  return {
    get state() {
      return state;
    },
    get persona() {
      return persona;
    },
    get supported() {
      return Boolean(Recognition);
    },
    get personaNotice() {
      return PERSONA_NOTICE;
    },
    parse: (transcript) => parseCommand(transcript, { commands, cityIndex }),
    startListening,
    stopListening,
    toggleListening,
    handleTranscript,
    speak,
    setPersona,
    mount,
    destroy,
    /** Exposed for tests: drive the recognition event path directly. */
    _debug: { commands, cityIndex },
  };
}

/**
 * Build app wiring for createVoiceControl from real app handles.
 *
 * Integration (one call, e.g. in src/app/data.js next to CyberIntelHud):
 *
 *   import { buildAppVoiceActions, createVoiceControl } from '../ui/voiceControl.js';
 *   const voice = createVoiceControl({
 *     actions: buildAppVoiceActions({
 *       viewer,
 *       setCyberLayerVisible: (visible) => { ...toggle layer 'cyber'...; return { ok: true }; },
 *       setCyberFeedMode: (mode) => { cyberLayer.setFeedMode(mode); return { ok: true }; },
 *       setPanelOpen: (panelId, open) => { panelChrome.setPanelCollapsed(panelId, !open); return { ok: true }; },
 *     }),
 *   });
 *   voice.mount(); // → #command-dock (falls back to document.body)
 *
 * Each callback may return { ok: true } (or nothing) on success, or
 * { ok: false, reason } on failure.
 */
export function buildAppVoiceActions({
  viewer = null,
  setCyberLayerVisible = null,
  setCyberFeedMode = null,
  setPanelOpen = null,
} = {}) {
  const wrap = (fn, label) =>
    typeof fn === 'function'
      ? (...args) => {
          try {
            const out = fn(...args);
            return out && typeof out === 'object' ? out : { ok: true };
          } catch (error) {
            return { ok: false, reason: 'error', error, label };
          }
        }
      : makeUnwired(label);

  return {
    setCyberLayerVisible: wrap(setCyberLayerVisible, 'cyber layer'),
    setCyberFeedMode: wrap(setCyberFeedMode, 'cyber feed mode'),
    zoomToCity: (cityId) => {
      if (!viewer || !CITY_POIS[cityId]) return makeUnwired('city flight')();
      try {
        flyToPresetLocation(viewer, cityId, {
          viewMode: 'overview',
          duration: 3,
        });
        return { ok: true };
      } catch (error) {
        return { ok: false, reason: 'error', error };
      }
    },
    setPanelOpen: wrap(setPanelOpen, 'panel'),
    resetView: () => {
      if (!viewer) return makeUnwired('view reset')();
      try {
        flyToGlobeView(viewer);
        return { ok: true };
      } catch (error) {
        return { ok: false, reason: 'error', error };
      }
    },
  };
}

export { DEFAULT_PERSONA_ID, PERSONA_NOTICE, listPersonas, resolvePersona };
