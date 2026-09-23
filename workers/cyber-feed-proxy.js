/**
 * Cyber Intel live threat-feed proxy.
 *
 * A Cloudflare Worker (and Pages `_worker.js`) module that serves
 * `GET /api/cyber-feed` by aggregating KEYLESS, no-signup threat-intel
 * feeds and returning them in the exact event schema the cyber layer's
 * `normalizeCyberEvents()` (src/layers/cyber/records.js) accepts — so the
 * in-app live feed (`src/layers/cyber/liveFeed.js`) can consume the
 * response with zero translation:
 *
 *   { id, src: {country, code, lat, lon, city?, region?, isp?, org?, asn?},
 *     dst: {...},
 *     type: 'ddos'|'malware'|'intrusion'|'phishing'|'scan'|'c2',
 *     severity: 1-5, ts: epochMs }
 *
 * Why the proxy exists: the upstream feeds either omit CORS headers or
 * rate-limit aggressively, so browsers cannot call them directly.
 *
 * Upstream sources (all keyless — this module uses NO secrets):
 *   - CINS Army "badguys" list  (https://cinsscore.com/list/ci-badguys.txt)
 *       IPs with recently observed malicious activity        → intrusion
 *   - blocklist.de "all" list    (https://lists.blocklist.de/lists/all.txt)
 *       IPs reported for attacks (brute-force/scans, 48h)    → scan
 *   - Spamhaus DROP v4           (https://www.spamhaus.org/drop/drop_v4.json)
 *       hijacked / spam-operation netblocks (representative IP per CIDR)
 *                                                            → intrusion
 *   - OpenPhish public feed      (https://openphish.com/feed.txt)
 *       live phishing URLs                                   → phishing
 *
 * GeoIP: ip-api.com batch endpoint (free, keyless, 45 req/min). One batch
 * request (≤100 IPs) per proxy call, and the assembled response is cached
 * at the edge for 60 s — so upstream sees at most ~1 request/min per PoP.
 * The batch asks for city, regionName, isp, org, and as (ASN) in addition
 * to country/coordinates; those ride on the src endpoint as
 * city/region/isp/org/asn for the click-to-inspect panel.
 *
 * Honesty notes (also documented in docs/CYBER_INTEL.md):
 *   - src for IP indicators is the REAL GeoIP location of that hostile IP.
 *   - dst (the "victim") is NOT known to any feed; it is a deterministic,
 *     hash-based pick from the same 12-hub list the simulator uses — an
 *     approximation, clearly documented.
 *   - OpenPhish gives URLs, not IPs; the batch GeoIP endpoint does not do
 *     DNS, so phishing events get hash-based hub endpoints on both ends
 *     (the real phishing URL is preserved in `ioc`).
 *   - severity is a per-source default (these feeds are unscored), except
 *     where noted.
 *
 * Free-tier safety: Cache API (60 s), per-upstream 9 s timeouts, partial
 * failure tolerated (a dead source contributes zero events, not a 500).
 */

const USER_AGENT = 'gods-eye-view-cyber-layer/1.0 (research feed proxy)';
const CACHE_TTL_SECONDS = 60;
const PER_SOURCE_LIMIT = 30;
const DEFAULT_LIMIT = 96;
const MAX_LIMIT = 200;
const FETCH_TIMEOUT_MS = 9000;
const GEOIP_BATCH_MAX = 100;

/** Major internet hubs — also used as deterministic fallback endpoints. */
const HUBS = [
  { country: 'United States', code: 'US', lat: 38.9072, lon: -77.0369 },
  { country: 'China', code: 'CN', lat: 39.9042, lon: 116.4074 },
  { country: 'Russia', code: 'RU', lat: 55.7558, lon: 37.6173 },
  { country: 'Germany', code: 'DE', lat: 52.52, lon: 13.405 },
  { country: 'United Kingdom', code: 'GB', lat: 51.5074, lon: -0.1278 },
  { country: 'Brazil', code: 'BR', lat: -23.5558, lon: -46.6396 },
  { country: 'India', code: 'IN', lat: 28.6139, lon: 77.209 },
  { country: 'Japan', code: 'JP', lat: 35.6762, lon: 139.6503 },
  { country: 'South Korea', code: 'KR', lat: 37.5665, lon: 126.978 },
  { country: 'Netherlands', code: 'NL', lat: 52.3676, lon: 4.9041 },
  { country: 'Singapore', code: 'SG', lat: 1.3521, lon: 103.8198 },
  { country: 'Australia', code: 'AU', lat: -33.8688, lon: 151.2093 },
];

