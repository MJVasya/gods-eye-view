/**
 * Weather imagery proxy for Cloudflare Workers / Pages `_worker.js`.
 *
 * Serves `GET /api/weather/manifest|tile|image` — a worker port of the
 * Vite dev-server middleware in `server/providers/weather.js`, so the
 * weather layers (rain radar, lightning density, satellite clouds, cyclone
 * panel is separate) work on the deployed Cloudflare Pages app, where the
 * dev middleware does not exist.
 *
 * Primary source: NOAA nowCOAST WMS (keyless, no signup).
 * Fallback sources (only when nowCOAST is unreachable; the manifest says so
 * honestly via `fallback: true` + `source` + `via`):
 *   - radar            -> Iowa State IEM NEXRAD n0q WMS (CONUS)
 *   - clouds           -> Iowa State IEM GOES-East ch13 IR WMS (CONUS)
 *   - clouds-regional  -> Iowa State IEM GOES-East ch13 IR WMS (CONUS)
 *   - lightning        -> no keyless fallback exists; honest UNAVAILABLE
 *
 * Workers-safe: no node: imports, no fs, no Buffer, no process.env. Binary
 * PNG validation uses DataView. Upstream fetches are capped and timed out.
 * Responses are cached at the edge (manifest 120 s, tiles/images 24 h).
 *
 * Why the proxy exists: browsers cannot call nowCOAST WMS directly at the
 * whole-extent sizes the globe needs without blowing mobile memory budgets,
 * and the app must never trust client-supplied upstream destinations.
 */

const NOWCOAST = 'https://nowcoast.noaa.gov/geoserver/observations/';
const IEM_NEXRAD = 'https://mesonet.agron.iastate.edu/cgi-bin/wms/nexrad/n0q.cgi';
const IEM_GOES_EAST =
  'https://mesonet.agron.iastate.edu/cgi-bin/wms/goes_east.cgi';
const FETCH_TIMEOUT_MS = 10_000;
const CAPABILITIES_CAP = 512 * 1024;
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const MANIFEST_TTL_MS = 120_000;
const TILE_TTL_SECONDS = 86_400;
const HOUR = 3600_000;
const USER_AGENT = 'gods-eye-view-weather/1.0 (keyless WMS proxy)';

/** Fallback WMS specs, keyed by `via`. */
const FALLBACKS = Object.freeze({
  iem: Object.freeze({
    via: 'iem',
    source: 'Iowa State IEM',
    attribution:
      'Iowa State University · Iowa Environmental Mesonet (NWS NEXRAD / NOAA GOES)',
    products: Object.freeze({
      radar: Object.freeze({
        base: IEM_NEXRAD,
        layer: 'nexrad-n0q',
        title: 'CONUS radar reflectivity (fallback)',
        coverage:
          'Contiguous United States via Iowa Environmental Mesonet; fallback while NOAA nowCOAST is unreachable. Gaps do not establish absence of precipitation.',
        description:
          'NEXRAD base reflectivity mosaic (dBZ) from Iowa State IEM, approximately 5-minute updates; not a rainfall forecast.',
        bounds: Object.freeze({ west: -126, south: 24, east: -66, north: 50 }),
      }),
      clouds: Object.freeze({
        base: IEM_GOES_EAST,
        layer: 'conus_ch13',
        title: 'GOES-East infrared (fallback)',
        coverage:
          'CONUS via Iowa Environmental Mesonet GOES-East; fallback while NOAA nowCOAST is unreachable. Not the usual global mosaic.',
        description:
          'GOES-East clean longwave infrared (~10.3 µm) from Iowa State IEM, approximately 10-minute updates. Not a cloud-only mask.',
        bounds: Object.freeze({ west: -126, south: 24, east: -66, north: 50 }),
      }),
      'clouds-regional': Object.freeze({
        base: IEM_GOES_EAST,
        layer: 'conus_ch13',
        title: 'GOES-East regional infrared (fallback)',
        coverage:
          'CONUS via Iowa Environmental Mesonet GOES-East; fallback while NOAA nowCOAST is unreachable.',
        description:
          'GOES-East clean longwave infrared (~10.3 µm) from Iowa State IEM, approximately 10-minute updates. Not a cloud-only mask.',
        bounds: Object.freeze({ west: -126, south: 24, east: -66, north: 50 }),
      }),
    }),
  }),
});

