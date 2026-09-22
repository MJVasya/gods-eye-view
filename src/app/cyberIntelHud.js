/**
 * @module cyberIntelHud
 * @description Tactical HUD stats panel for the Cyber Intel layer.
 *
 * Reads the layer module's `getStats()` contract —
 * `{ count, byType: {ddos, malware, intrusion, phishing, scan, c2},
 *    topSources, topDestinations, lastUpdate, error, simulated }` —
 * through the data manager's public `getAll()` rows and re-renders on the
 * layer's update tick (the manager's `data-updated` activity) and on
 * visibility changes. The panel renders nothing while the layer is disabled.
 *
 * No network calls: every value is computed locally from the simulated feed,
 * so this stays free-tier friendly. The prominent SIMULATED FEED badge is
 * deliberate — this data is generated locally and must never be mistaken for
 * real threat intelligence.
 */

const CYBER_LAYER_ID = 'cyber';

const THREAT_TYPES = Object.freeze([
  { key: 'ddos', label: 'DDOS' },
  { key: 'malware', label: 'MALWARE' },
  { key: 'intrusion', label: 'INTRUSION' },
  { key: 'phishing', label: 'PHISHING' },
  { key: 'scan', label: 'SCAN' },
  { key: 'c2', label: 'C2' },
]);

const MAX_TOP_ENTRIES = 5;

function finiteCount(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? Math.floor(numeric) : 0;
}

function cleanText(value) {
  return typeof value === 'string' ? value.trim().slice(0, 64) : '';
}

/**
 * Sanitize a raw `getStats()` result into the panel's exact contract shape.
 * Missing sections degrade to empty rather than throwing: an uninitialized
 * layer reports zeroed stats and the panel stays hidden until enablement.
 */
export function normalizeCyberStats(stats = {}) {
  const input = stats && typeof stats === 'object' ? stats : {};
  const byType = {};
  for (const { key } of THREAT_TYPES) {
    byType[key] = finiteCount(input.byType?.[key]);
  }
  const topEntries = (rows) =>
    (Array.isArray(rows) ? rows : []).slice(0, MAX_TOP_ENTRIES).map((row) => ({
      code: cleanText(row?.code),
      country: cleanText(row?.country),
      count: finiteCount(row?.count),
    }));
  return {
    count: finiteCount(input.count),
    byType,
    topSources: topEntries(input.topSources),
    topDestinations: topEntries(input.topDestinations),
    lastUpdate:
      typeof input.lastUpdate === 'number' && Number.isFinite(input.lastUpdate)
        ? input.lastUpdate
        : null,
    error: cleanText(input.error),
    simulated: input.simulated !== false,
  };
}

function formatCyberTimestamp(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '--:--:--Z';
  const date = new Date(ms);
  const pad = (value) => String(value).padStart(2, '0');
  return `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}Z`;
}

function formatCyberCount(value) {
  return finiteCount(value).toLocaleString('en-US');
}

/** Floating tactical-HUD stats readout bound to the cyber layer's lifecycle. */
export class CyberIntelHud {
  constructor(dataManager) {
    if (
      !dataManager?.subscribeActivity ||
      typeof dataManager.getAll !== 'function'
    )
      throw new TypeError('CyberIntelHud requires a data layer manager');
    this._manager = dataManager;
    this._root = null;
    this._doc = null;
    this._els = null;
    this._unsubscribe = null;
    this._destroyed = false;
  }

