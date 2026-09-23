/**
 * Simulated satellite catalog (TLE) feed.
 *
 * 100% original, generated in-repo. Makes ZERO network calls and requires no
 * API keys: it synthesizes valid two-line element sets for a small set of
 * well-known satellites (real NORAD IDs and names, plausible orbital
 * elements) so the layer can render an honest fallback when CelesTrak is
 * unreachable. The generated TLE flows through the exact same parse →
 * twoline2satrec → SGP4 propagation pipeline as live data, so on-screen
 * motion is real orbital mechanics — only the element sets are synthetic.
 *
 * Deterministic per (seed): the same seed always yields the same catalog
 * (names, elements, phasing). The TLE epoch is stamped at generation time so
 * propagation stays current.
 *
 * ⚠️ ALL DATA IS SIMULATED. It must never be presented as live CelesTrak
 * data. The layer surfaces it with the FALLBACK chip and a "Simulated …"
 * source label (see ingestion.js + controls.js getStats()).
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
 * Well-known satellites per CelesTrak group. NORAD IDs and names are real;
 * inclinations/mean motions are representative of each constellation's shell.
 * RAAN, argument of perigee and mean anomaly are seeded per catalog build so
 * the shell is distributed rather than stacked on one meridian.
 */
const DEFINITIONS = [
  // ---- stations ----
  { group: 'stations', name: 'ISS (ZARYA)', norad: 25544, intl: '98067A', inc: 51.6416, mm: 15.4956, ecc: 0.00063 },
  { group: 'stations', name: 'TIANGONG', norad: 48274, intl: '21035A', inc: 41.470, mm: 15.601, ecc: 0.00042 },
  { group: 'stations', name: 'HST', norad: 20580, intl: '90037B', inc: 28.469, mm: 15.092, ecc: 0.00029 },
  // ---- visual (bright) ----
  { group: 'visual', name: 'TERRA', norad: 25994, intl: '99068A', inc: 98.206, mm: 14.571, ecc: 0.00011 },
  { group: 'visual', name: 'AQUA', norad: 27424, intl: '02022A', inc: 98.205, mm: 14.571, ecc: 0.00012 },
  { group: 'visual', name: 'NOAA 19', norad: 33591, intl: '09005A', inc: 99.188, mm: 14.125, ecc: 0.00142 },
  // ---- gps-ops ----
  { group: 'gps-ops', name: 'GPS BIIR-2  (PRN 13)', norad: 24876, intl: '97035A', inc: 55.4, mm: 2.0056, ecc: 0.0031 },
  { group: 'gps-ops', name: 'GPS BIIR-5  (PRN 16)', norad: 26360, intl: '00025A', inc: 55.1, mm: 2.0056, ecc: 0.0042 },
  { group: 'gps-ops', name: 'GPS BIIR-9  (PRN 21)', norad: 28190, intl: '03010A', inc: 55.6, mm: 2.0056, ecc: 0.0028 },
  { group: 'gps-ops', name: 'GPS BIIF-3  (PRN 05)', norad: 38833, intl: '12053A', inc: 55.0, mm: 2.0056, ecc: 0.0035 },
  { group: 'gps-ops', name: 'GPS BIII-1  (PRN 04)', norad: 48859, intl: '18093A', inc: 55.3, mm: 2.0056, ecc: 0.0021 },
  { group: 'gps-ops', name: 'GPS BIII-4  (PRN 23)', norad: 54216, intl: '22053A', inc: 54.9, mm: 2.0056, ecc: 0.0026 },
  // ---- glo-ops ----
  { group: 'glo-ops', name: 'GLONASS 720', norad: 29672, intl: '06021A', inc: 64.8, mm: 2.0060, ecc: 0.0018 },
  { group: 'glo-ops', name: 'GLONASS 730', norad: 32276, intl: '07052A', inc: 64.8, mm: 2.0060, ecc: 0.0022 },
  { group: 'glo-ops', name: 'GLONASS 744', norad: 36112, intl: '10041A', inc: 64.8, mm: 2.0060, ecc: 0.0015 },
  { group: 'glo-ops', name: 'GLONASS 755', norad: 39620, intl: '14012A', inc: 64.8, mm: 2.0060, ecc: 0.0020 },
  // ---- galileo ----
  { group: 'galileo', name: 'GALILEO 5', norad: 40544, intl: '14050A', inc: 56.0, mm: 1.9030, ecc: 0.0011 },
  { group: 'galileo', name: 'GALILEO 8', norad: 40890, intl: '15017B', inc: 56.0, mm: 1.9030, ecc: 0.0009 },
  { group: 'galileo', name: 'GALILEO 19', norad: 43055, intl: '17048A', inc: 56.0, mm: 1.9030, ecc: 0.0013 },
  { group: 'galileo', name: 'GALILEO 23', norad: 43564, intl: '18060A', inc: 56.0, mm: 1.9030, ecc: 0.0010 },
  // ---- geo ----
  { group: 'geo', name: 'GOES-16', norad: 41866, intl: '16071A', inc: 0.024, mm: 1.0027, ecc: 0.00021 },
  { group: 'geo', name: 'GOES-18', norad: 51850, intl: '22022A', inc: 0.018, mm: 1.0027, ecc: 0.00019 },
  { group: 'geo', name: 'TDRS-12', norad: 39460, intl: '14004A', inc: 0.031, mm: 1.0027, ecc: 0.00024 },
  // ---- starlink ----
  { group: 'starlink', name: 'STARLINK-1007', norad: 44713, intl: '19074A', inc: 53.05, mm: 15.0639, ecc: 0.00014 },
  { group: 'starlink', name: 'STARLINK-1008', norad: 44714, intl: '19074B', inc: 53.05, mm: 15.0639, ecc: 0.00013 },
  { group: 'starlink', name: 'STARLINK-30123', norad: 55098, intl: '23001A', inc: 53.05, mm: 15.0639, ecc: 0.00015 },
  { group: 'starlink', name: 'STARLINK-30244', norad: 56122, intl: '23054A', inc: 53.05, mm: 15.0639, ecc: 0.00012 },
  { group: 'starlink', name: 'STARLINK-30310', norad: 56206, intl: '23058C', inc: 53.05, mm: 15.0639, ecc: 0.00014 },
  { group: 'starlink', name: 'STARLINK-30471', norad: 56372, intl: '23063K', inc: 53.05, mm: 15.0639, ecc: 0.00013 },
  { group: 'starlink', name: 'STARLINK-30552', norad: 56567, intl: '23072D', inc: 53.05, mm: 15.0639, ecc: 0.00015 },
  { group: 'starlink', name: 'STARLINK-30618', norad: 57123, intl: '23078A', inc: 53.05, mm: 15.0639, ecc: 0.00012 },
];

