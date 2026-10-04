/**
 * Live aircraft proxy for Cloudflare Workers / Pages `_worker.js`.
 *
 * Serves:
 *   GET /api/opensky[?lat=&lon=]  — OpenSky Network states/all (global),
 *                                    60 s edge cache; on 429/5xx/failure with
 *                                    a lat/lon anchor, falls back to the
 *                                    adsb.lol regional point query normalized
 *                                    to the OpenSky state-vector shape.
 *   GET /api/opensky-track?icao24= — OpenSky tracks/all (60 s cache).
 *   GET /api/adsblol/mil           — adsb.lol military aircraft (60 s cache,
 *                                    stale-while-cooldown).
 *   GET /api/adsblol/trace?hex=    — adsb.lol tar1090 track history (5 min).
 *
 * All sources are keyless, no signup. OpenSky anonymous quota is guarded by
 * the edge cache (one upstream fetch per minute per PoP max) plus honest
 * 429 propagation so the UI can show its rate-limit state.
 *
 * Workers-safe: no node: imports, no fs, no Buffer, no process.env.
 *
 * Honesty: the serving source rides on `x-flight-source` /
 * `x-flight-coverage` response headers, which the UI surfaces in the
 * layer panel — an adsb.lol fallback never masquerades as OpenSky.
 */

const OPENSKY_STATES = 'https://opensky-network.org/api/states/all?extended=1';
const OPENSKY_TRACKS = 'https://opensky-network.org/api/tracks/all';
const ADSB_LOL_MIL = 'https://api.adsb.lol/v2/mil';
const ADSB_LOL_POINT_RADIUS_NM = 250;
const FETCH_TIMEOUT_MS = 10_000;
const STATES_CACHE_MS = 60_000;
const TRACK_CACHE_MS = 60_000;
const MIL_CACHE_MS = 60_000;
const TRACE_CACHE_MS = 300_000;
const STATES_CAP = 8 * 1024 * 1024;
const POINT_CAP = 8 * 1024 * 1024;
const MIL_CAP = 2 * 1024 * 1024;
const TRACE_CAP = 5 * 1024 * 1024;
const USER_AGENT = 'gods-eye-view-flights/1.0 (keyless ADS-B proxy)';

// --- pure helpers (ported from src/data/adsbLolFallback.js) ---

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

const KNOT_TO_MPS = 0.514444;
const FOOT_TO_M = 0.3048;
const FPM_TO_MPS = 0.00508;

function emitterCategory(value) {
  const c = String(value || '').trim().toUpperCase();
  return (
    {
      A1: 2, A2: 3, A3: 4, A4: 5, A5: 6, A6: 7, A7: 8,
      B1: 9, B2: 10, B3: 11, B4: 12, B6: 14, B7: 15,
    }[c] || 0
  );
}

export function normalizeAdsbLolAircraftState(aircraft, nowSeconds) {
  const hex = String(aircraft?.hex || '').trim().toLowerCase();
  const latitude = finiteNumber(aircraft?.lat);
  const longitude = finiteNumber(aircraft?.lon);
  if (!hex || latitude === null || longitude === null) return null;
  const seenPosition = Math.max(
    0,
    finiteNumber(aircraft?.seen_pos) ?? finiteNumber(aircraft?.seen) ?? 0,
  );
  const seen = Math.max(0, finiteNumber(aircraft?.seen) ?? seenPosition);
  const onGround = aircraft?.alt_baro === 'ground';
  const barometricFeet = onGround ? null : finiteNumber(aircraft?.alt_baro);
  const geometricFeet = finiteNumber(aircraft?.alt_geom);
  const groundSpeedKnots = finiteNumber(aircraft?.gs);
  const verticalRateFpm =
    finiteNumber(aircraft?.baro_rate) ?? finiteNumber(aircraft?.geom_rate);
  const track = finiteNumber(aircraft?.track);
  return [
    hex,
    String(aircraft?.flight || aircraft?.r || '').trim() || null,
    null,
    Math.max(0, nowSeconds - seenPosition),
    Math.max(0, nowSeconds - seen),
    longitude,
    latitude,
    barometricFeet === null ? null : barometricFeet * FOOT_TO_M,
    onGround,
    groundSpeedKnots === null ? null : groundSpeedKnots * KNOT_TO_MPS,
    track,
    verticalRateFpm === null ? null : verticalRateFpm * FPM_TO_MPS,
    null,
    geometricFeet === null ? null : geometricFeet * FOOT_TO_M,
    aircraft?.squawk || null,
    aircraft?.spi === 1,
    0,
    emitterCategory(aircraft?.category),
  ];
}

