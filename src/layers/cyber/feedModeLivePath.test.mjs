/**
 * Phase 4c — end-to-end verification of the cyber GO LIVE path with the
 * REAL live feed stack (createLiveCyberFeed → createCyberSource →
 * createCyberLayer), mocking only the network via fetchImpl.
 *
 * Covers: chip click → setFeedMode → getSnapshot → fetch('/api/cyber-feed')
 * → normalizeCyberEvents → records → rendering → stats/HUD/chip state, plus
 * the three failure classes (network, malformed payload, hang/timeout) and
 * their distinct user-visible fallback notes.
 *
 * Headless: reuses the local ./cesium-test-stub.mjs fallback when the real
 * `cesium` package cannot be resolved.
 */
import { register } from 'node:module';
import assert from 'node:assert/strict';
import test from 'node:test';

const stubUrl = new URL('./cesium-test-stub.mjs', import.meta.url).href;
register(
  `data:text/javascript,${encodeURIComponent(`
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'cesium') {
    try {
      return await nextResolve(specifier, context);
    } catch {
      return { url: ${JSON.stringify(stubUrl)}, shortCircuit: true };
    }
  }
  return nextResolve(specifier, context);
}
`)}`,
);

const { createCyberLayer, createCyberSource } = await import('./index.js');
const {
  createLiveCyberFeed,
  LIVE_FEED_LABEL,
  DEFAULT_CYBER_FEED_PROXY_URL,
} = await import('./liveFeed.js');

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const endpoint = (code, country, lat, lon) => ({ code, country, lat, lon });
const simAttack = (id) => ({
  id,
  src: endpoint('RU', 'Russia', 55.7, 37.6),
  dst: endpoint('US', 'United States', 38.9, -77.0),
  type: 'ddos',
  severity: 4,
  ts: 1758550000000,
});

// Proxy-shaped payload: 3 valid rows + 1 malformed (dropped).
const LIVE_EVENTS = [
  {
    id: 'live-cins-1',
    src: endpoint('CN', 'China', 23.1181, 113.2539),
    dst: endpoint('NL', 'Netherlands', 52.3676, 4.9041),
    type: 'intrusion',
    severity: 3,
    ts: 1758550000000,
    ioc: '1.2.3.4',
  },
  {
    id: 'live-blocklist-1',
    src: endpoint('US', 'United States', 38.9, -77.0),
    dst: endpoint('DE', 'Germany', 52.5, 13.4),
    type: 'scan',
    severity: 2,
    ts: 1758550001000,
  },
  {
    id: 'live-openphish-1',
    src: endpoint('RU', 'Russia', 55.8, 37.6),
    dst: endpoint('GB', 'United Kingdom', 51.5, -0.13),
    type: 'phishing',
    severity: 3,
    ts: 1758550002000,
  },
  {
    id: 'live-bogus-1',
    src: endpoint('XX', 'Nowhere', 0, 0),
    dst: endpoint('YY', 'Elsewhere', 1, 1),
    type: 'ransomware', // invalid threat type → dropped
    severity: 9,
    ts: 1758550003000,
  },
];

const proxyPayload = (overrides = {}) => ({
  live: true,
  source: 'cins,blocklist,spamhaus,openphish',
  generated_at: 1758550000000,
  cache_ttl_s: 60,
  events: LIVE_EVENTS,
  ...overrides,
});

const okResponse = (payload) => ({
  ok: true,
  status: 200,
  json: async () => payload,
});

function harness(fetchImpl, feedOpts = {}) {
  const sources = [];
  const viewer = {
    dataSources: {
      add: (value) => sources.push(value),
      remove: (value) => sources.splice(sources.indexOf(value), 1),
    },
  };
  const layer = createCyberLayer({
    source: createCyberSource({
      feed: { getSnapshot: async () => [simAttack('sim-1')] },
    }),
    liveSource: createCyberSource({
      feed: createLiveCyberFeed({ fetchImpl, timeoutMs: 250, ...feedOpts }),
    }),
    overlayHost: {
      setEntries() {},
      setVisible() {},
      clearSource() {},
    },
  });
  layer.init(viewer);
  layer.enable(viewer);
  return { layer, viewer };
}

/** Simulate the layer panel's chip click: re-read the descriptor, then act. */
function clickFeedChip(layer) {
  const chip = layer
    .getRowControls()
    ?.chips?.find((entry) => entry.id === 'cyber-feed-mode');
  assert.ok(chip, 'feed-mode chip descriptor is present');
  assert.equal(typeof chip.onClick, 'function');
  chip.onClick();
}

/* ------------------------------------------------------------------ */
/* Live path                                                           */
/* ------------------------------------------------------------------ */

