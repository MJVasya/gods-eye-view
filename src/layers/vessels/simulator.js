/**
 * Simulated live-vessel (AIS) feed + honest live/fallback source decorator.
 *
 * 100% original, generated in-repo. Makes ZERO network calls and requires no
 * API keys: it sails a deterministic fleet of vessels along major shipping
 * lanes. Records use the exact shape `normalizeVesselObservation()` produces,
 * so the snapshot drops into the vessels ingestion/rendering pipeline
 * unchanged.
 *
 * Every snapshot is a pure function of (seed, tick): the same seed and the
 * same tick sequence always yield the same vessels at the same positions
 * (useful for tests and demos). `observedAtMs` is wall-clock so freshness
 * accounting stays truthful.
 *
 * ⚠️ ALL DATA IS SIMULATED. It must never be presented as live AIS traffic.
 * `withSimulatedFallback()` always tries the real source first and only
 * serves simulated snapshots while the live source is failing; every
 * simulated snapshot carries `simulated: true` plus "SIMULATED" source and
 * coverage labels, and the layer reports `fallback: true` in getStats() so
 * the panel renders the amber FALLBACK chip.
 *
 * Simulated MMSIs use the unassigned 000 MID block (e.g. 000123456) so they
 * can never collide with a real vessel's identity.
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

/**
 * Major shipping lanes as [lon, lat] waypoint polylines.
 * Widely-known approximate routes.
 */
const LANES = [
  {
    name: 'North Atlantic',
    from: 'NEW YORK',
    to: 'ROTTERDAM',
    waypoints: [
      [-74.0, 40.5], [-65.0, 41.0], [-50.0, 43.0], [-35.0, 46.0],
      [-20.0, 49.0], [-8.0, 49.5], [-1.0, 50.5], [3.0, 52.0],
    ],
  },
  {
    name: 'Transpacific',
    from: 'LOS ANGELES',
    to: 'TOKYO',
    waypoints: [
      [-118.2, 33.7], [-130.0, 35.0], [-150.0, 40.0], [-170.0, 45.0],
      [170.0, 48.0], [150.0, 42.0], [140.0, 35.5],
    ],
  },
  {
    name: 'Suez–Asia',
    from: 'PORT SAID',
    to: 'SINGAPORE',
    waypoints: [
      [32.3, 31.2], [35.0, 27.0], [43.0, 12.5], [55.0, 12.0],
      [65.0, 8.0], [80.0, 6.0], [95.0, 6.0], [104.0, 2.0],
    ],
  },
  {
    name: 'Panama–West Coast',
    from: 'LOS ANGELES',
    to: 'PANAMA',
    waypoints: [
      [-118.2, 33.7], [-110.0, 25.0], [-100.0, 18.0], [-90.0, 12.0], [-80.0, 8.0],
    ],
  },
  {
    name: 'Channel–North Sea',
    from: 'DOVER',
    to: 'HAMBURG',
    waypoints: [
      [-5.5, 49.5], [0.0, 50.5], [2.0, 52.0], [4.0, 54.0], [7.0, 58.0], [8.0, 54.5],
    ],
  },
  {
    name: 'Malacca–Indian Ocean',
    from: 'SINGAPORE',
    to: 'COLOMBO',
    waypoints: [
      [104.0, 2.0], [100.0, 6.0], [94.0, 6.0], [88.0, 6.5], [80.0, 6.0],
    ],
  },
];

const VESSEL_NAMES = [
  'MERIDIAN', 'AURORA', 'VENTURE', 'HORIZON', 'PIONEER', 'VOYAGER',
  'ATLAS', 'NEPTUNE', 'ORION', 'PEGASUS', 'TRITON', 'ZEPHYR',
  'CORAL', 'LAGOON', 'HARBOUR', 'ANCHOR', 'COMPASS', 'BEACON',
];
const VESSEL_TYPES = ['Cargo', 'Tanker', 'Container Ship', 'Bulk Carrier', 'Passenger', 'Ro-Ro'];

/** In-app source label while the simulated feed is active. Never claims live data. */
export const SIMULATED_VESSEL_SOURCE_LABEL = 'SIMULATED';
export const SIMULATED_VESSEL_COVERAGE = 'live AIS unreachable · seeded vessel positions';

