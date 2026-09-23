// Voice control (keyless Web Speech) — unit tests.
// The Speech API is fully mocked: command parsing, persona switching, the
// mic state machine, and the unsupported-browser degradation path are all
// exercised without a browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAppVoiceActions,
  buildCityIndex,
  createVoiceControl,
  detectSpeechRecognition,
  detectSpeechSynthesis,
  findCity,
  normalizeTranscript,
  parseCommand,
  phraseScore,
  tokenSimilarity,
  CYBER_PANEL_ID,
  MATCH_THRESHOLD,
  VOICE_ANCHOR_SELECTORS,
  VOICE_STATES,
} from './voiceControl.js';
import {
  DEFAULT_PERSONA_ID,
  PERSONA_NOTICE,
  listPersonas,
  pickPersonaVoice,
  resolvePersona,
} from './voicePersonas.js';

// ── fakes ────────────────────────────────────────────────────────────────

function fakeElement(tag) {
  const listeners = {};
  const el = {
    tagName: String(tag).toUpperCase(),
    children: [],
    parentNode: null,
    className: '',
    id: '',
    type: '',
    value: '',
    disabled: false,
    hidden: false,
    removed: false,
    dataset: {},
    style: {},
    _text: '',
    _attrs: {},
    _classes: new Set(),
    classList: null,
    get textContent() {
      return this._text + this.children.map((c) => c.textContent).join('');
    },
    set textContent(value) {
      this._text = String(value);
    },
    appendChild(child) {
      this.children.push(child);
      child.parentNode = this;
      return child;
    },
    removeChild(child) {
      const index = this.children.indexOf(child);
      if (index >= 0) this.children.splice(index, 1);
      child.parentNode = null;
      return child;
    },
    remove() {
      this.removed = true;
      this.parentNode?.removeChild(this);
    },
    setAttribute(name, value) {
      this._attrs[name] = String(value);
      if (name === 'disabled') this.disabled = true;
    },
    getAttribute(name) {
      return this._attrs[name] ?? null;
    },
    addEventListener(type, fn) {
      (listeners[type] ||= []).push(fn);
    },
    removeEventListener(type, fn) {
      const list = listeners[type];
      if (!list) return;
      const index = list.indexOf(fn);
      if (index >= 0) list.splice(index, 1);
    },
    click() {
      for (const fn of [...(listeners.click || [])])
        fn({ target: this, currentTarget: this });
    },
  };
  el.classList = {
    add: (...names) => names.forEach((n) => el._classes.add(n)),
    remove: (...names) => names.forEach((n) => el._classes.delete(n)),
    contains: (n) => el._classes.has(n),
  };
  return el;
}

function fakeDocument({ commandDock = true } = {}) {
  const byId = {};
  const doc = {
    _elements: [],
    body: null,
    createElement(tag) {
      const el = fakeElement(tag);
      doc._elements.push(el);
      return el;
    },
    getElementById(id) {
      return byId[id] || null;
    },
    querySelector() {
      return null;
    },
  };
  doc.body = fakeElement('body');
  if (commandDock) {
    const dock = fakeElement('div');
    dock.id = 'command-dock';
    byId['command-dock'] = dock;
    doc.body.appendChild(dock);
  }
  return doc;
}

function mockRecognitionKit() {
  const instances = [];
  class FakeRecognition {
    constructor() {
      this.lang = '';
      this.interimResults = false;
      this.continuous = false;
      this.onresult = null;
      this.onerror = null;
      this.onend = null;
      this.started = false;
      instances.push(this);
    }
    start() {
      this.started = true;
    }
    stop() {
      this.started = false;
      if (typeof this.onend === 'function') this.onend({});
    }
    emitResult(text, isFinal = true) {
      const results = [{ 0: { transcript: text }, isFinal, length: 1 }];
      if (typeof this.onresult === 'function') this.onresult({ results });
    }
    emitError(code) {
      if (typeof this.onerror === 'function') this.onerror({ error: code });
    }
  }
  return { FakeRecognition, instances };
}

function mockSynth(voices = []) {
  return {
    spoken: [],
    cancelled: 0,
    speak(utterance) {
      this.spoken.push(utterance);
    },
    cancel() {
      this.cancelled += 1;
    },
    getVoices() {
      return voices;
    },
  };
}

