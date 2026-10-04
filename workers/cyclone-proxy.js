/**
 * Tropical cyclone advisory proxy for Cloudflare Workers / Pages `_worker.js`.
 *
 * Serves `GET /api/cyclones` — a worker port of the Vite dev-server
 * middleware in `server/providers/cyclones.js`, so cyclone advisories work
 * on the deployed Cloudflare Pages app, where the dev middleware does not
 * exist.
 *
 * Sources (all keyless, no signup):
 *   - NHC CurrentStorms.json (active storm list + advisory metadata)
 *   - NHC tropical MapServer (forecast points, track lines, cones) via
 *     mapservices.weather.noaa.gov ArcGIS REST (GeoJSON)
 *
 * The pure parsers below are a verbatim port of the dev middleware's
 * validation logic; only the I/O shell is worker-specific. Response shape is
 * identical to the dev route so `src/layers/cyclones/source.js` needs no
 * changes.
 *
 * Workers-safe: no node: imports, no fs, no Buffer, no process.env.
 * Upstream fetches are capped and timed out; the assembled snapshot is
 * cached at the edge (5 min fresh, 12 h stale-while-revalidate).
 */

const STATUS_URL = 'https://www.nhc.noaa.gov/CurrentStorms.json';
const GIS =
  'https://mapservices.weather.noaa.gov/tropical/rest/services/tropical/NHC_tropical_weather_summary/MapServer';
const HOUR = 3600_000;
const FETCH_TIMEOUT_MS = 10_000;
const FRESH_MS = 300_000;
const STALE_MS = 12 * HOUR;
const USER_AGENT = 'Gods Eye View (public NOAA weather context)';
const LAYERS = [
  { id: 5, cap: 512 * 1024, count: 500, kind: 'points' },
  { id: 6, cap: 512 * 1024, count: 32, kind: 'track' },
  { id: 7, cap: 2 * 1024 * 1024, count: 32, kind: 'cone' },
];
const COVERAGE =
  'Atlantic and eastern/central North Pacific; not worldwide cyclone coverage.';

function invalid() {
  return new Error('invalid_cyclone_data');
}
function text(value, max = 80) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > max ||
    /[\u0000-\u001f<>]/.test(value)
  )
    throw invalid();
  return value.trim();
}
function advisory(value) {
  if (typeof value !== 'string' || !/^\d{1,3}[A-Z]?$/i.test(value))
    throw invalid();
  return value.replace(/^0+(?=\d)/, '').toUpperCase();
}
function number(value, min, max) {
  if (
    value === null ||
    value === undefined ||
    value === '' ||
    !['string', 'number'].includes(typeof value)
  )
    return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}
