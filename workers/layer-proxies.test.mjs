import test from 'node:test';
import assert from 'node:assert/strict';
import {
  handleFlightsRequest,
  normalizeAdsbLolAircraftState,
  normalizeAdsbLolPointResponse,
  anchorKey,
} from './flights-proxy.js';
import { handleSpaceRequest } from './space-proxy.js';
import { handleFireRequest, normalizeFirePerimeterSnapshot } from './fire-proxy.js';
import { handleRadioRequest } from './radio-proxy.js';
import { handleMiscRequest } from './misc-proxy.js';

// --- minimal worker globals ---

const cacheStore = new Map();
globalThis.caches = {
  default: {
    async match(key) {
      const k = key instanceof Request ? key.url : String(key);
      return cacheStore.get(k) || null;
    },
    async put(key, response) {
      const k = key instanceof Request ? key.url : String(key);
      cacheStore.set(k, response);
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

const json = (value, status = 200, headers = {}) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });

// --- flights ---

test('flights: normalizer drops positionless contacts', () => {
  const out = normalizeAdsbLolPointResponse(
    { now: 1700000000, ac: [{ hex: 'abc123', lat: 41.9, lon: -87.6 }, { hex: 'nope' }] },
    1700000000000,
  );
  assert.equal(out.states.length, 1);
  assert.equal(out.states[0][0], 'abc123');
  assert.equal(out.time, 1700000000);
});

test('flights: anchor key rounds to 0.25 grid', () => {
  assert.equal(anchorKey(41.93, -87.62), '42.00,-87.50');
});

test('flights: /api/opensky serves OpenSky with source headers', async () => {
  cacheStore.clear();
  globalThis.fetch = mockFetch([
    ['https://opensky-network.org/api/states/all', () => json({ time: 1700000000, states: [] })],
  ]);
  const res = await handleFlightsRequest(
    new Request('https://x.test/api/opensky?lat=41.9&lon=-87.6'), {},
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-flight-source'), 'OpenSky Network');
  const body = await res.json();
  assert.deepEqual(body.states, []);
});

test('flights: /api/opensky falls back to adsb.lol on OpenSky 429', async () => {
  cacheStore.clear();
  globalThis.fetch = mockFetch([
    ['https://opensky-network.org/api/states/all', () => new Response('rl', { status: 429 })],
    [
      'https://api.adsb.lol/v2/lat/',
      () => json({ now: 1700000000, ac: [{ hex: 'a1b2c3', lat: 41.9, lon: -87.6, flight: 'UAL1' }] }),
    ],
  ]);
  const res = await handleFlightsRequest(
    new Request('https://x.test/api/opensky?lat=41.9&lon=-87.6'), {},
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-flight-source'), 'adsb.lol');
  const body = await res.json();
  assert.equal(body.states.length, 1);
  assert.equal(body.states[0][1], 'UAL1');
});

test('flights: /api/adsblol/mil proxies military feed', async () => {
  cacheStore.clear();
  globalThis.fetch = mockFetch([
    ['https://api.adsb.lol/v2/mil', () => json({ now: 1, ac: [{ hex: 'ae1234' }] })],
  ]);
  const res = await handleFlightsRequest(new Request('https://x.test/api/adsblol/mil'), {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ac.length, 1);
});

test('flights: invalid icao24 rejected', async () => {
  const res = await handleFlightsRequest(
    new Request('https://x.test/api/opensky-track?icao24=zzz'), {},
  );
  assert.equal(res.status, 400);
});

// --- space ---

test('space: celestrak group validated', async () => {
  cacheStore.clear();
  const res = await handleSpaceRequest(new Request('https://x.test/api/celestrak/!!!invalid!!!'), {});
  assert.equal(res.status, 400);
});

test('space: celestrak serves TLE', async () => {
  cacheStore.clear();
  globalThis.fetch = mockFetch([
    ['https://celestrak.org/NORAD/elements/gp.php', () => new Response('ISS\n1 25544U fake\n2 25544 fake\n', { status: 200 })],
  ]);
  const res = await handleSpaceRequest(new Request('https://x.test/api/celestrak/stations'), {});
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /^1 /m);
});

test('space: launches validated as JSON', async () => {
  cacheStore.clear();
  globalThis.fetch = mockFetch([
    ['https://ll.thespacedevs.com/2.3.0/launches/', () => json({ count: 0, results: [] })],
  ]);
  const res = await handleSpaceRequest(new Request('https://x.test/api/launches'), {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.results, []);
});

// --- fire ---

test('fire: normalizer keeps valid polygons', () => {
  const rows = normalizeFirePerimeterSnapshot({
    features: [
      {
        id: 1,
        properties: { attr_UniqueFireIdentifier: 'fire-1', poly_IncidentName: 'Test Fire', attr_IncidentSize: 123.4 },
        geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] },
      },
      { properties: {}, geometry: null },
    ],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].stableId, 'fire-1');
  assert.equal(rows[0].acres, 123.4);
});

test('fire: /api/fire-perimeters proxies NIFC', async () => {
  cacheStore.clear();
  globalThis.fetch = mockFetch([
    [
      'https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Interagency_Perimeters_Current/FeatureServer/0/query',
      () =>
        json({
          features: [
            {
              properties: { attr_UniqueFireIdentifier: 'f1', poly_IncidentName: 'Big Fire' },
              geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] },
            },
          ],
        }),
    ],
  ]);
  const res = await handleFireRequest(new Request('https://x.test/api/fire-perimeters'), {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.rows.length, 1);
  assert.equal(body.rows[0].name, 'Big Fire');
});

test('fire: unknown route 404s', async () => {
  const res = await handleFireRequest(new Request('https://x.test/api/fire-perimeters/nope'), {});
  assert.equal(res.status, 404);
});

// --- radio ---

test('radio: stations directory normalized', async () => {
  cacheStore.clear();
  globalThis.fetch = mockFetch([
    [
      'https://de1.api.radio-browser.info/json/stations/search',
      () =>
        json([
          {
            stationuuid: '12345678-1234-1234-1234-123456789abc',
            name: 'Test FM',
            geo_lat: 41.9,
            geo_long: -87.6,
            codec: 'MP3',
            url_resolved: 'https://example.com/stream.mp3',
            lastcheckok: 1,
            hls: 0,
          },
          { stationuuid: 'bad', name: 'Nope' },
        ]),
    ],
  ]);
  const res = await handleRadioRequest(new Request('https://x.test/api/radio/stations'), {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.stations.length, 1);
  assert.equal(body.stations[0].name, 'Test FM');
  assert.equal(body.stations[0].streamUrl, 'https://example.com/stream.mp3');
});

test('radio: click posts to mirror', async () => {
  let clicked = null;
  globalThis.fetch = mockFetch([
    [
      'https://de1.api.radio-browser.info/json/url/',
      (url) => { clicked = url; return json({ ok: true }); },
    ],
  ]);
  const res = await handleRadioRequest(
    new Request('https://x.test/api/radio/click/12345678-1234-1234-1234-123456789abc', { method: 'POST' }),
    {},
  );
  assert.equal(res.status, 200);
  assert.ok(clicked.includes('12345678-1234-1234-1234-123456789abc'));
});

// --- misc ---

test('misc: route rejects bad profile', async () => {
  const res = await handleMiscRequest(
    new Request('https://x.test/api/route?profile=rocket&coords=0,0;1,1'), {},
  );
  const body = await res.json();
  assert.equal(body.ok, false);
});

test('misc: route proxies OSRM', async () => {
  cacheStore.clear();
  globalThis.fetch = mockFetch([
    ['https://routing.openstreetmap.de/routed-foot/route/v1/foot/', () => json({ routes: [{ legs: [{ steps: [1] }] }] })],
  ]);
  const res = await handleMiscRequest(
    new Request('https://x.test/api/route?profile=foot&coords=-87.6,41.9;-87.5,41.8'), {},
  );
  const body = await res.json();
  assert.ok(body.routes);
  assert.equal(body.routes[0].legs[0].steps, undefined); // stripped
});

test('misc: gbfs rejects non-allowlisted host', async () => {
  const res = await handleMiscRequest(
    new Request('https://x.test/api/gbfs/' + encodeURIComponent('https://evil.com/station_status.json')),
    {},
  );
  assert.equal(res.status, 403);
});

test('misc: gbfs proxies allowlisted host', async () => {
  globalThis.fetch = mockFetch([
    ['https://gbfs.bluebikes.com/gbfs/en/station_status.json', () => json({ data: { stations: [] } })],
  ]);
  const res = await handleMiscRequest(
    new Request('https://x.test/api/gbfs/' + encodeURIComponent('https://gbfs.bluebikes.com/gbfs/en/station_status.json')),
    {},
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
});

test('misc: overpass sanitizes oversized radius', async () => {
  const res = await handleMiscRequest(
    new Request('https://x.test/api/overpass', {
      method: 'POST',
      body: 'data=[out:json];node(around:99999999,41.9,-87.6);out;',
    }),
    {},
  );
  assert.equal(res.status, 400);
});

test('misc: overpass proxies valid query', async () => {
  globalThis.fetch = mockFetch([
    ['https://overpass-api.de/api/interpreter', () => json({ elements: [] })],
  ]);
  const res = await handleMiscRequest(
    new Request('https://x.test/api/overpass', {
      method: 'POST',
      body: 'data=[out:json];node(around:1000,41.9,-87.6)[amenity];out;',
    }),
    {},
  );
  assert.equal(res.status, 200);
});

test('transit: feeds catalog', async () => {
  const { handleTransitRequest } = await import('./transit-proxy.js');
  const res = await handleTransitRequest(new Request('https://x.test/api/transit/feeds'));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.feeds) && body.feeds.length > 0);
});
