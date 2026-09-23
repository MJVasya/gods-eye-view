/**
 * Simulated military air-traffic feed + honest live/fallback source decorator.
 *
 * 100% original, generated in-repo. Makes ZERO network calls and requires no
 * API keys: it flies a deterministic fleet of military aircraft between
 * airbases. Records use the exact shape `normalizeReadsbAircraft()` produces,
 * so the snapshot drops into the military ingestion/rendering pipeline
 * unchanged.
 *
 * Every snapshot is a pure function of (seed, tick): the same seed and the
 * same tick sequence always yield the same aircraft at the same positions
 * (useful for tests and demos). `observedAtMs` is wall-clock so freshness
 * accounting stays truthful.
 *
 * ⚠️ ALL DATA IS SIMULATED. It must never be presented as live adsb.lol
 * traffic. `withSimulatedFallback()` always tries the real source first and
 * only serves simulated snapshots while the live source is failing; every
 * simulated snapshot carries `simulated: true` plus "SIMULATED" source and
 * coverage labels, and the layer reports `fallback: true` in getStats() so
 * the panel renders the amber FALLBACK chip.
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

const TICK_MS = 10000;
const DEG = Math.PI / 180;
const EARTH_KM = 6371;

/** Airbases: { code, name, lat, lon }. Widely-known coordinates. */
const BASES = [
  { code: 'DOV', name: 'Dover AFB', lat: 39.1295, lon: -75.4663 },
  { code: 'RMS', name: 'Ramstein AB', lat: 49.4369, lon: 7.6003 },
  { code: 'KAD', name: 'Kadena AB', lat: 26.3555, lon: 127.7689 },
  { code: 'MHD', name: 'RAF Mildenhall', lat: 52.3619, lon: 0.4864 },
  { code: 'ELM', name: 'Elmendorf AFB', lat: 61.2517, lon: -149.8064 },
  { code: 'AUD', name: 'Al Udeid AB', lat: 25.1173, lon: 51.3144 },
  { code: 'YOK', name: 'Yokota AB', lat: 35.7486, lon: 139.3485 },
  { code: 'FAI', name: 'Fairford RAF', lat: 51.6822, lon: -1.7903 },
];

const TYPE_CODES = ['C17', 'KC135', 'B52', 'F16', 'C130', 'P8', 'E3', 'KC46'];

/** In-app source label while the simulated feed is active. Never claims live data. */
export const SIMULATED_MILITARY_SOURCE_LABEL = 'SIMULATED';
export const SIMULATED_MILITARY_COVERAGE = 'adsb.lol unreachable · seeded military tracks';

function toUnit(lat, lon) {
  const phi = (90 - lat) * DEG;
  const theta = (lon + 180) * DEG;
  return [
    Math.sin(phi) * Math.cos(theta),
    Math.sin(phi) * Math.sin(theta),
    Math.cos(phi),
  ];
}

function fromUnit(v) {
  const lat = 90 - Math.acos(Math.max(-1, Math.min(1, v[2]))) / DEG;
  const lon = Math.atan2(v[1], v[0]) / DEG - 180;
  return [lat, lon > 180 ? lon - 360 : lon < -180 ? lon + 360 : lon];
}

