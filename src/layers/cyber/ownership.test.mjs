/**
 * Cyber layer ownership tests.
 *
 * The layer imports the real `cesium` package; when it cannot be resolved
 * (e.g. a checkout without node_modules) these hooks fall back to the
 * local ./cesium-test-stub.mjs so the lifecycle tests still run headless.
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
const { LIVE_FEED_LABEL } = await import('./liveFeed.js');

const endpoint = (code, country, lat, lon) => ({ code, country, lat, lon });
const attack = (id, overrides = {}) => ({
  id,
  src: endpoint('RU', 'Russia', 55.7, 37.6),
  dst: endpoint('US', 'United States', 38.9, -77.0),
  type: 'ddos',
  severity: 4,
  ts: 1758550000000,
  ...overrides,
});

function harness(feedImpl, { liveSource = null } = {}) {
  const sources = [];
  const events = [];
  const viewer = {
    dataSources: {
      add(value) {
        sources.push(value);
      },
      remove(value) {
        sources.splice(sources.indexOf(value), 1);
      },
    },
  };
  const clears = [];
  const layer = createCyberLayer({
    source: createCyberSource({ feed: feedImpl }),
    liveSource,
    overlayHost: {
      setEntries(...args) {
        events.push(args);
      },
      setVisible() {},
      clearSource(sourceId) {
        clears.push(sourceId);
      },
    },
  });
  layer.init(viewer);
  layer.enable(viewer);
  return { layer, viewer, sources, events, clears };
}

const emptyStats = () => ({
  count: 0,
  byType: { ddos: 0, malware: 0, intrusion: 0, phishing: 0, scan: 0, c2: 0 },
  topSources: [],
  topDestinations: [],
  lastUpdate: null,
  error: null,
  simulated: true,
  feedMode: 'simulated',
  source: 'Simulated feed',
});

test('constructor rejects a missing source, bad source, or missing overlay host', () => {
  const host = { setEntries() {}, setVisible() {}, clearSource() {} };
  const source = createCyberSource({ feed: { getSnapshot: async () => [] } });
  assert.throws(() => createCyberLayer({ overlayHost: host }), TypeError);
  assert.throws(
    () => createCyberLayer({ source: {}, overlayHost: host }),
    TypeError,
  );
  assert.throws(() => createCyberLayer({ source }), TypeError);
});

test('layer identity mirrors the catalog contract', () => {
  const { layer, viewer } = harness({ getSnapshot: async () => [] });
  assert.equal(layer.id, 'cyber');
  assert.equal(layer.name, 'Cyber Intel');
  assert.equal(layer.icon, '🛡️');
  assert.equal(layer.source, 'Simulated feed');
  assert.equal(layer.updateInterval, 5000);
  layer.destroy(viewer);
});

test('update returns false and stats stay empty while disabled', async () => {
  const { layer, viewer } = harness({ getSnapshot: async () => [attack('a1')] });
  layer.disable(viewer);
  assert.equal(await layer.update(viewer), false);
  assert.deepEqual(layer.getStats(), emptyStats());
  assert.deepEqual(layer.getAnalystRecords(), []);
  layer.destroy(viewer);
});

test('late refresh cannot publish after disable, re-enable, or destroy', async () => {
  for (const action of ['disable', 'destroy']) {
    let resolve;
    let signal;
    const h = harness({
      getSnapshot(options) {
        signal = options.signal;
        return new Promise((done) => {
          resolve = done;
        });
      },
    });
    const pending = h.layer.update(h.viewer);
    h.layer[action](h.viewer);
    assert.equal(signal.aborted, true);
    if (action === 'disable') h.layer.enable(h.viewer);
    resolve([attack('late-1')]);
    assert.equal(await pending, false);
    assert.equal(h.layer.getStats().count, 0);
    assert.equal(h.events.length, 0);
    h.layer.destroy(h.viewer);
  }
});

test('two displays own separate data sources and destruction', async () => {
  const a = harness({ getSnapshot: async () => [attack('a1')] });
  const b = harness({ getSnapshot: async () => [] });
  await a.layer.update(a.viewer);
  await b.layer.update(b.viewer);
  assert.equal(a.layer.getStats().count, 1);
  assert.equal(b.layer.getStats().count, 0);
  a.layer.destroy();
  assert.equal(a.sources.length, 0);
  assert.equal(b.sources.length, 1);
  b.layer.destroy();
});

test('update aggregates stats in the exact HUD shape', async () => {
  const feed = {
    getSnapshot: async () => [
      attack('s1', { type: 'ddos', severity: 5, src: endpoint('CN', 'China', 39.9, 116.4) }),
      attack('s2', { type: 'ddos', severity: 3, src: endpoint('CN', 'China', 39.9, 116.4) }),
      attack('s3', { type: 'malware', severity: 2, src: endpoint('RU', 'Russia', 55.7, 37.6) }),
      attack('s4', {
        type: 'phishing',
        severity: 1,
        src: endpoint('BR', 'Brazil', -23.5, -46.6),
        dst: endpoint('DE', 'Germany', 52.5, 13.4),
      }),
      attack('s5', { type: 'c2', severity: 4, dst: endpoint('DE', 'Germany', 52.5, 13.4) }),
      attack('s6', { type: 'intrusion', severity: 4 }),
      attack('s7', { type: 'scan', severity: 1 }),
      attack('bad', { type: 'ransomware' }), // rejected by normalization
    ],
  };
  const { layer, viewer, events } = harness(feed);
  assert.equal(await layer.update(viewer), true);
  const stats = layer.getStats();
  assert.equal(stats.count, 7);
  assert.deepEqual(stats.byType, {
    ddos: 2,
    malware: 1,
    intrusion: 1,
    phishing: 1,
    scan: 1,
    c2: 1,
  });
  assert.deepEqual(stats.topSources, [
    { code: 'RU', country: 'Russia', count: 4 },
    { code: 'CN', country: 'China', count: 2 },
    { code: 'BR', country: 'Brazil', count: 1 },
  ]);
  assert.deepEqual(stats.topDestinations, [
    { code: 'US', country: 'United States', count: 5 },
    { code: 'DE', country: 'Germany', count: 2 },
  ]);
  assert.ok(typeof stats.lastUpdate === 'number');
  assert.equal(stats.error, null);
  assert.equal(stats.simulated, true);
  // Overlay entries published once for the visible cohort.
  assert.equal(events.length, 1);
  assert.equal(events[0][0], 'cyber');
  assert.ok(events[0][1].length > 0);
  assert.deepEqual(layer.getStats().byType, stats.byType);
  layer.destroy(viewer);
});

test('top endpoints are capped at five entries', async () => {
  const feed = {
    getSnapshot: async () =>
      Array.from({ length: 8 }, (_, i) =>
        attack(`cap-${i}`, {
          src: endpoint(`C${i}`, `Country ${i}`, 10 + i, 20 + i),
        }),
      ),
  };
  const { layer, viewer } = harness(feed);
  await layer.update(viewer);
  assert.equal(layer.getStats().topSources.length, 5);
  layer.destroy(viewer);
});

test('rendered arcs are capped near 300 while stats count everything', async () => {
  const feed = {
    getSnapshot: async () =>
      Array.from({ length: 400 }, (_, i) => attack(`flood-${i}`)),
  };
  const { layer, viewer, sources } = harness(feed);
  await layer.update(viewer);
  const entities = sources[0].entities.values;
  const arcs = entities.filter((e) => String(e.id).startsWith('cyber:arc:'));
  const markers = entities.filter((e) => String(e.id).startsWith('cyber:dst:'));
  assert.equal(arcs.length, 300);
  assert.equal(markers.length, 300);
  assert.equal(layer.getStats().count, 400);
  layer.destroy(viewer);
});

test('getAnalystRecords returns plain JSON-safe attack records', async () => {
  const { layer, viewer } = harness({
    getSnapshot: async () => [attack('r1', { type: 'c2', severity: 5 })],
  });
  await layer.update(viewer);
  const records = layer.getAnalystRecords();
  assert.equal(records.length, 1);
  assert.deepEqual(records[0], {
    id: 'r1',
    type: 'c2',
    severity: 5,
    srcCode: 'RU',
    srcCountry: 'Russia',
    srcLat: 55.7,
    srcLon: 37.6,
    dstCode: 'US',
    dstCountry: 'United States',
    dstLat: 38.9,
    dstLon: -77.0,
    timeMs: 1758550000000,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(records)), records);
  layer.destroy(viewer);
});

test('getAnalystRecords is empty while disabled and honors maxCount', async () => {
  const { layer, viewer } = harness({
    getSnapshot: async () => [attack('r1'), attack('r2')],
  });
  await layer.update(viewer);
  assert.equal(layer.getAnalystRecords(1).length, 1);
  layer.disable(viewer);
  assert.deepEqual(layer.getAnalystRecords(), []);
  layer.destroy(viewer);
});

test('feed errors surface on stats and clear on the next success', async () => {
  let fail = true;
  const { layer, viewer } = harness({
    getSnapshot: async () => {
      if (fail) throw new Error('feed offline');
      return [attack('ok-1')];
    },
  });
  assert.equal(await layer.update(viewer), false);
  assert.equal(layer.getStats().error, 'feed offline');
  assert.equal(layer.getStats().count, 0);
  fail = false;
  assert.equal(await layer.update(viewer), true);
  assert.equal(layer.getStats().error, null);
  assert.equal(layer.getStats().count, 1);
  layer.destroy(viewer);
});

test('createCyberSource requires a feed and rejects malformed snapshots', async () => {
  assert.throws(() => createCyberSource(), TypeError);
  assert.throws(() => createCyberSource({}), TypeError);
  assert.throws(() => createCyberSource({ feed: {} }), TypeError);
  const malformed = createCyberSource({ feed: { getSnapshot: async () => ({}) } });
  await assert.rejects(malformed.getSnapshot({}), /Malformed cyber feed snapshot/);
});

test('source passes the abort signal through to the feed', async () => {
  let seen;
  const source = createCyberSource({
    feed: {
      getSnapshot: async ({ signal }) => {
        seen = signal;
        return [];
      },
    },
  });
  const controller = new AbortController();
  await source.getSnapshot({ signal: controller.signal });
  assert.equal(seen, controller.signal);
});

/* ------------------------------------------------------------------ */
/* Live feed opt-in (workstream 1): simulated stays the default; the   */
/* live feed only activates through setFeedMode, and attributions      */
/* never mix.                                                         */
/* ------------------------------------------------------------------ */

