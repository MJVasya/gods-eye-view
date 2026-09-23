/**
 * Simulated civil air-traffic feed + honest live/fallback source decorator.
 *
 * 100% original, generated in-repo. Makes ZERO network calls and requires no
 * API keys: it flies a deterministic fleet of aircraft along great-circle
 * routes between major airports. Records use the exact shape
 * `normalizeOpenSkyAircraft()` produces, so the snapshot drops into the
 * flights ingestion/rendering pipeline unchanged.
 *
 * Every snapshot is a pure function of (seed, tick): the same seed and the
 * same tick sequence always yield the same aircraft at the same positions
 * (useful for tests and demos). `observedAtMs` is wall-clock so freshness
 * accounting stays truthful.
 *
 * ⚠️ ALL DATA IS SIMULATED. It must never be presented as live OpenSky
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

/** Major airports: { code, city, country, lat, lon }. Widely-known coordinates. */
const AIRPORTS = [
  { code: 'JFK', city: 'New York', country: 'United States', lat: 40.6413, lon: -73.7781 },
  { code: 'LAX', city: 'Los Angeles', country: 'United States', lat: 33.9416, lon: -118.4085 },
  { code: 'ORD', city: 'Chicago', country: 'United States', lat: 41.9742, lon: -87.9073 },
  { code: 'DFW', city: 'Dallas', country: 'United States', lat: 32.8998, lon: -97.0403 },
  { code: 'ATL', city: 'Atlanta', country: 'United States', lat: 33.6407, lon: -84.4277 },
  { code: 'MIA', city: 'Miami', country: 'United States', lat: 25.7932, lon: -80.2906 },
  { code: 'SEA', city: 'Seattle', country: 'United States', lat: 47.4502, lon: -122.3088 },
  { code: 'SFO', city: 'San Francisco', country: 'United States', lat: 37.6213, lon: -122.379 },
  { code: 'DEN', city: 'Denver', country: 'United States', lat: 39.8561, lon: -104.6737 },
  { code: 'BOS', city: 'Boston', country: 'United States', lat: 42.3656, lon: -71.0096 },
  { code: 'LHR', city: 'London', country: 'United Kingdom', lat: 51.47, lon: -0.4543 },
  { code: 'CDG', city: 'Paris', country: 'France', lat: 49.0097, lon: 2.5479 },
  { code: 'FRA', city: 'Frankfurt', country: 'Germany', lat: 50.0379, lon: 8.5622 },
  { code: 'AMS', city: 'Amsterdam', country: 'Netherlands', lat: 52.3105, lon: 4.7683 },
  { code: 'MAD', city: 'Madrid', country: 'Spain', lat: 40.4983, lon: -3.5676 },
  { code: 'DXB', city: 'Dubai', country: 'United Arab Emirates', lat: 25.2532, lon: 55.3657 },
  { code: 'HND', city: 'Tokyo', country: 'Japan', lat: 35.5494, lon: 139.7798 },
  { code: 'SIN', city: 'Singapore', country: 'Singapore', lat: 1.3644, lon: 103.9915 },
  { code: 'SYD', city: 'Sydney', country: 'Australia', lat: -33.9399, lon: 151.1753 },
  { code: 'GRU', city: 'São Paulo', country: 'Brazil', lat: -23.4356, lon: -46.4731 },
  { code: 'YYZ', city: 'Toronto', country: 'Canada', lat: 43.6777, lon: -79.6248 },
  { code: 'DEL', city: 'Delhi', country: 'India', lat: 28.5562, lon: 77.1 },
  { code: 'ICN', city: 'Seoul', country: 'South Korea', lat: 37.4602, lon: 126.4407 },
  { code: 'MEX', city: 'Mexico City', country: 'Mexico', lat: 19.4363, lon: -99.0721 },
];

/** In-app source label while the simulated feed is active. Never claims live data. */
export const SIMULATED_FLIGHT_SOURCE_LABEL = 'SIMULATED';
export const SIMULATED_FLIGHT_COVERAGE = 'OpenSky unreachable · seeded flight tracks';

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

/** Great-circle interpolation between two airports at fraction f ∈ [0, 1]. */
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
 * Create the seeded simulated flight feed.
 *
 * Same interface as the live OpenSky source (`getSnapshot(query, { signal })`
 * → OpenSky-shaped snapshot). Each call advances an internal tick counter;
 * aircraft positions for tick N are a pure function of (seed, N) — no
 * wall-clock, no network, no timers, no global state.
 *
 * @param {object} [opts]
 * @param {number} [opts.seed=90210] Deterministic fleet selector.
 * @param {number} [opts.aircraftCount=140] Aircraft in the simulated fleet.
 * @param {Function} [opts.now] Clock for `observedAtMs` (injectable in tests).
 */
