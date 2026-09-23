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

/**
 * Phase 4a panel-stack layout. The HUD is a fixed right-edge readout; the
 * CONTEXT panel lives in #right-context-rail, whose top is computed at
 * runtime (26vh baseline, adjusted for obstacles). A static `top` can never
 * clear it at every viewport size, so the HUD docks itself below the rail
 * whenever their horizontal bands intersect.
 */
const CYBER_HUD_DEFAULT_TOP = 118;
const CYBER_HUD_WIDTH = 248;
const CYBER_HUD_RIGHT_OFFSET = 14;
const CYBER_HUD_STACK_GAP = 12;
/** Fallback height (px) when the panel is not laid out yet. */
const CYBER_HUD_ESTIMATED_HEIGHT = 344;

/**
 * Pure layout math for the floating Cyber Intel HUD (phase 4a declutter).
 *
 * The HUD must never overlap #right-context-rail at any viewport size.
 * Placement preference: full height below the rail → full height above the
 * rail → shrunk below the rail → shrunk above the rail → clamped on screen
 * (overlap is unavoidable only when the rail itself nearly fills the
 * viewport; the panel then scrolls internally — see the phase-4a CSS).
 *
 * @param {object} [input]
 * @param {number} [input.viewportWidth] Viewport width in px.
 * @param {number} [input.viewportHeight] Viewport height in px.
 * @param {number} [input.hudWidth=248] HUD width in px.
 * @param {number} [input.hudHeight=0] Measured HUD height in px.
 * @param {object|null} [input.railRect] Visible #right-context-rail rect
 *   ({left,right,top,bottom}) or null when the rail is absent/hidden.
 * @param {number} [input.defaultTop=118] Top offset when nothing overlaps.
 * @param {number} [input.gap=12] Clearance between stacked panels.
 * @param {number} [input.minVisible=160] Minimum usable shrunk height.
 * @returns {{top:number,maxHeight:number|null}} Docked top offset, plus a
 *   max-height when the panel is shrunk to fit (null = unconstrained).
 */
export function computeCyberHudTop({
  viewportWidth = 0,
  viewportHeight = 0,
  hudWidth = CYBER_HUD_WIDTH,
  hudHeight = 0,
  railRect = null,
  defaultTop = CYBER_HUD_DEFAULT_TOP,
  gap = CYBER_HUD_STACK_GAP,
  minVisible = 160,
} = {}) {
  const vw = Math.max(0, Number(viewportWidth) || 0);
  const vh = Math.max(0, Number(viewportHeight) || 0);
  const width = Math.max(0, Number(hudWidth) || 0);
  const height = Math.max(0, Number(hudHeight) || 0);
  const safeGap = Math.max(0, Number(gap) || 0);
  const minFit = Math.max(0, Number(minVisible) || 0);
  const hudLeft = vw - CYBER_HUD_RIGHT_OFFSET - width;
  const hudRight = vw - CYBER_HUD_RIGHT_OFFSET;
  const overlapsRail =
    !!railRect &&
    Number.isFinite(railRect.left) &&
    Number.isFinite(railRect.right) &&
    Number.isFinite(railRect.top) &&
    Number.isFinite(railRect.bottom) &&
    railRect.right > railRect.left &&
    railRect.bottom > railRect.top &&
    railRect.left < hudRight &&
    railRect.right > hudLeft;

  /** Clamp a placement on screen; shrink when it cannot fit at full height. */
  const fit = (top, fullHeight) => {
    const clampedTop = Math.min(
      Math.max(safeGap, top),
      Math.max(safeGap, vh - safeGap - fullHeight),
    );
    const maxHeight =
      fullHeight > 0 && clampedTop + fullHeight > vh - safeGap
        ? Math.round(Math.max(0, vh - clampedTop - safeGap))
        : null;
    return { top: Math.round(clampedTop), maxHeight };
  };

  if (!overlapsRail) return fit(defaultTop, height);

  const below = railRect.bottom + safeGap;
  const belowSpace = vh - safeGap - below;
  const aboveFull = railRect.top - safeGap - height;
  const aboveSpace = railRect.top - safeGap - safeGap;
  if (belowSpace >= height) return { top: Math.round(below), maxHeight: null };
  if (aboveFull >= safeGap)
    return { top: Math.round(aboveFull), maxHeight: null };
  if (belowSpace >= minFit)
    return { top: Math.round(below), maxHeight: Math.round(belowSpace) };
  if (aboveSpace >= minFit)
    return { top: safeGap, maxHeight: Math.round(aboveSpace) };
  // No comfortable slot: take whatever sliver stays clear of the rail rather
  // than overlapping it. Only when the rail itself fills the viewport does
  // the final clamp allow overlap, keeping the panel on screen and scrollable.
  if (aboveSpace > 0)
    return { top: safeGap, maxHeight: Math.round(aboveSpace) };
  if (belowSpace > 0)
    return { top: Math.round(below), maxHeight: Math.round(belowSpace) };
  return fit(safeGap, height);
}