const liveAttack = attack('live-1', {
  src: endpoint('NL', 'Netherlands', 52.4, 4.9),
  type: 'c2',
});
const makeLiveSource = () =>
  createCyberSource({ feed: { getSnapshot: async () => [liveAttack] } });

test('feed mode defaults to simulated with simulated attribution', () => {
  const { layer, viewer } = harness(
    { getSnapshot: async () => [] },
    { liveSource: makeLiveSource() },
  );
  assert.equal(layer.getFeedMode(), 'simulated');
  assert.equal(layer.source, 'Simulated feed');
  assert.deepEqual(layer.getStats(), emptyStats());
  layer.destroy(viewer);
});

test('setFeedMode rejects unknown modes and unconfigured live feeds', () => {
  const { layer, viewer } = harness({ getSnapshot: async () => [] });
  assert.throws(() => layer.setFeedMode('real'), /Unknown cyber feed mode/);
  assert.throws(() => layer.setFeedMode('live'), /not configured/);
  assert.equal(layer.getRowControls, undefined);
  const live = harness({ getSnapshot: async () => [] }, { liveSource: makeLiveSource() });
  assert.equal(live.layer.setFeedMode('live'), 'live');
  assert.equal(live.layer.setFeedMode('live'), 'live'); // idempotent
  live.layer.destroy(live.viewer);
  layer.destroy(viewer);
});

