/**
 * Key-gated layer proxies for Cloudflare Workers / Pages `_worker.js`.
 *
 * Serves:
 *   GET  /api/tomtom/status                  — {hasKey, ...}
 *   GET  /api/tomtom/flow/{z}/{x}/{y}.pbf    — TomTom traffic vector tiles
 *   GET  /api/firms                          — NASA FIRMS active fires (24 h)
 *   GET  /api/firms/status                   — {hasKey, ...}
 *   GET  /api/google/nearby-places?lat=&lon=[&radiusM=]
 *   GET  /api/google/text-search?q=[&lat=&lon=&radiusM=]
 *   POST /api/openai/hud-summary             — 5-word HUD summary
 *
 * Keys come from worker secrets (env), never from the client:
 *   TOMTOM_API_KEY, FIRMS_MAP_KEY,
 *   GOOGLE_MAPS_SERVER_API_KEY (or GOOGLE_MAPS_API_KEY),
 *   OPENAI_API_KEY (OPENAI_HUD_SUMMARY_MODEL optional).
 *
 * Missing key → honest 503 {error:'no_key'} (or the UI's keyless contract
 * where the dev used one: Google places → 200 {configured:false}).
 * The key is never echoed in responses, errors, or logs.
 *
 * Workers-safe: no node: imports, no fs, no Buffer, no process.env.
 */

// ---------- shared ----------

const FETCH_TIMEOUT_MS = 30_000;
const USER_AGENT = 'gods-eye-view-keyed/1.0';

function jsonResponse(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

async function readTextCapped(response, maxBytes) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes)
      throw new Error('keyed_upstream_too_large');
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
      try { await reader.cancel(); } catch { /* no-op */ }
      throw new Error('keyed_upstream_too_large');
    }
    out += decoder.decode(value, { stream: true });
  }
  return out + decoder.decode();
}

async function upstreamText(url, { cap, method = 'GET', body = null, headers = {}, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method, body, signal: controller.signal, redirect: 'error',
      headers: { 'User-Agent': USER_AGENT, ...headers },
    });
    if (!response.ok) {
      const error = new Error(`upstream HTTP ${response.status}`);
      error.status = response.status;
      try { await response.body?.cancel(); } catch { /* no-op */ }
      throw error;
    }
    return readTextCapped(response, cap);
  } finally {
    clearTimeout(timer);
  }
}

async function upstreamBytes(url, { cap, headers = {} } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal, redirect: 'error',
      headers: { 'User-Agent': USER_AGENT, ...headers },
    });
    if (!response.ok) {
      const error = new Error(`upstream HTTP ${response.status}`);
      error.status = response.status;
      try { await response.body?.cancel(); } catch { /* no-op */ }
      throw error;
    }
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > cap) {
        try { await reader.cancel(); } catch { /* no-op */ }
        throw new Error('keyed_upstream_too_large');
      }
      chunks.push(value);
    }
    return { bytes: chunks, contentType: response.headers.get('content-type') };
  } finally {
    clearTimeout(timer);
  }
}

// ---------- TomTom traffic ----------

const TOMTOM_TILE_TTL_MS = 300_000;
const TOMTOM_TILE_CAP = 2 * 1024 * 1024;

function isValidTile(z, x, y) {
  return (
    Number.isInteger(z) && Number.isInteger(x) && Number.isInteger(y) &&
    z >= 0 && z <= 22 && x >= 0 && y >= 0 && x < 2 ** z && y < 2 ** z
  );
}