export function normalizeAdsbLolPointResponse(payload, nowMs = Date.now()) {
  const responseNow = finiteNumber(payload?.now);
  const nowSeconds =
    responseNow === null
      ? Math.floor(nowMs / 1000)
      : Math.floor(responseNow > 10_000_000_000 ? responseNow / 1000 : responseNow);
  const states = (Array.isArray(payload?.ac) ? payload.ac : [])
    .map((a) => normalizeAdsbLolAircraftState(a, nowSeconds))
    .filter(Boolean);
  return { time: nowSeconds, states };
}

/** Round an anchor to the 0.25° grid so cache keys repeat. */
export function anchorKey(lat, lon) {
  return `${(Math.round(lat * 4) / 4).toFixed(2)},${(Math.round(lon * 4) / 4).toFixed(2)}`;
}

// --- worker I/O ---

async function readJsonCapped(response, maxBytes) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    try { await response.body?.cancel(); } catch { /* no-op */ }
    throw new Error('flights_upstream_too_large');
  }
  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes)
      throw new Error('flights_upstream_too_large');
    return JSON.parse(text);
  }
  const decoder = new TextDecoder();
  let out = '';
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch { /* no-op */ }
      throw new Error('flights_upstream_too_large');
    }
    out += decoder.decode(value, { stream: true });
  }
  return JSON.parse(out + decoder.decode());
}

async function upstreamJson(url, cap, accept = 'application/json') {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'error',
      headers: { Accept: accept, 'User-Agent': USER_AGENT },
    });
    if (!response.ok) {
      const error = new Error(`upstream HTTP ${response.status}`);
      error.status = response.status;
      try { await response.body?.cancel(); } catch { /* no-op */ }
      throw error;
    }
    return { payload: await readJsonCapped(response, cap), response };
  } finally {
    clearTimeout(timer);
  }
}

