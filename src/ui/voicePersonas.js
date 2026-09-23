/**
 * @module voicePersonas
 * @description Local voice personas for the keyless Web Speech voice control.
 *
 * A persona changes ONLY two things: the wording of spoken confirmations and
 * which speechSynthesis voice reads them. Personas are LOCAL — they never
 * call, imply, or attempt calls to any external AI API. There are no keys, no
 * network requests, and no cloud model in the loop; speech recognition and
 * synthesis both run in the browser via the Web Speech API.
 */

/**
 * Honest label shown next to the persona picker. Every surface that offers a
 * persona must carry this so nobody mistakes a persona for an AI connection.
 */
export const PERSONA_NOTICE =
  'Local voice persona — on-device speech only. No AI service is contacted.';

export const DEFAULT_PERSONA_ID = 'muse';

/**
 * Persona table. Each persona defines:
 *  - id / name / tagline — shown in the picker.
 *  - voicePrefs — best-effort speechSynthesis voice selection
 *    ({ langs, nameHints, pitch, rate }).
 *  - confirm — per-command confirmation phrasings. Every entry is a function
 *    taking a slots object ({ cityName, panelName, label }) and returning the
 *    exact sentence to speak and caption.
 *  - greeting — spoken once when the persona is selected.
 */
export const VOICE_PERSONAS = Object.freeze({
  muse: Object.freeze({
    id: 'muse',
    name: 'Muse',
    tagline: 'Calm and precise.',
    voicePrefs: Object.freeze({
      langs: ['en-US', 'en'],
      nameHints: ['Samantha', 'Google US English', 'Aria'],
      pitch: 1.0,
      rate: 1.0,
    }),
    greeting: 'Voice control ready.',
    confirm: Object.freeze({
      'cyber.show': () => 'Cyber layer on.',
      'cyber.hide': () => 'Cyber layer off.',
      'cyber.live': () => 'Live threat feed engaged.',
      'cyber.simulated': () => 'Back to the simulated feed.',
      'nav.zoomCity': ({ cityName }) => `Flying to ${cityName}.`,
      'panel.open': ({ panelName }) => `${panelName} panel open.`,
      'panel.close': ({ panelName }) => `${panelName} panel closed.`,
      'view.reset': () => 'View reset.',
      'voice.help': () =>
        'You can say: show cyber layer, go live, zoom to Tokyo, open panel, or reset view.',
      unheard: () => "I didn't catch that. Try again.",
      notWired: ({ label }) =>
        `${label} — heard, but that control isn't wired to the app yet.`,
      failed: ({ label }) => `${label} didn't go through.`,
    }),
  }),

  grok: Object.freeze({
    id: 'grok',
    name: 'Grok',
    tagline: 'Wry and playful.',
    voicePrefs: Object.freeze({
      langs: ['en-GB', 'en'],
      nameHints: ['Daniel', 'Google UK English Male', 'Ryan'],
      pitch: 0.95,
      rate: 1.05,
    }),
    greeting: 'Grok ears on.',
    confirm: Object.freeze({
      'cyber.show': () => 'Cyber layer is up. Hack the planet — responsibly.',
      'cyber.hide': () => 'Cyber layer down. Nothing to see here.',
      'cyber.live': () => 'Live feed engaged. Real data now — handle with care.',
      'cyber.simulated': () => 'Back to simulation. Fake threats, real vibes.',
      'nav.zoomCity': ({ cityName }) => `Off to ${cityName}. Pack light.`,
      'panel.open': ({ panelName }) => `${panelName} panel, open for business.`,
      'panel.close': ({ panelName }) => `${panelName} panel closed. Out of sight.`,
      'view.reset': () => 'View reset. Back to the big blue marble.',
      'voice.help': () =>
        'Say things like: show cyber layer, go live, zoom to Tokyo, reset view.',
      unheard: () => 'Say what now? I missed that.',
      notWired: ({ label }) =>
        `${label} — loud and clear, but the app hasn't hooked that one up yet.`,
      failed: ({ label }) => `${label} fizzled. Try again?`,
    }),
  }),

  sentinel: Object.freeze({
    id: 'sentinel',
    name: 'Sentinel',
    tagline: 'Terse and tactical.',
    voicePrefs: Object.freeze({
      langs: ['en-US', 'en'],
      nameHints: ['Zira', 'David', 'Google US English'],
      pitch: 0.85,
      rate: 1.1,
    }),
    greeting: 'Sentinel listening.',
    confirm: Object.freeze({
      'cyber.show': () => 'Cyber layer: up.',
      'cyber.hide': () => 'Cyber layer: down.',
      'cyber.live': () => 'Live feed. Actuals.',
      'cyber.simulated': () => 'Simulated feed.',
      'nav.zoomCity': ({ cityName }) => `Vector: ${cityName}.`,
      'panel.open': ({ panelName }) => `${panelName} panel open.`,
      'panel.close': ({ panelName }) => `${panelName} panel closed.`,
      'view.reset': () => 'View reset.',
      'voice.help': () =>
        'Commands: cyber layer on or off, go live, simulation, zoom to city, open panel, reset view.',
      unheard: () => 'No copy. Repeat.',
      notWired: ({ label }) => `${label}: no link to app.`,
      failed: ({ label }) => `${label}: failed.`,
    }),
  }),

  relay: Object.freeze({
    id: 'relay',
    name: 'Relay',
    tagline: 'Warm radio operator.',
    voicePrefs: Object.freeze({
      langs: ['en-US', 'en'],
      nameHints: ['Jenny', 'Aria', 'Google US English'],
      pitch: 1.1,
      rate: 0.98,
    }),
    greeting: 'Relay standing by.',
    confirm: Object.freeze({
      'cyber.show': () => 'Copy that — cyber layer is on.',
      'cyber.hide': () => 'Copy — cyber layer off.',
      'cyber.live': () => 'Roger, switching to the live feed.',
      'cyber.simulated': () => 'Back on the simulated feed, over.',
      'nav.zoomCity': ({ cityName }) => `Taking you to ${cityName}, over.`,
      'panel.open': ({ panelName }) => `${panelName} panel coming right up.`,
      'panel.close': ({ panelName }) => 'Panel closed, standing by.',
      'view.reset': () => 'View reset to home, over.',
      'voice.help': () =>
        'I can hear: show cyber layer, go live, zoom to Tokyo, open panel, reset view.',
      unheard: () => "Didn't copy that one — say again?",
      notWired: ({ label }) =>
        `${label} received, but it isn't connected to the app yet.`,
      failed: ({ label }) => `${label} didn't go through, over.`,
    }),
  }),
});