function iso(value, now) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value)
  )
    throw invalid();
  const n = Date.parse(value);
  // NHC posts each synoptic-hour advisory package up to ~35 minutes before
  // its issuance timestamp; 45 minutes of future tolerance accepts genuine
  // NHC data while still rejecting clock-skewed garbage.
  if (
    !Number.isFinite(n) ||
    n > now + 45 * 60_000 ||
    now - n > 12 * HOUR ||
    new Date(n).toISOString().replace('.000Z', 'Z') !==
      value.replace('.000Z', 'Z')
  )
    throw invalid();
  return new Date(n).toISOString();
}
function position(coordinates) {
  if (
    !Array.isArray(coordinates) ||
    coordinates.length !== 2 ||
    !coordinates.every((n) => typeof n === 'number' && Number.isFinite(n)) ||
    Math.abs(coordinates[0]) > 180 ||
    Math.abs(coordinates[1]) > 90
  )
    throw invalid();
  return { longitude: coordinates[0], latitude: coordinates[1] };
}
function officialLink(value) {
  if (typeof value !== 'string' || value.length > 256) return null;
  try {
    const url = new URL(value);
    return url.origin === 'https://www.nhc.noaa.gov' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      /^\/text\/[A-Z0-9]+\.shtml$/.test(url.pathname)
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export function parseCycloneStatus(payload, now = Date.now()) {
  if (!Array.isArray(payload?.activeStorms) || payload.activeStorms.length > 32)
    throw invalid();
  const seen = new Set();
  return payload.activeStorms.map((raw) => {
    if (
      typeof raw?.id !== 'string' ||
      !/^(?:al|ep|cp)\d{6}$/.test(raw.id) ||
      seen.has(raw.id)
    )
      throw invalid();
    seen.add(raw.id);
    const forecast = raw.forecastAdvisory;
    const issuedAt = iso(forecast?.issuance, now);
    const advisoryNumber = advisory(forecast?.advNum);
    const positionAt = iso(raw.lastUpdate, now);
    return {
      id: raw.id,
      name: text(raw.name),
      classification: text(raw.classification, 16),
      basin: raw.id.slice(0, 2).toUpperCase(),
      position: position([raw.longitudeNumeric, raw.latitudeNumeric]),
      positionAt,
      advisoryNumber,
      issuedAt,
      windKt: number(raw.intensity, 0, 300),
      pressureHpa: number(raw.pressure, 800, 1100),
      movement: {
        directionDegrees: number(raw.movementDir, 0, 360),
        speedKt: number(raw.movementSpeed, 0, 200),
      },
      advisoryUrl: officialLink(forecast.url),
      outlookUrl: raw.id.startsWith('al')
        ? 'https://www.nhc.noaa.gov/gtwo.php?basin=atlc&fdays=7'
        : raw.id.startsWith('cp')
          ? 'https://www.nhc.noaa.gov/gtwo.php?basin=cpac&fdays=7'
          : 'https://www.nhc.noaa.gov/gtwo.php?basin=epac&fdays=7',
      geometryStatus: 'pending',
      geometryAdvisoryNumber: null,
      forecastPoints: [],
      track: null,
      cone: null,
    };
  });
}

function geometry(raw, kind, budget) {
  const types =
    kind === 'points'
      ? ['Point']
      : kind === 'track'
        ? ['LineString', 'MultiLineString']
        : ['Polygon', 'MultiPolygon'];
  if (!types.includes(raw?.type)) throw invalid();
  const point = (value) => {
    position(value);
    if (++budget.count > 25_000) throw invalid();
    return [...value];
  };
  const line = (value, ring = false) => {
    if (
      !Array.isArray(value) ||
      value.length < (ring ? 4 : 2) ||
      value.length > 10_000
    )
      throw invalid();
    const result = value.map(point);
    if (
      ring &&
      (result[0][0] !== result.at(-1)[0] || result[0][1] !== result.at(-1)[1])
    )
      throw invalid();
    return result;
  };
  const list = (value, read) => {
    if (!Array.isArray(value) || !value.length || value.length > 128)
      throw invalid();
    return value.map(read);
  };
  const polygon = (value) => list(value, (ring) => line(ring, true));
  const coordinates =
    raw.type === 'Point'
      ? point(raw.coordinates)
      : raw.type === 'LineString'
        ? line(raw.coordinates)
        : raw.type === 'MultiLineString'
          ? list(raw.coordinates, (part) => line(part))
          : raw.type === 'Polygon'
            ? polygon(raw.coordinates)
            : list(raw.coordinates, polygon);
  return { type: raw.type, coordinates };
}

/** Never relabel earlier GIS geometry with the newer status advisory. */
export function attachCycloneGeometry(storms, collections) {
  const budget = { count: 0 };
  const parsed = LAYERS.map((spec, index) => {
    const payload = collections[index];
    if (
      payload?.type !== 'FeatureCollection' ||
      payload.exceededTransferLimit ||
      !Array.isArray(payload.features) ||
      payload.features.length > spec.count
    )
      throw invalid();
    return payload.features.map((feature) => {
      if (feature?.type !== 'Feature') throw invalid();
      const p = feature.properties;
      const source =
        typeof p?.idp_source === 'string' &&
        p.idp_source.match(
          /^((?:al|ep|cp)\d{6})-(\d{1,3}[a-z]?)_5day_(pts|lin|pgn)$/i,
        );
      if (!source || source[3].toLowerCase() !== ['pts', 'lin', 'pgn'][index])
        throw invalid();
      const adv = advisory(p.advisnum);
      if (adv !== advisory(source[2])) throw invalid();
      return {
        id: source[1].toLowerCase(),
        advisoryNumber: adv,
        geometry: geometry(feature.geometry, spec.kind, budget),
        tauHours: number(p.tau, 0, 168),
        windKt: number(p.maxwind, 0, 300),
        gustKt: number(p.gust, 0, 350),
      };
    });
  });
  return storms.map((storm) => {
    const groups = parsed.map((items) =>
      items.filter(
        (item) =>
          item.id === storm.id && item.advisoryNumber === storm.advisoryNumber,
      ),
    );
    if (groups[1].length > 1 || groups[2].length > 1) throw invalid();
    if (!groups[0].length || groups[1].length !== 1 || groups[2].length !== 1)
      return storm;
    const taus = new Set();
    const forecastPoints = groups[0]
      .map((item) => {
        if (item.tauHours === null || taus.has(item.tauHours)) throw invalid();
        taus.add(item.tauHours);
        return {
          position: position(item.geometry.coordinates),
          tauHours: item.tauHours,
          windKt: item.windKt,
          gustKt: item.gustKt,
        };
      })
      .sort((a, b) => a.tauHours - b.tauHours);
    return {
      ...storm,
      geometryStatus: 'current',
      geometryAdvisoryNumber: storm.advisoryNumber,
      forecastPoints,
      track: groups[1][0].geometry,
      cone: groups[2][0].geometry,
    };
  });
}

async function readTextCapped(response, maxBytes) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    try {
      await response.body?.cancel();
    } catch {
      /* no-op */
    }
    throw new Error('cyclone_upstream_too_large');
  }
  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes)
      throw new Error('cyclone_upstream_too_large');
    return text;
  }
  const decoder = new TextDecoder();
  let out = '';
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        /* no-op */
      }
      throw new Error('cyclone_upstream_too_large');
    }
    out += decoder.decode(value, { stream: true });
  }
  return out + decoder.decode();
}