const PRODUCTS = Object.freeze({
  lightning: Object.freeze({
    service: 'lightning_detection',
    layer: 'ldn_lightning_strike_density',
    style: 'lightning_density',
    title: 'Lightning density · 15 min',
    coverage:
      'Pacific and Americas: 110°E across the dateline to 0°, 25°S–80°N; not global coverage.',
    description:
      'Observed 15-minute lightning strike density on an approximately 8 km grid, scaled as strikes/km²/min ×10³. Ground-network density, not individual GLM flashes.',
    attribution: 'NOAA/NWS nowCOAST; derived from Vaisala NLDN/GLD360',
    source: 'NOAA nowCOAST',
    image: Object.freeze({ width: 4096, height: 2048 }),
    fallbackVia: null,
  }),
  radar: Object.freeze({
    service: 'weather_radar',
    layer: 'conus_base_reflectivity_mosaic',
    style: 'weather_radar_base_reflectivity',
    title: 'CONUS radar reflectivity',
    coverage:
      'Contiguous United States; gaps do not establish absence of precipitation.',
    description:
      'Observed MRMS radar base reflectivity (dBZ), approximately 1 km and 4-minute updates; not a rainfall forecast.',
    attribution: 'NOAA/NWS/NESDIS nowCOAST',
    source: 'NOAA nowCOAST',
    image: Object.freeze({ width: 4096, height: 2048 }),
    fallbackVia: 'iem',
  }),
  clouds: Object.freeze({
    service: 'satellite',
    layer: 'global_longwave_imagery_mosaic',
    style: 'reflectance',
    title: 'Global satellite infrared',
    coverage:
      'Global mosaic with incomplete polar coverage; nominal coverage 60°S–60°N.',
    description:
      'Longwave infrared cloud and land/sea temperature patterns, approximately 3 km; hourly updates with 2–3 hour source latency. Not a cloud-only mask.',
    attribution: 'NOAA/NWS/NESDIS nowCOAST',
    source: 'NOAA nowCOAST',
    image: Object.freeze({ width: 2048, height: 1024 }),
    fallbackVia: 'iem',
  }),
  'clouds-regional': Object.freeze({
    service: 'satellite',
    layer: 'goes_longwave_imagery',
    style: 'goes-lir',
    title: 'GOES regional satellite infrared',
    coverage:
      'GOES East/West regional North American coverage; not a global image.',
    description:
      'GOES-19/18 longwave infrared Band 14 cloud and surface temperature patterns, approximately 2 km and 5-minute updates. Not a cloud-only mask.',
    attribution: 'NOAA/NWS/NESDIS nowCOAST',
    source: 'NOAA nowCOAST',
    image: Object.freeze({ width: 4096, height: 2048 }),
    fallbackVia: 'iem',
  }),
});

// Whole-extent images: 2:1 sizes up to each product's largest (the default).
const IMAGE_SIZES = Object.freeze(['1024x512', '2048x1024', '4096x2048']);
// Detail windows: any product up to 4096×2048 (the default).
const DETAIL_IMAGE = Object.freeze({ width: 4096, height: 2048 });
const BBOX_STEP = 0.25;

function failure(code, status = 503) {
  return Object.assign(new Error(code), { code, status });
}

/** Canonicalize only explicit UTC observations; never expand time intervals. */
export function observationTime(value) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
  )
    return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const canonical = date.toISOString();
  return canonical.replace('.000Z', 'Z') === value.replace('.000Z', 'Z')
    ? canonical
    : null;
}