function haversineKm(lon1, lat1, lon2, lat2) {
  const dLat = (lat2 - lat1) * DEG;
  const dLon = (lon2 - lon1) * DEG;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Initial bearing (deg) from (lon1, lat1) toward (lon2, lat2). */
function bearingDeg(lon1, lat1, lon2, lat2) {
  const dLon = (lon2 - lon1) * DEG;
  const y = Math.sin(dLon) * Math.cos(lat2 * DEG);
  const x =
    Math.cos(lat1 * DEG) * Math.sin(lat2 * DEG) -
    Math.sin(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.cos(dLon);
  return ((Math.atan2(y, x) / DEG) + 360) % 360;
}

/** Precompute cumulative leg lengths (km) for a waypoint polyline. */
function laneLengths(waypoints) {
  const legs = [];
  let total = 0;
  for (let i = 1; i < waypoints.length; i += 1) {
    const [lon1, lat1] = waypoints[i - 1];
    const [lon2, lat2] = waypoints[i];
    total += haversineKm(lon1, lat1, lon2, lat2);
    legs.push(total);
  }
  return { legs, total };
}

/** Position + course at arc distance s (km) along a lane; s may exceed total (wraps). */
function lanePosition(lane, sKm) {
  const { legs, total } = lane._lengths;
  let s = ((sKm % total) + total) % total;
  let i = 0;
  while (i < legs.length - 1 && legs[i] < s) i += 1;
  const prev = i === 0 ? 0 : legs[i - 1];
  const [lon1, lat1] = lane.waypoints[i];
  const [lon2, lat2] = lane.waypoints[i + 1];
  const legLen = legs[i] - prev || 1;
  const f = (s - prev) / legLen;
  return {
    lon: lon1 + (lon2 - lon1) * f,
    lat: lat1 + (lat2 - lat1) * f,
    course: bearingDeg(lon1, lat1, lon2, lat2),
  };
}

for (const lane of LANES) lane._lengths = laneLengths(lane.waypoints);

/**
 * Create the seeded simulated vessel feed.
 *
 * Same interface as the live AIS source (`getSnapshot({ maxRows }, { signal })`
 * → vessel-shaped snapshot). Each call advances an internal tick counter;
 * vessel positions for tick N are a pure function of (seed, N) — no
 * wall-clock, no network, no timers, no global state.
 *
 * @param {object} [opts]
 * @param {number} [opts.seed=90212] Deterministic fleet selector.
 * @param {number} [opts.vesselCount=80] Vessels in the simulated fleet.
 * @param {Function} [opts.now] Clock for `observedAtMs` (injectable in tests).
 */
export function createSimulatedVesselFeed({
  seed = 90212,
  vesselCount = 80,
  now = () => Date.now(),
} = {}) {
  const rng = mulberry32(seed >>> 0);
  const count = Math.max(0, Math.floor(vesselCount));
  const fleet = [];
  const usedMmsi = new Set();
  for (let i = 0; i < count; i += 1) {
    const lane = LANES[Math.floor(rng() * LANES.length)];
    const dir = rng() < 0.5 ? 1 : -1;
    let mmsi;
    do {
      mmsi = '000' + String(100000 + Math.floor(rng() * 899999));
    } while (usedMmsi.has(mmsi));
    usedMmsi.add(mmsi);
    const type = VESSEL_TYPES[Math.floor(rng() * VESSEL_TYPES.length)];
    fleet.push({
      mmsi,
      lane,
      dir,
      offsetKm: rng() * lane._lengths.total,
      // 10–24 kn in m/s.
      speedMps: (10 + rng() * 14) * 0.514444,
      name: `SIM ${VESSEL_NAMES[Math.floor(rng() * VESSEL_NAMES.length)]} ${String(10 + Math.floor(rng() * 89))}`,
      type,
      destination: dir > 0 ? lane.to : lane.from,
    });
  }

  let tick = 0;

  return {
    async getSnapshot({ maxRows = 12000 } = {}, { signal } = {}) {
      signal?.throwIfAborted();
      const t = now();
      const simS = (tick * TICK_MS) / 1000;
      const records = [];
      for (const v of fleet) {
        if (records.length >= maxRows) break;
        // Sail out-and-back: distance increases to 2×lane length then wraps.
        const travelled = v.offsetKm + v.dir * simS * v.speedMps * 3.6;
        const total = v.lane._lengths.total;
        let s = ((travelled % (total * 2)) + total * 2) % (total * 2);
        let courseFlip = false;
        if (s > total) {
          s = total * 2 - s;
          courseFlip = true;
        }
        const pos = lanePosition(v.lane, s);
        const course = courseFlip ? (pos.course + 180) % 360 : pos.course;
        records.push({
          id: v.mmsi,
          reference: v.mmsi,
          latitude: pos.lat,
          longitude: pos.lon,
          name: v.name,
          imo: '',
          type: v.type,
          destination: v.destination,
          speedMps: v.speedMps,
          courseDeg: course,
          headingDeg: course,
          observedAtMs: t,
          altitudeDatum: 'sea-surface',
        });
      }
      tick += 1;
      return {
        records,
        source: SIMULATED_VESSEL_SOURCE_LABEL,
        coverage: SIMULATED_VESSEL_COVERAGE,
        complete: true,
        rejectedCount: 0,
        observedAtMs: t,
        freshness: 'current',
        stale: false,
        transportStatus: null,
        lastMessageAt: t,
        nextAttemptAt: null,
        silentForMs: 0,
        reconnectAttempt: 0,
        rawRowCount: records.length,
        status: 200,
        simulated: true,
      };
    },
  };
}

const wrappedSources = new WeakSet();

/**
 * Decorate a live vessel source with the honest simulated fallback.
 *
 * Same contract as the flights/military decorators: tries the live source
 * first on every `getSnapshot`, serves the seeded simulator only while live
 * is failing, labels every simulated snapshot, and re-probes live on a
 * bounded cadence. AbortError is always rethrown. Idempotent; sources without
 * `getSnapshot` pass through untouched.
 */
export function withSimulatedFallback(
  source,
  { seed = 90212, now = () => Date.now(), liveCooldownMs = 60000, vesselCount } = {},
) {
  if (!source || typeof source.getSnapshot !== 'function') return source;
  if (wrappedSources.has(source)) return source;
  const sim = createSimulatedVesselFeed({ seed, now, vesselCount });
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
            `[Data:Vessels] Live source failed (${error?.message || error}); serving simulated feed`,
          );
        }
      }
      return sim.getSnapshot(query, opts);
    },
  };
  if (typeof source.getTrack === 'function') {
    wrapped.getTrack = async (...args) => {
      try {
        return await source.getTrack(...args);
      } catch (error) {
        if (error?.name === 'AbortError') throw error;
        return { records: [], complete: true };
      }
    };
  }
  wrappedSources.add(wrapped);
  return wrapped;
}
