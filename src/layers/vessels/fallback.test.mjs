import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIngestion, createVesselFeed } from './ingestion.js';
import { createQueries } from './queries.js';
import { withSimulatedFallback } from './simulator.js';
import { layerFeedState } from '../../data/feedState.js';

const failingSource = (label) => ({
  label,
  getSnapshot: async () => {
    throw new Error('No AIS transport responded');
  },
});

// Mirrors the production wiring in index.js: the live source is wrapped in the
// seeded simulator BEFORE the feed ever sees it.
function setup(wrappedSource) {
  const feed = createVesselFeed();
  feed.enabled = true;
  feed.sessionId = 1;
  const applied = [];
  const labels = [];
  let count = 0;
  const ingestion = createIngestion({
    feed,
    readSource: () => wrappedSource,
    readViewer: () => ({}),
    getRowLimit: () => 500,
    readCount: () => count,
    now: () => 9999,
    setSourceLabel: (value) => labels.push(value),
    applyRows: (_, rows) => {
      applied.push(rows);
      count = rows.length;
    },
    classifySnapshot: (payload) => ({
      acceptedRows: payload.rows,
      acceptedRowCount: payload.rows.length,
      rawRowCount: payload.rows.length,
      transportStatus: payload.status,
      lastMessageAt: payload.lastMessageAt,
      error: payload.rows.length ? null : 'No accepted positions',
    }),
    isDefinitiveTransportFailure: () => false,
    isGraceEligibleTransport: () => false,
    markUnavailable: (error) => {
      feed.error = error;
    },
    settleFirstConnect: (phase) => {
      feed.firstConnectPhase = phase;
    },
  });
  return { feed, applied, labels, ...ingestion };
}

function queryStats(feed) {
  const { methods } = createQueries({
    vesselState: { state: { feed } },
    services: { labels: {} },
    parts: {},
    layer: {},
    options: {},
  });
  return methods.getStats();
}

test('dead AIS transports publish simulated vessels and the chip reads FALLBACK', async () => {
  const probe = setup(withSimulatedFallback(failingSource('AISStream'), { seed: 42 }));
  await probe.methods.update();

  assert.equal(probe.feed.simulated, true, 'feed marked simulated');
  assert.equal(probe.feed.sourceLabel, 'SIMULATED', 'source label is exactly SIMULATED');
  assert.match(probe.feed.coverage, /live AIS unreachable · seeded vessel positions/, 'coverage explains the outage');
  assert.equal(probe.feed.error, null, 'no error left on a clean fallback snapshot');
  assert.ok(probe.applied.length > 0, 'simulated rows published');
  assert.ok(probe.applied[0].length > 0, 'simulated vessels published');
  assert.ok(
    probe.applied[0].every((row) => row.simulated === true),
    'every published row is flagged simulated',
  );
  assert.ok(
    probe.applied[0].some((row) => /^SIM /.test(row.name)),
    'vessel names are self-identifying as simulated',
  );

  const stats = queryStats(probe.feed);
  assert.equal(stats.fallback, true);
  assert.equal(stats.mode, 'sim');
  assert.equal(stats.error, null);
  assert.equal(stats.source, 'SIMULATED', 'panel text starts FALLBACK · SIMULATED');
  assert.equal(layerFeedState(stats), 'fallback', 'panel chip reads FALLBACK');
});

test('vesselDisplayRow defaults to a non-simulated row', () => {
  const probe = setup(withSimulatedFallback(failingSource('AISStream'), { seed: 1 }));
  const record = {
    name: 'OCEAN TRADER',
    mmsi: '123456789',
    type: 'Cargo',
    speed: 12,
    heading: 90,
    latitude: 40,
    longitude: -70,
    positionTime: null,
  };
  assert.equal(probe.vesselDisplayRow(record).simulated, false);
  assert.equal(probe.vesselDisplayRow(record, true).simulated, true);
});

test('live AIS snapshots pass through untouched (no fallback flags)', async () => {
  const live = failingSource('AISStream');
  live.getSnapshot = async () => ({
    records: [
      {
        id: '111111111',
        reference: '111111111',
        latitude: 51.9,
        longitude: 4.4,
        speed: 10,
        course: 90,
        heading: 90,
        name: 'OCEAN TRADER',
        type: 'Cargo',
        mmsi: '111111111',
        destination: 'ROTTERDAM',
        timestamp: 1234,
      },
    ],
    source: 'AISStream',
    coverage: 'terrestrial ais network',
    observedAtMs: 1234,
    freshness: 'current',
    complete: true,
  });
  const probe = setup(withSimulatedFallback(live, { seed: 42 }));
  await probe.methods.update();
  assert.equal(probe.feed.simulated, false);
  assert.equal(probe.feed.sourceLabel, 'AISStream');
  const stats = queryStats(probe.feed);
  assert.equal(stats.fallback, false);
  assert.equal(stats.mode, 'live');
  assert.equal(layerFeedState(stats), 'nominal');
});