/**
 * Read the named leaf from bounded capabilities without resolving XML
 * entities. Verbatim port of server/providers/weather.js (pure logic).
 */
export function parseWeatherCapabilities(xml, product, nowMs = Date.now()) {
  const spec = PRODUCTS[product];
  if (
    !spec ||
    typeof xml !== 'string' ||
    xml.length > CAPABILITIES_CAP ||
    /<!DOCTYPE|<!ENTITY/i.test(xml)
  )
    throw failure('invalid_weather_metadata');
  const stack = [];
  let leaf = null;
  let tags = 0;
  for (const match of xml.matchAll(/<\/?(?:[\w.-]+:)?Layer\b[^>]*>/g)) {
    if (++tags > 2048) throw failure('invalid_weather_metadata');
    if (!match[0].startsWith('</')) {
      if (stack.length) stack.at(-1).nested = true;
      if (stack.length >= 16 || match[0].endsWith('/>'))
        throw failure('invalid_weather_metadata');
      stack.push({ start: match.index + match[0].length, nested: false });
    } else {
      const opened = stack.pop();
      if (!opened) throw failure('invalid_weather_metadata');
      if (opened.nested) continue;
      const candidate = xml.slice(opened.start, match.index);
      const name = candidate
        .match(/<(?:[\w.-]+:)?Name\s*>([^<]+)<\/(?:[\w.-]+:)?Name>/)?.[1]
        ?.trim();
      if (name === spec.layer) {
        if (leaf !== null) throw failure('invalid_weather_metadata');
        leaf = candidate;
      }
    }
  }
  if (stack.length || !leaf) throw failure('invalid_weather_metadata');
  const box = leaf.match(
    /<(?:[\w.-]+:)?EX_GeographicBoundingBox\s*>([\s\S]*?)<\/(?:[\w.-]+:)?EX_GeographicBoundingBox>/,
  )?.[1];
  const bounds = {};
  for (const [key, tag] of Object.entries({
    west: 'westBoundLongitude',
    south: 'southBoundLatitude',
    east: 'eastBoundLongitude',
    north: 'northBoundLatitude',
  })) {
    const value = box
      ?.match(
        new RegExp(`<(?:[\\w.-]+:)?${tag}\\s*>([^<]+)</(?:[\\w.-]+:)?${tag}>`),
      )?.[1]
      ?.trim();
    bounds[key] = value ? Number(value) : NaN;
  }
  if (
    !Object.values(bounds).every(Number.isFinite) ||
    bounds.west < -180 ||
    bounds.east > 180 ||
    bounds.south < -90 ||
    bounds.north > 90 ||
    bounds.west >= bounds.east ||
    bounds.south >= bounds.north
  )
    throw failure('invalid_weather_metadata');
  const dimensions = [
    ...leaf.matchAll(
      /<(?:[\w.-]+:)?Dimension\b([^>]*)>([^<]*)<\/(?:[\w.-]+:)?Dimension>/g,
    ),
  ].filter((entry) => /\bname\s*=\s*["']time["']/.test(entry[1]));
  if (
    dimensions.length !== 1 ||
    !/\bunits\s*=\s*["']ISO8601["']/.test(dimensions[0][1])
  )
    throw failure('invalid_weather_metadata');
  const raw = dimensions[0][2].trim().split(',');
  if (!raw.length || raw.length > 512)
    throw failure('invalid_weather_metadata');
  const times = raw.map((value) => observationTime(value.trim()));
  if (times.some((value) => !value || Date.parse(value) > nowMs + 5 * 60_000))
    throw failure('invalid_weather_metadata');
  const defaultTime = observationTime(
    dimensions[0][1].match(/\bdefault\s*=\s*["']([^"']+)["']/)?.[1],
  );
  if (!defaultTime || !times.includes(defaultTime))
    throw failure('invalid_weather_metadata');
  const recent = [...new Set(times)]
    .filter((value) => nowMs - Date.parse(value) <= 24 * HOUR)
    .sort()
    .slice(-26);
  if (!recent.length) throw failure('weather_observations_expired');
  return { bounds, times: recent.slice(-13), allowedTimes: recent };
}

/** A detail window `west,south,east,north` in degrees, rounded to 0.25° so cache
 * keys repeat, with a 2:1 aspect within 1 %; null when absent. */
export function weatherImageBbox(value) {
  if (value === null) return null;
  const parts = value.split(',');
  if (
    parts.length !== 4 ||
    parts.some((part) => !/^-?\d{1,3}(?:\.\d{1,6})?$/.test(part))
  )
    throw failure('invalid_weather_bbox', 400);
  // `+ 0` turns a rounded -0 into 0 so equal windows share one key.
  const [west, south, east, north] = parts.map(
    (part) => Math.round(Number(part) / BBOX_STEP) * BBOX_STEP + 0,
  );
  if (
    west < -180 ||
    east > 180 ||
    south < -90 ||
    north > 90 ||
    west >= east ||
    south >= north ||
    Math.abs((east - west) / (north - south) / 2 - 1) > 0.01
  )
    throw failure('invalid_weather_bbox', 400);
  return [west, south, east, north];
}

/** GeographicTilingScheme's two longitude tiles and one latitude tile at level zero. */
export function weatherTileBounds(z, x, y) {
  if (
    ![z, x, y].every(Number.isInteger) ||
    z < 0 ||
    z > 6 ||
    x < 0 ||
    y < 0 ||
    x >= 2 ** (z + 1) ||
    y >= 2 ** z
  )
    throw failure('invalid_weather_tile', 400);
  const span = 180 / 2 ** z;
  return [
    -180 + x * span,
    90 - (y + 1) * span,
    -180 + (x + 1) * span,
    90 - y * span,
  ];
}

/** `via` must name a fallback configured for the product; null when absent. */
export function weatherVia(product, value) {
  if (value === null) return null;
  const spec = PRODUCTS[product];
  if (!spec || value !== spec.fallbackVia)
    throw failure('invalid_weather_via', 400);
  return value;
}

/** Read PNG dimensions without node:buffer. Null when not a valid PNG. */
export function pngDimensions(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 33) return null;
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) if (bytes[i] !== sig[i]) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452)
    return null;
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

async function readTextCapped(response, maxBytes, signal) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    try {
      await response.body?.cancel();
    } catch {
      /* no-op */
    }
    throw failure('weather_upstream_too_large');
  }
  signal?.throwIfAborted();
  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    signal?.throwIfAborted();
    if (new TextEncoder().encode(text).byteLength > maxBytes)
      throw failure('weather_upstream_too_large');
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
      throw failure('weather_upstream_too_large');
    }
    out += decoder.decode(value, { stream: true });
    signal?.throwIfAborted();
  }
  return out + decoder.decode();
}