test('setFeedMode toggles live on and off with clean attribution', async () => {
  const { layer, viewer } = harness(
    { getSnapshot: async () => [attack('sim-1')] },
    { liveSource: makeLiveSource() },
  );
  await layer.update(viewer);
  assert.equal(layer.getStats().count, 1);
  assert.equal(layer.getStats().simulated, true);

  layer.setFeedMode('live');
  assert.equal(layer.getFeedMode(), 'live');
  assert.equal(layer.source, LIVE_FEED_LABEL);
  // Prior simulated data is cleared immediately — never shown under live.
  const liveStats = layer.getStats();
  assert.equal(liveStats.count, 0);
  assert.equal(liveStats.simulated, false);
  assert.equal(liveStats.feedMode, 'live');
  assert.equal(liveStats.source, LIVE_FEED_LABEL);

  await layer.update(viewer);
  assert.equal(layer.getStats().count, 1);
  assert.equal(layer.getStats().simulated, false);
  assert.equal(layer.source, LIVE_FEED_LABEL);

  layer.setFeedMode('simulated');
  assert.equal(layer.getFeedMode(), 'simulated');
  assert.equal(layer.source, 'Simulated feed');
  assert.equal(layer.getStats().count, 0);
  assert.equal(layer.getStats().simulated, true);
  assert.equal(layer.getStats().source, 'Simulated feed');
  await layer.update(viewer);
  assert.equal(layer.getStats().count, 1);
  assert.equal(layer.getStats().simulated, true);
  layer.destroy(viewer);
});

test('switching feed mode clears prior feed data before the next update', async () => {
  const { layer, viewer, clears } = harness(
    { getSnapshot: async () => [attack('sim-1')] },
    { liveSource: makeLiveSource() },
  );
  await layer.update(viewer);
  assert.equal(layer.getStats().count, 1);
  layer.setFeedMode('live');
  assert.deepEqual(clears, ['cyber']);
  assert.equal(layer.getStats().count, 0);
  assert.equal(layer.getStats().error, null);
  assert.equal(layer.getStats().lastUpdate, null);
  layer.destroy(viewer);
});