/**
 * Stack the click-to-inspect intel panel under the HUD (phase 4a declutter).
 * Pure companion to computeCyberHudTop; keeps at least `minVisible` px of the
 * panel on screen on short viewports.
 */
export function computeCyberIntelPanelTop({
  viewportHeight = 0,
  hudTop = CYBER_HUD_DEFAULT_TOP,
  hudHeight = CYBER_HUD_ESTIMATED_HEIGHT,
  gap = CYBER_HUD_STACK_GAP,
  minVisible = 96,
} = {}) {
  const vh = Math.max(0, Number(viewportHeight) || 0);
  const safeGap = Math.max(0, Number(gap) || 0);
  const stacked =
    (Number(hudTop) || 0) + (Number(hudHeight) || 0) + safeGap;
  const clampedTop = Math.min(
    stacked,
    Math.max(safeGap, vh - Math.max(0, Number(minVisible) || 0)),
  );
  return Math.round(Math.max(safeGap, clampedTop));
}

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
    // Active feed attribution (mirrors the layer's source label); the badge
    // renders the short mode form, the full label rides on `title`.
    source: cleanText(input.source),
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
    this._onResize = null;
    this._railResizeObserver = null;
    this._railMutationObserver = null;
    this._repositionQueued = false;
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
    title.title = 'Cyber threat activity for the active feed';
    const simBadge = this._el(doc, 'span', 'cyber-hud-sim');
    simBadge.textContent = 'SIMULATED FEED';
    head.appendChild(title);
    head.appendChild(simBadge);
    root.appendChild(head);

    const counter = this._el(doc, 'div', 'cyber-hud-counter');
    counter.title = 'Attacks tracked in the current feed window';
    const countNum = this._el(doc, 'span', 'cyber-hud-count-num');
    countNum.textContent = '0';
    const countLabel = this._el(doc, 'span', 'cyber-hud-count-label');
    countLabel.textContent = 'TRACKED ATTACKS';
    counter.appendChild(countNum);
    counter.appendChild(countLabel);
    root.appendChild(counter);

    const columns = this._el(doc, 'div', 'cyber-hud-columns');
    const lists = {};
    for (const [key, heading, hint] of [
      ['sources', 'TOP SOURCES', 'Countries originating the most attacks'],
      ['destinations', 'TOP TARGETS', 'Countries receiving the most attacks'],
    ]) {
      const col = this._el(doc, 'div', 'cyber-hud-col');
      const section = this._el(doc, 'div', 'cyber-hud-sec');
      section.textContent = heading;
      section.title = hint;
      const list = this._el(doc, 'ol', 'cyber-hud-list');
      col.appendChild(section);
      col.appendChild(list);
      columns.appendChild(col);
      lists[key] = list;
    }
    root.appendChild(columns);

    const mixSec = this._el(doc, 'div', 'cyber-hud-sec');
    mixSec.textContent = 'THREAT MIX';
    mixSec.title = 'Threat-type breakdown of the tracked attacks';
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
      typeRows.set(key, { row, fill, count, label });
    }
    root.appendChild(mix);

    const foot = this._el(doc, 'div', 'cyber-hud-foot');
    const updated = this._el(doc, 'span', 'cyber-hud-updated');
    updated.textContent = 'UPD --:--:--Z';
    updated.title = 'Time of the last feed update (UTC)';
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
      simBadge,
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
      item.title = `${country || 'UNKNOWN'} — ${formatCyberCount(count)} attacks`;
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

  /**
   * Dock the HUD clear of #right-context-rail (phase 4a declutter).
   *
   * The rail's top/height are computed at runtime, so a static stylesheet
   * `top` overlaps it on some viewports (the reported HUD/CONTEXT overlap).
   * This measures the live rail rect and publishes --cyber-hud-top (plus the
   * stacked --cyber-intel-panel-top for the click-to-inspect panel) as CSS
   * variables; the phase-4a stylesheet rules consume them. When the HUD is
   * hidden or there is no viewport, the variables are removed so the static
   * stylesheet defaults apply.
   */
  _reposition() {
    if (this._destroyed || !this._root || !this._doc) return;
    const doc = this._doc;
    const rootEl = doc.documentElement;
    const setVar = (name, value) => {
      try {
        if (value == null) rootEl?.style?.removeProperty?.(name);
        else rootEl?.style?.setProperty?.(name, value);
      } catch {
        /* styling is best effort in non-DOM harnesses */
      }
    };
    const view =
      typeof globalThis.window !== 'undefined' ? globalThis.window : null;
    const vw =
      view && Number.isFinite(Number(view.innerWidth))
        ? Number(view.innerWidth)
        : 0;
    const vh =
      view && Number.isFinite(Number(view.innerHeight))
        ? Number(view.innerHeight)
        : 0;
    if (this._root.hidden || vw <= 0 || vh <= 0) {
      setVar('--cyber-hud-top', null);
      setVar('--cyber-hud-max-height', null);
      setVar('--cyber-intel-panel-top', null);
      return;
    }
    let railRect = null;
    const rail =
      typeof doc.getElementById === 'function'
        ? doc.getElementById('right-context-rail')
        : null;
    if (rail && typeof rail.getBoundingClientRect === 'function') {
      const rect = rail.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        railRect = {
          left: rect.left,
          right: rect.right,
          top: rect.top,
          bottom: rect.bottom,
        };
      }
    }
    this._ensureRailObserver(rail);
    const measured = Number(this._root.offsetHeight);
    const hudHeight =
      Number.isFinite(measured) && measured > 0
        ? measured
        : CYBER_HUD_ESTIMATED_HEIGHT;
    const { top, maxHeight } = computeCyberHudTop({
      viewportWidth: vw,
      viewportHeight: vh,
      hudHeight,
      railRect,
    });
    setVar('--cyber-hud-top', `${top}px`);
    setVar(
      '--cyber-hud-max-height',
      maxHeight == null ? null : `${maxHeight}px`,
    );
    setVar(
      '--cyber-intel-panel-top',
      `${computeCyberIntelPanelTop({
        viewportHeight: vh,
        hudTop: top,
        hudHeight: maxHeight == null ? hudHeight : maxHeight,
      })}px`,
    );
  }

  /**
   * Watch the rail for expand/collapse resizes AND moves. ResizeObserver
   * alone is not enough: the rail's own layout pass repositions it via
   * inline `--right-stack-safe-top` writes (a move, not a resize), so a
   * MutationObserver on style/class attributes covers every reposition.
   * Callbacks are rAF-throttled and best effort — they never throw.
   */
  _ensureRailObserver(rail) {
    if (this._destroyed) return;
    if (this._railResizeObserver && this._railMutationObserver) return;
    if (!rail) return;
    const schedule = () => this._scheduleReposition();
    if (
      !this._railResizeObserver &&
      typeof globalThis.ResizeObserver === 'function'
    ) {
      try {
        this._railResizeObserver = new globalThis.ResizeObserver(schedule);
        this._railResizeObserver.observe(rail);
      } catch {
        this._railResizeObserver = null;
      }
    }
    if (
      !this._railMutationObserver &&
      typeof globalThis.MutationObserver === 'function'
    ) {
      try {
        this._railMutationObserver = new globalThis.MutationObserver(schedule);
        this._railMutationObserver.observe(rail, {
          attributes: true,
          attributeFilter: ['style', 'class'],
        });
      } catch {
        this._railMutationObserver = null;
      }
    }
  }

  /** Coalesce bursts of rail mutations into one reposition per frame. */
  _scheduleReposition() {
    if (this._destroyed || this._repositionQueued) return;
    this._repositionQueued = true;
    const run = () => {
      this._repositionQueued = false;
      this._reposition();
    };
    if (typeof globalThis.requestAnimationFrame === 'function') {
      try {
        globalThis.requestAnimationFrame(run);
        return;
      } catch {
        /* fall through to a synchronous reposition */
      }
    }
    run();
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
    // Re-dock whenever visibility changes; _reposition clears the stacking
    // variables while hidden so the static stylesheet defaults apply.
    this._reposition();
    if (!enabled || !stats) return;
    this._els.countNum.textContent = formatCyberCount(stats.count);
    this._renderTopList(this._els.sourceList, stats.topSources);
    this._renderTopList(this._els.destinationList, stats.topDestinations);
    // Attribution badge follows the feed mode exactly: simulated and live
    // wording must never mix. The full live label rides on `title`.
    const live = !stats.simulated;
    const badge = this._els.simBadge;
    if (badge) {
      const label = live ? 'LIVE FEED' : 'SIMULATED FEED';
      if (badge.textContent !== label) badge.textContent = label;
      // Amber in simulated, cyan in live — matching the click-to-inspect
      // panel's cyber-intel-badge-live. classList is guarded for headless
      // test fakes that don't implement it.
      if (typeof badge.classList?.toggle === 'function') {
        badge.classList.toggle('cyber-hud-live', live);
      }
      badge.title = live
        ? stats.source || 'Live threat-intel feed'
        : 'Simulated feed — generated locally, not real threat intelligence';
      if (typeof badge.setAttribute === 'function') {
        badge.setAttribute(
          'aria-label',
          live ? 'Live threat-intel feed' : 'Simulated feed',
        );
      }
    }
    // The panel's own label must follow the mode too: a screen reader should
    // never hear "simulated feed" while live IOCs are on screen.
    if (typeof this._root.setAttribute === 'function') {
      this._root.setAttribute(
        'aria-label',
        live
          ? 'Cyber Intel statistics — live threat-intel feed'
          : 'Cyber Intel statistics — simulated feed',
      );
    }
    const total = THREAT_TYPES.reduce(
      (sum, { key }) => sum + stats.byType[key],
      0,
    );
    for (const { key } of THREAT_TYPES) {
      const row = this._els.typeRows.get(key);
      if (!row) continue;
      const value = stats.byType[key];
      row.count.textContent = formatCyberCount(value);
      row.row.title = `${row.label}: ${formatCyberCount(value)} attacks`;
      if (row.fill && typeof row.fill === 'object' && 'style' in row.fill) {
        row.fill.style.width = total > 0 ? `${(value / total) * 100}%` : '0%';
      }
    }
    this._els.updated.textContent = `UPD ${formatCyberTimestamp(stats.lastUpdate)}`;
    const hasError = Boolean(stats.error);
    this._els.error.hidden = !hasError;
    if (hasError) {
      this._els.error.textContent = `ERR ${stats.error}`;
      this._els.error.title = stats.error;
    }
    // Content height changed — re-dock clear of the context rail.
    this._reposition();
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
    // Re-dock on viewport resizes; the rail observer (installed in
    // _reposition) covers expand/collapse of the CONTEXT panel.
    const view =
      typeof globalThis.window !== 'undefined' ? globalThis.window : null;
    if (view && typeof view.addEventListener === 'function') {
      this._onResize = () => this._reposition();
      view.addEventListener('resize', this._onResize);
    }
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
    const view =
      typeof globalThis.window !== 'undefined' ? globalThis.window : null;
    if (
      view &&
      typeof view.removeEventListener === 'function' &&
      this._onResize
    ) {
      try {
        view.removeEventListener('resize', this._onResize);
      } catch {
        /* listener removal is best effort */
      }
    }
    this._onResize = null;
    if (this._railResizeObserver) {
      try {
        this._railResizeObserver.disconnect();
      } catch {
        /* observer teardown is best effort */
      }
      this._railResizeObserver = null;
    }
    if (this._railMutationObserver) {
      try {
        this._railMutationObserver.disconnect();
      } catch {
        /* observer teardown is best effort */
      }
      this._railMutationObserver = null;
    }
    this._repositionQueued = false;
    try {
      this._doc?.documentElement?.style?.removeProperty?.('--cyber-hud-top');
      this._doc?.documentElement?.style?.removeProperty?.(
        '--cyber-hud-max-height',
      );
      this._doc?.documentElement?.style?.removeProperty?.(
        '--cyber-intel-panel-top',
      );
    } catch {
      /* styling is best effort in non-DOM harnesses */
    }
    this._root?.remove?.();
    this._root = null;
    this._doc = null;
    this._els = null;
  }
}
