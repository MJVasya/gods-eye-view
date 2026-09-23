import test from 'node:test';
import assert from 'node:assert/strict';
import { CyberIntelHud, normalizeCyberStats } from './cyberIntelHud.js';
import {
  computeCyberHudTop,
  computeCyberIntelPanelTop,
} from './cyberIntelHud.js';

function fakeElement(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    children: [],
    parentNode: null,
    className: '',
    id: '',
    _text: '',
    hidden: false,
    style: {},
    removed: false,
    _attrs: {},
    get textContent() {
      // Mirror the DOM: textContent aggregates descendant text.
      return (
        this._text + this.children.map((child) => child.textContent).join('')
      );
    },
    set textContent(value) {
      this._text = String(value);
    },
    get firstChild() {
      return this.children[0] || null;
    },
    classList: {
      _host: null,
      _parse() {
        return String(this._host.className || '')
          .split(/\s+/)
          .filter(Boolean);
      },
      _write(classes) {
        this._host.className = classes.join(' ');
      },
      toggle(name, force) {
        const classes = this._parse();
        const has = classes.includes(name);
        const want = force === undefined ? !has : Boolean(force);
        if (want && !has) classes.push(name);
        if (!want && has) classes.splice(classes.indexOf(name), 1);
        this._write(classes);
        return want;
      },
      contains(name) {
        return this._parse().includes(name);
      },
    },
    appendChild(child) {
      this.children.push(child);
      child.parentNode = this;
      return child;
    },
    removeChild(child) {
      const index = this.children.indexOf(child);
      if (index >= 0) this.children.splice(index, 1);
      child.parentNode = null;
      return child;
    },
    setAttribute(name, value) {
      this._attrs[name] = value;
    },
    remove() {
      this.removed = true;
      this.parentNode?.removeChild(this);
    },
  };
  el.classList._host = el;
  return el;
}

function fakeDocument() {
  const doc = {
    _elements: [],
    createElement(tag) {
      const el = fakeElement(tag);
      doc._elements.push(el);
      return el;
    },
  };
  doc.body = fakeElement('body');
  return doc;
}

function findByClass(root, className) {
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (
      String(node.className || '')
        .split(/\s+/)
        .includes(className)
    )
      return node;
    stack.push(...node.children);
  }
  return null;
}

function allByClass(root, className) {
  const found = [];
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (
      String(node.className || '')
        .split(/\s+/)
        .includes(className)
    )
      found.push(node);
    stack.push(...[...node.children].reverse());
  }
  return found;
}

function fakeStats() {
  return {
    count: 1234,
    byType: {
      ddos: 10,
      malware: 20,
      intrusion: 30,
      phishing: 40,
      scan: 50,
      c2: 5,
    },
    topSources: [
      { code: 'US', country: 'United States', count: 120 },
      { code: 'CN', country: 'China', count: 90 },
    ],
    topDestinations: [{ code: 'DE', country: 'Germany', count: 60 }],
    lastUpdate: Date.UTC(2026, 8, 22, 12, 0, 0),
    error: null,
    simulated: true,
  };
}

function fakeManager(state) {
  const listeners = new Set();
  return {
    getAll: () => [{ id: 'cyber', enabled: state.enabled, stats: state.stats }],
    subscribeActivity(callback) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    emit(change) {
      for (const callback of [...listeners]) callback(change);
    },
    listenerCount: () => listeners.size,
  };
}

function withDocument(doc, fn) {
  const previous = globalThis.document;
  globalThis.document = doc;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  }
}

test('normalizeCyberStats fills the exact getStats contract and clamps top lists', () => {
  const stats = normalizeCyberStats({});
  assert.deepEqual(stats, {
    count: 0,
    byType: {
      ddos: 0,
      malware: 0,
      intrusion: 0,
      phishing: 0,
      scan: 0,
      c2: 0,
    },
    topSources: [],
    topDestinations: [],
    lastUpdate: null,
    error: '',
    simulated: true,
    source: '',
  });
  const many = Array.from({ length: 8 }, (_, i) => ({
    code: `C${i}`,
    country: `Country ${i}`,
    count: i,
  }));
  const clamped = normalizeCyberStats({
    count: '42',
    byType: { ddos: 3, bogus: 99 },
    topSources: many,
    topDestinations: many,
  });
  assert.equal(clamped.count, 42);
  assert.equal(clamped.byType.ddos, 3);
  assert.equal(clamped.byType.scan, 0);
  assert.ok(!('bogus' in clamped.byType));
  assert.equal(clamped.topSources.length, 5);
  assert.equal(clamped.topDestinations.length, 5);
});