const SOURCES = [
  {
    key: 'cins',
    url: 'https://cinsscore.com/list/ci-badguys.txt',
    kind: 'ips',
    type: 'intrusion',
    severity: 3,
    ref: 'https://cinsscore.com/',
  },
  {
    key: 'blocklist',
    url: 'https://lists.blocklist.de/lists/all.txt',
    kind: 'ips',
    type: 'scan',
    severity: 2,
    ref: 'https://lists.blocklist.de/',
  },
  {
    key: 'spamhaus',
    url: 'https://www.spamhaus.org/drop/drop_v4.json',
    kind: 'cidr',
    type: 'intrusion',
    severity: 3,
    ref: 'https://www.spamhaus.org/drop/',
  },
  {
    key: 'openphish',
    url: 'https://raw.githubusercontent.com/openphish/public_feed/refs/heads/main/feed.txt',
    kind: 'urls',
    type: 'phishing',
    severity: 3,
    ref: 'https://openphish.com/',
  },
];

/** FNV-1a 32-bit — deterministic hub picks, no Math.random anywhere. */
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function hubFor(seed, excludeCode) {
  let idx = fnv1a(seed) % HUBS.length;
  for (let i = 0; i < HUBS.length; i++) {
    const hub = HUBS[(idx + i) % HUBS.length];
    if (hub.code !== excludeCode) return { ...hub };
  }
  return { ...HUBS[idx] };
}

const IPV4_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/;
function isPublicIpv4(ip) {
  if (!IPV4_RE.test(ip)) return false;
  const o = ip.split('.').map(Number);
  if (o.some((n) => n > 255)) return false;
  const [a, b] = o;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false; // 0/8, 10/8, loopback, multicast+
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 169 && b === 254) return false; // link-local
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
  return true;
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { 'user-agent': USER_AGENT },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`upstream ${res.status} for ${url}`);
  return res.text();
}

function parseIndicators(source, text) {
  const out = [];
  const seen = new Set();
  const push = (kind, value) => {
    if (seen.has(value) || out.length >= PER_SOURCE_LIMIT) return;
    seen.add(value);
    out.push({ kind, value });
  };
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (source.kind === 'ips') {
      const ip = line.split(/\s+/)[0];
      if (isPublicIpv4(ip)) push('ip', ip);
    } else if (source.kind === 'cidr') {
      try {
        const cidr = JSON.parse(line).cidr;
        const ip = String(cidr || '').split('/')[0];
        if (isPublicIpv4(ip)) push('ip', ip);
      } catch {
        /* skip malformed NDJSON lines */
      }
    } else if (source.kind === 'urls') {
      if (/^https?:\/\/[^/\s]+\//i.test(line)) push('url', line);
    }
    if (out.length >= PER_SOURCE_LIMIT) break;
  }
  return out;
}

async function geoipBatch(ips) {
  const map = new Map();
  const batch = ips.slice(0, GEOIP_BATCH_MAX);
  if (batch.length === 0) return map;
  const res = await fetch('http://ip-api.com/batch', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': USER_AGENT,
    },
    body: JSON.stringify(
      batch.map((query) => ({
        query,
        fields:
          'status,message,country,countryCode,lat,lon,query,city,regionName,isp,org,as',
      })),
    ),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`ip-api ${res.status}`);
  const rows = await res.json();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (
      row?.status === 'success' &&
      row.country &&
      row.countryCode &&
      Number.isFinite(row.lat) &&
      Number.isFinite(row.lon)
    ) {
      const endpoint = {
        country: String(row.country),
        code: String(row.countryCode).toUpperCase(),
        lat: row.lat,
        lon: row.lon,
      };
      // City/ISP enrichment is best-effort: only non-empty strings ride
      // along, so clients can render "n/a" honestly when a field is
      // missing. `as` maps to `asn` in the event schema.
      const extras = {
        city: row.city,
        region: row.regionName,
        isp: row.isp,
        org: row.org,
        asn: row.as,
      };
      for (const [key, value] of Object.entries(extras)) {
        if (typeof value === 'string' && value.trim() !== '') {
          endpoint[key] = value.trim();
        }
      }
      map.set(row.query, endpoint);
    }
  }
  return map;
}