async function upstreamJson(url, cap) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'error',
      headers: {
        Accept: 'application/geo+json,application/json',
        'User-Agent': USER_AGENT,
      },
    });
    if (!response.ok) {
      try {
        await response.body?.cancel();
      } catch {
        /* no-op */
      }
      throw new Error('cyclone_upstream_unavailable');
    }
    return JSON.parse(await readTextCapped(response, cap));
  } finally {
    clearTimeout(timer);
  }
}

async function refreshSnapshot(nowMs) {
  let storms = parseCycloneStatus(
    await upstreamJson(STATUS_URL, 128 * 1024),
    nowMs,
  );
  if (storms.length) {
    try {
      const results = await Promise.allSettled(
        LAYERS.map(async (spec) => {
          const url = new URL(`${GIS}/${spec.id}/query`);
          url.search = new URLSearchParams({
            where: '1=1',
            outFields:
              spec.kind === 'points'
                ? 'idp_source,advisnum,tau,maxwind,gust'
                : 'idp_source,advisnum',
            outSR: '4326',
            resultRecordCount: String(spec.count),
            geometryPrecision: '4',
            f: 'geojson',
          }).toString();
          return upstreamJson(url.href, spec.cap);
        }),
      );
      if (results.some((result) => result.status === 'rejected'))
        throw invalid();
      storms = attachCycloneGeometry(
        storms,
        results.map((result) => result.value),
      );
    } catch {
      storms = storms.map((storm) => ({
        ...storm,
        geometryStatus: 'unavailable',
      }));
    }
  }
  return { storms, fetchedAt: nowMs };
}

function describe(value, stale = false) {
  return {
    schemaVersion: 1,
    source: 'NOAA NHC / CPHC',
    attribution:
      'NOAA/NWS National Hurricane Center / Central Pacific Hurricane Center',
    coverage: COVERAGE,
    fetchedAt: value?.fetchedAt ?? null,
    stale: stale || !value,
    unavailable: !value,
    reason: !value
      ? 'Cyclone data unavailable'
      : stale
        ? 'Cached cyclone advisory; upstream unavailable'
        : null,
    storms: value?.storms ?? [],
  };
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': status === 200 ? 'public, max-age=60' : 'no-store',
    },
  });
}

/**
 * Handle GET /api/cyclones — shared by the Pages `_worker.js`.
 * `ctx.waitUntil` finishes the edge-cache write after responding.
 */
export async function handleCycloneRequest(request, ctx) {
  const url = new URL(request.url);
  if (request.method !== 'GET')
    return jsonResponse({ error: 'method_not_allowed' }, 405);
  const path = url.pathname.replace(/^\/api\/cyclones/, '') || '/';
  if (path !== '/' || url.search)
    return jsonResponse({ error: 'invalid_cyclone_query' }, 400);
  const cache = caches.default;
  const cacheKey = new Request(`${url.origin}/api/cyclones`, { method: 'GET' });
  const nowMs = Date.now();
  const cached = await cache.match(cacheKey);
  if (cached) {
    try {
      const payload = await cached.json();
      if (
        Number.isFinite(payload?.fetchedAt) &&
        nowMs - payload.fetchedAt < FRESH_MS
      )
        return jsonResponse(describe(payload));
    } catch {
      /* fall through to refresh */
    }
  }
  try {
    const snapshot = await refreshSnapshot(nowMs);
    const response = jsonResponse(describe(snapshot));
    const put = cache.put(cacheKey, response.clone()).catch(() => {});
    if (ctx?.waitUntil) ctx.waitUntil(put);
    else await put.catch(() => {});
    return response;
  } catch {
    // Serve a stale snapshot (<= 12 h, advisories still current) before
    // admitting defeat — matches the dev middleware's honesty contract.
    if (cached) {
      try {
        const payload = await cached.json();
        const usable =
          Number.isFinite(payload?.fetchedAt) &&
          nowMs - payload.fetchedAt <= STALE_MS &&
          Array.isArray(payload?.storms) &&
          payload.storms.every(
            (storm) => nowMs - Date.parse(storm.issuedAt) <= STALE_MS,
          );
        if (usable) return jsonResponse(describe(payload, true));
      } catch {
        /* fall through */
      }
    }
    return jsonResponse(describe(null));
  }
}
