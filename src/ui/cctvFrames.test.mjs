import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CCTV_FRAME_LOAD_TIMEOUT_MS,
  buildCctvUnavailableCardHtml,
  _clearCctvFrame,
  _clearCctvFrameTimeout,
  _queueCctvFrame,
  _settleCctvFrame,
  _showCctvUnavailableCard,
  _hideCctvUnavailableCard,
  _syncCctvSourceBadge,
} from './cctvFrames.js';

function classList() {
  const classes = new Set();
  return {
    add(...values) {
      values.forEach((value) => classes.add(value));
    },
    remove(...values) {
      values.forEach((value) => classes.delete(value));
    },
    contains(value) {
      return classes.has(value);
    },
    toggle(value, enabled) {
      if (enabled) classes.add(value);
      else classes.delete(value);
    },
  };
}

function makeFrame() {
  return {
    dataset: {},
    src: '',
    classList: classList(),
    removeAttribute(name) {
      if (name === 'src') this.src = '';
    },
  };
}

function makeWrap() {
  const children = [];
  return {
    children,
    classList: classList(),
    appendChild(child) {
      children.push(child);
      return child;
    },
  };
}

/** Fake `this` context for the cctvFrames functions (they are `this`-bound). */
function frameCtx(camera) {
  return {
    destroyed: false,
    _cctvFrame: makeFrame(),
    _cctvFrameWrap: makeWrap(),
    _cctvSourceBadge: { textContent: '', dataset: {} },
    _cctvFrameRequestToken: 0,
    _cctvFramePreloader: null,
    _cctvFrameTimeout: null,
    _cctvFramePlaceholder: null,
    _cctvState: { activeCamera: camera || null, enabled: true },
    actions: { isEnabled: () => true },
    _clearCctvFrameTimeout(...args) {
      return _clearCctvFrameTimeout.call(this, ...args);
    },
    _settleCctvFrame(...args) {
      return _settleCctvFrame.call(this, ...args);
    },
    _showCctvUnavailableCard(...args) {
      return _showCctvUnavailableCard.call(this, ...args);
    },
    _hideCctvUnavailableCard(...args) {
      return _hideCctvUnavailableCard.call(this, ...args);
    },
    _syncCctvSourceBadge(...args) {
      return _syncCctvSourceBadge.call(this, ...args);
    },
  };
}

function installImageFake(t) {
  const prior = globalThis.Image;
  const requests = [];
  globalThis.Image = class {
    constructor() {
      requests.push(this);
    }
  };
  t.after(() => {
    globalThis.Image = prior;
  });
  return requests;
}

function installDocumentFake(t) {
  const prior = globalThis.document;
  const created = [];
  globalThis.document = {
    createElement(tag) {
      const el = {
        tagName: String(tag).toUpperCase(),
        className: '',
        innerHTML: '',
        style: {},
        children: [],
        appendChild(child) {
          this.children.push(child);
          return child;
        },
      };
      created.push(el);
      return el;
    },
  };
  t.after(() => {
    globalThis.document = prior;
  });
  return created;
}

const seedCamera = {
  id: 'paris-rivoli',
  name: 'Rue de Rivoli',
  city: 'Paris',
  lat: 48.8611,
  lon: 2.3358,
  feedConfigured: false,
  sourceKind: 'seed',
};

const liveCamera = {
  id: 'tfl-00001',
  name: 'JamCam 00001',
  city: 'London',
  lat: 51.5074,
  lon: -0.1278,
  feedConfigured: true,
  sourceKind: 'tfl-open-data',
};

test('unavailable card names the camera, its location, and is labeled a placeholder', () => {
  const html = buildCctvUnavailableCardHtml(seedCamera, 'unconfigured');
  assert.match(html, /NO LIVE FEED/);
  assert.match(html, /Rue de Rivoli/);
  assert.match(html, /Paris/);
  assert.match(html, /48\.8611/);
  assert.match(html, /2\.3358/);
  assert.match(html, /NOT A LIVE FEED/);
  assert.match(html, /no live video source configured/);
});

test('unavailable card escapes hostile camera text', () => {
  const html = buildCctvUnavailableCardHtml(
    { ...liveCamera, name: '<script>alert(1)</script>', city: 'A&B' },
    'timeout',
  );
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /A&amp;B/);
  assert.match(html, /FEED UNAVAILABLE/);
  assert.match(html, /timed out/);
});