test('the panel hides itself while the cyber layer is disabled', () => {
  withDocument(fakeDocument(), () => {
    const hud = new CyberIntelHud(fakeManager({ enabled: false, stats: null }));
    hud.mount();
    assert.equal(hud._root.id, 'cyber-intel-hud');
    assert.equal(hud._root.hidden, true);
    assert.equal(
      findByClass(hud._root, 'cyber-hud-sim').textContent,
      'SIMULATED FEED',
    );
    hud.destroy();
  });
});

test('the panel renders the full stats readout when the layer is enabled', () => {
  withDocument(fakeDocument(), () => {
    const hud = new CyberIntelHud(
      fakeManager({ enabled: true, stats: fakeStats() }),
    );
    hud.mount();
    assert.equal(hud._root.hidden, false);
    assert.equal(
      findByClass(hud._root, 'cyber-hud-title').textContent,
      'CYBER INTEL',
    );
    assert.equal(
      findByClass(hud._root, 'cyber-hud-count-num').textContent,
      '1,234',
    );
    const sources = allByClass(hud._root, 'cyber-hud-item');
    assert.equal(sources.length, 3);
    assert.match(sources[0].textContent, /US/);
    assert.match(sources[0].textContent, /United States/);
    assert.match(sources[0].textContent, /120/);
    const typeCounts = allByClass(hud._root, 'cyber-hud-type-count').map(
      (node) => node.textContent,
    );
    assert.deepEqual(typeCounts, ['10', '20', '30', '40', '50', '5']);
    assert.match(
      findByClass(hud._root, 'cyber-hud-updated').textContent,
      /12:00:00Z/,
    );
    assert.equal(findByClass(hud._root, 'cyber-hud-error').hidden, true);
    hud.destroy();
  });
});

test('the panel re-renders on the layer update tick and hides on disable', () => {
  withDocument(fakeDocument(), () => {
    const state = { enabled: true, stats: fakeStats() };
    const manager = fakeManager(state);
    const hud = new CyberIntelHud(manager);
    hud.mount();
    assert.equal(
      findByClass(hud._root, 'cyber-hud-count-num').textContent,
      '1,234',
    );
    // Unrelated layers must not repaint the readout.
    manager.emit({ type: 'data-updated', layerId: 'flights' });
    state.stats = { ...fakeStats(), count: 9999 };
    manager.emit({ type: 'data-updated', layerId: 'cyber' });
    assert.equal(
      findByClass(hud._root, 'cyber-hud-count-num').textContent,
      '9,999',
    );
    state.enabled = false;
    manager.emit({ type: 'visibility-settled', layerId: 'cyber' });
    assert.equal(hud._root.hidden, true);
    hud.destroy();
  });
});

test('feed errors surface on the panel and destroy releases the subscription', () => {
  withDocument(fakeDocument(), () => {
    const manager = fakeManager({
      enabled: true,
      stats: { ...fakeStats(), error: 'feed stale' },
    });
    const hud = new CyberIntelHud(manager);
    hud.mount();
    const errorNode = findByClass(hud._root, 'cyber-hud-error');
    assert.equal(errorNode.hidden, false);
    assert.match(errorNode.textContent, /feed stale/);
    assert.equal(manager.listenerCount(), 1);
    const root = hud._root;
    hud.destroy();
    assert.equal(manager.listenerCount(), 0);
    assert.equal(root.removed, true);
  });
});

test('mount is a no-op without a real document', () => {
  withDocument({ getElementById: () => null }, () => {
    const hud = new CyberIntelHud(fakeManager({ enabled: true, stats: {} }));
    hud.mount();
    assert.equal(hud._root, null);
    hud.destroy();
  });
});

test('the attribution badge follows the feed mode and never mixes the labels', () => {
  withDocument(fakeDocument(), () => {
    const state = { enabled: true, stats: fakeStats() };
    const manager = fakeManager(state);
    const hud = new CyberIntelHud(manager);
    hud.mount();
    const badge = findByClass(hud._root, 'cyber-hud-sim');
    assert.equal(badge.textContent, 'SIMULATED FEED');

    // Live stats: badge flips to the live wording and carries the full
    // source label in its tooltip — the simulated wording is gone.
    state.stats = {
      ...fakeStats(),
      simulated: false,
      source: 'CINS Army · blocklist.de · Spamhaus · OpenPhish',
    };
    manager.emit({ type: 'data-updated', layerId: 'cyber' });
    assert.equal(badge.textContent, 'LIVE FEED');
    assert.equal(badge.title, 'CINS Army · blocklist.de · Spamhaus · OpenPhish');

    // Back to simulated: badge returns to the simulated wording.
    state.stats = fakeStats();
    manager.emit({ type: 'data-updated', layerId: 'cyber' });
    assert.equal(badge.textContent, 'SIMULATED FEED');
    hud.destroy();
  });
});

