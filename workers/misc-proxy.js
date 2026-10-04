/**
 * Misc layer proxies for Cloudflare Workers / Pages `_worker.js`.
 *
 * Serves:
 *   GET /api/route?profile=foot|bike|car&coords=lon,lat;...[&steps=1]
 *     — OSRM routing via routing.openstreetmap.de (keyless). 2–12 coords,
 *       leg/total distance guards, 1 h edge cache.
 *   GET /api/gbfs/<encoded-https-url>
 *     — GBFS bikeshare proxy. Host allowlist + station_information/status
 *       path restriction, no redirects, 5 MB cap.
 *   POST /api/overpass (body: data=<overpass QL>)
 *     — Overpass API proxy (keyless). Query sanitized: single data param,
 *       around-radius cap, bbox cap, no control-flow constructs, 1 MB cap.
 *
 * All sources are keyless and free.
 * Workers-safe: no node: imports, no fs, no Buffer, no process.env.
 */

// ---------- shared ----------

const FETCH_TIMEOUT_MS = 15_000;
const USER_AGENT = 'gods-eye-view-misc/1.0';

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
      throw new Error('misc_upstream_too_large');
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
      throw new Error('misc_upstream_too_large');
    }
    out += decoder.decode(value, { stream: true });
  }
  return out + decoder.decode();
}

async function upstreamText(url, { cap, method = 'GET', body = null, headers = {} } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method,
      body,
      signal: controller.signal,
      redirect: 'error',
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

// ---------- /api/route (OSRM) ----------

const ROUTE_PROFILES = new Set(['foot', 'bike', 'car']);
const ROUTE_MAX_LEG_KM = 200;
const ROUTE_MAX_TOTAL_KM = 2000;
const ROUTE_CACHE_MS = 3600_000;

function haversineKm(lat1, lon1, lat2, lon2) {
  const r = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(a));
}

async function handleRoute(url, cache, ctx) {
  const profile = (url.searchParams.get('profile') || 'foot').toLowerCase();
  if (!ROUTE_PROFILES.has(profile))
    return jsonResponse({ ok: false, error: 'invalid profile' });
  const osrmProfile = profile === 'car' ? 'driving' : profile;
  const pairs = (url.searchParams.get('coords') || '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  if (pairs.length < 2 || pairs.length > 12)
    return jsonResponse({ ok: false, error: 'need 2-12 coordinates' });
  const clean = [];
  const pts = [];
  for (const pr of pairs) {
    const parts = pr.split(',');
    if (parts.length !== 2) return jsonResponse({ ok: false, error: 'invalid coordinate' });
    const lon = Number(parts[0]);
    const lat = Number(parts[1]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lat) > 90 || Math.abs(lon) > 180)
      return jsonResponse({ ok: false, error: 'invalid coordinate' });
    clean.push(`${lon},${lat}`);
    pts.push([lon, lat]);
  }
  let totalKm = 0;
  for (let i = 1; i < pts.length; i++) {
    const legKm = haversineKm(pts[i - 1][1], pts[i - 1][0], pts[i][1], pts[i][0]);
    if (legKm > ROUTE_MAX_LEG_KM) return jsonResponse({ ok: false, error: 'route leg too long' });
    totalKm += legKm;
  }
  if (totalKm > ROUTE_MAX_TOTAL_KM) return jsonResponse({ ok: false, error: 'route too long' });

  const coords = clean.join(';');
  const wantSteps = url.searchParams.get('steps') === '1';
  const key = new Request(
    `${url.origin}/api/route?p=${profile}&c=${encodeURIComponent(coords)}&s=${wantSteps ? 1 : 0}`,
    { method: 'GET' },
  );
  const cached = await cache.match(key);
  if (cached) {
    const fetchedAt = Number(cached.headers.get('x-misc-fetched-at'));
    if (Number.isFinite(fetchedAt) && Date.now() - fetchedAt < ROUTE_CACHE_MS) {
      const payload = await cached.json();
      return jsonResponse(stripSteps(payload, wantSteps));
    }
  }
  const osrmUrl =
    `https://routing.openstreetmap.de/routed-${osrmProfile}/route/v1/${osrmProfile}/` +
    `${coords}?overview=full&geometries=geojson&steps=true`;
  try {
    const payload = JSON.parse(await upstreamText(osrmUrl, { cap: 2 * 1024 * 1024 }));
    const response = jsonResponse(payload, 200, {
      'x-misc-fetched-at': String(Date.now()),
      'Cache-Control': 'no-store',
    });
    const put = cache.put(key, response.clone()).catch(() => {});
    if (ctx?.waitUntil) ctx.waitUntil(put);
    return jsonResponse(stripSteps(payload, wantSteps));
  } catch {
    return jsonResponse({ ok: false, error: 'route unavailable' });
  }
}

function stripSteps(payload, wantSteps) {
  if (wantSteps || !payload || typeof payload !== 'object') return payload;
  const copy = JSON.parse(JSON.stringify(payload));
  for (const route of copy.routes || [])
    for (const leg of route.legs || []) delete leg.steps;
  return copy;
}

// ---------- /api/gbfs/* ----------