const mockUtterance = (text) => ({ text });

function makeControl(overrides = {}) {
  const { FakeRecognition } = mockRecognitionKit();
  const synth = mockSynth(overrides.voices);
  const doc = overrides.doc ?? fakeDocument();
  const voice = createVoiceControl({
    doc,
    SpeechRecognition: overrides.recognition ?? FakeRecognition,
    speechSynthesis: overrides.synth ?? synth,
    createUtterance: mockUtterance,
    actions: overrides.actions,
    personaId: overrides.personaId,
    captionMs: 0,
    listenMs: 60_000,
    onStateChange: overrides.onStateChange,
  });
  return { voice, synth, doc, FakeRecognition };
}

function lastSpoken(synth) {
  return synth.spoken.length ? synth.spoken[synth.spoken.length - 1].text : null;
}

// ── matching primitives ────────────────────────────────────────────────

test('normalizeTranscript lowercases and strips punctuation', () => {
  assert.equal(normalizeTranscript("  Zoom   TO Tokyo! "), 'zoom to tokyo');
  assert.equal(normalizeTranscript("don't"), 'dont');
});

test('tokenSimilarity tolerates ASR-scale typos but not short tokens', () => {
  assert.equal(tokenSimilarity('cyber', 'cyber'), 1);
  assert.ok(tokenSimilarity('cyber', 'syber') >= 0.7);
  assert.ok(tokenSimilarity('tokyo', 'tkyo') >= 0.7);
  assert.equal(tokenSimilarity('to', 'two'), 0, 'short tokens need exact match');
  assert.equal(tokenSimilarity('on', 'off'), 0);
});

test('phraseScore is order-free over pattern coverage', () => {
  assert.equal(
    phraseScore(['turn', 'on', 'the', 'cyber', 'layer'], ['turn', 'on', 'cyber', 'layer']),
    1,
  );
  assert.ok(phraseScore(['open', 'panel'], ['close', 'panel']) < MATCH_THRESHOLD);
});

// ── command parsing ────────────────────────────────────────────────────

const PARSE_CASES = [
  ['show cyber layer', 'cyber.show'],
  ['turn on the cyber layer', 'cyber.show'],
  ['cyber layer on', 'cyber.show'],
  ['hide cyber layer', 'cyber.hide'],
  ['turn off cyber layer', 'cyber.hide'],
  ['cyber layer off', 'cyber.hide'],
  ['go live', 'cyber.live'],
  ['switch to live feed', 'cyber.live'],
  ['back to simulation', 'cyber.simulated'],
  ['use simulated feed', 'cyber.simulated'],
  ['open panel', 'panel.open'],
  ['show cyber panel', 'panel.open'],
  ['close panel', 'panel.close'],
  ['hide cyber panel', 'panel.close'],
  ['reset view', 'view.reset'],
  ['go home', 'view.reset'],
  ['help', 'voice.help'],
  ['what can you say', 'voice.help'],
  // fuzzy ASR input still lands
  ['show syber layer', 'cyber.show'],
  ['tern off cyber layer', 'cyber.hide'],
];

test('parseCommand recognizes every supported command, fuzzily', () => {
  for (const [input, expected] of PARSE_CASES) {
    const parsed = parseCommand(input);
    assert.equal(parsed.id, expected, `“${input}”`);
    assert.ok(parsed.score >= MATCH_THRESHOLD, `“${input}” clears threshold`);
  }
});

test('parseCommand rejects gibberish, empties, and ambiguous fragments', () => {
  for (const input of ['', '   ', 'flibberty gibbet', 'cyber layer', 'umm']) {
    const parsed = parseCommand(input);
    assert.equal(parsed.id, null, `“${input}” should not match`);
  }
});