function slugify(value) {
  return value.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function buildEvents(perSource, geo, now, limit) {
  const events = [];
  for (const { source, indicators } of perSource) {
    for (const { kind, value } of indicators) {
      if (events.length >= limit) break;
      let src;
      let dst;
      let id;
      if (kind === 'ip') {
        const g = geo.get(value);
        src = g ? { ...g } : hubFor(`src|${value}`);
        dst = hubFor(`dst|${value}`, src.code);
        id = `live-${source.key}-${slugify(value)}`;
      } else {
        src = hubFor(`src|${value}`);
        dst = hubFor(`dst|${value}`, src.code);
        id = `live-${source.key}-${fnv1a(value).toString(36)}`;
      }
      events.push({
        id,
        src,
        dst,
        type: source.type,
        severity: source.severity,
        ts: now,
        // Extra provenance fields — ignored by normalizeCyberEvents().
        ioc: value,
        ref: source.ref,
      });
    }
    if (events.length >= limit) break;
  }
  return events;
}

async function assembleFeed(limit) {
  const now = Date.now();
  const settled = await Promise.allSettled(
    SOURCES.map(async (source) => ({
      source,
      indicators: parseIndicators(source, await fetchText(source.url)),
    })),
  );
  const perSource = [];
  for (const s of settled) {
    if (s.status === 'fulfilled' && s.value.indicators.length > 0) {
      perSource.push(s.value);
    }
  }
  const ips = [
    ...new Set(
      perSource.flatMap(({ indicators }) =>
        indicators.filter((i) => i.kind === 'ip').map((i) => i.value),
      ),
    ),
  ];
  let geo = new Map();
  try {
    geo = await geoipBatch(ips);
  } catch {
    geo = new Map(); // GeoIP is best-effort; hubs cover the rest.
  }
  const events = buildEvents(perSource, geo, now, limit);
  return {
    live: true,
    source: perSource.map(({ source }) => source.key).join(','),
    generated_at: now,
    cache_ttl_s: CACHE_TTL_SECONDS,
    events,
  };
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': `public, max-age=${CACHE_TTL_SECONDS}`,
      'access-control-allow-origin': '*',
    },
  });
}

/**
 * Handle GET /api/cyber-feed — shared by the Pages `_worker.js` and the
 * standalone Worker. `ctx` is optional; when present its `waitUntil` is
 * used to finish the edge-cache write after responding.
 */
export async function handleCyberFeedRequest(request, ctx) {
  const url = new URL(request.url);
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, parseInt(url.searchParams.get('limit') || '', 10) || DEFAULT_LIMIT),
  );
  const cache = caches.default;
  const cacheKey = new Request(`${url.origin}/api/cyber-feed?limit=${limit}`, {
    method: 'GET',
  });
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  let payload;
  try {
    payload = await assembleFeed(limit);
  } catch (err) {
    return jsonResponse(
      {
        live: false,
        source: '',
        generated_at: Date.now(),
        cache_ttl_s: 0,
        events: [],
        error: `feed assembly failed: ${err?.message || err}`,
      },
      502,
    );
  }
  if (payload.events.length === 0) {
    return jsonResponse({ ...payload, live: false, error: 'all upstreams failed' }, 502);
  }
  const response = jsonResponse(payload);
  const put = cache.put(cacheKey, response.clone()).catch(() => {});
  if (ctx?.waitUntil) ctx.waitUntil(put);
  else await put;
  return response;
}

/** Standalone-Worker entrypoint: `wrangler deploy` serves /api/cyber-feed. */
export default {
  async fetch(request, env, ctx) {
    return handleCyberFeedRequest(request, ctx);
  },
};
