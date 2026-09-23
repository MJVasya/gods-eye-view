/**
 * @module cyberIntelPanel
 * @description Click-to-inspect location-intel panel for the Cyber Intel
 * layer.
 *
 * Clicking an attack SOURCE marker (or its arc) opens a floating panel with
 * the source's location intel: indicator, GeoIP enrichment, threat type and
 * severity, plus keyless Google map embeds (Street View / Satellite tabs).
 * Attribution honesty is structural: the badge is derived only from the
 * feed mode captured with the event (`getCyberEvent().feedMode`), so a
 * simulated source can never render under the live label or vice versa.
 * Missing GeoIP fields render as "n/a" — the panel never invents data.
 *
 * Keyless by design: the map iframes use the same no-key Google embed
 * endpoints as the repo's keyless geocoder precedent — no API keys, no
 * secrets, free tier.
 */

const PANEL_ID = 'cyber-intel-panel';

const SIMULATED_BADGE = 'SIMULATED FEED';
const LIVE_BADGE = 'LIVE FEED';

/** In-app attribution while the simulated feed is active (the default). */
const SIMULATED_SOURCE_LABEL = 'Simulated feed';

/** Rows rendered in the intel table, in display order. */
const ROW_ORDER = [
  'ip',
  'country',
  'city',
  'region',
  'latlon',
  'isp',
  'org',
  'asn',
  'threat',
  'severity',
];

const ROW_LABELS = {
  ip: 'IP',
  country: 'COUNTRY',
  city: 'CITY',
  region: 'REGION',
  latlon: 'LAT / LON',
  isp: 'ISP',
  org: 'ORG',
  asn: 'ASN',
  threat: 'THREAT',
  severity: 'SEVERITY',
};

let _doc = null;
let _root = null;
let _els = null;
let _destroyed = false;

function el(doc, tag, className) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  return node;
}