/** Ordered personas for the picker UI. */
export function listPersonas() {
  return Object.values(VOICE_PERSONAS);
}

/**
 * Resolve a persona id to a persona, falling back to the default when the id
 * is unknown — the picker can never end up personless.
 */
export function resolvePersona(id) {
  if (typeof id === 'string' && VOICE_PERSONAS[id]) return VOICE_PERSONAS[id];
  return VOICE_PERSONAS[DEFAULT_PERSONA_ID];
}

/**
 * Best-effort speechSynthesis voice selection for a persona.
 *
 * @param {object} persona - a VOICE_PERSONAS entry.
 * @param {SpeechSynthesisVoice[]} voices - from speechSynthesis.getVoices().
 * @returns {SpeechSynthesisVoice|null} the best match, or null.
 */
export function pickPersonaVoice(persona, voices = []) {
  const list = Array.isArray(voices) ? voices : [];
  if (list.length === 0) return null;
  const prefs = persona?.voicePrefs || {};
  const langs = (prefs.langs || ['en']).map((l) => String(l).toLowerCase());
  const hints = (prefs.nameHints || []).map((h) => String(h).toLowerCase());
  const langOf = (voice) => String(voice?.lang || '').toLowerCase();
  const nameOf = (voice) => String(voice?.name || '').toLowerCase();
  const matchesLang = (voice) =>
    langs.some((lang) => langOf(voice).startsWith(lang));
  const matchesHint = (voice) =>
    hints.some((hint) => hint && nameOf(voice).includes(hint));
  return (
    list.find((voice) => matchesLang(voice) && matchesHint(voice)) ||
    list.find(matchesLang) ||
    list.find((voice) => langOf(voice).startsWith('en')) ||
    list[0] ||
    null
  );
}