test('parseCommand maps “zoom to <city>” onto the app city presets', () => {
  const cityCases = [
    ['zoom to tokyo', 'tokyo', 'Tokyo'],
    ['fly to New York City', 'nyc', 'New York'],
    ['go to san francisco', 'sf', 'San Francisco'],
    ['take me to washington dc', 'dc', 'Washington DC'],
    ['zoom to london', 'london', 'London'],
    ['zoom to tkyo', 'tokyo', 'Tokyo'],
  ];
  for (const [input, cityId, cityName] of cityCases) {
    const parsed = parseCommand(input);
    assert.equal(parsed.id, 'nav.zoomCity', `“${input}”`);
    assert.equal(parsed.slots.cityId, cityId, `“${input}” city`);
    assert.equal(parsed.slots.cityName, cityName, `“${input}” name`);
  }
});

test('parseCommand does not invent cities', () => {
  assert.equal(parseCommand('zoom to atlantis').id, null);
  assert.equal(parseCommand('zoom to').id, null);
});

test('findCity prefers the longest matching alias', () => {
  const hit = findCity('new york city', buildCityIndex());
  assert.equal(hit?.id, 'nyc');
  assert.equal(findCity('york', buildCityIndex()), null);
});

test('custom registry entries take precedence over defaults', () => {
  const ran = [];
  const voice = createVoiceControl({
    doc: fakeDocument(),
    SpeechRecognition: null,
    speechSynthesis: null,
    commands: [
      {
        id: 'custom.ping',
        label: 'ping',
        patterns: ['ping'],
        run: () => {
          ran.push(true);
          return { ok: true };
        },
      },
    ],
  });
  const parsed = voice.parse('ping');
  assert.equal(parsed.id, 'custom.ping');
  voice.handleTranscript('ping');
  assert.equal(ran.length, 1);
  voice.destroy();
});

// ── personas ───────────────────────────────────────────────────────────

test('personas resolve, fall back, and stay honest about being local', () => {
  assert.equal(resolvePersona('grok').id, 'grok');
  assert.equal(resolvePersona('no-such-persona').id, DEFAULT_PERSONA_ID);
  assert.equal(resolvePersona(undefined).id, DEFAULT_PERSONA_ID);
  assert.match(PERSONA_NOTICE, /local/i);
  assert.match(PERSONA_NOTICE, /no ai service/i);
});

test('every persona phrases every command (no silent confirmations)', () => {
  const ids = [
    'cyber.show',
    'cyber.hide',
    'cyber.live',
    'cyber.simulated',
    'nav.zoomCity',
    'panel.open',
    'panel.close',
    'view.reset',
    'voice.help',
    'unheard',
    'notWired',
    'failed',
  ];
  const personas = listPersonas();
  assert.ok(personas.length >= 3, 'offers a real choice of personas');
  for (const persona of personas) {
    for (const id of ids) {
      const phrase = persona.confirm[id];
      assert.equal(typeof phrase, 'function', `${persona.id}.${id}`);
      const text = phrase({ cityName: 'Tokyo', panelName: 'Cyber intel', label: 'x' });
      assert.ok(text && text.length > 0, `${persona.id}.${id} is non-empty`);
    }
  }
});

test('personas color confirmations differently', () => {
  const grok = resolvePersona('grok').confirm['cyber.show']();
  const sentinel = resolvePersona('sentinel').confirm['cyber.show']();
  assert.notEqual(grok, sentinel);
});

test('setPersona switches phrasing and announces itself', (t) => {
  const { voice, synth, doc } = makeControl({
    actions: { setCyberLayerVisible: () => ({ ok: true }) },
  });
  t.after(() => voice.destroy());
  voice.mount();
  assert.equal(voice.persona.id, DEFAULT_PERSONA_ID);
  voice.setPersona('sentinel', { announce: true });
  assert.equal(voice.persona.id, 'sentinel');
  assert.equal(lastSpoken(synth), 'Sentinel listening.');
  const { spoken } = voice.handleTranscript('show cyber layer');
  assert.equal(spoken, 'Cyber layer: up.');
  voice.setPersona('bogus');
  assert.equal(voice.persona.id, DEFAULT_PERSONA_ID, 'unknown id falls back');
});

