import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createLiveCyberFeed,
  DEFAULT_CYBER_FEED_PROXY_URL,
  LIVE_FEED_LABEL,
} from './liveFeed.js';
import { normalizeCyberEvents } from './records.js';

/* ------------------------------------------------------------------ */
/* Fixtures shaped like the real /api/cyber-feed proxy payload         */
/* (workers/cyber-feed-proxy.js). Stubbed — no network in tests.       */
/* ------------------------------------------------------------------ */

const PROXY_EVENTS = [
  {
    id: 'live-cins-1-12-229-231',
    src: { country: 'China', code: 'CN', lat: 23.1181, lon: 113.2539 },
    dst: { country: 'Netherlands', code: 'NL', lat: 52.3676, lon: 4.9041 },
    type: 'intrusion',
    severity: 3,
    ts: 1758550000000,
    ioc: '1.12.229.231', // extras are ignored by the validator
    ref: 'https://cinsscore.com/',
  },
  {
    id: 'live-blocklist-203-0-113-44',
    src: { country: 'United States', code: 'US', lat: 38.9, lon: -77.0 },
    dst: { country: 'Germany', code: 'DE', lat: 52.5, lon: 13.4 },
    type: 'scan',
    severity: 2,
    ts: 1758550001000,
    ioc: '203.0.113.44',
    ref: 'https://lists.blocklist.de/',
  },
  {
    id: 'live-openphish-abc123',
    src: { country: 'Russia', code: 'RU', lat: 55.8, lon: 37.6 },
    dst: { country: 'United Kingdom', code: 'GB', lat: 51.5, lon: -0.13 },
    type: 'phishing',
    severity: 3,
    ts: 1758550002000,
    ioc: 'http://example.com/login',
    ref: 'https://openphish.com/',
  },
  // Malformed rows must be dropped, never rendered.
  {
    id: 'live-bogus-1',
    src: { country: 'Nowhere', code: 'XX', lat: 0, lon: 0 },
    dst: { country: 'Elsewhere', code: 'YY', lat: 1, lon: 1 },
    type: 'ransomware', // not a valid threat type
    severity: 9,
    ts: 1758550003000,
  },
];

function makePayload(overrides = {}) {
  return {
    live: true,
    source: 'cins,blocklist,openphish',
    generated_at: 1758550000000,
    cache_ttl_s: 60,
    events: PROXY_EVENTS,
    ...overrides,
  };
}

function stubFetch(handler) {
  return async (url, options) => handler(url, options);
}

const okResponse = (payload) => ({
  ok: true,
  status: 200,
  json: async () => payload,
});

test('proxy URL defaults to /api/cyber-feed and sends ?limit=', async () => {
  assert.equal(DEFAULT_CYBER_FEED_PROXY_URL, '/api/cyber-feed');
  const seen = [];
  const fetch = stubFetch(async (url, options) => {
    seen.push([url, options]);
    return okResponse(makePayload());
  });
  await createLiveCyberFeed({ fetchImpl: fetch }).getSnapshot();
  assert.equal(seen[0][0], '/api/cyber-feed?limit=96');
  assert.equal(seen[0][1].headers.accept, 'application/json');

  await createLiveCyberFeed({
    fetchImpl: fetch,
    proxyUrl: '/custom/cyber',
    maxEvents: 10,
  }).getSnapshot();
  assert.equal(seen[1][0], '/custom/cyber?limit=10');
});

test('createLiveCyberFeed requires a non-empty proxy URL', () => {
  assert.throws(() => createLiveCyberFeed({ proxyUrl: '  ' }), /proxy URL/i);
});

test('returns schema-conformant events, dropping malformed rows', async () => {
  const fetch = stubFetch(async () => okResponse(makePayload()));
  const events = await createLiveCyberFeed({ fetchImpl: fetch }).getSnapshot();

  // 3 valid events; the ransomware row is dropped by normalization.
  assert.equal(events.length, 3);
  for (const event of events) {
    assert.deepEqual(Object.keys(event).sort(), [
      'dst',
      'id',
      'ioc',
      'ref',
      'severity',
      'src',
      'ts',
      'type',
    ]);
  }
  // Provenance extras ride through for the click-to-inspect panel.
  assert.equal(events[0].ioc, '1.12.229.231');
  assert.equal(events[0].ref, 'https://cinsscore.com/');
  assert.equal(events[2].ioc, 'http://example.com/login');
  assert.equal(events[2].ref, 'https://openphish.com/');
  // The feed output is exactly what the layer's validator accepts.
  assert.equal(normalizeCyberEvents(events).length, 3);

  const [intrusion, scan, phishing] = events;
  assert.equal(intrusion.id, 'live-cins-1-12-229-231');
  assert.equal(intrusion.type, 'intrusion');
  assert.equal(intrusion.severity, 3);
  assert.deepEqual(intrusion.src, {
    country: 'China',
    code: 'CN',
    lat: 23.1181,
    lon: 113.2539,
  });
  assert.equal(scan.type, 'scan');
  assert.equal(phishing.type, 'phishing');
});

test('proxy failures throw descriptive errors (layer falls back to simulated)', async () => {
  const cases = [
    ['http error', stubFetch(async () => ({ ok: false, status: 502 })), /HTTP 502/],
    [
      'live:false payload',
      stubFetch(async () =>
        okResponse({ live: false, source: '', events: [], error: 'all upstreams failed' }),
      ),
      /all upstreams failed/,
    ],
    [
      'missing events',
      stubFetch(async () => okResponse({ live: true })),
      /unavailable/,
    ],
    [
      'invalid json',
      stubFetch(async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError('bad json');
        },
      })),
      /invalid JSON/,
    ],
    [
      'unreachable',
      stubFetch(async () => {
        throw new Error('socket hang up');
      }),
      /unreachable/,
    ],
  ];
  for (const [label, fetch, pattern] of cases) {
    await assert.rejects(
      () => createLiveCyberFeed({ fetchImpl: fetch }).getSnapshot(),
      pattern,
      label,
    );
  }
});

test('an empty live event list is a valid (empty) snapshot', async () => {
  const fetch = stubFetch(async () => okResponse(makePayload({ events: [] })));
  const events = await createLiveCyberFeed({ fetchImpl: fetch }).getSnapshot();
  assert.deepEqual(events, []);
});

test('abort signal is honored (pre-abort and mid-flight)', async () => {
  const fetch = stubFetch(async () => okResponse(makePayload()));
  const preAborted = new AbortController();
  preAborted.abort();
  await assert.rejects(
    () =>
      createLiveCyberFeed({ fetchImpl: fetch }).getSnapshot({
        signal: preAborted.signal,
      }),
    (error) => error.name === 'AbortError',
  );

  const midFlight = new AbortController();
  const slow = stubFetch(async (url, options) => {
    options.signal?.throwIfAborted?.();
    midFlight.abort();
    options.signal?.throwIfAborted?.();
    throw new DOMException('aborted', 'AbortError');
  });
  await assert.rejects(
    () =>
      createLiveCyberFeed({ fetchImpl: slow }).getSnapshot({
        signal: midFlight.signal,
      }),
    (error) => error.name === 'AbortError',
  );
});

test('LIVE_FEED_LABEL names the real aggregated sources', () => {
  assert.match(LIVE_FEED_LABEL, /CINS Army/);
  assert.match(LIVE_FEED_LABEL, /blocklist\.de/);
  assert.match(LIVE_FEED_LABEL, /Spamhaus/);
  assert.match(LIVE_FEED_LABEL, /OpenPhish/);
  assert.notEqual(LIVE_FEED_LABEL.toLowerCase(), 'simulated feed');
});