/** Groups this simulator can synthesize (mirrors source.js). */
export const SIMULATED_GROUPS = Object.freeze([
  'stations',
  'visual',
  'gps-ops',
  'glo-ops',
  'galileo',
  'geo',
  'starlink',
]);

/** TLE checksum over the first 68 columns: digits sum, '-' counts 1, mod 10. */
function tleChecksum(line68) {
  let sum = 0;
  for (let i = 0; i < line68.length; i += 1) {
    const ch = line68[i];
    if (ch >= '0' && ch <= '9') sum += ch.charCodeAt(0) - 48;
    else if (ch === '-') sum += 1;
  }
  return String(sum % 10);
}

/** `YYDDD.DDDDDDDD` (14 chars) epoch stamp for a Date. */
function epochStamp(date) {
  const year = date.getUTCFullYear();
  const dayOfYear = (date.getTime() - Date.UTC(year, 0, 0)) / 86400000;
  const yy = String(year % 100).padStart(2, '0');
  const ddd = String(Math.floor(dayOfYear)).padStart(3, '0');
  const frac = (dayOfYear % 1).toFixed(8).slice(1); // ".12345678"
  return `${yy}${ddd}${frac}`;
}

function buildLine1(def, epoch) {
  const sat5 = String(def.norad).padStart(5, ' ');
  const intl8 = String(def.intl || '').padEnd(8, ' ').slice(0, 8);
  const body =
    `1 ${sat5}U ${intl8} ${epoch} ` +
    ` .00000000  00000-0  00000-0 0  900`;
  return body + tleChecksum(body);
}

function buildLine2(def, raan, argp, ma) {
  const sat5 = String(def.norad).padStart(5, ' ');
  const inc8 = def.inc.toFixed(4).padStart(8, ' ');
  const raan8 = raan.toFixed(4).padStart(8, ' ');
  const ecc7 = String(Math.round(def.ecc * 1e7)).padStart(7, '0');
  const argp8 = argp.toFixed(4).padStart(8, ' ');
  const ma8 = ma.toFixed(4).padStart(8, ' ');
  const mm11 = def.mm.toFixed(8).padStart(11, ' ');
  const body =
    `2 ${sat5} ${inc8} ${raan8} ${ecc7} ${argp8} ${ma8} ${mm11}00001`;
  return body + tleChecksum(body);
}

/**
 * Generate synthetic 3-line TLE text for one catalog group.
 *
 * Same shape as a CelesTrak group response (name line + line 1 + line 2 per
 * satellite), so it drops into `parseTLE` unchanged. Phasing (RAAN / mean
 * anomaly / argument of perigee) is drawn from the seeded PRNG; the epoch is
 * stamped at call time so SGP4 propagation stays current.
 *
 * @param {string} group CelesTrak group path (e.g. 'stations').
 * @param {object} [opts]
 * @param {number} [opts.seed=424242] Deterministic catalog selector.
 * @param {Date} [opts.epoch=new Date()] TLE epoch.
 * @returns {string} 3LE text, or '' for an unknown group.
 */