test('pickPersonaVoice prefers the persona’s hinted voice', () => {
  const voices = [
    { name: 'Google US English', lang: 'en-US' },
    { name: 'Daniel', lang: 'en-GB' },
    { name: 'Amélie', lang: 'fr-FR' },
  ];
  const grokVoice = pickPersonaVoice(resolvePersona('grok'), voices);
  assert.equal(grokVoice?.name, 'Daniel');
  assert.equal(pickPersonaVoice(resolvePersona('muse'), []), null);
  assert.equal(pickPersonaVoice(resolvePersona('muse'), voices)?.name, 'Google US English');
});

// ── state machine + recognition path ───────────────────────────────────

test('full recognition round-trip via the injected mock', (t) => {
  const kit = mockRecognitionKit();
  const synth = mockSynth();
  const calls = [];
  const voice = createVoiceControl({
    doc: fakeDocument(),
    SpeechRecognition: kit.FakeRecognition,
    speechSynthesis: synth,
    createUtterance: mockUtterance,
    captionMs: 0,
    listenMs: 60_000,
    actions: {
      setCyberLayerVisible: (visible) => {
        calls.push(visible);
        return { ok: true };
      },
      zoomToCity: (cityId) => {
        calls.push(cityId);
        return { ok: true };
      },
    },
  });
  t.after(() => voice.destroy());
  voice.mount();

  assert.ok(voice.startListening());
  assert.equal(voice.state, 'listening');
  const active = kit.instances[kit.instances.length - 1];
  active.emitResult('show cyber layer');
  assert.deepEqual(calls, [true]);
  assert.equal(voice.state, 'idle');
  assert.equal(lastSpoken(synth), 'Cyber layer on.');

  voice.startListening();
  const active2 = kit.instances[kit.instances.length - 1];
  active2.emitResult('zoom to tokyo');
  assert.deepEqual(calls, [true, 'tokyo']);
  assert.equal(lastSpoken(synth), 'Flying to Tokyo.');
});

test('toggleListening stops an active session', (t) => {
  const { voice } = makeControl();
  t.after(() => voice.destroy());
  voice.mount();
  voice.toggleListening();
  assert.equal(voice.state, 'listening');
  voice.toggleListening();
  assert.equal(voice.state, 'idle');
});

