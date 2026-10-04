/**
 * Radio Browser proxy for Cloudflare Workers / Pages `_worker.js`.
 *
 * Serves:
 *   GET  /api/radio/stations       — geo-tagged HTTPS station directory
 *     (top by clickcount, 1 h edge cache, stale-served on failure).
 *   POST /api/radio/click/{uuid}   — click counter passthrough.
 *
 * radio-browser.info is keyless and free. Mirrors are tried in order
 * (de1 → de2 → nl1); DNS-based mirror discovery from the dev server is
 * skipped — the fixed mirrors are the documented fallback set.
 *
 * Workers-safe: no node: imports, no fs, no Buffer, no process.env.
 */

const MIRRORS = [
  'https://de1.api.radio-browser.info',
  'https://de2.api.radio-browser.info',
];
const DIRECTORY_TTL_MS = 3600_000;
const FETCH_TIMEOUT_MS = 15_000;
const DIRECTORY_CAP = 8 * 1024 * 1024;
const USER_AGENT = 'gods-eye-view-radio/1.0';
const RADIO_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cleanText(value, max) {
  const s = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return s.length > max ? s.slice(0, max) : s;
}

function publicHttpsUrl(value) {
  const s = cleanText(value, 500);
  if (!/^https:\/\//i.test(s)) return null;
  try {
    const u = new URL(s);
    if (u.username || u.password || u.port) return null;
    return u.href;
  } catch {
    return null;
  }
}

function normalizeStation(raw) {
  const id = cleanText(raw?.stationuuid, 40).toLowerCase();
  const lat = raw?.geo_lat === null || raw?.geo_lat === '' ? null : Number(raw?.geo_lat);
  const lon = raw?.geo_long === null || raw?.geo_long === '' ? null : Number(raw?.geo_long);
  const codec = cleanText(raw?.codec, 16).toUpperCase();
  const streamUrl = publicHttpsUrl(raw?.url_resolved || raw?.url);
  if (
    !RADIO_UUID_RE.test(id) ||
    Number(raw?.lastcheckok) !== 1 ||
    Number(raw?.hls) === 1 ||
    !Number.isFinite(lat) || lat < -90 || lat > 90 ||
    !Number.isFinite(lon) || lon < -180 || lon > 180 ||
    !/^(?:MP3|AAC(?:\+|-LC|-HE)?|HE-AAC)$/i.test(codec) ||
    !streamUrl
  )
    return null;
  const name = cleanText(raw?.name, 140);
  if (!name) return null;
  return {
    id,
    name,
    lat,
    lon,
    streamUrl,
    homepage: publicHttpsUrl(raw?.homepage),
    tags: String(raw?.tags ?? '')
      .split(',')
      .map((t) => cleanText(t, 80).toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .filter((t, i, all) => all.indexOf(t) === i)
      .slice(0, 24),
    languages: String(raw?.language ?? '')
      .split(',')
      .map((l) => cleanText(l, 40))
      .filter(Boolean)
      .slice(0, 8),
    state: cleanText(raw?.state, 80),
    country: cleanText(raw?.country, 80),
    countryCode: cleanText(raw?.countrycode, 2).toUpperCase(),
    metadataTrust: 'untrusted-community',
    codec,
    bitrate: (() => {
      const b = Number(raw?.bitrate);
      return Number.isInteger(b) && b >= 8 && b <= 1024 ? b : null;
    })(),
  };
}

async function readJsonCapped(response, maxBytes) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes)
      throw new Error('radio_upstream_too_large');
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
      throw new Error('radio_upstream_too_large');
    }
    out += decoder.decode(value, { stream: true });
  }
  return JSON.parse(out + decoder.decode());
}

async function mirrorFetch(path, { method = 'GET', cap = DIRECTORY_CAP } = {}) {
  let lastError = null;
  for (const mirror of MIRRORS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(mirror + path, {
        method,
        signal: controller.signal,
        redirect: 'error',
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      });
      if (!response.ok) {
        lastError = new Error(`mirror HTTP ${response.status}`);
        lastError.status = response.status;
        try { await response.body?.cancel(); } catch { /* no-op */ }
        continue;
      }
      return await readJsonCapped(response, cap);
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new Error('all mirrors failed');
}

export async function handleRadioRequest(request, ctx) {
  const url = new URL(request.url);
  const cache = caches.default;
  const path = url.pathname;

  try {
    if (path === '/api/radio/stations' && request.method === 'GET') {
      const key = new Request(`${url.origin}/api/radio/stations`, { method: 'GET' });
      const cached = await cache.match(key);
      if (cached) {
        const fetchedAt = Number(cached.headers.get('x-radio-fetched-at'));
        if (Number.isFinite(fetchedAt) && Date.now() - fetchedAt < DIRECTORY_TTL_MS)
          return cached;
      }
      try {
        const params = new URLSearchParams({
          has_geo_info: 'true',
          is_https: 'true',
          hidebroken: 'true',
          order: 'clickcount',
          reverse: 'true',
          limit: '500',
        });
        const rows = await mirrorFetch(`/json/stations/search?${params}`);
        if (!Array.isArray(rows)) throw new Error('bad directory payload');
        const stations = rows.map(normalizeStation).filter(Boolean);
        const response = new Response(
          JSON.stringify({ stations, fetchedAt: Date.now() }),
          {
            status: 200,
            headers: {
              'Content-Type': 'application/json',
              'Cache-Control': 'no-store',
              'x-radio-fetched-at': String(Date.now()),
            },
          },
        );
        const put = cache.put(key, response.clone()).catch(() => {});
        if (ctx?.waitUntil) ctx.waitUntil(put);
        return response;
      } catch (error) {
        if (cached) {
          const headers = new Headers(cached.headers);
          headers.set('x-data-stale', 'true');
          return new Response(cached.body, { status: cached.status, headers });
        }
        throw error;
      }
    }

    const clickMatch = path.match(/^\/api\/radio\/click\/([0-9a-f-]{36})$/i);
    if (clickMatch && request.method === 'POST') {
      const id = clickMatch[1].toLowerCase();
      if (!RADIO_UUID_RE.test(id))
        return new Response(JSON.stringify({ error: 'invalid id' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      await mirrorFetch(`/json/url/${id}`, { cap: 64 * 1024 });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
    }

    return new Response(JSON.stringify({ error: 'not_found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch {
    return new Response(JSON.stringify({ error: 'radio_unavailable' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
