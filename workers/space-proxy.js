/**
 * Space data proxy for Cloudflare Workers / Pages `_worker.js`.
 *
 * Serves:
 *   GET /api/celestrak/{group} — CelesTrak TLE sets (text/plain), 6 h edge
 *                                 cache, stale-served on upstream failure.
 *   GET /api/launches           — Launch Library 2 upcoming/recent launches
 *                                 (JSON), 15 min edge cache.
 *
 * Both upstreams are keyless and free. CelesTrak 403s requests without a
 * descriptive User-Agent, so one is always sent.
 *
 * Workers-safe: no node: imports, no fs, no Buffer, no process.env.
 */

const CELESTRAK_TLE = (group) =>
  `https://celestrak.org/NORAD/elements/gp.php?GROUP=${group}&FORMAT=tle`;
const LAUNCHES_URL = () => {
  const end = new Date();
  const start = new Date(end.getTime() - 30 * 86400000);
  const url = new URL('https://ll.thespacedevs.com/2.3.0/launches/');
  url.searchParams.set('net__gte', start.toISOString());
  url.searchParams.set('net__lte', end.toISOString());
  url.searchParams.set('limit', '100');
  url.searchParams.set('mode', 'detailed');
  return url.toString();
};

const TLE_CACHE_MS = 6 * 3600_000;
const LAUNCHES_CACHE_MS = 15 * 60_000;
const FETCH_TIMEOUT_MS = 20_000;
const TLE_CAP = 4 * 1024 * 1024;
const LAUNCHES_CAP = 2 * 1024 * 1024;
const USER_AGENT =
  'gods-eye-view-celestrak-proxy/1.0 (+https://github.com/bilawalsidhu/gods-eye-view)';

async function readTextCapped(response, maxBytes) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    try { await response.body?.cancel(); } catch { /* no-op */ }
    throw new Error('space_upstream_too_large');
  }
  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes)
      throw new Error('space_upstream_too_large');
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
      throw new Error('space_upstream_too_large');
    }
    out += decoder.decode(value, { stream: true });
  }
  return out + decoder.decode();
}

async function upstreamText(url, cap, accept = '*/*') {
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
    return readTextCapped(response, cap);
  } finally {
    clearTimeout(timer);
  }
}

async function freshOrStale(cache, key, ttlMs, fetcher, contentType) {
  const cached = await cache.match(key);
  if (cached) {
    const fetchedAt = Number(cached.headers.get('x-space-fetched-at'));
    if (Number.isFinite(fetchedAt) && Date.now() - fetchedAt < ttlMs)
      return { response: cached, stale: false };
  }
  try {
    const body = await fetcher();
    const response = new Response(body, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'no-store',
        'x-space-fetched-at': String(Date.now()),
        'x-space-cache': cached ? 'STALE-REFRESHED' : 'MISS',
      },
    });
    const put = cache.put(key, response.clone()).catch(() => {});
    return { response, stale: false, put };
  } catch (error) {
    if (cached) {
      const headers = new Headers(cached.headers);
      headers.set('x-space-cache', 'STALE');
      return { response: new Response(cached.body, { status: cached.status, headers }), stale: true };
    }
    throw error;
  }
}

export async function handleSpaceRequest(request, ctx) {
  const url = new URL(request.url);
  if (request.method !== 'GET')
    return new Response(JSON.stringify({ error: 'method_not_allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  const cache = caches.default;
  const path = url.pathname;

  try {
    // ---- CelesTrak TLE ----
    if (path === '/api/celestrak' || path.startsWith('/api/celestrak/')) {
      const group = path.replace(/^\/api\/celestrak\/?/, '').split('?')[0];
      if (!/^[a-z0-9-]+$/i.test(group) || group.length > 40)
        return new Response('invalid group', { status: 400 });
      const key = new Request(`${url.origin}/api/celestrak/${group.toLowerCase()}`, { method: 'GET' });
      const result = await freshOrStale(cache, key, TLE_CACHE_MS, async () => {
        const body = await upstreamText(CELESTRAK_TLE(encodeURIComponent(group)), TLE_CAP, 'text/plain');
        if (!/^1 /m.test(body)) throw new Error('no TLE lines in response');
        return body;
      }, 'text/plain; charset=utf-8');
      if (result.put && ctx?.waitUntil) ctx.waitUntil(result.put);
      return result.response;
    }

    // ---- Launch Library 2 ----
    if (path === '/api/launches') {
      const key = new Request(`${url.origin}/api/launches`, { method: 'GET' });
      const result = await freshOrStale(cache, key, LAUNCHES_CACHE_MS, async () => {
        const body = await upstreamText(LAUNCHES_URL(), LAUNCHES_CAP, 'application/json');
        JSON.parse(body); // validate
        return body;
      }, 'application/json');
      if (result.put && ctx?.waitUntil) ctx.waitUntil(result.put);
      return result.response;
    }

    return new Response(JSON.stringify({ error: 'not_found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    const status = error?.status === 429 ? 429 : 502;
    return new Response(
      JSON.stringify({ error: status === 429 ? 'rate limited' : 'space source unavailable' }),
      {
        status,
        headers: {
          'Content-Type': 'application/json',
          ...(status === 429 ? { 'Retry-After': '60' } : {}),
        },
      },
    );
  }
}