function jsonResponse(value, status = 200, headers = {}) {
  return new Response(typeof value === 'string' ? value : JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

async function cachedJson(cache, key, ttlMs, producer) {
  const cached = await cache.match(key);
  if (cached) {
    const fetchedAt = Number(cached.headers.get('x-flights-fetched-at'));
    if (Number.isFinite(fetchedAt) && Date.now() - fetchedAt < ttlMs)
      return cached;
  }
  const response = await producer();
  const put = cache.put(key, response.clone()).catch(() => {});
  return { response, put };
}

function withFetchedAt(response) {
  const headers = new Headers(response.headers);
  headers.set('x-flights-fetched-at', String(Date.now()));
  return new Response(response.body, { status: response.status, headers });
}

/**
 * Handle /api/opensky*, /api/adsblol/* — shared by the Pages `_worker.js`.
 */
export async function handleFlightsRequest(request, ctx) {
  const url = new URL(request.url);
  if (request.method !== 'GET')
    return jsonResponse({ error: 'method_not_allowed' }, 405);
  const cache = caches.default;
  const path = url.pathname;

  try {
    // ---- OpenSky states ----
    if (path === '/api/opensky' || path === '/api/opensky/') {
      const lat = url.searchParams.get('lat');
      const lon = url.searchParams.get('lon');
      const anchor =
        lat !== null && lon !== null &&
        Number.isFinite(Number(lat)) && Number.isFinite(Number(lon)) &&
        Math.abs(Number(lat)) <= 90 && Math.abs(Number(lon)) <= 180
          ? { lat: Number(lat), lon: Number(lon) }
          : null;
      const cacheKey = new Request(`${url.origin}/api/opensky`, { method: 'GET' });
      const cached = await cache.match(cacheKey);
      if (cached) {
        const fetchedAt = Number(cached.headers.get('x-flights-fetched-at'));
        if (Number.isFinite(fetchedAt) && Date.now() - fetchedAt < STATES_CACHE_MS)
          return cached;
      }
      try {
        const { payload } = await upstreamJson(OPENSKY_STATES, STATES_CAP);
        if (!Array.isArray(payload?.states)) throw new Error('malformed opensky');
        const response = jsonResponse(payload, 200, {
          'Cache-Control': 'no-store',
          'x-flight-source': 'OpenSky Network',
          'x-flight-coverage': 'worldwide snapshot',
          'x-flights-fetched-at': String(Date.now()),
        });
        const put = cache.put(cacheKey, response.clone()).catch(() => {});
        if (ctx?.waitUntil) ctx.waitUntil(put);
        return response;
      } catch (error) {
        // Rate-limited or down: regional adsb.lol fallback when anchored,
        // stale cache when available, honest 502 otherwise.
        if (anchor) {
          const key = anchorKey(anchor.lat, anchor.lon);
          const fbKey = new Request(`${url.origin}/api/opensky/fb?k=${key}`, { method: 'GET' });
          const fbCached = await cache.match(fbKey);
          if (fbCached) {
            const fetchedAt = Number(fbCached.headers.get('x-flights-fetched-at'));
            if (Number.isFinite(fetchedAt) && Date.now() - fetchedAt < STATES_CACHE_MS)
              return fbCached;
          }
          const [rlat, rlon] = key.split(',').map(Number);
          const { payload } = await upstreamJson(
            `https://api.adsb.lol/v2/lat/${rlat}/lon/${rlon}/dist/${ADSB_LOL_POINT_RADIUS_NM}`,
            POINT_CAP,
          );
          const normalized = normalizeAdsbLolPointResponse(payload);
          const response = jsonResponse(normalized, 200, {
            'Cache-Control': 'no-store',
            'x-flight-source': 'adsb.lol',
            'x-flight-coverage': `regional ~${ADSB_LOL_POINT_RADIUS_NM} NM (OpenSky unavailable)`,
            'x-flights-fetched-at': String(Date.now()),
          });
          const put = cache.put(fbKey, response.clone()).catch(() => {});
          if (ctx?.waitUntil) ctx.waitUntil(put);
          return response;
        }
        if (cached) {
          const headers = new Headers(cached.headers);
          headers.set('x-flight-stale', 'true');
          return new Response(cached.body, { status: cached.status, headers });
        }
        if (error?.status === 429)
          return jsonResponse({ error: 'OpenSky rate limited (anonymous)' }, 429, { 'Retry-After': '60' });
        return jsonResponse({ error: 'flight source unavailable' }, 502);
      }
    }

    // ---- OpenSky track ----
    if (path === '/api/opensky-track') {
      const icao24 = url.searchParams.get('icao24');
      if (!icao24 || !/^[0-9a-fA-F]{6}$/.test(icao24))
        return jsonResponse({ error: 'invalid icao24' }, 400);
      const key = new Request(
        `${url.origin}/api/opensky-track?icao24=${icao24.toLowerCase()}`,
        { method: 'GET' },
      );
      const result = await cachedJson(cache, key, TRACK_CACHE_MS, async () => {
        const { payload } = await upstreamJson(
          `${OPENSKY_TRACKS}?icao24=${icao24.toLowerCase()}&time=0`,
          TRACE_CAP,
        );
        return withFetchedAt(jsonResponse(payload, 200, { 'Cache-Control': 'no-store' }));
      });
      const response = result.response ?? result;
      if (result.put) { if (ctx?.waitUntil) ctx.waitUntil(result.put); }
      return response;
    }

    // ---- adsb.lol military ----
    if (path === '/api/adsblol/mil') {
      const key = new Request(`${url.origin}/api/adsblol/mil`, { method: 'GET' });
      const result = await cachedJson(cache, key, MIL_CACHE_MS, async () => {
        const { payload } = await upstreamJson(ADSB_LOL_MIL, MIL_CAP);
        return withFetchedAt(jsonResponse(payload, 200, {
          'Cache-Control': 'no-store',
          'x-flight-source': 'adsb.lol',
        }));
      });
      const response = result.response ?? result;
      if (result.put) { if (ctx?.waitUntil) ctx.waitUntil(result.put); }
      return response;
    }

    // ---- adsb.lol trace ----
    if (path === '/api/adsblol/trace') {
      const hex = url.searchParams.get('hex');
      if (!hex || !/^[0-9a-fA-F]{6}$/.test(hex))
        return jsonResponse({ error: 'invalid hex' }, 400);
      const lower = hex.toLowerCase();
      const key = new Request(`${url.origin}/api/adsblol/trace?hex=${lower}`, { method: 'GET' });
      const result = await cachedJson(cache, key, TRACE_CACHE_MS, async () => {
        const { payload } = await upstreamJson(
          `https://adsb.lol/data/traces/${lower.slice(-2)}/trace_full_${lower}.json`,
          TRACE_CAP,
        );
        return withFetchedAt(jsonResponse(payload, 200, { 'Cache-Control': 'no-store' }));
      });
      const response = result.response ?? result;
      if (result.put) { if (ctx?.waitUntil) ctx.waitUntil(result.put); }
      return response;
    }

    return jsonResponse({ error: 'not_found' }, 404);
  } catch (error) {
    const status = error?.status === 429 ? 429 : 502;
    return jsonResponse(
      { error: status === 429 ? 'rate limited' : 'flight source unavailable' },
      status,
      status === 429 ? { 'Retry-After': '60' } : {},
    );
  }
}
