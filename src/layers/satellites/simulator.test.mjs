import { test } from 'node:test';
import assert from 'node:assert/strict';
import { twoline2satrec, propagate } from 'satellite.js';
import {
  simulatedGroupTle,
  SIMULATED_GROUPS,
  createSimulatedSatelliteSource,
  withSimulatedFallback,
} from './simulator.js';

const EPOCH = new Date('2026-09-22T00:00:00Z');

function tleChecksum(line) {
  let sum = 0;
  for (let i = 0; i < 68; i += 1) {
    const ch = line[i];
    if (ch >= '0' && ch <= '9') sum += ch.charCodeAt(0) - 48;
    else if (ch === '-') sum += 1;
  }
  return String(sum % 10);
}

test('every supported group yields well-formed 3-line TLE text', () => {
  assert.ok(SIMULATED_GROUPS.length > 0, 'simulator covers groups');
  for (const group of SIMULATED_GROUPS) {
    const text = simulatedGroupTle(group, { seed: 424242, epoch: EPOCH });
    assert.ok(text.length > 0, `group ${group} must produce text`);
    const lines = text.split('\n');
    assert.equal(lines.length % 3, 0, `group ${group}: lines come in threes`);
    for (let i = 0; i < lines.length; i += 3) {
      const [name, l1, l2] = [lines[i], lines[i + 1], lines[i + 2]];
      assert.ok(name.length > 0, 'name line non-empty');
      assert.equal(l1.length, 69, `line 1 length for ${name}`);
      assert.equal(l2.length, 69, `line 2 length for ${name}`);
      assert.ok(l1.startsWith('1 '), `line 1 starts with "1 " for ${name}`);
      assert.ok(l2.startsWith('2 '), `line 2 starts with "2 " for ${name}`);
      assert.equal(l1[68], tleChecksum(l1), `line 1 checksum for ${name}`);
      assert.equal(l2[68], tleChecksum(l2), `line 2 checksum for ${name}`);
    }
  }
});

test('generated TLE propagates without error to plausible altitudes', () => {
  for (const group of SIMULATED_GROUPS) {
    const lines = simulatedGroupTle(group, { seed: 424242, epoch: EPOCH }).split('\n');
    for (let i = 0; i < lines.length; i += 3) {
      const satrec = twoline2satrec(lines[i + 1], lines[i + 2]);
      assert.equal(satrec.error, 0, `satrec error-free for ${lines[i]}`);
      const pv = propagate(satrec, EPOCH);
      assert.ok(pv.position, `position available for ${lines[i]}`);
      const altKm = Math.sqrt(
        pv.position.x ** 2 + pv.position.y ** 2 + pv.position.z ** 2,
      ) - 6371;
      assert.ok(altKm > 300 && altKm < 40000, `plausible altitude for ${lines[i]}: ${altKm}`);
    }
  }
});

test('same seed + epoch is deterministic; different seeds diverge', () => {
  const a = simulatedGroupTle('stations', { seed: 424242, epoch: EPOCH });
  const b = simulatedGroupTle('stations', { seed: 424242, epoch: EPOCH });
  const c = simulatedGroupTle('stations', { seed: 777, epoch: EPOCH });
  assert.equal(a, b, 'identical catalog for identical inputs');
  assert.notEqual(a, c, 'seeded phasing differs between seeds');
});

test('epoch stamp reflects the generation time', () => {
  const a = simulatedGroupTle('stations', { seed: 424242, epoch: EPOCH });
  const b = simulatedGroupTle('stations', { seed: 424242, epoch: new Date('2027-06-01T00:00:00Z') });
  assert.notEqual(a, b, 'epoch stamp moves with the generation date');
});

test('unknown groups return empty text (same as CelesTrak 404 path)', () => {
  assert.equal(simulatedGroupTle('bogus-group', { epoch: EPOCH }), '');
});

test('createSimulatedSatelliteSource mirrors the live source interface', async () => {
  const source = createSimulatedSatelliteSource({ seed: 424242 });
  const res = await source.readGroup('stations', {});
  assert.equal(res.ok, true);
  assert.equal(res.status, 200);
  assert.equal(res.simulated, true);
  assert.ok(res.text.includes('ISS (ZARYA)'), 'contains the ISS entry');
  await assert.rejects(
    source.readGroup('bogus', {}),
    TypeError,
    'unknown group rejects like a malformed live group',
  );
  const ctrl = new AbortController();
  ctrl.abort();
  await assert.rejects(
    source.readGroup('stations', { signal: ctrl.signal }),
    { name: 'AbortError' },
    'abort is respected',
  );
});

