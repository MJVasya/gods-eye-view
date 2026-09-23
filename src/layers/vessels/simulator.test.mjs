import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSimulatedVesselFeed,
  withSimulatedFallback,
  SIMULATED_VESSEL_SOURCE_LABEL,
  SIMULATED_VESSEL_COVERAGE,
} from './simulator.js';

function collectSnapshots(seed, ticks, opts = {}) {
  const feed = createSimulatedVesselFeed({ seed, now: () => 1_000_000, ...opts });
  return Promise.all(Array.from({ length: ticks }, () => feed.getSnapshot()));
}

function assertValidRecord(rec) {
  for (const field of [
    'id', 'reference', 'latitude', 'longitude', 'name', 'imo', 'type',
    'destination', 'speedMps', 'courseDeg', 'headingDeg', 'observedAtMs',
  ]) {
    assert.ok(field in rec, `record has ${field}`);
  }
  assert.match(rec.id, /^000\d{6}$/, 'MMSI uses the unassigned 000 MID block');
  assert.equal(rec.id, rec.reference);
  assert.match(rec.name, /^SIM /, 'simulated vessel name is self-labeling');
  assert.ok(rec.latitude >= -90 && rec.latitude <= 90);
  assert.ok(rec.longitude >= -180 && rec.longitude <= 180);
  assert.ok(rec.courseDeg >= 0 && rec.courseDeg < 360);
}

test('snapshots match the live vessel source contract and are honest about simulation', async () => {
  const feed = createSimulatedVesselFeed({ seed: 90212 });
  const snap = await feed.getSnapshot();
  assert.ok(snap.records.length > 0, 'fleet is non-empty');
  for (const rec of snap.records) assertValidRecord(rec);
  assert.equal(snap.simulated, true);
  assert.equal(snap.source, SIMULATED_VESSEL_SOURCE_LABEL);
  assert.match(snap.source, /Simulated/i);
  assert.equal(snap.coverage, SIMULATED_VESSEL_COVERAGE);
  assert.match(snap.coverage, /seeded vessel positions/i);
  assert.equal(snap.complete, true);
  assert.equal(snap.freshness, 'current');
  assert.equal(snap.rawRowCount, snap.records.length);
  assert.equal(snap.stale, false);
});

test('maxRows is honored', async () => {
  const feed = createSimulatedVesselFeed({ seed: 90212 });
  const snap = await feed.getSnapshot({ maxRows: 10 });
  assert.equal(snap.records.length, 10);
});

test('same seed yields identical snapshots across ticks; vessels move between ticks', async () => {
  const a = await collectSnapshots(90212, 3);
  const b = await collectSnapshots(90212, 3);
  for (let i = 0; i < 3; i += 1) {
    assert.deepEqual(a[i].records, b[i].records, `tick ${i} identical`);
  }
  const moved = a[0].records.some(
    (rec, i) =>
      rec.latitude !== a[1].records[i].latitude || rec.longitude !== a[1].records[i].longitude,
  );
  assert.ok(moved, 'positions advance between ticks');
});

test('different seeds diverge', async () => {
  const a = await collectSnapshots(90212, 1);
  const b = await collectSnapshots(1234, 1);
  assert.notDeepEqual(a[0].records, b[0].records);
});

test('decorator passes through live snapshots untouched (simulated:false)', async () => {
  const live = {
    label: 'AIS',
    getSnapshot: async () => ({ records: [{ id: '123456789' }], complete: true, source: 'AIS' }),
  };
  const wrapped = withSimulatedFallback(live, { seed: 90212 });
  assert.equal(wrapped.label, 'AIS');
  const snap = await wrapped.getSnapshot();
  assert.equal(snap.simulated, false);
  assert.equal(snap.source, 'AIS');
});

test('decorator falls back to simulated feed when live fails', async () => {
  const live = {
    label: 'AIS',
    getSnapshot: async () => {
      throw new Error('Malformed vessel response');
    },
  };
  const wrapped = withSimulatedFallback(live, { seed: 90212, liveCooldownMs: 60_000 });
  const snap = await wrapped.getSnapshot();
  assert.ok(snap.records.length > 0, 'simulated fleet served');
  assert.equal(snap.simulated, true);
  assert.match(snap.source, /Simulated/i);
  for (const rec of snap.records) assertValidRecord(rec);
});

test('decorator re-probes live after the cooldown and recovers to real data', async () => {
  let liveOk = false;
  let clock = 3_000_000;
  const live = {
    label: 'AIS',
    getSnapshot: async () => {
      if (!liveOk) throw new Error('boom');
      return { records: [{ id: '999888777' }], source: 'AIS', complete: true };
    },
  };
  const wrapped = withSimulatedFallback(live, {
    seed: 90212,
    liveCooldownMs: 30_000,
    now: () => clock,
  });
  assert.equal((await wrapped.getSnapshot()).simulated, true);
  liveOk = true;
  clock += 40_000;
  const recovered = await wrapped.getSnapshot();
  assert.equal(recovered.simulated, false);
  assert.equal(recovered.records[0].id, '999888777');
});

test('decorator rethrows AbortError and is idempotent', async () => {
  const live = {
    label: 'AIS',
    getSnapshot: async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    },
  };
  const wrapped = withSimulatedFallback(live, { seed: 90212 });
  await assert.rejects(wrapped.getSnapshot(), { name: 'AbortError' });
  assert.equal(withSimulatedFallback(wrapped, { seed: 90212 }), wrapped, 'no double wrapping');
  const plain = {};
  assert.equal(withSimulatedFallback(null), null);
  assert.equal(withSimulatedFallback(plain), plain, 'non-source passes through by reference');
});