test('the attribution badge flips its live styling class with the feed mode', () => {
  withDocument(fakeDocument(), () => {
    const state = { enabled: true, stats: fakeStats() };
    const manager = fakeManager(state);
    const hud = new CyberIntelHud(manager);
    hud.mount();
    const badge = findByClass(hud._root, 'cyber-hud-sim');
    assert.equal(badge.classList.contains('cyber-hud-live'), false);

    state.stats = { ...fakeStats(), simulated: false };
    manager.emit({ type: 'data-updated', layerId: 'cyber' });
    assert.equal(badge.classList.contains('cyber-hud-live'), true);

    state.stats = fakeStats();
    manager.emit({ type: 'data-updated', layerId: 'cyber' });
    assert.equal(badge.classList.contains('cyber-hud-live'), false);
    hud.destroy();
  });
});

test('the panel aria-label follows the feed mode', () => {
  withDocument(fakeDocument(), () => {
    const state = { enabled: true, stats: fakeStats() };
    const manager = fakeManager(state);
    const hud = new CyberIntelHud(manager);
    hud.mount();
    assert.equal(
      hud._root._attrs['aria-label'],
      'Cyber Intel statistics — simulated feed',
    );

    state.stats = { ...fakeStats(), simulated: false, source: 'live source' };
    manager.emit({ type: 'data-updated', layerId: 'cyber' });
    assert.equal(
      hud._root._attrs['aria-label'],
      'Cyber Intel statistics — live threat-intel feed',
    );
    hud.destroy();
  });
});

test('computeCyberHudTop keeps the static offset when the rail is absent', () => {
  assert.deepEqual(
    computeCyberHudTop({ viewportWidth: 1600, viewportHeight: 900, hudHeight: 344 }),
    { top: 118, maxHeight: null },
  );
});

test('computeCyberHudTop docks below the rail when bands intersect', () => {
  // 1600x900: HUD band x 1338..1586; rail x 1218..1548, top 234, bottom 700.
  // Full height fits neither below nor above, so the HUD docks below the
  // rail, shrunk to the available slot — still no overlap.
  const rail = { left: 1218, right: 1548, top: 234, bottom: 700 };
  assert.deepEqual(
    computeCyberHudTop({
      viewportWidth: 1600,
      viewportHeight: 900,
      hudHeight: 344,
      railRect: rail,
    }),
    { top: 712, maxHeight: 176 },
  );
});

test('computeCyberHudTop docks below a short rail with room to spare', () => {
  const rail = { left: 1218, right: 1548, top: 234, bottom: 320 };
  const { top, maxHeight } = computeCyberHudTop({
    viewportWidth: 1600,
    viewportHeight: 900,
    hudHeight: 344,
    railRect: rail,
  });
  assert.equal(top, 332);
  assert.equal(maxHeight, null);
});

test('computeCyberHudTop ignores a rail that does not intersect horizontally', () => {
  const rail = { left: 100, right: 430, top: 234, bottom: 700 };
  const { top } = computeCyberHudTop({
    viewportWidth: 1600,
    viewportHeight: 900,
    hudHeight: 344,
    railRect: rail,
  });
  assert.equal(top, 118);
});

test('computeCyberHudTop never overlaps: narrow and short viewports', () => {
  for (const [w, h] of [
    [1280, 720],
    [1920, 1080],
    [1366, 768],
    [1920, 1200],
    [2560, 1440],
  ]) {
    const rail = { left: w - 52 - 330, right: w - 52, top: h * 0.26, bottom: h * 0.7 };
    const { top, maxHeight } = computeCyberHudTop({
      viewportWidth: w,
      viewportHeight: h,
      hudHeight: 344,
      railRect: rail,
    });
    const hudLeft = w - 14 - 248;
    const hudRight = w - 14;
    const hOverlap = rail.left < hudRight && rail.right > hudLeft;
    const hudBottom = top + (maxHeight == null ? 344 : maxHeight);
    assert.ok(top >= 0 && hudBottom <= h + 1, `viewport ${w}x${h}: on screen`);
    if (hOverlap) {
      const clears =
        top >= rail.bottom + 12 - 1 || hudBottom <= rail.top - 12 + 1;
      assert.ok(clears, `viewport ${w}x${h}: clears the rail`);
    }
  }
});

