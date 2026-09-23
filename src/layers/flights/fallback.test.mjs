import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFlightFeed, createIngestion } from './ingestion.js';
import { createQueries } from './queries.js';
import { layerFeedState } from '../../data/feedState.js';

const failingSource = (label) => ({
  label,
  getSnapshot: async () => {
    throw new Error('Malformed OpenSky response');
  },
});

function stubServices() {
  return {
    aircraftPresentation: {},
    labels: {},
    militaryRegistry: {},
    camera: {},
    focus: {},
    recession: {},
  };
}

function stubParts() {
  return { testing: { _clearDisplayFloorStateForTest() {} } };
}

test('live OpenSky failure publishes simulated traffic and the chip reads FALLBACK', async () => {
  // createFlightFeed wraps the source exactly like the production layer does.
  const feed = createFlightFeed(failingSource('OpenSky Network'));
  const snapshots = [];
  const { methods } = createIngestion({
    feed,
    getQuery: () => ({}),
    applySnapshot: (snapshot) => {
      snapshots.push(snapshot);
      return { count: snapshot.records.length, ids: new Set() };
    },
    setSourceLabel: () => {},
    applyPendingTrackingRestore: () => {},
  });
  await methods.update(null);

  assert.equal(feed._simulated, true, 'feed marked simulated');
  assert.equal(feed._lastSource, 'SIMULATED', 'source label is exactly SIMULATED');
  assert.match(feed._lastCoverage, /OpenSky unreachable · seeded flight tracks/, 'coverage explains the outage');
  assert.equal(feed._lastError, null, 'no error left on a clean fallback snapshot');
  assert.equal(feed._backoff, false, 'no backoff while simulated data flows');
  assert.ok(snapshots[0].records.length > 0, 'simulated aircraft published');
  assert.equal(snapshots[0].simulated, true);

  const { methods: queryMethods } = createQueries({
    flightState: { feed },
    services: stubServices(),
    parts: stubParts(),
    layer: {},
  });
  const stats = queryMethods.getStats();
  assert.equal(stats.fallback, true);
  assert.equal(stats.mode, 'sim');
  assert.equal(stats.error, null);
  assert.equal(stats.source, 'SIMULATED', 'panel text starts FALLBACK · SIMULATED');
  assert.equal(layerFeedState(stats), 'fallback', 'panel chip reads FALLBACK');
});

test('live snapshots pass through untouched (no fallback flags)', async () => {
  const live = {
    label: 'OpenSky Network',
    getSnapshot: async () => ({
      records: [],
      source: 'OpenSky Network',
      coverage: 'worldwide upstream snapshot',
      observedAtMs: 1234,
      freshness: 'current',
      complete: true,
    }),
  };
  const feed = createFlightFeed(live);
  const { methods } = createIngestion({
    feed,
    getQuery: () => ({}),
    applySnapshot: () => ({ count: 0, ids: new Set() }),
    setSourceLabel: () => {},
    applyPendingTrackingRestore: () => {},
  });
  await methods.update(null);
  assert.equal(feed._simulated, false);
  assert.equal(feed._lastSource, 'OpenSky Network');
  const { methods: queryMethods } = createQueries({
    flightState: { feed },
    services: stubServices(),
    parts: stubParts(),
    layer: {},
  });
  const stats = queryMethods.getStats();
  assert.equal(stats.fallback, false);
  assert.equal(stats.mode, 'live');
  assert.equal(layerFeedState(stats), 'nominal');
});
