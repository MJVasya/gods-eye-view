/**
 * Diagnostic health check for Cloudflare Workers / Pages `_worker.js`.
 *
 * GET /api/health — returns worker version, secret presence (booleans only,
 * never values), and live upstream reachability for every proxied source.
 *
 * This is a diagnostic tool: it makes real upstream requests so we can tell
 * whether a layer failure is the worker, the secret, or the upstream.
 * No secrets are echoed. Response is JSON, no-store.
 */

const VERSION = '2026-10-10-diag2';

async function probe(name, url, { timeoutMs = 8000, expectJson = false } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'manual',
      headers: { 'User-Agent': 'gods-eye-view-health/1.0', Accept: expectJson ? 'application/json' : '*/*' },
    });
    // For health we only care about reachability, not 2xx.
    return { name, ok: res.status < 500, status: res.status, ms: Date.now() - started };
  } catch (e) {
    return { name, ok: false, error: `${e?.name}: ${e?.message || 'no message'}`, ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchVariants() {
  const results = {};
  const url = 'https://example.com/';
  // Variant 1: bare fetch, no options
  try {
    const r = await fetch(url);
    results.bare = `ok ${r.status}`;
  } catch (e) {
    results.bare = `${e?.name}: ${e?.message || 'no message'}`;
  }
  // Variant 2: with User-Agent header
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'test/1.0' } });
    results.withUA = `ok ${r.status}`;
  } catch (e) {
    results.withUA = `${e?.name}: ${e?.message || 'no message'}`;
  }
  // Variant 3: with AbortSignal
  try {
    const c = new AbortController();
    const r = await fetch(url, { signal: c.signal });
    results.withSignal = `ok ${r.status}`;
  } catch (e) {
    results.withSignal = `${e?.name}: ${e?.message || 'no message'}`;
  }
  // Variant 4: with redirect:error
  try {
    const r = await fetch(url, { redirect: 'manual' });
    results.withRedirect = `ok ${r.status}`;
  } catch (e) {
    results.withRedirect = `${e?.name}: ${e?.message || 'no message'}`;
  }
  return results;
}

export async function handleHealthRequest(request, env) {
  if (request.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'method_not_allowed' }), {
      status: 405, headers: { 'Content-Type': 'application/json' },
    });
  }

  const secrets = {
    TOMTOM_API_KEY: Boolean(String(env.TOMTOM_API_KEY || '').trim()),
    FIRMS_MAP_KEY: Boolean(String(env.FIRMS_MAP_KEY || '').trim()),
    GOOGLE_MAPS_SERVER_API_KEY: Boolean(String(env.GOOGLE_MAPS_SERVER_API_KEY || '').trim()),
    GOOGLE_MAPS_API_KEY: Boolean(String(env.GOOGLE_MAPS_API_KEY || '').trim()),
    OPENAI_API_KEY: Boolean(String(env.OPENAI_API_KEY || '').trim()),
  };

  // Probe keyless upstreams in parallel (bounded).
  const probes = await Promise.all([
    probe('opensky', 'https://opensky-network.org/api/states/all?extended=1', { timeoutMs: 10000 }),
    probe('adsb.lol', 'https://api.adsb.lol/v2/mil', { expectJson: true }),
    probe('celestrak', 'https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=tle'),
    probe('nhc', 'https://www.nhc.noaa.gov/CurrentStorms.json', { expectJson: true }),
    probe('nowcoast', 'https://nowcoast.noaa.gov/geoserver/observations/ows?service=WMS&request=GetCapabilities'),
    probe('nifc', 'https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Interagency_Perimeters_Current/FeatureServer/0/query?where=1%3D0&f=json', { expectJson: true }),
    probe('radio-browser', 'https://de1.api.radio-browser.info/json/stations/search?limit=1', { expectJson: true }),
    probe('osrm', 'https://routing.openstreetmap.de/routed-foot/route/v1/foot/-87.6,41.9;-87.5,41.8?overview=false', { expectJson: true }),
  ]);

  return new Response(JSON.stringify({
    version: VERSION,
    now: new Date().toISOString(),
    secrets,
    fetchVariants: await fetchVariants(),
    upstreams: probes,
  }, null, 2), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
