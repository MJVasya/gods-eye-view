import test from 'node:test';
import assert from 'node:assert/strict';
import { handleKeyedRequest } from './keyed-proxy.js';

const cacheStore = new Map();
globalThis.caches = {
  default: {
    async match(key) {
      return cacheStore.get(key instanceof Request ? key.url : String(key)) || null;
    },
    async put(key, response) {
      cacheStore.set(key instanceof Request ? key.url : String(key), response);
    },
  },
};

function mockFetch(routes) {
  return async (input, init = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    for (const [prefix, handler] of routes) {
      if (url.startsWith(prefix)) return handler(url, init);
    }
    return new Response('not found', { status: 404 });
  };
}

const json = (value, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const NO_KEYS = {};
const ctx = { waitUntil(p) { p.catch(() => {}); } };

// --- TomTom ---

test('tomtom: status reports key presence honestly', async () => {
  const noKey = await handleKeyedRequest(new Request('https://x/api/tomtom/status'), NO_KEYS, ctx);
  assert.equal((await noKey.json()).hasKey, false);
  const withKey = await handleKeyedRequest(
    new Request('https://x/api/tomtom/status'), { TOMTOM_API_KEY: 'secret' }, ctx,
  );
  assert.equal((await withKey.json()).hasKey, true);
});

test('tomtom: flow without key → 503, never leaks key', async () => {
  const res = await handleKeyedRequest(
    new Request('https://x/api/tomtom/flow/10/123/456.pbf'), NO_KEYS, ctx,
  );
  assert.equal(res.status, 503);
  const body = await res.text();
  assert.ok(!body.includes('secret'));
});

test('tomtom: invalid tile rejected', async () => {
  const res = await handleKeyedRequest(
    new Request('https://x/api/tomtom/flow/10/99999/99999.pbf'),
    { TOMTOM_API_KEY: 'k' }, ctx,
  );
  assert.equal(res.status, 400);
});

test('tomtom: tile proxied as protobuf', async () => {
  cacheStore.clear();
  globalThis.fetch = mockFetch([
    ['https://api.tomtom.com/traffic/map/4/tile/flow/relative/10/123/456.pbf',
      () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'Content-Type': 'application/x-protobuf' } })],
  ]);
  const res = await handleKeyedRequest(
    new Request('https://x/api/tomtom/flow/10/123/456.pbf'),
    { TOMTOM_API_KEY: 'k' }, ctx,
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Content-Type'), 'application/x-protobuf');
});

// --- FIRMS ---

test('firms: no key → 503', async () => {
  const res = await handleKeyedRequest(new Request('https://x/api/firms'), NO_KEYS, ctx);
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error, 'no_key');
});

test('firms: parses CSV and filters 24h', async () => {
  cacheStore.clear();
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const hhmm = String(now.getUTCHours()).padStart(2, '0') + String(now.getUTCMinutes()).padStart(2, '0');
  const csv = `latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_t31,frp,daynight\n41.9,-87.6,320.5,0.4,0.4,${today},${hhmm},N21,VIIRS,h,2.0NRT,290.1,5.2,D\n0,0,300,0.4,0.4,2020-01-01,1200,N21,VIIRS,h,2.0NRT,290,1.0,D\n`;
  globalThis.fetch = mockFetch([
    ['https://firms.modaps.eosdis.nasa.gov/api/area/csv/', () => new Response(csv, { status: 200 })],
  ]);
  const res = await handleKeyedRequest(
    new Request('https://x/api/firms'), { FIRMS_MAP_KEY: 'k' }, ctx,
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.fires.length, 4); // 1 recent fire × 4 sources; 2020 record filtered
  assert.equal(body.fires[0].lat, 41.9);
  assert.ok(body.sources.every((s) => s.ok));
});

// --- Google ---

test('google: keyless → 200 configured:false', async () => {
  const res = await handleKeyedRequest(
    new Request('https://x/api/google/nearby-places?lat=41.9&lon=-87.6'), NO_KEYS, ctx,
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.configured, false);
  assert.deepEqual(body.places, []);
});

test('google: nearby-places proxies with key header', async () => {
  let sawKey = null;
  globalThis.fetch = mockFetch([
    ['https://places.googleapis.com/v1/places:searchNearby',
      (url, init) => {
        sawKey = init.headers['X-Goog-Api-Key'];
        return json({ places: [{ id: 'p1' }] });
      }],
  ]);
  const res = await handleKeyedRequest(
    new Request('https://x/api/google/nearby-places?lat=41.9&lon=-87.6'),
    { GOOGLE_MAPS_SERVER_API_KEY: 'gkey' }, ctx,
  );
  assert.equal(res.status, 200);
  assert.equal(sawKey, 'gkey');
  assert.equal((await res.json()).places.length, 1);
});

test('google: invalid coords → 400', async () => {
  const res = await handleKeyedRequest(
    new Request('https://x/api/google/nearby-places?lat=999&lon=-87.6'),
    { GOOGLE_MAPS_API_KEY: 'gkey' }, ctx,
  );
  assert.equal(res.status, 400);
});

// --- OpenAI ---

test('openai: keyless → 200 summary:null', async () => {
  const res = await handleKeyedRequest(
    new Request('https://x/api/openai/hud-summary', { method: 'POST', body: '{}' }),
    NO_KEYS, ctx,
  );
  assert.equal(res.status, 200);
  assert.equal((await res.json()).summary, null);
});

test('openai: hud-summary trims to five words', async () => {
  globalThis.fetch = mockFetch([
    ['https://api.openai.com/v1/responses',
      () => json({ output_text: 'Severe thunderstorm warning for downtown Chicago area residents' })],
  ]);
  const res = await handleKeyedRequest(
    new Request('https://x/api/openai/hud-summary', { method: 'POST', body: '{"x":1}' }),
    { OPENAI_API_KEY: 'sk-test' }, ctx,
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.summary.split(' ').length, 5);
  assert.equal(body.summary, 'Severe thunderstorm warning for downtown');
});

test('openai: GET rejected', async () => {
  const res = await handleKeyedRequest(
    new Request('https://x/api/openai/hud-summary'), { OPENAI_API_KEY: 'k' }, ctx,
  );
  assert.equal(res.status, 405);
});
