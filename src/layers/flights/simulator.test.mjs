import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSimulatedFlightFeed,
  withSimulatedFallback,
  SIMULATED_FLIGHT_SOURCE_LABEL,
  SIMULATED_FLIGHT_COVERAGE,
} from './simulator.js';

function collectSnapshots(seed, ticks, opts = {}) {
  const feed = createSimulatedFlightFeed({ seed, now: () => 1_000_000, ...opts });
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
  assert.ok(rec.latitude >= -90 && rec.latitude <= 90, 'latitude in range');
  assert.ok(rec.longitude >= -180 && rec.longitude <= 180, 'longitude in range');
  assert.ok(rec.baroAltitudeM > 1000, 'airborne altitude');
  assert.equal(rec.onGround, false);
  assert.match(rec.callsign, /^SIM\d{4}$/, 'callsign is self-identifying as simulated');
}

test('snapshots match the OpenSky source contract and are honest about simulation', async () => {
  const feed = createSimulatedFlightFeed({ seed: 90210 });
  const snap = await feed.getSnapshot();
  assert.ok(snap.records.length > 0, 'fleet is non-empty');
  for (const rec of snap.records) assertValidRecord(rec);
  assert.equal(snap.simulated, true);
  assert.equal(snap.source, SIMULATED_FLIGHT_SOURCE_LABEL);
  assert.match(snap.source, /Simulated/i);
  assert.equal(snap.coverage, SIMULATED_FLIGHT_COVERAGE);
  assert.match(snap.coverage, /seeded flight tracks/i);
  assert.equal(snap.complete, true);
  assert.equal(snap.freshness, 'current');
  assert.equal(snap.stale, false);
});

test('same seed yields identical snapshots across ticks; aircraft move between ticks', async () => {
  const a = await collectSnapshots(90210, 3);
  const b = await collectSnapshots(90210, 3);
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
  const a = await collectSnapshots(90210, 1);
  const b = await collectSnapshots(4242, 1);
  assert.notDeepEqual(a[0].records, b[0].records);
});

test('decorator passes through live snapshots untouched (simulated:false)', async () => {
  const liveSnapshot = {
    records: [{ id: 'abc' }],
    complete: true,
    source: 'OpenSky',
    observedAtMs: 1,
  };
  const live = {
    label: 'OpenSky',
    getSnapshot: async () => liveSnapshot,
  };
  const wrapped = withSimulatedFallback(live, { seed: 90210 });
  assert.equal(wrapped.label, 'OpenSky', 'label delegates to the live source');
  const snap = await wrapped.getSnapshot();
  assert.equal(snap.records, liveSnapshot.records, 'live records pass through by reference');
  assert.equal(snap.simulated, false);
  assert.equal(snap.source, 'OpenSky');
});

test('decorator falls back to simulated feed when live fails', async () => {
  const live = {
    label: 'OpenSky',
    getSnapshot: async () => {
      throw new Error('Malformed OpenSky response');
    },
  };
  const wrapped = withSimulatedFallback(live, { seed: 90210, liveCooldownMs: 60_000 });
  const snap = await wrapped.getSnapshot();
  assert.ok(snap.records.length > 0, 'simulated fleet served');
  assert.equal(snap.simulated, true);
  assert.match(snap.source, /Simulated/i, 'source label admits simulation');
  for (const rec of snap.records) assertValidRecord(rec);
  const snap2 = await wrapped.getSnapshot();
  assert.equal(snap2.simulated, true, 'cooldown keeps serving simulated feed');
});

test('decorator re-probes live after the cooldown and recovers to real data', async () => {
  let liveOk = false;
  let clock = 1_000_000;
  const live = {
    label: 'OpenSky',
    getSnapshot: async () => {
      if (!liveOk) throw new Error('boom');
      return { records: [{ id: 'real' }], source: 'OpenSky', complete: true };
    },
  };
  const wrapped = withSimulatedFallback(live, {
    seed: 90210,
    liveCooldownMs: 30_000,
    now: () => clock,
  });
  const fallbackSnap = await wrapped.getSnapshot();
  assert.equal(fallbackSnap.simulated, true);
  liveOk = true;
  clock += 10_000;
  const stillSim = await wrapped.getSnapshot();
  assert.equal(stillSim.simulated, true, 'cooldown not yet elapsed');
  clock += 30_000;
  const recovered = await wrapped.getSnapshot();
  assert.equal(recovered.simulated, false);
  assert.equal(recovered.records[0].id, 'real', 'live feed resumes');
});

test('decorator rethrows AbortError from live and respects pre-aborted signals', async () => {
  const live = {
    label: 'OpenSky',
    getSnapshot: async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    },
  };
  const wrapped = withSimulatedFallback(live, { seed: 90210 });
  await assert.rejects(wrapped.getSnapshot(), { name: 'AbortError' });
  const ctrl = new AbortController();
  ctrl.abort();
  const alwaysLive = { label: 'OpenSky', getSnapshot: async () => ({ records: [] }) };
  const wrapped2 = withSimulatedFallback(alwaysLive, { seed: 90210 });
  await assert.rejects(wrapped2.getSnapshot({}, { signal: ctrl.signal }), { name: 'AbortError' });
});

test('decorator is idempotent and passes non-sources through', async () => {
  const live = { label: 'OpenSky', getSnapshot: async () => ({ records: [] }) };
  const once = withSimulatedFallback(live, { seed: 90210 });
  assert.equal(withSimulatedFallback(once, { seed: 90210 }), once, 'no double wrapping');
  const plain = {};
  assert.equal(withSimulatedFallback(null), null);
  assert.equal(withSimulatedFallback(plain), plain, 'non-source passes through by reference');
});

test('optional live methods degrade gracefully under fallback', async () => {
  const live = {
    label: 'OpenSky',
    getSnapshot: async () => {
      throw new Error('down');
    },
    getTrack: async () => {
      throw new Error('down');
    },
  };
  const wrapped = withSimulatedFallback(live, { seed: 90210 });
  const track = await wrapped.getTrack('abc');
  assert.deepEqual(track.records, []);
  assert.equal(track.complete, true);
});