export function createSimulatedFlightFeed({
  seed = 90210,
  aircraftCount = 140,
  now = () => Date.now(),
} = {}) {
  const rng = mulberry32(seed >>> 0);
  const count = Math.max(0, Math.floor(aircraftCount));
  const fleet = [];
  const usedIcao = new Set();
  for (let i = 0; i < count; i += 1) {
    const from = AIRPORTS[Math.floor(rng() * AIRPORTS.length)];
    let to = AIRPORTS[Math.floor(rng() * AIRPORTS.length)];
    if (to === from) to = AIRPORTS[(AIRPORTS.indexOf(from) + 7) % AIRPORTS.length];
    let icao;
    do {
      icao = Math.floor(rng() * 0xffffff)
        .toString(16)
        .padStart(6, '0');
    } while (usedIcao.has(icao));
    usedIcao.add(icao);
    const distKm = haversineKm(from, to);
    const speedMps = 215 + rng() * 45;
    const cruiseM = 9000 + rng() * 3000;
    fleet.push({
      icao,
      from,
      to,
      durationS: (distKm * 1000) / speedMps,
      speedMps,
      cruiseM,
      // Self-identifying: never shaped like a real airline flight number, so
      // a tooltip or screenshot can never be mistaken for live traffic.
      callsign: 'SIM' + String(1000 + Math.floor(rng() * 9000)),
      country: from.country,
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
        // Climb out / descend near the endpoints; cruise mid-leg.
        const climb = Math.min(1, Math.min(f, 1 - f) * 8);
        const alt = 1500 + (ac.cruiseM - 1500) * climb;
        return {
          id: ac.icao,
          reference: ac.icao,
          latitude: lat,
          longitude: lon,
          callsign: ac.callsign,
          originCountry: ac.country,
          positionTimeMs: t,
          contactTimeMs: t,
          baroAltitudeM: alt,
          ellipsoidAltitudeM: alt,
          onGround: false,
          speedMps: ac.speedMps,
          courseDeg: course,
          verticalRateMps: 0,
          category: 0,
          typeCode: null,
          registration: null,
          operator: null,
        };
      });
      tick += 1;
      return {
        records,
        complete: true,
        rejectedCount: 0,
        source: SIMULATED_FLIGHT_SOURCE_LABEL,
        coverage: SIMULATED_FLIGHT_COVERAGE,
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
 * Decorate a live flight source with the honest simulated fallback.
 *
 * The wrapper exposes the same interface (`label`, `getSnapshot`, plus
 * `getTrack`/`getEnrichment` when the live source has them). Every
 * `getSnapshot` tries the live source first; only when it throws does the
 * call fall back to the seeded simulator — and the returned snapshot is
 * always labeled simulated. A short cooldown after a live failure keeps a
 * dead endpoint from being hammered every refresh tick, while still
 * re-probing live on a bounded cadence so the real feed lights up on its
 * own once it works again. AbortError is always rethrown, never swallowed.
 *
 * Idempotent: wrapping an already-wrapped source (e.g. via setSource after
 * construction) returns it unchanged. A source without `getSnapshot` is
 * returned untouched so downstream "source required" errors keep working.
 *
 * @param {object} [source] Live source (e.g. createOpenSkySource()).
 * @param {object} [opts]
 * @param {number} [opts.seed=90210] Simulator seed.
 * @param {Function} [opts.now] Clock (injectable in tests).
 * @param {number} [opts.liveCooldownMs=60000] Min ms between live attempts after a failure.
 * @param {number} [opts.aircraftCount] Simulated fleet size.
 */
export function withSimulatedFallback(
  source,
  { seed = 90210, now = () => Date.now(), liveCooldownMs = 60000, aircraftCount } = {},
) {
  if (!source || typeof source.getSnapshot !== 'function') return source;
  if (wrappedSources.has(source)) return source;
  const sim = createSimulatedFlightFeed({ seed, now, aircraftCount });
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
            `[Data:Flights] Live source failed (${error?.message || error}); serving simulated feed`,
          );
        }
      }
      return sim.getSnapshot(query, opts);
    },
  };
  for (const method of ['getTrack', 'getEnrichment']) {
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