const GBFS_ALLOWED_HOSTS = new Set([
  'gbfs.lyft.com',
  'gbfs.bluebikes.com',
  'gbfs.bcycle.com',
  'gbfs.biketownpdx.com',
  'gbfs.cogobikeshare.com',
  'austin.publicbikesystem.net',
  'hon.publicbikesystem.net',
  'chat.publicbikesystem.net',
]);
const GBFS_CAP = 5 * 1024 * 1024;

function isAllowedGbfsHost(hostname) {
  const host = String(hostname || '').trim().toLowerCase();
  if (!host) return false;
  if (GBFS_ALLOWED_HOSTS.has(host)) return true;
  return host.endsWith('.publicbikesystem.net');
}

async function handleGbfs(url) {
  const encodedTarget = url.pathname.replace(/^\/api\/gbfs\/?/, '');
  if (!encodedTarget) return jsonResponse({ error: 'Missing GBFS upstream target' }, 400);
  let target;
  try {
    target = decodeURIComponent(encodedTarget);
  } catch {
    return jsonResponse({ error: 'Bad GBFS target encoding' }, 400);
  }
  let upstreamUrl;
  try {
    upstreamUrl = new URL(target);
  } catch {
    return jsonResponse({ error: 'Bad GBFS target URL' }, 400);
  }
  if (upstreamUrl.protocol !== 'https:')
    return jsonResponse({ error: 'GBFS upstream must be https' }, 400);
  if (!isAllowedGbfsHost(upstreamUrl.hostname))
    return jsonResponse({ error: 'GBFS host not allowed' }, 403);
  if (!/\/station_(information|status)\.json$/i.test(upstreamUrl.pathname))
    return jsonResponse({ error: 'GBFS path not allowed' }, 403);
  try {
    const body = await upstreamText(upstreamUrl.toString(), {
      cap: GBFS_CAP,
      headers: { Accept: 'application/json' },
    });
    JSON.parse(body); // validate
    const isInfo = /\/station_information\.json$/i.test(upstreamUrl.pathname);
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': isInfo ? 'public, max-age=300' : 'no-store',
      },
    });
  } catch {
    return jsonResponse({ error: 'GBFS upstream unavailable' }, 502);
  }
}

// ---------- /api/overpass ----------

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.nchc.org.tw/api/interpreter',
];
const OVERPASS_MAX_AROUND_M = 50_000;
const OVERPASS_MAX_BBOX_DEG = 2;
const OVERPASS_CAP = 1024 * 1024;
const OVERPASS_FORBIDDEN = /\b(foreach|for\s*\(|while|if\s*\(|complete|retro|compare|convert|make\s+\w+\s*->|out\s+meta)\b/i;

function sanitizeOverpass(data) {
  if (!data || !data.trim()) return { ok: false, error: 'Missing Overpass data query' };
  if (data.length > 4000) return { ok: false, error: 'Overpass query too long' };
  const stripped = data.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of stripped.matchAll(/around(?:\.\w+)?:\s*([\d.eE+-]+)/gi)) {
    const radius = Number(m[1]);
    if (!Number.isFinite(radius) || radius > OVERPASS_MAX_AROUND_M)
      return { ok: false, error: 'Overpass around radius too large' };
  }
  for (const m of stripped.matchAll(
    /\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)/g,
  )) {
    if (
      Math.abs(Number(m[3]) - Number(m[1])) > OVERPASS_MAX_BBOX_DEG ||
      Math.abs(Number(m[4]) - Number(m[2])) > OVERPASS_MAX_BBOX_DEG
    )
      return { ok: false, error: 'Overpass bbox too large' };
  }
  if (OVERPASS_FORBIDDEN.test(stripped))
    return { ok: false, error: 'Overpass query construct not allowed' };
  return { ok: true, data };
}

async function handleOverpass(request) {
  if (request.method !== 'POST')
    return jsonResponse({ error: 'method_not_allowed' }, 405);
  const raw = await request.text().catch(() => '');
  let data = null;
  try {
    const params = new URLSearchParams(raw);
    const all = params.getAll('data');
    if (all.length === 1) data = all[0];
  } catch {
    return jsonResponse({ error: 'Malformed query body' }, 400);
  }
  if (data === null)
    return jsonResponse({ error: 'Exactly one data query is required' }, 400);
  const check = sanitizeOverpass(data);
  if (!check.ok) return jsonResponse({ error: check.error }, 400);
  const formBody = new URLSearchParams({ data: check.data }).toString();
  let lastError = null;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const body = await upstreamText(endpoint, {
        cap: OVERPASS_CAP,
        method: 'POST',
        body: formBody,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
      return new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
    } catch (error) {
      lastError = error;
    }
  }
  return jsonResponse({ error: 'Overpass unavailable' }, 502);
}

// ---------- dispatch ----------

export async function handleMiscRequest(request, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;
  try {
    if (path === '/api/route') return handleRoute(url, caches.default, ctx);
    if (path === '/api/gbfs' || path.startsWith('/api/gbfs/')) return handleGbfs(url);
    if (path === '/api/overpass') return handleOverpass(request);
    return jsonResponse({ error: 'not_found' }, 404);
  } catch {
    return jsonResponse({ error: 'unavailable' }, 502);
  }
}