test('decorator passes through live group responses untouched', async () => {
  const live = {
    readGroup: async (group) => ({ ok: true, status: 200, text: 'live-tle' }),
  };
  const wrapped = withSimulatedFallback(live, { seed: 424242 });
  const res = await wrapped.readGroup('stations', {});
  assert.equal(res.ok, true);
  assert.equal(res.text, 'live-tle');
  assert.equal(res.simulated, undefined);
});

test('fixed clock makes the wrapped catalog byte-for-byte deterministic', async () => {
  const T0 = new Date('2026-09-23T00:00:00Z').getTime();
  const live = {
    readGroup: async () => {
      throw new Error('CelesTrak unreachable');
    },
  };
  const a = withSimulatedFallback(live, { seed: 424242, now: () => T0 });
  const b = withSimulatedFallback(
    { readGroup: async () => { throw new Error('down'); } },
    { seed: 424242, now: () => T0 },
  );
  const ra = await a.readGroup('stations', {});
  const rb = await b.readGroup('stations', {});
  assert.equal(ra.text, rb.text, 'same (seed, clock) → identical catalog');
  const c = withSimulatedFallback(live, { seed: 424242, now: () => T0 + 60000 });
  const rc = await c.readGroup('stations', {});
  assert.notEqual(ra.text, rc.text, 'a later clock stamps a later epoch');
});

test('decorator falls back to the simulated catalog when live fails', async () => {
  const live = {
    readGroup: async () => {
      throw new Error('fetch failed');
    },
  };
  const wrapped = withSimulatedFallback(live, { seed: 424242, liveCooldownMs: 60_000 });
  const res = await wrapped.readGroup('stations', {});
  assert.equal(res.ok, true);
  assert.equal(res.simulated, true);
  assert.ok(res.text.includes('ISS (ZARYA)'));
  // Cooldown: the next call serves simulated without touching live.
  let liveCalls = 0;
  const counting = {
    readGroup: async () => {
      liveCalls += 1;
      throw new Error('down');
    },
  };
  const wrapped2 = withSimulatedFallback(counting, { seed: 424242, liveCooldownMs: 60_000 });
  await wrapped2.readGroup('stations', {});
  await wrapped2.readGroup('stations', {});
  assert.equal(liveCalls, 1, 'live probed once per cooldown window');
});

test('decorator falls back on non-OK and empty live responses', async () => {
  for (const bad of [
    { ok: false, status: 500, text: '' },
    { ok: true, status: 200, text: '   ' },
  ]) {
    const live = { readGroup: async () => bad };
    const wrapped = withSimulatedFallback(live, { seed: 424242 });
    const res = await wrapped.readGroup('geo', {});
    assert.equal(res.simulated, true, `fallback for ${JSON.stringify(bad)}`);
  }
});

test('decorator re-probes live after the cooldown and recovers', async () => {
  let liveOk = false;
  let clock = 5_000_000;
  const live = {
    readGroup: async () => {
      if (!liveOk) throw new Error('down');
      return { ok: true, status: 200, text: 'live-tle' };
    },
  };
  const wrapped = withSimulatedFallback(live, {
    seed: 424242,
    liveCooldownMs: 30_000,
    now: () => clock,
  });
  assert.equal((await wrapped.readGroup('stations', {})).simulated, true);
  liveOk = true;
  clock += 40_000;
  const recovered = await wrapped.readGroup('stations', {});
  assert.equal(recovered.simulated, undefined);
  assert.equal(recovered.text, 'live-tle');
});

test('decorator rethrows AbortError and is idempotent', async () => {
  const live = {
    readGroup: async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    },
  };
  const wrapped = withSimulatedFallback(live, { seed: 424242 });
  await assert.rejects(wrapped.readGroup('stations', {}), { name: 'AbortError' });
  const ctrl = new AbortController();
  ctrl.abort();
  await assert.rejects(wrapped.readGroup('stations', { signal: ctrl.signal }), {
    name: 'AbortError',
  });
  assert.equal(withSimulatedFallback(wrapped, { seed: 424242 }), wrapped, 'no double wrapping');
  assert.equal(withSimulatedFallback(null), null);
  const plain = {};
  assert.equal(withSimulatedFallback(plain), plain, 'non-source passes through by reference');
});
