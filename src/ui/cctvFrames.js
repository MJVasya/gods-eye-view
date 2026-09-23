/**
 * Upper bound for one panel frame acquisition. A preloader Image has no
 * built-in timeout: without this deadline, a stalled frame request leaves the
 * "ACQUIRING FRAME" shimmer spinning forever. Past the deadline the attempt
 * settles as failed and the panel lands on the honest unavailable card.
 */
export const CCTV_FRAME_LOAD_TIMEOUT_MS = 15000;

/** Inline card chrome (the shared cctv.css is outside the CCTV workstream's
 * edit scope, so the placeholder carries its own styles). Mirrors the panel's
 * tactical palette: dark gradient, cyan mono type, amber warning headline. */
const CCTV_UNAVAILABLE_CARD_STYLE = [
  'position:absolute',
  'inset:0',
  'display:flex',
  'flex-direction:column',
  'align-items:center',
  'justify-content:center',
  'gap:8px',
  'padding:18px',
  'text-align:center',
  'background:linear-gradient(180deg,rgba(8,14,19,0.96),rgba(4,7,11,0.98))',
  'font-family:var(--font-mono,ui-monospace,SFMono-Regular,monospace)',
  'pointer-events:none',
  'z-index:2',
].join(';');

function escapeCctvHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatCctvCoord(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(4) : '—';
}

/**
 * Builds the inner HTML of the honest "feed unavailable" card shown in the
 * CCTV panel when a camera has no retrievable frame. Pure (no DOM) so it is
 * unit-testable. The card always names the camera and its location, states
 * WHY no picture is shown, and is explicitly labeled as a placeholder —
 * never presented as a live feed.
 *
 * @param {Object} [camera] - Public camera state (name, city, lat, lon, feedConfigured).
 * @param {string} [reason] - 'unconfigured' | 'timeout' | any other failure.
 * @returns {string} Inner HTML for the placeholder card.
 */
export function buildCctvUnavailableCardHtml(camera, reason) {
  const name = escapeCctvHtml(camera?.name || 'CCTV camera');
  const city = escapeCctvHtml(camera?.city || 'UNKNOWN LOCATION');
  const coords = `${formatCctvCoord(camera?.lat)}, ${formatCctvCoord(camera?.lon)}`;
  const configured = camera?.feedConfigured !== false;
  const headline = configured ? 'FEED UNAVAILABLE' : 'NO LIVE FEED';
  const detail =
    reason === 'timeout'
      ? 'The frame request timed out — the camera source did not answer in time.'
      : configured
        ? 'The camera source is unreachable right now.'
        : 'This camera marker has no live video source configured.';
  return (
    `<div style="font-size:10px;letter-spacing:3px;color:#ffd97a;">${headline}</div>` +
    `<div style="font-size:13px;font-weight:600;color:#aaf2ff;max-width:100%;overflow:hidden;text-overflow:ellipsis;">${name}</div>` +
    `<div style="font-size:10px;letter-spacing:1.5px;color:rgba(127,216,231,0.8);">${city} · ${coords}</div>` +
    `<div style="font-size:10px;line-height:1.6;color:rgba(170,200,210,0.75);max-width:280px;">${escapeCctvHtml(detail)}</div>` +
    `<div style="font-size:8px;letter-spacing:2px;color:rgba(145,237,255,0.45);">PLACEHOLDER — NOT A LIVE FEED</div>`
  );
}

export function _clearCctvFrameTimeout() {
  if (this._cctvFrameTimeout) {
    clearTimeout(this._cctvFrameTimeout);
    this._cctvFrameTimeout = null;
  }
}

/**
 * Shows the honest unavailable card for a camera inside the frame wrap,
 * creating the card element lazily on first use.
 */
export function _showCctvUnavailableCard(camera, reason) {
  if (this.destroyed || !this._cctvFrameWrap || typeof document === 'undefined')
    return;
  let card = this._cctvFramePlaceholder;
  if (!card) {
    card = document.createElement('div');
    card.className = 'cctv-frame-unavailable';
    card.style.cssText = CCTV_UNAVAILABLE_CARD_STYLE;
    this._cctvFrameWrap.appendChild(card);
    this._cctvFramePlaceholder = card;
  }
  card.innerHTML = buildCctvUnavailableCardHtml(camera, reason);
  card.style.display = 'flex';
}

export function _hideCctvUnavailableCard() {
  const card = this._cctvFramePlaceholder;
  if (card) card.style.display = 'none';
}

export function _clearCctvFrame() {
  this._cctvFrameRequestToken += 1;
  this._clearCctvFrameTimeout();
  if (this._cctvFramePreloader) {
    this._cctvFramePreloader.onload = null;
    this._cctvFramePreloader.onerror = null;
  }
  this._cctvFramePreloader = null;
  if (this._cctvFrame) {
    this._cctvFrame.classList.remove('active');
    this._cctvFrame.removeAttribute('src');
    this._cctvFrame.dataset.cameraId = '';
    this._cctvFrame.dataset.currentSrc = '';
    this._cctvFrame.dataset.loading = '';
    this._cctvFrame.dataset.error = '';
    this._cctvFrame.dataset.unavailable = '';
  }
  this._hideCctvUnavailableCard();
  this._cctvFrameWrap?.classList.remove('loading', 'has-frame');
}