export function simulatedGroupTle(group, { seed = 424242, epoch = new Date() } = {}) {
  if (!SIMULATED_GROUPS.includes(group)) return '';
  const rng = mulberry32(seed >>> 0);
  const stamp = epochStamp(epoch instanceof Date ? epoch : new Date(epoch));
  const lines = [];
  for (const def of DEFINITIONS) {
    if (def.group !== group) continue;
    const raan = rng() * 360;
    const argp = rng() * 360;
    const ma = rng() * 360;
    lines.push(def.name, buildLine1(def, stamp), buildLine2(def, raan, argp, ma));
  }
  return lines.join('\n');
}

/**
 * Create a satellite source backed by the simulator, mirroring
 * `createSatelliteSource` (`readGroup(group, { signal })`). Pure and
 * deterministic per (seed, now): the seeded PRNG picks the orbital phasing
 * and the injected clock stamps the TLE epoch, so a fixed clock reproduces
 * the catalog byte-for-byte. Used by tests and available to app wiring that
 * wants the simulated catalog without touching the network at all.
 */
export function createSimulatedSatelliteSource({ seed = 424242, now = () => Date.now() } = {}) {
  return {
    async readGroup(group, { signal } = {}) {
      if (!SIMULATED_GROUPS.includes(group))
        throw new TypeError('Unknown satellite group');
      signal?.throwIfAborted();
      return {
        ok: true,
        status: 200,
        text: simulatedGroupTle(group, { seed, epoch: new Date(now()) }),
        simulated: true,
      };
    },
  };
}

const wrappedSources = new WeakSet();

/**
 * Decorate a live CelesTrak source with the honest simulated fallback.
 *
 * The wrapper exposes the same `readGroup(group, { signal })` interface.
 * Every call tries the live source first; only when the request throws or
 * returns a non-OK / empty body does it serve the seeded synthetic catalog —
 * and the returned response always carries `simulated: true` so ingestion can
 * label the layer honestly. A short cooldown after a live failure keeps a
 * dead endpoint from being hammered every refresh tick, while still
 * re-probing live on a bounded cadence so the real catalog lights up on its
 * own once CelesTrak works again. AbortError is always rethrown, never
 * swallowed.
 *
 * Idempotent: wrapping an already-wrapped source returns it unchanged.
 * A source without `readGroup` is returned untouched so downstream "source
 * required" errors keep working.
 *
 * The injected `now` clock drives both the live-retry cooldown and the TLE
 * epoch stamp, so (seed, now) fully determines the served catalog.
 *
 * @param {object} [source] Live source (e.g. createSatelliteSource()).
 * @param {object} [opts]
 * @param {number} [opts.seed=424242] Simulator seed.
 * @param {Function} [opts.now] Clock (injectable in tests).
 * @param {number} [opts.liveCooldownMs=60000] Min ms between live attempts after a failure.
 */
export function withSimulatedFallback(
  source,
  { seed = 424242, now = () => Date.now(), liveCooldownMs = 60000 } = {},
) {
  if (!source || typeof source.readGroup !== 'function') return source;
  if (wrappedSources.has(source)) return source;
  // The injected clock drives both the live-retry cooldown and the TLE epoch
  // stamp, so a fixed clock makes the whole fallback deterministic.
  const sim = createSimulatedSatelliteSource({ seed, now });
  let lastLiveFailureAt = -Infinity;
  const wrapped = {
    async readGroup(group, { signal } = {}) {
      signal?.throwIfAborted();
      const t = now();
      let liveError = null;
      if (t - lastLiveFailureAt >= liveCooldownMs) {
        try {
          const res = await source.readGroup(group, { signal });
          signal?.throwIfAborted();
          if (res?.ok && res?.text && res.text.trim()) return res;
          liveError = new Error(
            `CelesTrak group '${group}' failed (ok=${res?.ok}, status=${res?.status})`,
          );
        } catch (error) {
          if (error?.name === 'AbortError') throw error;
          signal?.throwIfAborted();
          liveError = error;
        }
        lastLiveFailureAt = t;
      }
      if (liveError && !SIMULATED_GROUPS.includes(group)) throw liveError;
      if (liveError)
        console.warn(
          `[Data:Satellites] Live group '${group}' failed (${liveError?.message || liveError}); serving simulated catalog`,
        );
      return sim.readGroup(group, { signal });
    },
  };
  wrappedSources.add(wrapped);
  return wrapped;
}