test('computeCyberHudTop degrades gracefully when the rail fills the viewport', () => {
  // 800x600: the rail (156..420) leaves no full-height slot clear of it, so
  // the HUD takes the 132px sliver above the rail rather than overlapping it.
  const { top, maxHeight } = computeCyberHudTop({
    viewportWidth: 800,
    viewportHeight: 600,
    hudHeight: 344,
    railRect: { left: 418, right: 748, top: 156, bottom: 420 },
  });
  assert.equal(top, 12);
  assert.equal(maxHeight, 132);
  assert.ok(top + maxHeight <= 156 - 12 + 1, 'clears the rail');
});

test('computeCyberHudTop clamps an over-tall panel with a max-height', () => {
  const { top, maxHeight } = computeCyberHudTop({
    viewportWidth: 1600,
    viewportHeight: 500,
    hudHeight: 900,
    railRect: null,
  });
  assert.equal(top, 12);
  assert.equal(maxHeight, 500 - 24);
});

test('computeCyberIntelPanelTop stacks below the HUD and stays on screen', () => {
  assert.equal(
    computeCyberIntelPanelTop({ viewportHeight: 900, hudTop: 332, hudHeight: 344 }),
    332 + 344 + 12,
  );
  // Short viewport: keep at least the panel header visible.
  const top = computeCyberIntelPanelTop({
    viewportHeight: 500,
    hudTop: 400,
    hudHeight: 344,
  });
  assert.ok(top <= 500 - 96 && top >= 12);
});

test('rail style mutations re-dock the HUD without overlapping', () => {
  // The rail's own layout pass moves it via inline style writes (a move, not
  // a resize) — the HUD must follow those moves, not just resizes.
  let railRect = { left: 1218, right: 1548, top: 234, bottom: 700, width: 330, height: 466 };
  const rail = fakeElement('div');
  rail.getBoundingClientRect = () => ({ ...railRect });
  const vars = {};
  const doc = fakeDocument();
  doc.getElementById = (id) => (id === 'right-context-rail' ? rail : null);
  doc.documentElement = {
    style: {
      setProperty: (k, v) => {
        vars[k] = v;
      },
      removeProperty: (k) => {
        delete vars[k];
      },
    },
  };
  const prevWindow = globalThis.window;
  const prevMO = globalThis.MutationObserver;
  const prevRO = globalThis.ResizeObserver;
  const prevRAF = globalThis.requestAnimationFrame;
  let mutationCallback = null;
  globalThis.window = {
    innerWidth: 1600,
    innerHeight: 900,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  globalThis.MutationObserver = class {
    constructor(cb) {
      mutationCallback = cb;
    }
    observe() {}
    disconnect() {}
  };
  globalThis.ResizeObserver = undefined;
  globalThis.requestAnimationFrame = (fn) => {
    fn();
    return 1;
  };
  try {
    withDocument(doc, () => {
      const state = { enabled: true, stats: fakeStats() };
      const manager = fakeManager(state);
      const hud = new CyberIntelHud(manager);
      hud.mount();
      // Tall rail at 234..700: the 344px HUD docks below it, shrunk to fit.
      assert.equal(vars['--cyber-hud-top'], '712px');
      assert.equal(vars['--cyber-hud-max-height'], '176px');
      assert.ok(mutationCallback, 'rail mutation observer installed');

      // The rail's layout pass moves it (same size, new position).
      railRect = { left: 1218, right: 1548, top: 100, bottom: 200, width: 330, height: 100 };
      mutationCallback();
      assert.equal(vars['--cyber-hud-top'], '212px');
      assert.equal(vars['--cyber-hud-max-height'], undefined);

      // Hiding the layer clears the stacking variables.
      state.enabled = false;
      manager.emit({ type: 'data-updated', layerId: 'cyber' });
      assert.equal(vars['--cyber-hud-top'], undefined);
      hud.destroy();
    });
  } finally {
    if (prevWindow === undefined) delete globalThis.window;
    else globalThis.window = prevWindow;
    if (prevMO === undefined) delete globalThis.MutationObserver;
    else globalThis.MutationObserver = prevMO;
    if (prevRO === undefined) delete globalThis.ResizeObserver;
    else globalThis.ResizeObserver = prevRO;
    if (prevRAF === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = prevRAF;
  }
});
