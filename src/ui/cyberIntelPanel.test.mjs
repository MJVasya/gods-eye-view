/**
 * Cyber intel panel tests (phase 3b click-to-inspect).
 *
 * The panel is a DOM module; these tests run against a minimal fake
 * document in the style of src/app/cyberIntelHud.test.mjs — no browser,
 * no network. Each test imports a fresh module copy (query-string
 * specifier) so the panel's module-global singleton never leaks between
 * tests.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

function fakeElement(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    children: [],
    parentNode: null,
    className: '',
    id: '',
    _text: '',
    hidden: false,
    _attrs: {},
    _listeners: {},
    get textContent() {
      return (
        this._text + this.children.map((child) => child.textContent).join('')
      );
    },
    set textContent(value) {
      this._text = String(value);
    },
    appendChild(child) {
      this.children.push(child);
      child.parentNode = this;
      return child;
    },
    setAttribute(name, value) {
      this._attrs[name] = String(value);
    },
    getAttribute(name) {
      return this._attrs[name];
    },
    removeAttribute(name) {
      delete this._attrs[name];
    },
    addEventListener(type, handler) {
      (this._listeners[type] ||= []).push(handler);
    },
    removeEventListener(type, handler) {
      const list = this._listeners[type];
      if (list) this._listeners[type] = list.filter((h) => h !== handler);
    },
    remove() {
      this.parentNode?.children.splice(
        this.parentNode.children.indexOf(this),
        1,
      );
      this.parentNode = null;
    },
  };
  return el;
}

function fakeDocument() {
  const doc = {
    _listeners: {},
    createElement(tag) {
      return fakeElement(tag);
    },
    addEventListener(type, handler) {
      (this._listeners[type] ||= []).push(handler);
    },
    removeEventListener(type, handler) {
      const list = this._listeners[type];
      if (list) this._listeners[type] = list.filter((h) => h !== handler);
    },
    fire(type, event) {
      for (const handler of this._listeners[type] || []) handler(event);
    },
  };
  doc.body = fakeElement('body');
  return doc;
}

function findById(root, id) {
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (node.id === id) return node;
    stack.push(...node.children);
  }
  return null;
}

function findByClass(root, className) {
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (String(node.className || '').split(/\s+/).includes(className))
      return node;
    stack.push(...node.children);
  }
  return null;
}

function allValues(root) {
  const rows = [];
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (String(node.className || '').split(/\s+/).includes('cyber-intel-row')) {
      const key = node.children[0]?.textContent;
      const value = node.children[1]?.textContent;
      rows.push([key, value]);
    }
    stack.push(...[...node.children].reverse());
  }
  return new Map(rows);
}

const simulatedEntry = (overrides = {}) => ({
  feedMode: 'simulated',
  sourceLabel: 'Simulated feed',
  record: {
    id: 'attack-1',
    src: { country: 'Russia', code: 'RU', lat: 55.7558, lon: 37.6173 },
    dst: { country: 'United States', code: 'US', lat: 38.9072, lon: -77.0369 },
    type: 'intrusion',
    severity: 3,
    ts: 1758550000000,
    ...overrides,
  },
});

const liveEntry = (overrides = {}) =>
  simulatedEntry({
    src: {
      country: 'Germany',
      code: 'DE',
      lat: 50.1109,
      lon: 8.6821,
      city: 'Frankfurt am Main',
      region: 'Hesse',
      isp: 'Example ISP GmbH',
      org: 'Example Org',
      asn: 'AS12345',
    },
    ioc: '1.12.229.231',
    ref: 'https://cinsscore.com/',
    ...overrides,
  });

async function freshPanel() {
  const doc = fakeDocument();
  const previous = globalThis.document;
  globalThis.document = doc;
  const suffix = Math.random().toString(36).slice(2);
  const panel = await import(`./cyberIntelPanel.js?fresh=${suffix}`);
  const restore = () => {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  };
  return { panel, doc, restore };
}

test('open renders simulated attribution and honest n/a fields', async () => {
  const { panel, doc, restore } = await freshPanel();
  panel.openCyberIntelPanel(simulatedEntry());
  assert.equal(panel.isCyberIntelPanelOpen(), true);
  const root = findById(doc.body, 'cyber-intel-panel');
  assert.ok(root, 'panel mounted to body');
  assert.equal(root.hidden, false);

  const badge = findByClass(root, 'cyber-intel-badge');
  assert.equal(badge.textContent, 'SIMULATED FEED');
  assert.ok(!badge.className.includes('cyber-intel-badge-live'));

  const values = allValues(root);
  assert.equal(values.get('IP'), 'simulated');
  assert.equal(values.get('COUNTRY'), 'Russia (RU)');
  assert.equal(values.get('CITY'), 'n/a');
  assert.equal(values.get('REGION'), 'n/a');
  assert.equal(values.get('LAT / LON'), '55.7558°, 37.6173°');
  assert.equal(values.get('ISP'), 'n/a');
  assert.equal(values.get('ORG'), 'n/a');
  assert.equal(values.get('ASN'), 'n/a');
  assert.equal(values.get('THREAT'), 'INTRUSION');
  assert.equal(values.get('SEVERITY'), '3 / 5');
  restore();
});

test('open renders live attribution with real GeoIP and indicator', async () => {
  const { panel, doc, restore } = await freshPanel();
  panel.openCyberIntelPanel({
    ...liveEntry(),
    feedMode: 'live',
    sourceLabel: 'CINS Army · blocklist.de · Spamhaus · OpenPhish',
  });
  const root = findById(doc.body, 'cyber-intel-panel');
  const badge = findByClass(root, 'cyber-intel-badge');
  assert.equal(badge.textContent, 'LIVE FEED');
  assert.ok(badge.className.includes('cyber-intel-badge-live'));
  assert.equal(
    badge.title,
    'CINS Army · blocklist.de · Spamhaus · OpenPhish',
  );

  const values = allValues(root);
  assert.equal(values.get('IP'), '1.12.229.231');
  assert.equal(values.get('COUNTRY'), 'Germany (DE)');
  assert.equal(values.get('CITY'), 'Frankfurt am Main');
  assert.equal(values.get('REGION'), 'Hesse');
  assert.equal(values.get('ISP'), 'Example ISP GmbH');
  assert.equal(values.get('ORG'), 'Example Org');
  assert.equal(values.get('ASN'), 'AS12345');
  restore();
});

test('open ignores a missing record instead of rendering garbage', async () => {
  const { panel, restore } = await freshPanel();
  panel.openCyberIntelPanel(null);
  panel.openCyberIntelPanel({ feedMode: 'live' });
  assert.equal(panel.isCyberIntelPanelOpen(), false);
  restore();
});

test('street view is the default tab; satellite tab switches the frame', async () => {
  const { panel, doc, restore } = await freshPanel();
  panel.openCyberIntelPanel(simulatedEntry());
  const root = findById(doc.body, 'cyber-intel-panel');
  const frames = [];
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (String(node.className || '').split(/\s+/).includes('cyber-intel-map'))
      frames.push(node);
    stack.push(...node.children);
  }
  assert.equal(frames.length, 2);
  const street = frames.find((f) => f.getAttribute('title').includes('Street'));
  const satellite = frames.find((f) =>
    f.getAttribute('title').includes('Satellite'),
  );
  assert.equal(street.hidden, false);
  assert.equal(satellite.hidden, true);
  assert.ok(street.getAttribute('src').includes('output=svembed'));
  assert.ok(street.getAttribute('src').includes('cbll=55.755800,37.617300'));
  assert.ok(satellite.getAttribute('src').includes('output=embed'));
  assert.ok(satellite.getAttribute('src').includes('t=k'));

  // Click the Satellite tab; frames swap.
  const tabs = [];
  const stack2 = [root];
  while (stack2.length) {
    const node = stack2.pop();
    if (String(node.className || '').split(/\s+/).includes('cyber-intel-tab'))
      tabs.push(node);
    stack2.push(...node.children);
  }
  const satTab = tabs.find((t) => t.textContent === 'SATELLITE');
  for (const handler of satTab._listeners.click || []) handler();
  assert.equal(street.hidden, true);
  assert.equal(satellite.hidden, false);
  restore();
});

test('close button and Escape dismiss the panel', async () => {
  const { panel, doc, restore } = await freshPanel();
  panel.openCyberIntelPanel(simulatedEntry());
  const root = findById(doc.body, 'cyber-intel-panel');

  const close = findByClass(root, 'cyber-intel-close');
  for (const handler of close._listeners.click || []) handler();
  assert.equal(panel.isCyberIntelPanelOpen(), false);
  assert.equal(root.hidden, true);

  panel.openCyberIntelPanel(simulatedEntry());
  assert.equal(panel.isCyberIntelPanelOpen(), true);
  doc.fire('keydown', { key: 'Escape' });
  assert.equal(panel.isCyberIntelPanelOpen(), false);

  // Non-Escape keys leave the panel alone.
  panel.openCyberIntelPanel(simulatedEntry());
  doc.fire('keydown', { key: 'Enter' });
  assert.equal(panel.isCyberIntelPanelOpen(), true);
  restore();
});

test('close is safe before mount and destroy unmounts cleanly', async () => {
  const { panel, doc, restore } = await freshPanel();
  panel.closeCyberIntelPanel(); // no throw without a document mount
  panel.openCyberIntelPanel(simulatedEntry());
  assert.ok(findById(doc.body, 'cyber-intel-panel'));
  panel.destroyCyberIntelPanel();
  assert.equal(findById(doc.body, 'cyber-intel-panel'), null);
  assert.equal(panel.isCyberIntelPanelOpen(), false);
  assert.deepEqual(doc._listeners.keydown || [], []);
  restore();
});

test('indicator text cannot inject markup', async () => {
  const { panel, doc, restore } = await freshPanel();
  panel.openCyberIntelPanel({
    ...liveEntry({
      ioc: '<img src=x onerror=alert(1)>',
      src: {
        country: 'Germany',
        code: 'DE',
        lat: 50.1,
        lon: 8.68,
        city: '<b>Frankfurt</b>',
      },
    }),
    feedMode: 'live',
    sourceLabel: 'CINS Army · blocklist.de · Spamhaus · OpenPhish',
  });
  const values = allValues(findById(doc.body, 'cyber-intel-panel'));
  assert.equal(values.get('IP'), '<img src=x onerror=alert(1)>');
  assert.equal(values.get('CITY'), '<b>Frankfurt</b>');
  restore();
});