test('recognition errors surface a message; fatal ones enter the error state', (t) => {
  const kit = mockRecognitionKit();
  const voice = createVoiceControl({
    doc: fakeDocument(),
    SpeechRecognition: kit.FakeRecognition,
    speechSynthesis: mockSynth(),
    createUtterance: mockUtterance,
    captionMs: 0,
    listenMs: 60_000,
  });
  t.after(() => voice.destroy());
  const root = voice.mount();
  const caption = root.children.find((c) => c.className === 'gev-voice-caption');

  voice.startListening();
  kit.instances.at(-1).emitError('not-allowed');
  assert.equal(voice.state, 'error');
  assert.match(caption.textContent, /blocked/i);

  voice.startListening();
  assert.equal(voice.state, 'listening');
  kit.instances.at(-1).emitError('no-speech');
  assert.equal(voice.state, 'idle', 'no-speech is recoverable');
  assert.match(caption.textContent, /didn't hear/i);
});

test('unwired actions get an honest “not wired yet” confirmation', (t) => {
  const { voice, synth } = makeControl(); // default actions are unwired stubs
  t.after(() => voice.destroy());
  voice.mount();
  const { spoken, result } = voice.handleTranscript('go live');
  assert.equal(result.reason, 'unwired');
  assert.match(spoken, /isn't wired to the app yet/);
  assert.equal(lastSpoken(synth), spoken);
});

test('unheard input gets the persona’s unheard line, no action fires', (t) => {
  const { voice, synth } = makeControl({
    actions: { setCyberLayerVisible: () => assert.fail('must not run') },
  });
  t.after(() => voice.destroy());
  voice.mount();
  const { parsed, spoken } = voice.handleTranscript('flibberty gibbet');
  assert.equal(parsed.id, null);
  assert.equal(spoken, "I didn't catch that. Try again.");
  assert.equal(lastSpoken(synth), spoken);
});

// ── degradation ────────────────────────────────────────────────────────

test('without SpeechRecognition the control degrades to a disabled button', (t) => {
  const doc = fakeDocument();
  const voice = createVoiceControl({
    doc,
    SpeechRecognition: null,
    speechSynthesis: null,
  });
  t.after(() => voice.destroy());
  assert.equal(voice.supported, false);
  assert.equal(voice.state, 'unsupported');

  const root = voice.mount();
  const button = root.children.find((c) => c.className === 'gev-voice-mic');
  assert.ok(button, 'mic button still renders');
  assert.equal(button.getAttribute('disabled'), 'true');
  assert.equal(button.getAttribute('aria-disabled'), 'true');
  assert.match(button.getAttribute('title'), /not supported/i);
  assert.equal(voice.startListening(), false, 'never a dead click');
});

test('detectors read the ambient browser globals', () => {
  class SR {}
  assert.equal(detectSpeechRecognition({ SpeechRecognition: SR }), SR);
  assert.equal(detectSpeechRecognition({ webkitSpeechRecognition: SR }), SR);
  assert.equal(detectSpeechRecognition({}), null);
  const synth = { speak() {} };
  assert.equal(detectSpeechSynthesis({ speechSynthesis: synth }), synth);
  assert.equal(detectSpeechSynthesis({}), null);
});

// ── mounting ───────────────────────────────────────────────────────────

test('mount targets #command-dock first, then falls back to body', (t) => {
  const docked = makeControl({ doc: fakeDocument({ commandDock: true }) });
  t.after(() => docked.voice.destroy());
  const root = docked.voice.mount();
  assert.ok(root, 'mounted');
  assert.equal(root.id, 'gev-voice');
  assert.equal(root.parentNode.id, 'command-dock');

  const plain = makeControl({ doc: fakeDocument({ commandDock: false }) });
  t.after(() => plain.voice.destroy());
  const root2 = plain.voice.mount();
  assert.equal(root2.parentNode, plain.doc.body);

  // Idempotent: a second mount returns the same root, no duplicates.
  assert.equal(plain.voice.mount(), root2);
  assert.equal(
    plain.doc.body.children.filter((c) => c.id === 'gev-voice').length,
    1,
  );
});

test('mount carries the persona picker with an honest local label', (t) => {
  const { voice } = makeControl();
  t.after(() => voice.destroy());
  const root = voice.mount();
  const select = root.children
    .flatMap((c) => c.children)
    .find((c) => c.className === 'gev-voice-persona');
  assert.ok(select, 'persona select renders');
  assert.equal(select.getAttribute('title'), PERSONA_NOTICE);
  const localTag = root.children.find((c) => c.className === 'gev-voice-local');
  assert.equal(localTag?.textContent, 'LOCAL');
  assert.equal(localTag?.getAttribute('title'), PERSONA_NOTICE);
  // Changing the picker switches the persona and announces it.
  select.value = 'relay';
  voice.setPersona('relay', { announce: true });
  assert.equal(voice.persona.id, 'relay');
});

test('anchor selectors name the real shell tray first', () => {
  assert.deepEqual([...VOICE_ANCHOR_SELECTORS], [
    '#command-dock',
    '#display-controls',
    '[data-voice-anchor]',
  ]);
  assert.ok(VOICE_STATES.includes('unsupported'));
});

// ── app wiring helper ──────────────────────────────────────────────────

test('buildAppVoiceActions wraps real callbacks and degrades without them', () => {
  const seen = [];
  const wired = buildAppVoiceActions({
    viewer: null,
    setCyberLayerVisible: (visible) => {
      seen.push(visible);
      return { ok: true };
    },
    setCyberFeedMode: (mode) => ({ ok: true, mode }),
  });
  assert.deepEqual(wired.setCyberLayerVisible(true), { ok: true });
  assert.deepEqual(seen, [true]);
  assert.equal(wired.setCyberFeedMode('live').mode, 'live');
  // No viewer / no callbacks → honest unwired results, never throws.
  assert.equal(wired.zoomToCity('tokyo').reason, 'unwired');
  assert.equal(wired.resetView().reason, 'unwired');
  assert.equal(wired.setPanelOpen(CYBER_PANEL_ID, true).reason, 'unwired');

  const failing = buildAppVoiceActions({
    setCyberLayerVisible: () => {
      throw new Error('boom');
    },
  });
  assert.equal(failing.setCyberLayerVisible(true).ok, false);
});
