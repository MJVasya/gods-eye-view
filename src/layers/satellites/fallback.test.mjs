import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withSimulatedFallback } from './simulator.js';
import { CATALOG_GROUPS } from './policy.js';
import { createState, refreshSimulatedFlag } from './state.js';
import { createControls } from './controls.js';
import { layerFeedState } from '../../data/feedState.js';

const failingSource = (label) => ({
  label,
  async readGroup() {
    throw new Error('CelesTrak unreachable');
  },
});

function probeState() {
  return createState({
    services: {
      overlays: {
        setOverlayEntries() {},
        setOverlaySourceVisible() {},
        clearOverlaySource() {},
      },
    },
  });
}

function statsFor(state, source) {
  const { methods } = createControls({
    state,
    services: { layerState: {} },
    parts: {},
    source,
  });
  return methods.getStats();
}

test('CelesTrak outage serves the seeded catalog through the same readGroup path', async () => {
  const source = withSimulatedFallback(failingSource('CelesTrak'));
  for (const group of CATALOG_GROUPS) {
    const res = await source.readGroup(group.path);
    assert.equal(res.ok, true, `${group.tag}: simulated group resolves ok`);
    assert.equal(res.simulated, true, `${group.tag}: marked simulated`);
    assert.ok(res.text.trim().length > 0, `${group.tag}: synthetic TLE text`);
    assert.equal(res.text.split('\n').length % 3, 0, `${group.tag}: 3-line TLE shape`);
  }
  const stations = await source.readGroup('stations');
  assert.ok(stations.text.includes('ISS (ZARYA)'), 'stations group carries ISS');
});

test('live CelesTrak reads pass through untouched', async () => {
  const live = {
    label: 'CelesTrak',
    readGroup: async (path) => ({ ok: true, text: `0 ${path}\n1 00005U\n2 00005`, simulated: false }),
  };
  const source = withSimulatedFallback(live);
  const res = await source.readGroup('stations');
  assert.equal(res.ok, true);
  assert.equal(res.simulated, false);
  assert.match(res.text, /0 stations/);
});

test('stats flip between LIVE and FALLBACK as groups go simulated', () => {
  const state = probeState();
  const source = withSimulatedFallback(failingSource('CelesTrak'));

  // Simulated path: every core group served from the seeded catalog.
  state._simulatedCoreGroups = CATALOG_GROUPS.map((group) => group.tag);
  refreshSimulatedFlag(state);
  const fallbackStats = statsFor(state, source);
  assert.equal(fallbackStats.fallback, true);
  assert.equal(fallbackStats.mode, 'sim');
  assert.equal(fallbackStats.error, null);
  assert.equal(fallbackStats.source, 'SIMULATED', 'panel text starts FALLBACK · SIMULATED');
  assert.equal(layerFeedState(fallbackStats), 'fallback', 'panel chip reads FALLBACK');

  // Live recovery: no simulated groups left.
  state._simulatedCoreGroups = [];
  refreshSimulatedFlag(state);
  const liveStats = statsFor(state, source);
  assert.equal(liveStats.fallback, false);
  assert.equal(liveStats.mode, 'live');
  assert.equal(layerFeedState(liveStats), 'nominal');
});
