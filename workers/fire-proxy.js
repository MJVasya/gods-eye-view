/**
 * Fire perimeters proxy for Cloudflare Workers / Pages `_worker.js`.
 *
 * Serves:
 *   GET /api/fire-perimeters                      — NIFC WFIGS current
 *     interagency fire perimeters (GeoJSON via ArcGIS), normalized to the
 *     UI's row shape; 5 min edge cache, stale-served on upstream failure.
 *   GET /api/fire-perimeters/inciweb/index        — InciWeb publication
 *     index (1 h cache).
 *   GET /api/fire-perimeters/inciweb/publication/{id} — InciWeb incident
 *     origin/update times scraped from the incident page (30 min cache).
 *
 * All sources are keyless and free (NIFC ArcGIS, InciWeb).
 * Workers-safe: no node: imports, no fs, no Buffer, no process.env.
 */

const PERIMETERS_URL =
  'https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/' +
  'WFIGS_Interagency_Perimeters_Current/FeatureServer/0/query?' +
  new URLSearchParams({
    where: '1=1',
    outFields: [
      'poly_IncidentName',
      'attr_UniqueFireIdentifier',
      'attr_IncidentSize',
      'attr_PercentContained',
      'attr_POOState',
      'attr_IncidentTypeCategory',
      'attr_FireDiscoveryDateTime',
      'poly_DateCurrent',
      'attr_FireCause',
      'attr_FireBehaviorGeneral',
      'attr_TotalIncidentPersonnel',
      'attr_POOCounty',
      'attr_EstimatedCostToDate',
      'attr_IncidentComplexityLevel',
      'attr_CpxName',
    ].join(','),
    maxAllowableOffset: '0.001',
    outSR: '4326',
    f: 'geojson',
  }).toString();

const INCIWEB_INDEX_URL = 'https://inciweb.wildfire.gov/api/single-publication/';

const PERIMETERS_TTL_MS = 300_000;
const INDEX_TTL_MS = 3_600_000;
const PUBLICATION_TTL_MS = 1_800_000;
const FETCH_TIMEOUT_MS = 30_000;
const CAP = 16 * 1024 * 1024;
const USER_AGENT = 'gods-eye-view-fire-proxy/1.0';

// --- pure normalizer (ported from src/layers/perimeters/records.js) ---

function finiteOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function textOrNull(v) {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}
function validRing(ring) {
  return (
    Array.isArray(ring) &&
    ring.length >= 4 &&
    ring.every(
      (p) =>
        Array.isArray(p) &&
        p.length >= 2 &&
        Number.isFinite(Number(p[0])) &&
        Number.isFinite(Number(p[1])),
    )
  );
}
function normalizePolygons(geometry) {
  if (!geometry || typeof geometry !== 'object') return null;
  let polygons;
  if (geometry.type === 'Polygon') polygons = [geometry.coordinates];
  else if (geometry.type === 'MultiPolygon') polygons = geometry.coordinates;
  else return null;
  if (!Array.isArray(polygons)) return null;
  const result = [];
  for (const rings of polygons) {
    if (!Array.isArray(rings)) return null;
    if (!rings.length) continue;
    if (!rings.every(validRing)) return null;
    result.push(rings);
  }
  return result;
}

export function normalizeFirePerimeterSnapshot(geojson) {
  if (!Array.isArray(geojson?.features)) return null;
  const rows = [];
  const ids = new Set();
  for (const feature of geojson.features) {
    const properties = feature?.properties;
    if (!properties || typeof properties !== 'object' || Array.isArray(properties))
      continue;
    const polygons = normalizePolygons(feature.geometry);
    if (polygons === null || !polygons.length) continue;
    const uniqueId = properties.attr_UniqueFireIdentifier;
    const stableId =
      typeof uniqueId === 'string' && uniqueId !== ''
        ? uniqueId
        : feature.id == null || feature.id === ''
          ? null
          : String(feature.id);
    if (stableId == null || ids.has(stableId)) continue;
    ids.add(stableId);
    rows.push({
      stableId,
      name: typeof properties.poly_IncidentName === 'string' ? properties.poly_IncidentName : null,
      acres: finiteOrNull(properties.attr_IncidentSize),
      containedPct: finiteOrNull(properties.attr_PercentContained),
      state: typeof properties.attr_POOState === 'string' ? properties.attr_POOState : null,
      category: typeof properties.attr_IncidentTypeCategory === 'string' ? properties.attr_IncidentTypeCategory : null,
      discoveredTime: finiteOrNull(properties.attr_FireDiscoveryDateTime),
      updatedTime: finiteOrNull(properties.poly_DateCurrent),
      cause: textOrNull(properties.attr_FireCause),
      behavior: textOrNull(properties.attr_FireBehaviorGeneral),
      personnel: finiteOrNull(properties.attr_TotalIncidentPersonnel),
      county: textOrNull(properties.attr_POOCounty),
      costToDate: finiteOrNull(properties.attr_EstimatedCostToDate),
      complexity: textOrNull(properties.attr_IncidentComplexityLevel),
      complexName: textOrNull(properties.attr_CpxName),
      polygons,
    });
  }
  return rows;
}

// --- worker I/O ---

async function readTextCapped(response, maxBytes) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes)
      throw new Error('fire_upstream_too_large');
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
      throw new Error('fire_upstream_too_large');
    }
    out += decoder.decode(value, { stream: true });
  }
  return out + decoder.decode();
}

