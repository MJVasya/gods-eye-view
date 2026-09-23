import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

test('panel presentation places Transit between Street Traffic and Bike Share in Movement', () => {
  const source = readFileSync(
    new URL('./layerPanel.js', import.meta.url),
    'utf8',
  );
  const declarations = source.slice(
    source.indexOf('const PANEL_GROUPS ='),
    source.indexOf('const PANEL_POSITIONS ='),
  );
  const order = JSON.parse(
    runInNewContext(`${declarations}\nJSON.stringify(PANEL_ORDER)`),
  );
  assert.deepEqual(
    order.filter(({ label }) => label === 'Movement').map(({ id }) => id),
    [
      'satellites',
      'flights',
      'military',
      'ais-live-vessels',
      'traffic',
      'transit',
      'bikeshare',
    ],
  );
  assert.equal(order.filter(({ id }) => id === 'transit').length, 1);
});

test('panel presentation places Cyber Intel between Earthquakes and Active Fires in Events', () => {
  const source = readFileSync(
    new URL('./layerPanel.js', import.meta.url),
    'utf8',
  );
  const declarations = source.slice(
    source.indexOf('const PANEL_GROUPS ='),
    source.indexOf('const PANEL_POSITIONS ='),
  );
  const order = JSON.parse(
    runInNewContext(`${declarations}\nJSON.stringify(PANEL_ORDER)`),
  );
  assert.deepEqual(
    order.filter(({ label }) => label === 'Events').map(({ id }) => id),
    ['rocket-launches', 'earthquakes', 'cyber', 'local-firms'],
  );
  assert.equal(order.filter(({ id }) => id === 'cyber').length, 1);
});

test('partial feed controls distinguish incomplete records from stale data and outages', async () => {
  const { LayerPanel, layerFeedState } = await import('./layerPanel.js');
  const classes = new Map();
  const attrs = new Map();
  const button = {
    classList: { toggle: (key, value) => classes.set(key, value) },
    dataset: {},
    setAttribute: (key, value) => attrs.set(key, value),
  };
  const layer = {
    id: 'ais-live-vessels',
    name: 'Live Vessels',
    source: 'AISStream',
    enabled: true,
    stats: {
      partial: true,
      stale: false,
      count: 2,
      acceptedRowCount: 2,
      rawRowCount: 3,
      lastUpdate: Date.now(),
    },
  };
  const panel = LayerPanel.prototype;
  panel._syncToggleButton(button, layer);
  assert.equal(button.textContent, 'PARTIAL');
  assert.equal(button.dataset.feedState, 'partial');
  assert.equal(classes.get('feed-partial'), true);
  assert.equal(classes.get('feed-stale'), false);
  assert.match(attrs.get('aria-label'), /PARTIAL/);
  assert.match(
    panel._buildMetaText(layer),
    /^PARTIAL · AISStream · 2 of 3 records accepted · /,
  );
  assert.match(
    panel._buildMetaText({
      ...layer,
      stats: { ...layer.stats, rawRowCount: 2 },
    }),
    /incomplete snapshot/,
  );
  assert.equal(layerFeedState({ ...layer.stats, stale: true }), 'stale');
  assert.equal(
    layerFeedState({ ...layer.stats, error: 'Connection lost' }),
    'degraded',
  );
  assert.equal(
    layerFeedState({ ...layer.stats, status: 'unavailable' }),
    'unavailable',
  );
  assert.equal(layerFeedState({ ...layer.stats, loading: true }), 'loading');
  layer.stats = { ...layer.stats, partial: false };
  panel._syncToggleButton(button, layer);
  assert.equal(button.textContent, 'ON');
  assert.equal(classes.get('feed-partial'), false);
  layer.enabled = false;
  panel._syncToggleButton(button, layer);
  assert.equal(button.textContent, 'OFF');
});

test('layer toggle pills carry an actionable tooltip and count pills name their exact count', async () => {
  const { LayerPanel } = await import('./layerPanel.js');
  const button = {
    classList: { toggle: () => {} },
    dataset: {},
    setAttribute: () => {},
  };
  const off = {
    id: 'cyber',
    name: 'Cyber Intel',
    source: 'sim',
    enabled: false,
    stats: {},
  };
  LayerPanel.prototype._syncToggleButton(button, off);
  assert.equal(button.textContent, 'OFF');
  assert.equal(button.title, 'Cyber Intel — OFF; click to enable this layer');

  const on = {
    ...off,
    enabled: true,
    stats: { count: 1234, lastUpdate: Date.now() },
  };
  LayerPanel.prototype._syncToggleButton(button, on);
  assert.equal(button.textContent, 'ON');
  assert.equal(button.title, 'Cyber Intel — ON; click to disable this layer');

  const busy = { ...on, lifecycleState: 'enabling' };
  LayerPanel.prototype._syncToggleButton(button, busy);
  assert.equal(button.title, 'Cyber Intel — enabling...');

  const count = {};
  LayerPanel.prototype._syncCount(count, on);
  assert.equal(count.textContent, '1.2K');
  assert.equal(count.title, 'Cyber Intel — 1,234 loaded');
  LayerPanel.prototype._syncCount(count, off);
  assert.equal(count.textContent, '—');
  assert.equal(count.title, '');
});