test('an unconfigured seed camera skips the network and lands on the card', (t) => {
  const requests = installImageFake(t);
  installDocumentFake(t);
  const ctx = frameCtx(seedCamera);
  _queueCctvFrame.call(
    ctx,
    '/api/cctv/frame/paris-rivoli',
    'paris-rivoli',
    true,
    seedCamera,
  );
  assert.equal(requests.length, 0);
  assert.equal(ctx._cctvFrame.dataset.error, 'true');
  assert.equal(ctx._cctvFrame.dataset.unavailable, 'unconfigured');
  assert.ok(ctx._cctvFramePlaceholder);
  assert.equal(ctx._cctvFrameWrap.children.length, 1);
  assert.match(ctx._cctvFramePlaceholder.innerHTML, /NO LIVE FEED/);
  assert.match(ctx._cctvFramePlaceholder.innerHTML, /Rue de Rivoli/);
  assert.equal(ctx._cctvSourceBadge.textContent, 'NO LIVE FEED');
  assert.equal(ctx._cctvSourceBadge.dataset.frameState, 'error');
});

test('a stalled frame request settles as failed at the timeout', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const requests = installImageFake(t);
  installDocumentFake(t);
  const ctx = frameCtx(liveCamera);
  _queueCctvFrame.call(
    ctx,
    '/api/cctv/frame/tfl-00001',
    'tfl-00001',
    true,
    liveCamera,
  );
  assert.equal(requests.length, 1);
  assert.equal(ctx._cctvFrame.dataset.loading, 'true');
  ctx._syncCctvSourceBadge(liveCamera, true);
  assert.equal(ctx._cctvSourceBadge.textContent, 'FRAME · LOADING');
  // The request hangs: neither onload nor onerror fires.
  t.mock.timers.tick(CCTV_FRAME_LOAD_TIMEOUT_MS);
  assert.equal(ctx._cctvFrame.dataset.loading, '');
  assert.equal(ctx._cctvFrame.dataset.error, 'true');
  assert.equal(ctx._cctvFrameTimeout, null);
  assert.ok(ctx._cctvFramePlaceholder);
  assert.match(ctx._cctvFramePlaceholder.innerHTML, /FEED UNAVAILABLE/);
  assert.match(ctx._cctvFramePlaceholder.innerHTML, /timed out/);
  assert.equal(ctx._cctvSourceBadge.textContent, 'FRAME · UNAVAILABLE');
});

test('a frame that loads before the timeout clears the deadline', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const requests = installImageFake(t);
  installDocumentFake(t);
  const ctx = frameCtx(liveCamera);
  _queueCctvFrame.call(
    ctx,
    '/api/cctv/frame/tfl-00001',
    'tfl-00001',
    true,
    liveCamera,
  );
  requests[0].onload();
  assert.equal(ctx._cctvFrame.src, '/api/cctv/frame/tfl-00001');
  assert.ok(ctx._cctvFrame.classList.contains('active'));
  assert.ok(ctx._cctvFrameWrap.classList.contains('has-frame'));
  assert.equal(ctx._cctvFrameTimeout, null);
  assert.equal(ctx._cctvFramePlaceholder, null);
  // Ticking past the old deadline must not retroactively fail the frame.
  t.mock.timers.tick(CCTV_FRAME_LOAD_TIMEOUT_MS * 2);
  assert.equal(ctx._cctvFrame.dataset.error, '');
  assert.ok(ctx._cctvFrame.classList.contains('active'));
});

test('a failed refresh keeps the last good frame and shows no card', (t) => {
  const requests = installImageFake(t);
  installDocumentFake(t);
  const ctx = frameCtx(liveCamera);
  // A previously settled frame is on screen.
  ctx._cctvFrameWrap.classList.add('has-frame');
  ctx._cctvFrame.classList.add('active');
  ctx._cctvFrame.src = '/api/cctv/frame/tfl-00001?ts=1';
  _queueCctvFrame.call(
    ctx,
    '/api/cctv/frame/tfl-00001?ts=2',
    'tfl-00001',
    false,
    liveCamera,
  );
  requests[0].onerror();
  assert.equal(ctx._cctvFrame.dataset.error, 'true');
  assert.equal(ctx._cctvFramePlaceholder, null);
  assert.equal(ctx._cctvFrame.src, '/api/cctv/frame/tfl-00001?ts=1');
  assert.ok(ctx._cctvFrame.classList.contains('active'));
});

test('clearing the frame drops the pending timeout and the card', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  installImageFake(t);
  installDocumentFake(t);
  const ctx = frameCtx(liveCamera);
  _queueCctvFrame.call(
    ctx,
    '/api/cctv/frame/tfl-00001',
    'tfl-00001',
    true,
    liveCamera,
  );
  assert.ok(ctx._cctvFrameTimeout);
  _clearCctvFrame.call(ctx);
  assert.equal(ctx._cctvFrameTimeout, null);
  // The orphaned timeout must not resurrect an error state afterwards.
  t.mock.timers.tick(CCTV_FRAME_LOAD_TIMEOUT_MS * 2);
  assert.equal(ctx._cctvFrame.dataset.error, '');
});