async function readBytesCapped(response, maxBytes, signal) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    try {
      await response.body?.cancel();
    } catch {
      /* no-op */
    }
    throw failure('weather_upstream_too_large');
  }
  signal?.throwIfAborted();
  const reader = response.body?.getReader?.();
  if (!reader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    signal?.throwIfAborted();
    if (bytes.byteLength > maxBytes)
      throw failure('weather_upstream_too_large');
    return bytes;
  }
  const chunks = [];
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
      throw failure('weather_upstream_too_large');
    }
    chunks.push(value);
    signal?.throwIfAborted();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function timeoutSignal(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return {
    signal: controller.signal,
    done() {
      clearTimeout(timer);
    },
  };
}

async function upstreamGet(url, { accept, signal } = {}) {
  const t = timeoutSignal(FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: signal ?? t.signal,
      redirect: 'error',
      headers: {
        Accept: accept ?? 'application/xml,text/xml',
        'User-Agent': USER_AGENT,
      },
    });
    if (!response.ok) {
      try {
        await response.body?.cancel();
      } catch {
        /* no-op */
      }
      throw failure('weather_upstream_unavailable');
    }
    return response;
  } finally {
    if (!signal) t.done();
  }
}

/** Manifest payload shared by the manifest route and internal tile/image use. */
export function describeWeatherManifest(product, value) {
  const spec = PRODUCTS[product];
  const time = value?.times.at(-1) ?? null;
  const via = value?.via ?? null;
  const viaQuery = via ? `&via=${via}` : '';
  return {
    schemaVersion: 1,
    product,
    title: value?.title ?? spec.title,
    coverage: value?.coverage ?? spec.coverage,
    description: value?.description ?? spec.description,
    source: value?.source ?? spec.source,
    attribution: value?.attribution ?? spec.attribution,
    fallback: value?.fallback ?? false,
    via,
    fallbackFor: value?.fallbackFor ?? null,
    bounds: value?.bounds ?? null,
    times: value?.times ?? [],
    latest: time,
    time,
    observedAt: time,
    fetchedAt: value?.fetchedAt ?? null,
    stale: value?.stale ?? true,
    unavailable: !value,
    reason: !value
      ? 'Weather imagery unavailable'
      : value.stale
        ? 'Cached weather metadata; upstream unavailable'
        : null,
    tileSize: 256,
    maxLevel: 6,
    tilingScheme: 'geographic',
    tileTemplate: time
      ? `/api/weather/tile?product=${product}${viaQuery}&time=${encodeURIComponent(time)}&z={z}&x={x}&y={y}`
      : null,
    imageUrl: time
      ? `/api/weather/image?product=${product}${viaQuery}&time=${encodeURIComponent(time)}`
      : null,
    imageSize: { ...spec.image },
  };
}

