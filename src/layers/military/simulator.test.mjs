import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSimulatedMilitaryFeed,
  withSimulatedFallback,
  SIMULATED_MILITARY_SOURCE_LABEL,
  SIMULATED_MILITARY_COVERAGE,
} from './simulator.js';

function collectSnapshots(seed, ticks, opts = {}) {
  const feed = createSimulatedMilitaryFeed({ seed, now: () => 1_000_000, ...opts });
  return Promise.all(Array.from({ length: ticks }, () => feed.getSnapshot()));
}

function assertValidRecord(rec) {
  for (const field of [
    'id', 'reference', 'latitude', 'longitude', 'callsign', 'originCountry',
    'positionTimeMs', 'contactTimeMs', 'baroAltitudeM', 'ellipsoidAltitudeM',
    'onGround', 'speedMps', 'courseDeg', 'verticalRateMps', 'category',
    'typeCode', 'registration', 'operator',
  ]) {
    assert.ok(field in rec, `record has ${field}`);
  }
  assert.match(rec.id, /^ae[0-9a-f]{4}$/, 'hex in the AE military block');
  assert.equal(rec.id, rec.reference);
  assert.match(rec.callsign, /^SM\d{3}$/, 'callsign is self-identifying as simulated');
  assert.ok(rec.latitude >= -90 && rec.latitude <= 90);
  assert.ok(rec.longitude >= -180 && rec.longitude <= 180);
  assert.ok(rec.baroAltitudeM > 1000, 'airborne altitude');
}

test('snapshots match the adsb.lol source contract and are honest about simulation', async () => {
  const feed = createSimulatedMilitaryFeed({ seed: 90211 });
  const snap = await feed.getSnapshot();
  assert.ok(snap.records.length > 0, 'fleet is non-empty');
  for (const rec of snap.records) assertValidRecord(rec);
  assert.equal(snap.simulated, true);
  assert.equal(snap.source, SIMULATED_MILITARY_SOURCE_LABEL);
  assert.match(snap.source, /Simulated/i);
  assert.equal(snap.coverage, SIMULATED_MILITARY_COVERAGE);
  assert.match(snap.coverage, /seeded military tracks/i);
  assert.equal(snap.complete, true);
  assert.equal(snap.freshness, 'current');
});

test('same seed yields identical snapshots across ticks; aircraft move between ticks', async () => {
  const a = await collectSnapshots(90211, 3);
  const b = await collectSnapshots(90211, 3);
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
  const a = await collectSnapshots(90211, 1);
  const b = await collectSnapshots(777, 1);
  assert.notDeepEqual(a[0].records, b[0].records);
});

test('decorator passes through live snapshots untouched (simulated:false)', async () => {
  const live = {
    label: 'adsb.lol',
    getSnapshot: async () => ({ records: [{ id: 'ae1234' }], complete: true, source: 'adsb.lol' }),
  };
  const wrapped = withSimulatedFallback(live, { seed: 90211 });
  assert.equal(wrapped.label, 'adsb.lol');
  const snap = await wrapped.getSnapshot();
  assert.equal(snap.simulated, false);
  assert.equal(snap.source, 'adsb.lol');
});

test('decorator falls back to simulated feed when live fails', async () => {
  const live = {
    label: 'adsb.lol',
    getSnapshot: async () => {
      throw new Error('Malformed adsb.lol response');
    },
  };
  const wrapped = withSimulatedFallback(live, { seed: 90211, liveCooldownMs: 60_000 });
  const snap = await wrapped.getSnapshot();
  assert.ok(snap.records.length > 0, 'simulated fleet served');
  assert.equal(snap.simulated, true);
  assert.match(snap.source, /Simulated/i);
  for (const rec of snap.records) assertValidRecord(rec);
});

test('decorator re-probes live after the cooldown and recovers to real data', async () => {
  let liveOk = false;
  let clock = 2_000_000;
  const live = {
    label: 'adsb.lol',
    getSnapshot: async () => {
      if (!liveOk) throw new Error('boom');
      return { records: [{ id: 'ae9999' }], source: 'adsb.lol', complete: true };
    },
  };
  const wrapped = withSimulatedFallback(live, {
    seed: 90211,
    liveCooldownMs: 30_000,
    now: () => clock,
  });
  assert.equal((await wrapped.getSnapshot()).simulated, true);
  liveOk = true;
  clock += 40_000;
  const recovered = await wrapped.getSnapshot();
  assert.equal(recovered.simulated, false);
  assert.equal(recovered.records[0].id, 'ae9999');
});

test('decorator rethrows AbortError and is idempotent', async () => {
  const live = {
    label: 'adsb.lol',
    getSnapshot: async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    },
  };
  const wrapped = withSimulatedFallback(live, { seed: 90211 });
  await assert.rejects(wrapped.getSnapshot(), { name: 'AbortError' });
  assert.equal(withSimulatedFallback(wrapped, { seed: 90211 }), wrapped, 'no double wrapping');
  const plain = {};
  assert.equal(withSimulatedFallback(null), null);
  assert.equal(withSimulatedFallback(plain), plain, 'non-source passes through by reference');
});