async function handleTomTom(url, env, cache, ctx) {
  const key = String(env.TOMTOM_API_KEY || '').trim();
  const path = url.pathname.replace(/\/+$/, '');

  if (path === '/api/tomtom/status') {
    return jsonResponse({ hasKey: Boolean(key), source: 'tomtom' }, 200, {
      'Cache-Control': 'no-store',
    });
  }
  const m = path.match(/^\/api\/tomtom\/flow\/(\d+)\/(\d+)\/(\d+)\.pbf$/);
  if (!m) return jsonResponse({ error: 'not_found' }, 404);
  const z = Number(m[1]), x = Number(m[2]), y = Number(m[3]);
  if (!isValidTile(z, x, y)) return jsonResponse({ error: 'invalid_tile' }, 400);
  if (!key) return jsonResponse({ error: 'no_key' }, 503);

  const cacheKey = new Request(`${url.origin}/api/tomtom/flow/${z}/${x}/${y}.pbf`, { method: 'GET' });
  const cached = await cache.match(cacheKey);
  if (cached) {
    const fetchedAt = Number(cached.headers.get('x-keyed-fetched-at'));
    if (Number.isFinite(fetchedAt) && Date.now() - fetchedAt < TOMTOM_TILE_TTL_MS)
      return cached;
  }
  try {
    const { bytes, contentType } = await upstreamBytes(
      `https://api.tomtom.com/traffic/map/4/tile/flow/relative/${z}/${x}/${y}.pbf?key=${encodeURIComponent(key)}`,
      { cap: TOMTOM_TILE_CAP },
    );
    const body = new Blob(bytes, { type: contentType || 'application/x-protobuf' });
    const response = new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'application/x-protobuf',
        'Cache-Control': 'no-store',
        'x-keyed-fetched-at': String(Date.now()),
        'x-tomtom-cache': 'MISS',
      },
    });
    const put = cache.put(cacheKey, response.clone()).catch(() => {});
    if (ctx?.waitUntil) ctx.waitUntil(put);
    return response;
  } catch (error) {
    if (cached) {
      const headers = new Headers(cached.headers);
      headers.set('x-tomtom-cache', 'STALE');
      return new Response(cached.body, { status: cached.status, headers });
    }
    return jsonResponse({ error: 'traffic_unavailable' }, error?.status === 429 ? 429 : 502);
  }
}

// ---------- NASA FIRMS ----------

const FIRMS_SOURCES = ['VIIRS_NOAA20_NRT', 'VIIRS_NOAA21_NRT', 'VIIRS_SNPP_NRT', 'MODIS_NRT'];
const FIRMS_TTL_MS = 900_000;
const FIRMS_CAP = 64 * 1024 * 1024;
const FIRMS_WINDOW_MS = 24 * 3600_000;
const FIRMS_SLACK_MS = 2 * 3600_000;