export function _queueCctvFrame(src, cameraId, cameraChanged, camera) {
  if (this.destroyed || !this._cctvFrame || !src) return;

  if (cameraChanged) {
    // A different camera gets an honest acquisition state. Never retain
    // the prior camera's pixels under the newly selected metadata.
    this._cctvFrame.classList.remove('active');
    this._cctvFrame.removeAttribute('src');
    this._cctvFrameWrap?.classList.remove('has-frame');
    this._hideCctvUnavailableCard();
  }

  // Seed markers and other cameras without a configured live source never had
  // a feed to fetch — skip the doomed network attempt and land immediately on
  // the honest placeholder instead of churning a request every refresh tick.
  if (camera && camera.feedConfigured === false) {
    this._cctvFrameRequestToken += 1;
    this._clearCctvFrameTimeout();
    if (this._cctvFramePreloader) {
      this._cctvFramePreloader.onload = null;
      this._cctvFramePreloader.onerror = null;
    }
    this._cctvFramePreloader = null;
    this._cctvFrame.dataset.cameraId = cameraId;
    this._cctvFrame.dataset.currentSrc = src;
    this._cctvFrame.dataset.loading = '';
    this._cctvFrame.dataset.error = 'true';
    this._cctvFrame.dataset.unavailable = 'unconfigured';
    this._cctvFrameWrap?.classList.remove('loading');
    this._showCctvUnavailableCard(camera, 'unconfigured');
    this._syncCctvSourceBadge(
      this._cctvState?.activeCamera,
      !!this._cctvState?.enabled && !!this.actions.isEnabled(),
    );
    return;
  }

  if (this._cctvFramePreloader) {
    this._cctvFramePreloader.onload = null;
    this._cctvFramePreloader.onerror = null;
  }
  this._clearCctvFrameTimeout();
  const token = ++this._cctvFrameRequestToken;
  this._cctvFrame.dataset.cameraId = cameraId;
  this._cctvFrame.dataset.currentSrc = src;
  this._cctvFrame.dataset.loading = 'true';
  this._cctvFrame.dataset.error = '';
  this._cctvFrame.dataset.unavailable = '';
  this._cctvFrameWrap?.classList.toggle(
    'loading',
    !this._cctvFrameWrap?.classList.contains('has-frame'),
  );

  const preloader = new Image();
  this._cctvFramePreloader = preloader;
  preloader.onload = () => this._settleCctvFrame(token, src, true);
  preloader.onerror = () => this._settleCctvFrame(token, src, false);
  // A stalled request must never spin the "ACQUIRING FRAME" shimmer forever:
  // past the deadline the attempt settles as failed and the panel lands on
  // the honest unavailable card (or keeps the last good frame on a refresh).
  this._cctvFrameTimeout = setTimeout(() => {
    this._cctvFrameTimeout = null;
    this._settleCctvFrame(token, src, false, 'timeout');
  }, CCTV_FRAME_LOAD_TIMEOUT_MS);
  preloader.src = src;
}

export function _settleCctvFrame(token, src, ok, reason) {
  if (
    this.destroyed ||
    !this._cctvFrame ||
    token !== this._cctvFrameRequestToken
  )
    return;
  this._clearCctvFrameTimeout();
  if (this._cctvFramePreloader) {
    this._cctvFramePreloader.onload = null;
    this._cctvFramePreloader.onerror = null;
  }
  this._cctvFramePreloader = null;
  this._cctvFrame.dataset.loading = '';
  this._cctvFrameWrap?.classList.remove('loading');

  const syncBadge = () =>
    this._syncCctvSourceBadge(
      this._cctvState?.activeCamera,
      !!this._cctvState?.enabled && !!this.actions.isEnabled(),
    );

  if (!ok) {
    // Leave the element untouched — a settled frame stays on screen. The
    // unavailable card only replaces the frame area when nothing was ever
    // displayed; a failed REFRESH keeps the last good frame up.
    this._cctvFrame.dataset.error = 'true';
    if (!this._cctvFrameWrap?.classList.contains('has-frame')) {
      this._cctvFrame.dataset.unavailable =
        reason === 'timeout' ? 'timeout' : 'error';
      this._showCctvUnavailableCard(this._cctvState?.activeCamera, reason);
    }
    syncBadge();
    return;
  }

  this._cctvFrame.dataset.error = '';
  this._cctvFrame.dataset.unavailable = '';
  this._hideCctvUnavailableCard();
  this._cctvFrame.src = src;
  this._cctvFrame.classList.add('active');
  this._cctvFrameWrap?.classList.add('has-frame');
  syncBadge();
}

export function _syncCctvSourceBadge(activeCamera, enabled) {
  if (!this._cctvSourceBadge) return;
  if (!enabled || !activeCamera) {
    this._cctvSourceBadge.textContent = 'SOURCE · UNKNOWN';
    this._cctvSourceBadge.dataset.frameState = 'idle';
    return;
  }
  const hasDisplayedFrame =
    this._cctvFrameWrap?.classList.contains('has-frame');
  if (this._cctvFrame?.dataset.loading === 'true' && !hasDisplayedFrame) {
    this._cctvSourceBadge.textContent = 'FRAME · LOADING';
    this._cctvSourceBadge.dataset.frameState = 'loading';
    return;
  }
  if (this._cctvFrame?.dataset.error === 'true' && !hasDisplayedFrame) {
    // Distinguish "this camera never had a feed" from "the feed broke":
    // seed markers land on NO LIVE FEED, configured cameras on UNAVAILABLE.
    const unavailable = this._cctvFrame?.dataset.unavailable === 'unconfigured';
    this._cctvSourceBadge.textContent = unavailable
      ? 'NO LIVE FEED'
      : 'FRAME · UNAVAILABLE';
    this._cctvSourceBadge.dataset.frameState = 'error';
    return;
  }
  const kind = String(
    activeCamera.sourceKind || activeCamera.feedType || 'unknown',
  ).toUpperCase();
  const status = String(activeCamera.sourceStatus || 'unknown').toUpperCase();
  this._cctvSourceBadge.textContent = `${kind} · ${status}`;
  this._cctvSourceBadge.dataset.frameState = 'ready';
}
