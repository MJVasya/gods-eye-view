import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSimulatedCyberFeed } from './simulator.js';

const TYPES = new Set(['ddos', 'malware', 'intrusion', 'phishing', 'scan', 'c2']);

function assertValidEvent(event) {
  assert.equal(typeof event.id, 'string');
  assert.match(event.id, /^cyber-\d+-\d+$/, 'id shape cyber-<tick>-<n>');
  for (const endpoint of [event.src, event.dst]) {
    assert.equal(typeof endpoint.country, 'string');
    assert.equal(typeof endpoint.code, 'string');
    assert.match(endpoint.code, /^[A-Z]{2}$/);
    assert.equal(typeof endpoint.lat, 'number');
    assert.equal(typeof endpoint.lon, 'number');
    assert.ok(endpoint.lat >= -90 && endpoint.lat <= 90);
    assert.ok(endpoint.lon >= -180 && endpoint.lon <= 180);
  }
  assert.ok(TYPES.has(event.type), `known threat type, got ${event.type}`);
  assert.ok(Number.isInteger(event.severity));
  assert.ok(event.severity >= 1 && event.severity <= 5);
  assert.equal(typeof event.ts, 'number');
  assert.ok(Number.isFinite(event.ts) && event.ts > 0);
}

async function collectSnapshots(seed, ticks, opts) {
  const feed = createSimulatedCyberFeed({ seed, ...opts });
  const snaps = [];
  for (let i = 0; i < ticks; i += 1) {
    snaps.push(await feed.getSnapshot());
  }
  return snaps;
}

test('same seed yields identical snapshots across ticks (deterministic)', async () => {
  const a = await collectSnapshots(1337, 5);
  const b = await collectSnapshots(1337, 5);
  assert.equal(a.length, 5);
  for (let i = 0; i < 5; i += 1) {
    assert.deepEqual(a[i], b[i], `tick ${i} must be identical`);
  }
});

test('different seeds diverge', async () => {
  const a = await collectSnapshots(1337, 1);
  const b = await collectSnapshots(4242, 1);
  assert.notDeepEqual(a[0], b[0]);
});

test('every event matches the exact schema', async () => {
  const snaps = await collectSnapshots(1337, 4);
  assert.ok(snaps.flat().length > 0);
  const seen = new Set();
  for (const snapshot of snaps) {
    for (const event of snapshot) {
      assertValidEvent(event);
      assert.ok(!seen.has(event.id), `id ${event.id} must be unique`);
      seen.add(event.id);
    }
  }
});

test('src !== dst for every event', async () => {
  const snaps = await collectSnapshots(1337, 6);
  for (const event of snaps.flat()) {
    assert.notEqual(event.src.code, event.dst.code);
  }
});

test('severity stays within 1–5 and is skewed low', async () => {
  const snaps = await collectSnapshots(1337, 10);
  const events = snaps.flat();
  for (const event of events) {
    assert.ok(event.severity >= 1 && event.severity <= 5);
  }
  const low = events.filter((e) => e.severity <= 2).length;
  const high = events.filter((e) => e.severity >= 4).length;
  assert.ok(low > high, `severity should skew low (low=${low}, high=${high})`);
});

test('event count respects eventsPerTick cap', async () => {
  for (const eventsPerTick of [40, 10, 1, 0]) {
    const snaps = await collectSnapshots(1337, 2, { eventsPerTick });
    for (const snapshot of snaps) {
      assert.ok(
        snapshot.length <= eventsPerTick,
        `cap ${eventsPerTick} respected, got ${snapshot.length}`,
      );
    }
  }
});

test('defaults match: seed 1337, 40 events per tick', async () => {
  const feed = createSimulatedCyberFeed();
  const snapshot = await feed.getSnapshot();
  assert.equal(snapshot.length, 40);
  const same = await collectSnapshots(1337, 1);
  assert.deepEqual(snapshot, same[0]);
});

test('tick counter advances ids across calls', async () => {
  const feed = createSimulatedCyberFeed({ seed: 7, eventsPerTick: 3 });
  const first = await feed.getSnapshot();
  const second = await feed.getSnapshot();
  assert.deepEqual(
    first.map((e) => e.id),
    ['cyber-0-0', 'cyber-0-1', 'cyber-0-2'],
  );
  assert.deepEqual(
    second.map((e) => e.id),
    ['cyber-1-0', 'cyber-1-1', 'cyber-1-2'],
  );
});

test('getSnapshot respects an aborted AbortSignal', async () => {
  const feed = createSimulatedCyberFeed();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => feed.getSnapshot({ signal: controller.signal }), {
    name: 'AbortError',
  });
});

test('threat types follow weights: scans most frequent, c2 rarest', async () => {
  const snaps = await collectSnapshots(1337, 40);
  const counts = {};
  for (const event of snaps.flat()) counts[event.type] = (counts[event.type] || 0) + 1;
  assert.ok(counts.scan > counts.c2, 'scans more frequent than c2');
  const sorted = [...TYPES].sort((a, b) => (counts[a] || 0) - (counts[b] || 0));
  assert.equal(sorted[sorted.length - 1], 'scan', 'scan is the most frequent type');
});