test('update in live mode renders live events with live attribution', async () => {
  const { layer, viewer, events } = harness(
    { getSnapshot: async () => [attack('sim-1')] },
    { liveSource: makeLiveSource() },
  );
  layer.setFeedMode('live');
  assert.equal(await layer.update(viewer), true);
  const stats = layer.getStats();
  assert.equal(stats.count, 1);
  assert.equal(stats.simulated, false);
  assert.equal(stats.feedMode, 'live');
  assert.equal(stats.source, LIVE_FEED_LABEL);
  assert.deepEqual(stats.topSources, [
    { code: 'NL', country: 'Netherlands', count: 1 },
  ]);
  assert.equal(events.length, 1);
  assert.equal(events[0][0], 'cyber');
  assert.equal(layer.getAnalystRecords()[0].id, 'live-1');
  layer.destroy(viewer);
});

test('getRowControls exposes the opt-in toggle chip with a live descriptor per read', () => {
  const { layer, viewer } = harness(
    { getSnapshot: async () => [] },
    { liveSource: makeLiveSource() },
  );
  let controls = layer.getRowControls();
  assert.equal(controls.chips.length, 1);
  const chip = controls.chips[0];
  assert.equal(chip.id, 'cyber-feed-mode');
  assert.equal(chip.label, 'GO LIVE');
  assert.equal(chip.active, false);
  assert.ok(chip.title.length > 0);

  chip.onClick();
  assert.equal(layer.getFeedMode(), 'live');
  // The panel re-reads the descriptor on click, so a stale chip can never
  // apply an inverted toggle.
  controls = layer.getRowControls();
  assert.equal(controls.chips[0].label, 'LIVE ●');
  assert.equal(controls.chips[0].active, true);
  controls.chips[0].onClick();
  assert.equal(layer.getFeedMode(), 'simulated');
  assert.equal(layer.getRowControls().chips[0].label, 'GO LIVE');
  layer.destroy(viewer);
});

test('row-controls listener is notified when the feed mode changes', () => {
  const { layer, viewer } = harness(
    { getSnapshot: async () => [] },
    { liveSource: makeLiveSource() },
  );
  let notified = 0;
  layer.setRowControlsListener(() => {
    notified += 1;
  });
  layer.setFeedMode('live');
  assert.equal(notified, 1);
  layer.setFeedMode('simulated');
  assert.equal(notified, 2);
  layer.setRowControlsListener(null); // safe removal
  layer.setFeedMode('live');
  assert.equal(notified, 2);
  layer.destroy(viewer);
});

test('live proxy failure falls back to simulated with a visible note', async () => {
  const failingLive = createCyberSource({
    feed: {
      getSnapshot: async () => {
        throw new Error('proxy 502');
      },
    },
  });
  const { layer, viewer } = harness(
    { getSnapshot: async () => [attack('sim-1')] },
    { liveSource: failingLive },
  );
  let notified = 0;
  layer.setRowControlsListener(() => {
    notified += 1;
  });
  layer.setFeedMode('live');
  assert.equal(layer.getFeedMode(), 'live');

  // The live fetch fails; the layer reverts to simulated in the same tick.
  assert.equal(await layer.update(viewer), true);
  assert.equal(layer.getFeedMode(), 'simulated');
  assert.equal(layer.source, 'Simulated feed');
  const stats = layer.getStats();
  assert.equal(stats.count, 1);
  assert.equal(stats.simulated, true);
  assert.equal(stats.source, 'Simulated feed');
  assert.match(stats.error, /Live feed unavailable.*proxy 502/);
  assert.match(stats.error, /showing simulated feed/);
  // The toggle chip was notified so it repaints back to GO LIVE.
  assert.ok(notified >= 1);
  assert.equal(layer.getRowControls().chips[0].label, 'GO LIVE');

  // The note clears on the next successful tick, like other feed errors.
  assert.equal(await layer.update(viewer), true);
  assert.equal(layer.getStats().error, null);
  layer.destroy(viewer);
});

test('abort during a live fetch does not trigger the simulated fallback', async () => {
  let signal;
  const { layer, viewer } = harness(
    { getSnapshot: async () => [attack('sim-1')] },
    {
      liveSource: createCyberSource({
        feed: {
          getSnapshot({ signal: feedSignal }) {
            signal = feedSignal;
            return new Promise((_, reject) => {
              feedSignal.addEventListener('abort', () => {
                reject(new DOMException('aborted', 'AbortError'));
              });
            });
          },
        },
      }),
    },
  );
  layer.setFeedMode('live');
  const pending = layer.update(viewer);
  layer.disable(viewer);
  assert.equal(signal.aborted, true);
  assert.equal(await pending, false);
  // Still in live mode: the abort was a lifecycle event, not a feed failure.
  assert.equal(layer.getFeedMode(), 'live');
  assert.equal(layer.source, LIVE_FEED_LABEL);
  layer.destroy(viewer);
});