// Ported from src/data/firmsCsv.js (pure functions).
function firmsCell(parts, i) {
  return i == null || i >= parts.length ? '' : String(parts[i]).trim();
}
function firmsFiniteOrZero(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function parseFirmsCsv(text) {
  if (!/latitude/i.test(text.slice(0, 2000))) return null;
  const lines = text.split('\n');
  let hi = 0;
  while (hi < lines.length && !lines[hi].trim()) hi += 1;
  if (hi >= lines.length) return null;
  const header = lines[hi].trim().toLowerCase().split(',').map((f) => f.trim());
  const col = new Map(header.map((name, i) => [name, i]));
  const iLat = col.get('latitude'), iLon = col.get('longitude');
  if (iLat == null || iLon == null) return null;
  const iFrp = col.get('frp'), iConf = col.get('confidence');
  const iBri = col.get('bright_ti4') ?? col.get('brightness');
  const iBri5 = col.get('bright_ti5') ?? col.get('bright_t31');
  const iDn = col.get('daynight'), iDate = col.get('acq_date'), iTime = col.get('acq_time');
  const iSat = col.get('satellite'), iInst = col.get('instrument');
  const records = [];
  for (let i = hi + 1; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    const parts = line.split(',');
    if (parts.length < header.length) continue;
    const lat = Number(parts[iLat]), lon = Number(parts[iLon]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    records.push({
      lat, lon,
      frp: firmsFiniteOrZero(parts[iFrp]),
      confidence: firmsCell(parts, iConf),
      brightness: firmsFiniteOrZero(parts[iBri]),
      brightnessTi5: firmsFiniteOrZero(parts[iBri5]),
      daynight: firmsCell(parts, iDn),
      acqDate: firmsCell(parts, iDate),
      acqTime: firmsCell(parts, iTime),
      satellite: firmsCell(parts, iSat),
      instrument: firmsCell(parts, iInst),
    });
  }
  return records;
}
function acquisitionMsUtc(acqDate, acqTime) {
  if (typeof acqDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(acqDate)) return NaN;
  const t = String(acqTime ?? '').trim();
  if (!/^\d{1,4}$/.test(t)) return NaN;
  const hhmm = t.padStart(4, '0');
  const ms = Date.UTC(
    Number(acqDate.slice(0, 4)), Number(acqDate.slice(5, 7)) - 1, Number(acqDate.slice(8, 10)),
    Number(hhmm.slice(0, 2)), Number(hhmm.slice(2, 4)),
  );
  return Number.isFinite(ms) ? ms : NaN;
}
function filterTrailing24h(records, nowMs) {
  if (!Array.isArray(records) || !Number.isFinite(nowMs)) return [];
  const oldest = nowMs - FIRMS_WINDOW_MS, newest = nowMs + FIRMS_SLACK_MS;
  const memo = new Map();
  return records.filter((r) => {
    const k = `${r.acqDate}:${r.acqTime}`;
    let ms = memo.get(k);
    if (ms === undefined) { ms = acquisitionMsUtc(r.acqDate, r.acqTime); memo.set(k, ms); }
    return Number.isFinite(ms) && ms >= oldest && ms <= newest;
  });
}

async function handleFirms(url, env, cache, ctx) {
  const key = String(env.FIRMS_MAP_KEY || '').trim();
  const path = url.pathname.replace(/\/+$/, '');
  if (path === '/api/firms/status') {
    return jsonResponse({ hasKey: Boolean(key), source: 'firms' }, 200, { 'Cache-Control': 'no-store' });
  }
  if (path !== '/api/firms') return jsonResponse({ error: 'not_found' }, 404);
  if (!key) return jsonResponse({ error: 'no_key' }, 503);

  const cacheKey = new Request(`${url.origin}/api/firms`, { method: 'GET' });
  const cached = await cache.match(cacheKey);
  const freshEnough = (r) => {
    if (!r) return false;
    const at = Number(r.headers.get('x-keyed-fetched-at'));
    return Number.isFinite(at) && Date.now() - at < FIRMS_TTL_MS;
  };
  if (freshEnough(cached)) return cached;

  try {
    const now = Date.now();
    const sources = [];
    const fires = [];
    for (const source of FIRMS_SOURCES) {
      try {
        const text = await upstreamText(
          `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${encodeURIComponent(key)}/${source}/world/2`,
          { cap: FIRMS_CAP, timeoutMs: 60_000 },
        );
        const records = parseFirmsCsv(text);
        if (!records) throw new Error('non-CSV upstream response');
        const recent = filterTrailing24h(records, now);
        for (const r of recent) fires.push(r);
        sources.push({ source, count: recent.length, ok: true });
      } catch {
        sources.push({ source, count: 0, ok: false });
      }
    }
    if (!sources.some((s) => s.ok)) throw new Error('all FIRMS sources failed');
    const payload = {
      fetchedAt: now, stale: false, ttlMs: FIRMS_TTL_MS,
      sources, count: fires.length,
      fires: filterTrailing24h(fires, Date.now()),
    };
    const response = jsonResponse(payload, 200, {
      'Cache-Control': 'no-store',
      'x-keyed-fetched-at': String(now),
    });
    const put = cache.put(cacheKey, response.clone()).catch(() => {});
    if (ctx?.waitUntil) ctx.waitUntil(put);
    return response;
  } catch {
    if (cached) {
      const headers = new Headers(cached.headers);
      headers.set('x-data-stale', 'true');
      return new Response(cached.body, { status: cached.status, headers });
    }
    return jsonResponse({ error: 'firms_unavailable' }, 502);
  }
}

// ---------- Google Places ----------

function googleKey(env) {
  return (
    String(env.GOOGLE_MAPS_SERVER_API_KEY || '').trim() ||
    String(env.GOOGLE_MAPS_API_KEY || '').trim()
  );
}

async function handleGoogle(request, url, env) {
  const key = googleKey(env);
  const path = url.pathname;
  const noStore = { 'Cache-Control': 'no-store' };

  if (path === '/api/google/nearby-places') {
    if (request.method !== 'GET')
      return jsonResponse({ error: 'Method not allowed', places: [] }, 405, noStore);
    if (!key) return jsonResponse({ configured: false, error: null, places: [] }, 200, noStore);
    const lat = Number(url.searchParams.get('lat'));
    const lon = Number(url.searchParams.get('lon'));
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180)
      return jsonResponse({ error: 'invalid coordinates', places: [] }, 400, noStore);
    const radiusM = Math.max(25, Math.min(5000, Number(url.searchParams.get('radiusM')) || 250));
    try {
      const upstream = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
        method: 'POST',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': key,
          'X-Goog-FieldMask': 'places.id,places.displayName,places.location,places.types,places.rating',
        },
        body: JSON.stringify({
          locationRestriction: {
            circle: { center: { latitude: lat, longitude: lon }, radius: radiusM },
          },
          maxResultCount: 20,
        }),
      });
      if (!upstream.ok) throw new Error(`upstream HTTP ${upstream.status}`);
      const data = await upstream.json();
      return jsonResponse({ configured: true, error: null, places: data.places || [] }, 200, noStore);
    } catch {
      return jsonResponse({ configured: true, error: 'places_unavailable', places: [] }, 502, noStore);
    }
  }

  if (path === '/api/google/text-search') {
    if (request.method !== 'GET')
      return jsonResponse({ error: 'Method not allowed', places: [] }, 405, noStore);
    if (!key) return jsonResponse({ configured: false, error: null, places: [] }, 200, noStore);
    const q = String(url.searchParams.get('q') || '').trim().slice(0, 200);
    if (!q) return jsonResponse({ error: 'missing query', places: [] }, 400, noStore);
    const lat = Number(url.searchParams.get('lat'));
    const lon = Number(url.searchParams.get('lon'));
    const radiusM = Math.max(100, Math.min(50000, Number(url.searchParams.get('radiusM')) || 4000));
    const body = { textQuery: q, maxResultCount: 10 };
    if (Number.isFinite(lat) && Number.isFinite(lon))
      body.locationBias = { circle: { center: { latitude: lat, longitude: lon }, radius: radiusM } };
    try {
      const upstream = await fetch('https://places.googleapis.com/v1/places:searchText', {
        method: 'POST',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': key,
          'X-Goog-FieldMask': 'places.id,places.displayName,places.location,places.formattedAddress,places.types',
        },
        body: JSON.stringify(body),
      });
      if (!upstream.ok) throw new Error(`upstream HTTP ${upstream.status}`);
      const data = await upstream.json();
      return jsonResponse({ configured: true, error: null, places: data.places || [] }, 200, noStore);
    } catch {
      return jsonResponse({ configured: true, error: 'places_unavailable', places: [] }, 502, noStore);
    }
  }

  return jsonResponse({ error: 'not_found' }, 404);
}