  _el(doc, tag, className) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    return node;
  }

  _buildPanel(doc) {
    const root = this._el(doc, 'section', 'cyber-hud');
    root.id = 'cyber-intel-hud';
    root.hidden = true;
    if (typeof root.setAttribute === 'function')
      root.setAttribute(
        'aria-label',
        'Cyber Intel statistics — simulated feed',
      );

    const corner = (className, glyph) => {
      const node = this._el(doc, 'span', `cyber-hud-corner ${className}`);
      node.textContent = glyph;
      return node;
    };
    root.appendChild(corner('cyber-hud-tl', '┌'));
    root.appendChild(corner('cyber-hud-tr', '┐'));
    root.appendChild(corner('cyber-hud-bl', '└'));
    root.appendChild(corner('cyber-hud-br', '┘'));

    const head = this._el(doc, 'div', 'cyber-hud-head');
    const title = this._el(doc, 'span', 'cyber-hud-title');
    title.textContent = 'CYBER INTEL';
    const simBadge = this._el(doc, 'span', 'cyber-hud-sim');
    simBadge.textContent = 'SIMULATED FEED';
    head.appendChild(title);
    head.appendChild(simBadge);
    root.appendChild(head);

    const counter = this._el(doc, 'div', 'cyber-hud-counter');
    const countNum = this._el(doc, 'span', 'cyber-hud-count-num');
    countNum.textContent = '0';
    const countLabel = this._el(doc, 'span', 'cyber-hud-count-label');
    countLabel.textContent = 'TRACKED ATTACKS';
    counter.appendChild(countNum);
    counter.appendChild(countLabel);
    root.appendChild(counter);

    const columns = this._el(doc, 'div', 'cyber-hud-columns');
    const lists = {};
    for (const [key, heading] of [
      ['sources', 'TOP SOURCES'],
      ['destinations', 'TOP TARGETS'],
    ]) {
      const col = this._el(doc, 'div', 'cyber-hud-col');
      const section = this._el(doc, 'div', 'cyber-hud-sec');
      section.textContent = heading;
      const list = this._el(doc, 'ol', 'cyber-hud-list');
      col.appendChild(section);
      col.appendChild(list);
      columns.appendChild(col);
      lists[key] = list;
    }
    root.appendChild(columns);

    const mixSec = this._el(doc, 'div', 'cyber-hud-sec');
    mixSec.textContent = 'THREAT MIX';
    root.appendChild(mixSec);
    const mix = this._el(doc, 'div', 'cyber-hud-mix');
    const typeRows = new Map();
    for (const { key, label } of THREAT_TYPES) {
      const row = this._el(doc, 'div', 'cyber-hud-type-row');
      const name = this._el(doc, 'span', 'cyber-hud-type-name');
      name.textContent = label;
      const bar = this._el(doc, 'span', 'cyber-hud-type-bar');
      const fill = this._el(doc, 'span', 'cyber-hud-type-fill');
      bar.appendChild(fill);
      const count = this._el(doc, 'span', 'cyber-hud-type-count');
      count.textContent = '0';
      row.appendChild(name);
      row.appendChild(bar);
      row.appendChild(count);
      mix.appendChild(row);
      typeRows.set(key, { fill, count });
    }
    root.appendChild(mix);

    const foot = this._el(doc, 'div', 'cyber-hud-foot');
    const updated = this._el(doc, 'span', 'cyber-hud-updated');
    updated.textContent = 'UPD --:--:--Z';
    const error = this._el(doc, 'span', 'cyber-hud-error');
    error.hidden = true;
    foot.appendChild(updated);
    foot.appendChild(error);
    root.appendChild(foot);

    this._els = {
      countNum,
      sourceList: lists.sources,
      destinationList: lists.destinations,
      typeRows,
      updated,
      error,
    };
    return root;
  }

  _renderTopList(list, entries) {
    const doc = this._doc;
    while (list.firstChild) list.removeChild(list.firstChild);
    for (const { code, country, count } of entries) {
      // Build with explicit child nodes so values are textContent-escaped.
      const item = doc.createElement('li');
      item.className = 'cyber-hud-item';
      const codeNode = doc.createElement('span');
      codeNode.className = 'cyber-hud-item-code';
      codeNode.textContent = code || '--';
      const nameNode = doc.createElement('span');
      nameNode.className = 'cyber-hud-item-name';
      nameNode.textContent = country || 'UNKNOWN';
      const countNode = doc.createElement('span');
      countNode.className = 'cyber-hud-item-count';
      countNode.textContent = formatCyberCount(count);
      item.appendChild(codeNode);
      item.appendChild(nameNode);
      item.appendChild(countNode);
      list.appendChild(item);
    }
  }

  _readStats() {
    try {
      const row = this._manager
        .getAll()
        .find((entry) => entry?.id === CYBER_LAYER_ID);
      if (!row?.enabled) return { enabled: false, stats: null };
      return { enabled: true, stats: normalizeCyberStats(row.stats) };
    } catch (error) {
      console.warn('[CyberIntel] stats read failed:', error);
      return { enabled: false, stats: null };
    }
  }

  refresh() {
    if (this._destroyed || !this._root || !this._els) return;
    const { enabled, stats } = this._readStats();
    this._root.hidden = !enabled;
    if (!enabled || !stats) return;
    this._els.countNum.textContent = formatCyberCount(stats.count);
    this._renderTopList(this._els.sourceList, stats.topSources);
    this._renderTopList(this._els.destinationList, stats.topDestinations);
    const total = THREAT_TYPES.reduce(
      (sum, { key }) => sum + stats.byType[key],
      0,
    );
    for (const { key } of THREAT_TYPES) {
      const row = this._els.typeRows.get(key);
      if (!row) continue;
      const value = stats.byType[key];
      row.count.textContent = formatCyberCount(value);
      if (row.fill && typeof row.fill === 'object' && 'style' in row.fill) {
        row.fill.style.width = total > 0 ? `${(value / total) * 100}%` : '0%';
      }
    }
    this._els.updated.textContent = `UPD ${formatCyberTimestamp(stats.lastUpdate)}`;
    const hasError = Boolean(stats.error);
    this._els.error.hidden = !hasError;
    if (hasError) this._els.error.textContent = `ERR ${stats.error}`;
  }

  mount(container = null) {
    if (this._destroyed || this._root) return;
    const doc = globalThis.document;
    if (!doc || typeof doc.createElement !== 'function') return;
    const host = container || doc.body;
    if (!host || typeof host.appendChild !== 'function') return;
    this._doc = doc;
    this._root = this._buildPanel(doc);
    host.appendChild(this._root);
    this._unsubscribe = this._manager.subscribeActivity((change) => {
      if (this._destroyed || !change) return;
      if (change.type === 'destroy-all') {
        this.destroy();
        return;
      }
      if (change.layerId !== CYBER_LAYER_ID) return;
      if (
        change.type === 'data-updated' ||
        change.type === 'visibility-settled' ||
        change.type === 'status'
      )
        this.refresh();
    });
    this.refresh();
  }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    try {
      this._unsubscribe?.();
    } catch {
      /* listener removal is best effort */
    }
    this._unsubscribe = null;
    this._root?.remove?.();
    this._root = null;
    this._doc = null;
    this._els = null;
  }
}