function haversineKm(a, b) {
  const dLat = (b.lat - a.lat) * DEG;
  const dLon = (b.lon - a.lon) * DEG;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * DEG) * Math.cos(b.lat * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Great-circle interpolation between two bases at fraction f ∈ [0, 1]. */
function greatCircle(a, b, f) {
  const u = toUnit(a.lat, a.lon);
  const v = toUnit(b.lat, b.lon);
  const dot = Math.max(-1, Math.min(1, u[0] * v[0] + u[1] * v[1] + u[2] * v[2]));
  const omega = Math.acos(dot);
  if (omega < 1e-9) return [a.lat, a.lon];
  const so = Math.sin(omega);
  const k0 = Math.sin((1 - f) * omega) / so;
  const k1 = Math.sin(f * omega) / so;
  return fromUnit([k0 * u[0] + k1 * v[0], k0 * u[1] + k1 * v[1], k0 * u[2] + k1 * v[2]]);
}

/** Initial bearing (deg) from (lat1, lon1) toward (lat2, lon2). */
function bearingDeg(lat1, lon1, lat2, lon2) {
  const dLon = (lon2 - lon1) * DEG;
  const y = Math.sin(dLon) * Math.cos(lat2 * DEG);
  const x =
    Math.cos(lat1 * DEG) * Math.sin(lat2 * DEG) -
    Math.sin(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.cos(dLon);
  return ((Math.atan2(y, x) / DEG) + 360) % 360;
}

/**
 * Create the seeded simulated military feed.
 *
 * Same interface as the live adsb.lol source (`getSnapshot(query, { signal })`
 * → readsb-shaped snapshot). Each call advances an internal tick counter;
 * aircraft positions for tick N are a pure function of (seed, N) — no
 * wall-clock, no network, no timers, no global state.
 *
 * @param {object} [opts]
 * @param {number} [opts.seed=90211] Deterministic fleet selector.
 * @param {number} [opts.aircraftCount=36] Aircraft in the simulated fleet.
 * @param {Function} [opts.now] Clock for `observedAtMs` (injectable in tests).
 */
export function createSimulatedMilitaryFeed({
  seed = 90211,
  aircraftCount = 36,
  now = () => Date.now(),
} = {}) {
  const rng = mulberry32(seed >>> 0);
  const count = Math.max(0, Math.floor(aircraftCount));
  const fleet = [];
  const usedHex = new Set();
  for (let i = 0; i < count; i += 1) {
    const from = BASES[Math.floor(rng() * BASES.length)];
    let to = BASES[Math.floor(rng() * BASES.length)];
    if (to === from) to = BASES[(BASES.indexOf(from) + 3) % BASES.length];
    let hex;
    do {
      // AE0000–AEFFFF is the US military ICAO block; simulated addresses stay
      // inside it so they read as military while the layer is in fallback.
      hex = 'ae' + Math.floor(rng() * 0xffff).toString(16).padStart(4, '0');
    } while (usedHex.has(hex));
    usedHex.add(hex);
    const distKm = haversineKm(from, to);
    const speedMps = 200 + rng() * 60;
    const cruiseM = 8000 + rng() * 4000;
    fleet.push({
      hex,
      from,
      to,
      durationS: (distKm * 1000) / speedMps,
      speedMps,
      cruiseM,
      // Self-identifying: never shaped like a real military callsign, so a
      // tooltip or screenshot can never be mistaken for live traffic. The
      // SM prefix keeps simulated military contacts visually distinct from
      // simulated civil (SIM) contacts.
      callsign: 'SM' + String(100 + Math.floor(rng() * 900)),
      typeCode: TYPE_CODES[Math.floor(rng() * TYPE_CODES.length)],
      phase: rng(),
    });
  }

  let tick = 0;

  return {
    async getSnapshot(_query = {}, { signal } = {}) {
      signal?.throwIfAborted();
      const t = now();
      const simS = (tick * TICK_MS) / 1000;
      const records = fleet.map((ac) => {
        // Out-and-back legs: 0→durationS outbound, durationS→2×durationS return.
        const legT = (simS + ac.phase * ac.durationS * 2) % (ac.durationS * 2);
        let a = ac.from;
        let b = ac.to;
        let f = legT / ac.durationS;
        if (f > 1) {
          f -= 1;
          a = ac.to;
          b = ac.from;
        }
        const [lat, lon] = greatCircle(a, b, f);
        const course = bearingDeg(lat, lon, b.lat, b.lon);
        const climb = Math.min(1, Math.min(f, 1 - f) * 8);
        const alt = 1500 + (ac.cruiseM - 1500) * climb;
        return {
          id: ac.hex,
          reference: ac.hex,
          latitude: lat,
          longitude: lon,
          callsign: ac.callsign,
          originCountry: null,
          positionTimeMs: t,
          contactTimeMs: t,
          baroAltitudeM: alt,
          ellipsoidAltitudeM: alt,
          onGround: false,
          speedMps: ac.speedMps,
          courseDeg: course,
          verticalRateMps: 0,
          category: 'A3',
          typeCode: ac.typeCode,
          registration: null,
          operator: null,
        };
      });
      tick += 1;
      return {
        records,
        complete: true,
        rejectedCount: 0,
        source: SIMULATED_MILITARY_SOURCE_LABEL,
        coverage: SIMULATED_MILITARY_COVERAGE,
        observedAtMs: t,
        ageMs: 0,
        stale: false,
        freshness: 'current',
        status: 200,
        simulated: true,
      };
    },
  };
}

const wrappedSources = new WeakSet();

/**
 * Decorate a live military source with the honest simulated fallback.
 *
 * Same contract as the flights decorator: tries the live source first on
 * every `getSnapshot`, serves the seeded simulator only while live is
 * failing, labels every simulated snapshot, and re-probes live on a bounded
 * cadence. AbortError is always rethrown. Idempotent; sources without
 * `getSnapshot` pass through untouched.
 */
export function withSimulatedFallback(
  source,
  { seed = 90211, now = () => Date.now(), liveCooldownMs = 60000, aircraftCount } = {},
) {
  if (!source || typeof source.getSnapshot !== 'function') return source;
  if (wrappedSources.has(source)) return source;
  const sim = createSimulatedMilitaryFeed({ seed, now, aircraftCount });
  let lastLiveFailureAt = -Infinity;
  const wrapped = {
    get label() {
      return source.label;
    },
    async getSnapshot(query = {}, opts = {}) {
      const signal = opts?.signal;
      signal?.throwIfAborted();
      const t = now();
      if (t - lastLiveFailureAt >= liveCooldownMs) {
        try {
          const snapshot = await source.getSnapshot(query, opts);
          signal?.throwIfAborted();
          return { ...snapshot, simulated: false };
        } catch (error) {
          if (error?.name === 'AbortError') throw error;
          signal?.throwIfAborted();
          lastLiveFailureAt = t;
          console.warn(
            `[Data:Military] Live source failed (${error?.message || error}); serving simulated feed`,
          );
        }
      }
      return sim.getSnapshot(query, opts);
    },
  };
  for (const method of ['getTrack', 'getIdentities']) {
    if (typeof source[method] === 'function') {
      wrapped[method] = async (...args) => {
        try {
          return await source[method](...args);
        } catch (error) {
          if (error?.name === 'AbortError') throw error;
          return { records: [], complete: true };
        }
      };
    }
  }
  wrappedSources.add(wrapped);
  return wrapped;
}
