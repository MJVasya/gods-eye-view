import test from 'node:test';
import assert from 'node:assert/strict';
import { handleHealthRequest } from './health-proxy.js';

test('health: reports version and secret booleans, never values', async () => {
  globalThis.fetch = async () => new Response('ok', { status: 200 });
  const res = await handleHealthRequest(
    new Request('https://x/api/health'),
    { TOMTOM_API_KEY: 'super-secret-value', FIRMS_MAP_KEY: '' },
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.version);
  assert.equal(body.secrets.TOMTOM_API_KEY, true);
  assert.equal(body.secrets.FIRMS_MAP_KEY, false);
  const text = JSON.stringify(body);
  assert.ok(!text.includes('super-secret-value'), 'secret value leaked!');
  assert.ok(Array.isArray(body.upstreams) && body.upstreams.length > 0);
});

test('health: upstream failure reported, not thrown', async () => {
  globalThis.fetch = async () => { throw new Error('boom'); };
  const res = await handleHealthRequest(new Request('https://x/api/health'), {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.upstreams.every((u) => u.ok === false));
});