function fallbackManifest(product, nowMs) {
  const spec = PRODUCTS[product];
  const via = spec.fallbackVia;
  const fbProvider = FALLBACKS[via];
  const fb = fbProvider?.products[product];
  if (!fb) return null;
  // IEM serves the latest mosaic; advertise a 5-minute-aligned synthetic
  // observation time so tiles stay cacheable and the UI clock is honest.
  const time = new Date(Math.floor(nowMs / 300_000) * 300_000).toISOString();
  return {
    title: fb.title,
    coverage: fb.coverage,
    description: fb.description,
    source: fbProvider.source,
    attribution: fbProvider.attribution,
    fallback: true,
    via,
    fallbackFor: 'NOAA nowCOAST',
    bounds: { ...fb.bounds },
    times: [time],
    allowedTimes: [time],
    fetchedAt: nowMs,
    stale: false,
  };
}

async function getManifestData(product, nowMs = Date.now()) {
  const spec = PRODUCTS[product];
  if (!spec) throw failure('unknown_weather_product', 400);
  try {
    const url = `${NOWCOAST}${spec.service}/ows?service=WMS&version=1.3.0&request=GetCapabilities`;
    const response = await upstreamGet(url);
    const xml = await readTextCapped(response, CAPABILITIES_CAP);
    const value = {
      ...parseWeatherCapabilities(xml, product, nowMs),
      fetchedAt: nowMs,
      stale: false,
    };
    return { kind: 'primary', value };
  } catch (error) {
    if (error.status === 400 || error.status === 429) throw error;
    const fb = fallbackManifest(product, nowMs);
    if (fb) return { kind: 'fallback', value: fb };
    return { kind: 'unavailable', value: null };
  }
}

function wmsGetMapUrl({ base, layer, style }, bbox, width, height, time) {
  const url = new URL(base);
  const params = {
    service: 'WMS',
    version: '1.1.1',
    request: 'GetMap',
    layers: layer,
    styles: style ?? '',
    srs: 'EPSG:4326',
    bbox: bbox.join(','),
    width: String(width),
    height: String(height),
    format: 'image/png',
    transparent: 'true',
  };
  if (time) params.time = time;
  url.search = new URLSearchParams(params).toString();
  return url.href;
}