// ---------- OpenAI HUD summary ----------

const HUD_INSTRUCTIONS =
  'Summarize the provided situational context as a terse heads-up-display line of at most five words. No punctuation flourishes, no emoji.';

function extractOpenAiText(data) {
  if (typeof data?.output_text === 'string' && data.output_text.trim())
    return data.output_text.trim();
  if (!Array.isArray(data?.output)) return '';
  return data.output
    .flatMap((item) => (Array.isArray(item?.content) ? item.content : []))
    .map((part) => part?.text || part?.output_text || '')
    .join(' ')
    .trim();
}

function toFiveWords(value) {
  return String(value || '')
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 5)
    .join(' ');
}

async function handleHudSummary(request, env) {
  const noStore = { 'Cache-Control': 'no-store' };
  if (request.method !== 'POST')
    return jsonResponse({ error: 'Method not allowed' }, 405, noStore);
  const apiKey = String(env.OPENAI_API_KEY || '').trim();
  if (!apiKey)
    return jsonResponse({ summary: null, configured: false }, 200, {
      ...noStore,
      'Content-Type': 'application/json; charset=utf-8',
    });
  try {
    const raw = await request.text();
    if (raw.length > 64 * 1024) return jsonResponse({ error: 'payload too large' }, 413, noStore);
    const context = JSON.parse(raw || '{}');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let upstream;
    try {
      upstream = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: String(env.OPENAI_HUD_SUMMARY_MODEL || 'gpt-4o-mini').trim() || 'gpt-4o-mini',
          instructions: HUD_INSTRUCTIONS,
          input: JSON.stringify(context),
          reasoning: { effort: 'minimal' },
          max_output_tokens: 100,
        }),
      });
    } finally {
      clearTimeout(timer);
    }
    const data = await upstream.json().catch(() => ({}));
    const summary = toFiveWords(extractOpenAiText(data));
    if (!upstream.ok || !summary)
      return jsonResponse({ summary: null, error: 'OpenAI HUD summary request failed' }, upstream.ok ? 502 : upstream.status, noStore);
    return jsonResponse({ summary, error: null }, 200, {
      ...noStore,
      'Content-Type': 'application/json; charset=utf-8',
    });
  } catch {
    return jsonResponse({ summary: null, error: 'OpenAI HUD summary request failed' }, 502, noStore);
  }
}

// ---------- dispatch ----------

export async function handleKeyedRequest(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;
  const cache = caches.default;
  try {
    if (path === '/api/tomtom/status' || path.startsWith('/api/tomtom/flow/'))
      return handleTomTom(url, env, cache, ctx);
    if (path === '/api/firms' || path === '/api/firms/status')
      return handleFirms(url, env, cache, ctx);
    if (path === '/api/google/nearby-places' || path === '/api/google/text-search')
      return handleGoogle(request, url, env);
    if (path === '/api/openai/hud-summary')
      return handleHudSummary(request, env);
    return jsonResponse({ error: 'not_found' }, 404);
  } catch {
    return jsonResponse({ error: 'unavailable' }, 502);
  }
}
