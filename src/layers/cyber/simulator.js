/**
 * Simulated cyber threat-intelligence feed.
 *
 * 100% original, generated in-repo. Makes ZERO network calls, requires no
 * paid APIs, no timers, and no global state: every tick is a pure function of
 * (seed, tick counter), so the same seed always yields the same event stream
 * (useful for tests and demos).
 *
 * ⚠️ ALL DATA IS SIMULATED. It must never be presented as real threat
 * intelligence. The layer's UI attribution reads "Simulated feed" (see the
 * layer module + docs/CYBER_INTEL.md).
 */

/** Deterministic 32-bit PRNG (mulberry32). */
function mulberry32(a) {
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Major country hubs, each `{ country, code, lat, lon }`.
 * Widely-known approximate capital/metro coordinates.
 */
const HUBS = [
  { country: 'United States', code: 'US', lat: 38.9, lon: -77.0 }, // Washington, D.C.
  { country: 'China', code: 'CN', lat: 39.9, lon: 116.4 }, // Beijing
  { country: 'Russia', code: 'RU', lat: 55.8, lon: 37.6 }, // Moscow
  { country: 'Germany', code: 'DE', lat: 52.5, lon: 13.4 }, // Berlin
  { country: 'United Kingdom', code: 'GB', lat: 51.5, lon: -0.13 }, // London
  { country: 'Brazil', code: 'BR', lat: -23.55, lon: -46.63 }, // São Paulo
  { country: 'India', code: 'IN', lat: 28.6, lon: 77.2 }, // New Delhi
  { country: 'Japan', code: 'JP', lat: 35.7, lon: 139.7 }, // Tokyo
  { country: 'South Korea', code: 'KR', lat: 37.6, lon: 127.0 }, // Seoul
  { country: 'Netherlands', code: 'NL', lat: 52.4, lon: 4.9 }, // Amsterdam
  { country: 'Singapore', code: 'SG', lat: 1.35, lon: 103.8 }, // Singapore
  { country: 'Australia', code: 'AU', lat: -33.9, lon: 151.2 }, // Sydney
];

/** Threat-type weights: scans most frequent, c2 rarest. */
const TYPE_WEIGHTS = [
  ['scan', 0.4],
  ['phishing', 0.2],
  ['ddos', 0.15],
  ['malware', 0.12],
  ['intrusion', 0.1],
  ['c2', 0.03],
];

/** Severity weights (1–5), skewed low: most simulated events are minor. */
const SEVERITY_WEIGHTS = [0.34, 0.28, 0.2, 0.12, 0.06];

/** Epoch-ms anchor for tick 0; each tick advances TICK_MS so `ts` is pure. */
const BASE_EPOCH_MS = Date.UTC(2026, 8, 22, 0, 0, 0);
const TICK_MS = 5000;

/** Pick an index from a [value, weight] table using one PRNG draw. */
function pickWeighted(rng, table) {
  let r = rng();
  for (let i = 0; i < table.length; i += 1) {
    r -= table[i][1];
    if (r <= 0) return table[i][0];
  }
  return table[table.length - 1][0];
}

/** Pick a severity 1–5 using one PRNG draw. */
function pickSeverity(rng) {
  let r = rng();
  for (let i = 0; i < SEVERITY_WEIGHTS.length; i += 1) {
    r -= SEVERITY_WEIGHTS[i];
    if (r <= 0) return i + 1;
  }
  return SEVERITY_WEIGHTS.length;
}

function copyHub(hub) {
  return { country: hub.country, code: hub.code, lat: hub.lat, lon: hub.lon };
}

/**
 * Create a simulated cyber-threat feed source.
 *
 * Mirrors the layer source interface (`src/layers/earthquakes/source.js`):
 * returns `{ getSnapshot({ signal } = {}) }`. Each call advances an internal
 * tick counter; the events for tick N are derived deterministically from
 * (seed, N) — no wall-clock, no network, no timers, no global state.
 *
 * @param {object} [opts]
 * @param {number} [opts.seed=1337] Deterministic stream selector.
 * @param {number} [opts.eventsPerTick=40] Max events emitted per tick.
 */
export function createSimulatedCyberFeed({
  seed = 1337,
  eventsPerTick = 40,
} = {}) {
  const seedU32 = seed >>> 0;
  const count = Math.max(0, Math.floor(eventsPerTick));
  let tick = 0;

  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      // Fresh PRNG per (seed, tick): snapshot content is a pure function of
      // the seed and the tick counter, independent of call timing or order.
      const rng = mulberry32((seedU32 ^ Math.imul(tick + 1, 0x9e3779b1)) >>> 0);
      const events = [];
      for (let n = 0; n < count; n += 1) {
        const srcIdx = Math.floor(rng() * HUBS.length);
        let dstIdx = Math.floor(rng() * (HUBS.length - 1));
        if (dstIdx >= srcIdx) dstIdx += 1; // dst ≠ src, uniform over the rest
        const ts = BASE_EPOCH_MS + tick * TICK_MS + Math.floor(rng() * TICK_MS);
        events.push({
          id: `cyber-${tick}-${n}`,
          src: copyHub(HUBS[srcIdx]),
          dst: copyHub(HUBS[dstIdx]),
          type: pickWeighted(rng, TYPE_WEIGHTS),
          severity: pickSeverity(rng),
          ts,
        });
      }
      tick += 1;
      return events;
    },
  };
}