async function upstream(url, cap, { method = 'GET', body = null, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      body,
      signal: controller.signal,
      redirect: 'error',
      headers: {
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
        ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
      },
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

async function fetchPerimeters() {
  const features = [];
  for (let page = 0; page < 5; page++) {
    const url = page === 0 ? PERIMETERS_URL : `${PERIMETERS_URL}&resultOffset=${features.length}`;
    const payload = JSON.parse(await upstream(url, CAP));
    if (!Array.isArray(payload?.features)) throw new Error('invalid_snapshot');
    features.push(...payload.features);
    if (!payload.exceededTransferLimit || !payload.features.length) break;
  }
  const rows = normalizeFirePerimeterSnapshot({ features });
  return { fetchedAt: Date.now(), rows };
}

async function fetchPublicationTimes(id) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    let response = await fetch(`https://inciweb.wildfire.gov/node/${id}`, {
      signal: controller.signal,
      redirect: 'manual',
      headers: { 'User-Agent': USER_AGENT },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      try { await response.body?.cancel(); } catch { /* no-op */ }
      const location = response.headers.get('location');
      if (!location || /\.\.|[?%\\]/.test(location)) throw new Error('invalid_redirect');
      const url = new URL(location, 'https://inciweb.wildfire.gov/');
      if (
        url.hostname !== 'inciweb.wildfire.gov' ||
        !/^\/[a-z0-9-]+(?:\/[a-z0-9-]+)?$/.test(url.pathname) ||
        !['http:', 'https:'].includes(url.protocol) ||
        url.port || url.username || url.password
      )
        throw new Error('invalid_redirect');
      url.protocol = 'https:';
      url.search = '';
      url.hash = '';
      response = await fetch(url.href, {
        signal: controller.signal,
        redirect: 'error',
        headers: { 'User-Agent': USER_AGENT },
      });
    }
    if (response.status !== 200) {
      try { await response.body?.cancel(); } catch { /* no-op */ }
      throw new Error('upstream_unavailable');
    }
    const html = await readTextCapped(response, 2 * 1024 * 1024);
    const changed = Date.parse(
      html.match(/<meta\s+property="og:updated_time"\s+content="([^"]+)"/)?.[1],
    );
    const created = Date.parse(
      html.match(/Date of Origin<\/th>\s*<td[^>]*>\s*<time\s+datetime="([^"]+)"/)?.[1],
    );
    const createdMs = Number.isFinite(created) ? created : null;
    const changedMs = Number.isFinite(changed) ? changed : null;
    if (createdMs === null && changedMs === null) throw new Error('invalid_incident_page');
    return { createdMs, changedMs };
  } finally {
    clearTimeout(timer);
  }
}

async function freshOrStale(cache, key, ttlMs, loader) {
  const cached = await cache.match(key);
  if (cached) {
    const fetchedAt = Number(cached.headers.get('x-fire-fetched-at'));
    if (Number.isFinite(fetchedAt) && Date.now() - fetchedAt < ttlMs)
      return { response: cached, stale: false };
  }
  try {
    const value = await loader();
    const response = new Response(JSON.stringify(value), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'x-fire-fetched-at': String(Date.now()),
      },
    });
    const put = cache.put(key, response.clone()).catch(() => {});
    return { response, stale: false, put };
  } catch (error) {
    if (cached) {
      const headers = new Headers(cached.headers);
      headers.set('x-data-stale', 'true');
      return {
        response: new Response(cached.body, { status: cached.status, headers }),
        stale: true,
      };
    }
    throw error;
  }
}

export async function handleFireRequest(request, ctx) {
  const url = new URL(request.url);
  if (request.method !== 'GET')
    return new Response(JSON.stringify({ error: 'method_not_allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json', Allow: 'GET' },
    });
  const cache = caches.default;
  const path = url.pathname.replace(/\/+$/, '') || '/';

  try {
    if (path === '/api/fire-perimeters') {
      const key = new Request(`${url.origin}/api/fire-perimeters`, { method: 'GET' });
      const result = await freshOrStale(cache, key, PERIMETERS_TTL_MS, fetchPerimeters);
      if (result.put && ctx?.waitUntil) ctx.waitUntil(result.put);
      return result.response;
    }
    if (path === '/api/fire-perimeters/inciweb/index') {
      const key = new Request(`${url.origin}/api/fire-perimeters/inciweb/index`, { method: 'GET' });
      const result = await freshOrStale(cache, key, INDEX_TTL_MS, async () => {
        const rows = JSON.parse(
          await upstream(INCIWEB_INDEX_URL, 4 * 1024 * 1024, {
            method: 'POST',
            body: JSON.stringify({ title: '' }),
          }),
        );
        if (!Array.isArray(rows)) throw new Error('invalid_index');
        return rows;
      });
      if (result.put && ctx?.waitUntil) ctx.waitUntil(result.put);
      return result.response;
    }
    const pubMatch = path.match(/^\/api\/fire-perimeters\/inciweb\/publication\/(\d{1,9})$/);
    if (pubMatch) {
      const id = pubMatch[1];
      const key = new Request(`${url.origin}/api/fire-perimeters/inciweb/publication/${id}`, { method: 'GET' });
      const result = await freshOrStale(cache, key, PUBLICATION_TTL_MS, () => fetchPublicationTimes(id));
      if (result.put && ctx?.waitUntil) ctx.waitUntil(result.put);
      return result.response;
    }
    return new Response(JSON.stringify({ error: 'unknown_route' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch {
    return new Response(JSON.stringify({ error: 'fire_perimeters_unavailable' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