test('GO LIVE tap renders real proxy events with live attribution', async () => {
  const seen = [];
  const fetch = async (url, options) => {
    seen.push([url, options]);
    return okResponse(proxyPayload());
  };
  const { layer, viewer } = harness(fetch);

  assert.equal(DEFAULT_CYBER_FEED_PROXY_URL, '/api/cyber-feed');
  clickFeedChip(layer); // GO LIVE
  assert.equal(layer.getFeedMode(), 'live');
  assert.equal(await layer.update(viewer), true);

  // The real proxy path was hit with the documented contract.
  assert.equal(seen.length, 1);
  assert.equal(seen[0][0], '/api/cyber-feed?limit=96');
  assert.equal(seen[0][1].headers.accept, 'application/json');

  const stats = layer.getStats();
  assert.equal(stats.count, 3); // malformed row dropped
  assert.equal(stats.simulated, false);
  assert.equal(stats.feedMode, 'live');
  assert.equal(stats.source, LIVE_FEED_LABEL);
  assert.equal(layer.source, LIVE_FEED_LABEL);
  assert.equal(stats.error, null);

  // Chip + retained records follow the mode.
  const chip = layer.getRowControls().chips[0];
  assert.equal(chip.label, 'LIVE ●');
  assert.equal(chip.active, true);
  assert.match(chip.title, /One tap returns to the simulated feed/);
  const entry = layer.getCyberEvent('live-cins-1');
  assert.equal(entry?.feedMode, 'live');
  assert.equal(entry?.sourceLabel, LIVE_FEED_LABEL);

  // One tap back to simulated.
  clickFeedChip(layer);
  assert.equal(layer.getFeedMode(), 'simulated');
  assert.equal(await layer.update(viewer), true);
  assert.equal(layer.getStats().count, 1);
  assert.equal(layer.getStats().source, 'Simulated feed');
  layer.destroy(viewer);
});

/* ------------------------------------------------------------------ */
/* Failure classes → distinct user-visible fallback notes              */
/* ------------------------------------------------------------------ */

test('network failure falls back with a distinct unreachable note', async () => {
  const { layer, viewer } = harness(async () => {
    throw new Error('socket hang up');
  });
  clickFeedChip(layer);
  assert.equal(await layer.update(viewer), true);
  assert.equal(layer.getFeedMode(), 'simulated');
  const stats = layer.getStats();
  assert.equal(stats.count, 1); // simulated rows rendered
  assert.match(stats.error, /proxy unreachable/);
  assert.match(stats.error, /showing simulated feed/);
  assert.equal(layer.getRowControls().chips[0].label, 'GO LIVE');
  layer.destroy(viewer);
});

test('HTTP error falls back with a distinct status note', async () => {
  const { layer, viewer } = harness(async () => ({
    ok: false,
    status: 502,
  }));
  clickFeedChip(layer);
  assert.equal(await layer.update(viewer), true);
  assert.match(layer.getStats().error, /HTTP 502/);
  layer.destroy(viewer);
});

test('malformed payload falls back with a distinct payload note', async () => {
  const { layer, viewer } = harness(async () =>
    okResponse(proxyPayload({ live: true, events: undefined })),
  );
  clickFeedChip(layer);
  assert.equal(await layer.update(viewer), true);
  const stats = layer.getStats();
  assert.equal(layer.getFeedMode(), 'simulated');
  assert.match(stats.error, /malformed/);
  assert.match(stats.error, /showing simulated feed/);
  layer.destroy(viewer);
});

test('live:false payload falls back with the proxy error surfaced', async () => {
  const { layer, viewer } = harness(async () =>
    okResponse({
      live: false,
      source: '',
      events: [],
      error: 'all upstreams failed',
    }),
  );
  clickFeedChip(layer);
  assert.equal(await layer.update(viewer), true);
  assert.match(layer.getStats().error, /all upstreams failed/);
  layer.destroy(viewer);
});

test('hung proxy times out and falls back instead of wedging', async () => {
  const hanging = (url, { signal }) =>
    new Promise((_, reject) => {
      signal?.addEventListener?.('abort', () =>
        reject(signal.reason ?? new DOMException('aborted', 'AbortError')),
      );
    });
  const { layer, viewer } = harness(hanging, { timeoutMs: 80 });
  clickFeedChip(layer);
  const started = Date.now();
  assert.equal(await layer.update(viewer), true);
  assert.ok(
    Date.now() - started < 5000,
    'timeout must release the tick on its own schedule',
  );
  assert.equal(layer.getFeedMode(), 'simulated');
  assert.match(layer.getStats().error, /timed out after 80ms/);
  layer.destroy(viewer);
});

test('user-initiated abort during a live fetch stays silent (no fallback note)', async () => {
  const hanging = (url, { signal }) =>
    new Promise((_, reject) => {
      signal?.addEventListener?.('abort', () =>
        reject(signal.reason ?? new DOMException('aborted', 'AbortError')),
      );
    });
  const { layer, viewer } = harness(hanging);
  clickFeedChip(layer); // GO LIVE
  const pending = layer.update(viewer);
  clickFeedChip(layer); // back to simulated mid-flight → aborts the request
  assert.equal(await pending, false);
  assert.equal(layer.getFeedMode(), 'simulated');
  assert.equal(layer.getStats().error, null);
  layer.destroy(viewer);
});