function nowcoastImageUrl(product, bbox, width, height, time) {
  const spec = PRODUCTS[product];
  return wmsGetMapUrl(
    { base: `${NOWCOAST}${spec.service}/ows`, layer: spec.layer, style: spec.style },
    bbox,
    width,
    height,
    time,
  );
}

function fallbackImageUrl(product, via, bbox, width, height) {
  const fb = FALLBACKS[via]?.products[product];
  if (!fb) throw failure('invalid_weather_via', 400);
  return wmsGetMapUrl(
    { base: fb.base, layer: fb.layer },
    bbox,
    width,
    height,
    null,
  );
}

async function fetchImageBytes(url, width, height, maxBytes) {
  const response = await upstreamGet(url, { accept: 'image/png' });
  if (!/^image\/png(?:;|$)/i.test(response.headers.get('content-type') || '')) {
    try {
      await response.body?.cancel();
    } catch {
      /* no-op */
    }
    throw failure('weather_upstream_unavailable');
  }
  const bytes = await readBytesCapped(response, maxBytes);
  const dims = pngDimensions(bytes);
  if (!dims || dims.width !== width || dims.height !== height)
    throw failure('invalid_weather_image');
  return bytes;
}

function jsonResponse(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...headers,
    },
  });
}

function errorResponse(error) {
  const status =
    error?.status === 400 || error?.status === 429 ? error.status : 503;
  const headers = error?.status === 429 ? { 'Retry-After': '2' } : {};
  return jsonResponse(
    {
      error:
        error?.status === 400 || error?.status === 429
          ? error.code
          : 'weather_upstream_unavailable',
    },
    status,
    headers,
  );
}

/**
 * Handle GET /api/weather/manifest|tile|image — shared by the Pages
 * `_worker.js`. `ctx.waitUntil` finishes edge-cache writes after responding.
 */
