import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFrames } from './frames.js';
import { PROJECTION_IMAGE_TIMEOUT_MS } from './policy.js';

function fixture() {
  const parts = {
    model: {
      safeNumber(value, fallback = NaN) {
        const n = Number(value);
        return Number.isFinite(n) ? n : fallback;
      },
    },
  };
  const state = { _activeCameraId: 'cam-1' };
  const source = {
    getFrameUrl: (camera) => `/api/cctv/frame/${camera.id}`,
  };
  const frames = createFrames({ state, services: {}, parts, source });
  const runtime = {
    mode: 'image',
    image: { src: '' },
    imageLoading: false,
    imageReady: false,
    imageTimeout: null,
    lastImageRefreshAt: 0,
  };
  const record = { camera: { id: 'cam-1' }, projection: runtime };
  return { frames, runtime, record };
}

test('a stalled projection frame releases the imageLoading latch on timeout', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { frames, runtime, record } = fixture();
  frames.refreshProjectionImage(record, true);
  assert.equal(runtime.imageLoading, true);
  assert.ok(runtime.imageTimeout);
  assert.match(runtime.image.src, /^\/api\/cctv\/frame\/cam-1/);
  // The request hangs: neither the load nor the error handler in
  // createProjectionRuntime fires.
  t.mock.timers.tick(PROJECTION_IMAGE_TIMEOUT_MS);
  assert.equal(runtime.imageLoading, false);
  assert.equal(runtime.imageReady, false);
  assert.equal(runtime.imageTimeout, null);
});

test('after the timeout releases the latch, the next tick retries', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { frames, runtime, record } = fixture();
  frames.refreshProjectionImage(record, true);
  t.mock.timers.tick(PROJECTION_IMAGE_TIMEOUT_MS);
  assert.equal(runtime.imageLoading, false);
  // Previously the latch wedged at true forever and every later refresh was
  // skipped by the `if (runtime.imageLoading) return` guard.
  frames.refreshProjectionImage(record, true);
  assert.equal(runtime.imageLoading, true);
  assert.ok(runtime.imageTimeout);
});

test('a second forced refresh re-arms the deadline instead of stacking', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { frames, runtime, record } = fixture();
  frames.refreshProjectionImage(record, true);
  const firstDeadline = runtime.imageTimeout;
  // Simulate the load handler clearing the latch, then a fresh refresh.
  runtime.imageLoading = false;
  runtime.imageTimeout = null;
  frames.refreshProjectionImage(record, true);
  assert.notEqual(runtime.imageTimeout, firstDeadline);
  t.mock.timers.tick(PROJECTION_IMAGE_TIMEOUT_MS - 1);
  assert.equal(runtime.imageLoading, true);
  t.mock.timers.tick(1);
  assert.equal(runtime.imageLoading, false);
});
