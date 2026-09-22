import test from 'node:test';
import assert from 'node:assert/strict';
import { CyberIntelHud, normalizeCyberStats } from './cyberIntelHud.js';

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