export async function handleWeatherRequest(request, ctx) {
  const url = new URL(request.url);
  try {
    if (request.method !== 'GET')
      throw failure('method_not_allowed', 405);
    const route = url.pathname.replace(/^\/api\/weather/, '') || '/';
    if (!['/manifest', '/tile', '/image'].includes(route))
      throw failure('not_found', 404);
    const allowed =
      route === '/manifest'
        ? ['product']
        : route === '/image'
          ? ['product', 'time', 'size', 'bbox', 'via']
          : ['product', 'time', 'z', 'x', 'y', 'size', 'via'];
    if (
      url.pathname.length + url.search.length > 512 ||
      [...url.searchParams.keys()].some(
        (key) =>
          !allowed.includes(key) || url.searchParams.getAll(key).length !== 1,
      )
    )
      throw failure('invalid_weather_query', 400);
    const product = url.searchParams.get('product');
    if (!Object.hasOwn(PRODUCTS, product))
      throw failure('unknown_weather_product', 400);
    const via = weatherVia(product, url.searchParams.get('via'));
    const cache = caches.default;
    const nowMs = Date.now();

    if (route === '/manifest') {
      const cacheKey = new Request(
        `${url.origin}/api/weather/manifest?product=${product}`,
        { method: 'GET' },
      );
      const cached = await cache.match(cacheKey);
      if (cached) {
        const fetchedAt = Number(cached.headers.get('x-weather-fetched-at'));
        if (Number.isFinite(fetchedAt) && nowMs - fetchedAt < MANIFEST_TTL_MS)
          return cached;
      }
      const data = await getManifestData(product, nowMs);
      const body = describeWeatherManifest(product, data.value);
      const response = new Response(JSON.stringify(body), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=120',
          'x-weather-fetched-at': String(nowMs),
          'x-weather-kind': data.kind,
        },
      });
      const put = cache
        .put(cacheKey, response.clone())
        .catch(() => {});
      if (ctx?.waitUntil) ctx.waitUntil(put);
      else await put.catch(() => {});
      return response;
    }

    const wholeImage = route === '/image';
    const detailBox = wholeImage
      ? weatherImageBbox(url.searchParams.get('bbox'))
      : null;
    const largest = detailBox ? DETAIL_IMAGE : PRODUCTS[product].image;
    const size =
      url.searchParams.get('size') ??
      (wholeImage ? `${largest.width}x${largest.height}` : '256');
    if (
      wholeImage
        ? !IMAGE_SIZES.includes(size) ||
          Number.parseInt(size, 10) > largest.width
        : !['256', '512', '1024'].includes(size)
    )
      throw failure(
        wholeImage ? 'invalid_weather_image_size' : 'invalid_weather_tile_size',
        400,
      );
    const coords = wholeImage
      ? null
      : ['z', 'x', 'y'].map((key) => url.searchParams.get(key));
    if (coords?.some((value) => !/^(?:0|[1-9]\d{0,2})$/.test(value ?? '')))
      throw failure('invalid_weather_tile', 400);
    const tileBounds = coords ? weatherTileBounds(...coords.map(Number)) : null;
    const time = url.searchParams.get('time');
    if (!time || observationTime(time) !== time)
      throw failure('invalid_weather_time', 400);

    const data = await getManifestData(product, nowMs);
    if (data.kind === 'unavailable') throw failure('weather_upstream_unavailable');
    const value = data.value;
    // A `via` pin selects the fallback source deterministically; without it
    // the manifest's winning source serves the frame — never a silent mix.
    const useVia = via ?? (data.kind === 'fallback' ? value.via : null);
    if (useVia && useVia !== value.via)
      throw failure('weather_upstream_unavailable');
    if (!useVia) {
      if (
        !value.allowedTimes.includes(time) ||
        nowMs - Date.parse(time) > 24 * HOUR
      )
        throw failure('unknown_weather_time', 400);
      if (value.stale) throw failure('weather_metadata_stale');
    }
    const bounds = value.bounds;
    if (
      detailBox &&
      (detailBox[0] < bounds.west ||
        detailBox[1] < bounds.south ||
        detailBox[2] > bounds.east ||
        detailBox[3] > bounds.north)
    )
      throw failure('invalid_weather_bbox', 400);
    const bbox =
      detailBox ??
      (wholeImage
        ? [bounds.west, bounds.south, bounds.east, bounds.north]
        : tileBounds);
    const [width, height] = wholeImage
      ? size.split('x').map(Number)
      : [Number(size), Number(size)];
    const maxBytes = wholeImage
      ? MAX_IMAGE_BYTES
      : Math.max(1024 * 1024, width ** 2 * 4 + 65_536);

    const cacheKey = new Request(
      `${url.origin}/api/weather/${wholeImage ? 'image' : 'tile'}` +
        `?product=${product}&via=${useVia ?? 'nowcoast'}` +
        `&time=${encodeURIComponent(time)}` +
        (wholeImage
          ? `&size=${size}&bbox=${bbox.join(',')}`
          : `&size=${size}&z=${coords[0]}&x=${coords[1]}&y=${coords[2]}`),
      { method: 'GET' },
    );
    const cachedTile = await cache.match(cacheKey);
    if (cachedTile) return cachedTile;

    const upstreamUrl = useVia
      ? fallbackImageUrl(product, useVia, bbox, width, height)
      : nowcoastImageUrl(product, bbox, width, height, time);
    const bytes = await fetchImageBytes(upstreamUrl, width, height, maxBytes);
    const response = new Response(bytes, {
      status: 200,
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': `public, max-age=${TILE_TTL_SECONDS}, immutable`,
        'X-Content-Type-Options': 'nosniff',
        'x-weather-via': useVia ?? 'nowcoast',
      },
    });
    const put = cache.put(cacheKey, response.clone()).catch(() => {});
    if (ctx?.waitUntil) ctx.waitUntil(put);
    else await put.catch(() => {});
    return response;
  } catch (error) {
    return errorResponse(error);
  }
}