function finiteCoord(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function text(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : 'n/a';
}

function formatLatLon(lat, lon) {
  const la = finiteCoord(lat);
  const lo = finiteCoord(lon);
  if (la === null || lo === null) return 'n/a';
  return `${la.toFixed(4)}°, ${lo.toFixed(4)}°`;
}

/** Build the row values for one retained event entry. All values are plain
 *  strings, rendered via textContent so indicators can't inject markup. */
export function cyberIntelRowValues(entry) {
  const record = entry?.record || {};
  const src = record.src || {};
  const live = entry?.feedMode === 'live';
  return {
    ip: live ? text(record.ioc) : 'simulated',
    country:
      typeof src.country === 'string' && src.country
        ? src.code
          ? `${src.country} (${src.code})`
          : src.country
        : 'n/a',
    city: text(src.city),
    region: text(src.region),
    latlon: formatLatLon(src.lat, src.lon),
    isp: text(src.isp),
    org: text(src.org),
    asn: text(src.asn),
    threat:
      typeof record.type === 'string' && record.type
        ? record.type.toUpperCase()
        : 'n/a',
    severity: Number.isInteger(record.severity)
      ? `${record.severity} / 5`
      : 'n/a',
  };
}

function mapUrls(lat, lon) {
  const la = finiteCoord(lat);
  const lo = finiteCoord(lon);
  if (la === null || lo === null) return null;
  const coords = `${la.toFixed(6)},${lo.toFixed(6)}`;
  return {
    street: `https://maps.google.com/maps?q=&layer=c&cbll=${coords}&output=svembed`,
    satellite: `https://maps.google.com/maps?q=${coords}&z=17&t=k&output=embed`,
  };
}

function buildPanel(doc) {
  const root = el(doc, 'section', 'cyber-intel-panel');
  root.id = PANEL_ID;
  root.hidden = true;
  if (typeof root.setAttribute === 'function')
    root.setAttribute('aria-label', 'Cyber Intel attack source details');

  const head = el(doc, 'div', 'cyber-intel-head');
  const title = el(doc, 'span', 'cyber-intel-title');
  title.textContent = 'ATTACK SOURCE';
  const badge = el(doc, 'span', 'cyber-intel-badge');
  badge.textContent = SIMULATED_BADGE;
  const close = el(doc, 'button', 'cyber-intel-close');
  close.type = 'button';
  close.textContent = '×';
  if (typeof close.setAttribute === 'function')
    close.setAttribute('aria-label', 'Close intel panel');
  head.appendChild(title);
  head.appendChild(badge);
  head.appendChild(close);
  root.appendChild(head);

  const rows = el(doc, 'div', 'cyber-intel-rows');
  const valueEls = {};
  for (const key of ROW_ORDER) {
    const row = el(doc, 'div', 'cyber-intel-row');
    const label = el(doc, 'span', 'cyber-intel-key');
    label.textContent = ROW_LABELS[key];
    const value = el(doc, 'span', 'cyber-intel-value');
    value.textContent = 'n/a';
    row.appendChild(label);
    row.appendChild(value);
    rows.appendChild(row);
    valueEls[key] = value;
  }
  root.appendChild(rows);

  const tabs = el(doc, 'div', 'cyber-intel-tabs');
  const tabButtons = {};
  for (const [key, label] of [
    ['street', 'STREET VIEW'],
    ['satellite', 'SATELLITE'],
  ]) {
    const button = el(doc, 'button', 'cyber-intel-tab');
    button.type = 'button';
    button.textContent = label;
    if (typeof button.setAttribute === 'function')
      button.setAttribute('role', 'tab');
    tabs.appendChild(button);
    tabButtons[key] = button;
  }
  root.appendChild(tabs);

  const maps = el(doc, 'div', 'cyber-intel-maps');
  const frames = {};
  for (const key of ['street', 'satellite']) {
    const frame = el(doc, 'iframe', 'cyber-intel-map');
    frame.hidden = key !== 'street';
    if (typeof frame.setAttribute === 'function') {
      frame.setAttribute(
        'title',
        key === 'street'
          ? 'Street View of the attack source location'
          : 'Satellite view of the attack source location',
      );
      frame.setAttribute('loading', 'lazy');
    }
    maps.appendChild(frame);
    frames[key] = frame;
  }
  root.appendChild(maps);

  const note = el(doc, 'div', 'cyber-intel-note');
  // Keyless embeds can't detect Street View coverage reliably, so the
  // Satellite tab is one click away instead of a faked "no coverage" state.
  note.textContent =
    'No Street View here? Try the Satellite tab — keyless coverage detection is unreliable.';
  root.appendChild(note);

  return { root, badge, close, valueEls, tabButtons, frames };
}

function setTab(name) {
  if (!_els) return;
  for (const [key, button] of Object.entries(_els.tabButtons)) {
    const active = key === name;
    if (typeof button.setAttribute === 'function')
      button.setAttribute('aria-selected', active ? 'true' : 'false');
    // Toggle a class without clobbering the base class on fake DOMs.
    const base = 'cyber-intel-tab';
    button.className = active ? `${base} cyber-intel-tab-active` : base;
  }
  for (const [key, frame] of Object.entries(_els.frames)) {
    frame.hidden = key !== name;
  }
}

function onKeyDown(event) {
  if (event?.key === 'Escape') closeCyberIntelPanel();
}

/**
 * Mount the panel into the document (idempotent). Consistent with
 * CyberIntelHud: floating, body-mounted, owned by its module. A no-op
 * without a real document (unit tests, SSR).
 * @param {HTMLElement|null} [container] Mount target; defaults to body.
 */
export function mountCyberIntelPanel(container = null) {
  if (_destroyed || _root) return;
  const doc = globalThis.document;
  if (!doc || typeof doc.createElement !== 'function') return;
  const host = container || doc.body;
  if (!host || typeof host.appendChild !== 'function') return;
  _doc = doc;
  _els = buildPanel(doc);
  _root = _els.root;
  _els.close.addEventListener?.('click', closeCyberIntelPanel);
  _els.tabButtons.street.addEventListener?.('click', () => setTab('street'));
  _els.tabButtons.satellite.addEventListener?.('click', () =>
    setTab('satellite'),
  );
  if (typeof doc.addEventListener === 'function')
    doc.addEventListener('keydown', onKeyDown);
  host.appendChild(_root);
  setTab('street');
}

/**
 * Open the panel for one retained layer event.
 * @param {{ record: object, feedMode: 'simulated'|'live', sourceLabel: string }} entry
 *   As returned by the cyber layer's getCyberEvent(id).
 */
export function openCyberIntelPanel(entry) {
  const record = entry?.record;
  if (!record || typeof record !== 'object') return;
  mountCyberIntelPanel();
  if (!_root || !_els) return;
  const live = entry.feedMode === 'live';
  const badge = _els.badge;
  badge.textContent = live ? LIVE_BADGE : SIMULATED_BADGE;
  badge.title = live
    ? entry.sourceLabel || 'Live threat-intel feed'
    : `${SIMULATED_SOURCE_LABEL} — generated locally, not real threat intelligence`;
  const base = 'cyber-intel-badge';
  badge.className = live ? `${base} cyber-intel-badge-live` : base;
  if (typeof badge.setAttribute === 'function')
    badge.setAttribute(
      'aria-label',
      live ? 'Live threat-intel feed' : 'Simulated feed',
    );

  const values = cyberIntelRowValues(entry);
  for (const key of ROW_ORDER) {
    _els.valueEls[key].textContent = values[key];
  }

  const urls = mapUrls(record.src?.lat, record.src?.lon);
  for (const [key, frame] of Object.entries(_els.frames)) {
    if (typeof frame.setAttribute === 'function') {
      if (urls) frame.setAttribute('src', urls[key]);
      else frame.removeAttribute?.('src');
    }
  }
  setTab('street');
  _root.hidden = false;
}

/** Hide the panel without unmounting it. Safe to call any time. */
export function closeCyberIntelPanel() {
  if (_root) _root.hidden = true;
}

/** Whether the panel is currently visible. */
export function isCyberIntelPanelOpen() {
  return Boolean(_root && !_root.hidden);
}

/** Unmount the panel and release its listeners. */
export function destroyCyberIntelPanel() {
  if (_destroyed) return;
  _destroyed = true;
  try {
    _doc?.removeEventListener?.('keydown', onKeyDown);
  } catch {
    /* listener removal is best effort */
  }
  _root?.remove?.();
  _root = null;
  _els = null;
  _doc = null;
}
