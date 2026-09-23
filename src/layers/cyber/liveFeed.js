import { normalizeCyberEvents } from './records.js';

/**
 * Live cyber threat-intel feed (OPT-IN only).
 *
 * Consumes the same-origin proxy at `/api/cyber-feed` (implemented by
 * workstream 2 in `workers/cyber-feed-proxy.js`, documented in
 * docs/CYBER_INTEL.md). The proxy aggregates four keyless, no-signup
 * upstream feeds — CINS Army, blocklist.de, Spamhaus DROP, OpenPhish —
 * resolves hostile IPs to countries server-side, and returns events
 * already in the exact schema `normalizeCyberEvents()` accepts:
 *
 *   GET {proxyUrl}?limit={maxEvents} → 200
 *   {
 *     live: true,                  // false (or non-2xx) = total failure
 *     source: "cins,blocklist",    // contributing upstreams, diagnostic
 *     generated_at: 1730000000000,
 *     cache_ttl_s: 60,
 *     events: [ { id, src, dst, type, severity, ts, ...extras }, ... ]
 *   }
 *
 * The client does no upstream fetching and no GeoIP: browsers can't call
 * the upstreams directly (missing CORS headers / aggressive rate limits),
 * so every network call here goes to the same-origin proxy only.
 *
 * ⚠️ ATTRIBUTION: events from this feed are REAL community threat intel.
 * They must always be labeled with LIVE_FEED_LABEL and must never be
 * mixed with simulated events. The simulated feed stays the default; this
 * feed only activates through the layer's explicit opt-in toggle, and the
 * layer falls back to the simulated feed (flipping attribution with it)
 * whenever the proxy is unreachable or reports `live: false`.
 */

/** Default same-origin proxy path. Overridable via `proxyUrl` or the
 *  `CYBER_FEED_PROXY` build-time env (Vite: `import.meta.env`). */
export const DEFAULT_CYBER_FEED_PROXY_URL = '/api/cyber-feed';

/**
 * Exact in-app attribution for the live feed: the real sources the proxy
 * aggregates. The layer shows this (and only this) while the live feed is
 * active; the simulated feed shows 'Simulated feed'. Keep the names in
 * DATA_SOURCES.md verbatim in sync.
 */
export const LIVE_FEED_LABEL =
  'CINS Army · blocklist.de · Spamhaus · OpenPhish';

function envProxyUrl() {
  try {
    const value = import.meta?.env?.CYBER_FEED_PROXY;
    return typeof value === 'string' && value.trim() ? value.trim() : '';
  } catch {
    return '';
  }
}

function withLimitParam(proxyUrl, maxEvents) {
  const separator = proxyUrl.includes('?') ? '&' : '?';
  return `${proxyUrl}${separator}limit=${encodeURIComponent(maxEvents)}`;
}

/**
 * Combine the caller's abort authority with a client-side timeout.
 *
 * Without this, a hung proxy (connection accepted, no bytes ever sent)
 * wedges the whole layer: the data manager skips re-entrant ticks while a
 * refresh is in flight, and the layer only aborts the previous request at
 * the start of a new update() — which never comes. The chip would read
 * "LIVE ●" forever with stale data and no error. A timeout abort surfaces
 * as a plain fetch failure (see below), so the layer falls back to the
 * simulated feed with a user-visible notice instead of wedging.
 *
 * The caller's signal keeps priority: a user-initiated abort rethrows its
 * own reason first, preserving the layer's abort-swallowing path.
 */
function combineWithTimeout(signal, timeoutMs) {
  const timeoutSignal =
    Number.isFinite(timeoutMs) &&
    timeoutMs > 0 &&
    typeof AbortSignal?.timeout === 'function'
      ? AbortSignal.timeout(timeoutMs)
      : null;
  if (
    signal &&
    timeoutSignal &&
    typeof AbortSignal?.any === 'function'
  ) {
    try {
      return {
        combined: AbortSignal.any([signal, timeoutSignal]),
        timeoutSignal,
      };
    } catch {
      /* feature-detect fallback below */
    }
  }
  return { combined: signal ?? timeoutSignal, timeoutSignal };
}

/**
 * Create a live cyber-threat feed source.
 *
 * Same interface as the simulator (`{ getSnapshot({ signal }) }`) so it
 * plugs into `createCyberSource` / `createCyberLayer` unchanged. Events are
 * re-validated with `normalizeCyberEvents()` so a bare feed (not wrapped in
 * `createCyberSource`) still yields schema-conformant rows; malformed rows
 * are dropped, never rendered.
 *
 * Any proxy failure — unreachable host, non-2xx status, invalid JSON, or a
 * payload with `live: false` / missing `events` — throws a descriptive
 * error. The layer catches it and falls back to the simulated feed.
 *
 * @param {object} [opts]
 * @param {string} [opts.proxyUrl] Proxy base URL. Defaults to
 *   `CYBER_FEED_PROXY` (build-time env) or `/api/cyber-feed`.
 * @param {Function} [opts.fetchImpl] Injectable fetch (tests).
 * @param {number} [opts.maxEvents=96] Cap on events per snapshot, sent to
 *   the proxy as `?limit=` (proxy clamps to 1–200).
 * @param {number} [opts.timeoutMs=20000] Client-side timeout per snapshot.
 *   A hung proxy otherwise wedges the layer's refresh loop (the manager
 *   never re-enters a tick while one is in flight); the timeout turns a
 *   hang into a normal fetch failure so the layer falls back to simulated.
 */
export function createLiveCyberFeed({
  proxyUrl = envProxyUrl() || DEFAULT_CYBER_FEED_PROXY_URL,
  fetchImpl = (...args) => globalThis.fetch(...args),
  maxEvents = 96,
  timeoutMs = 20000,
} = {}) {
  if (typeof proxyUrl !== 'string' || !proxyUrl.trim()) {
    throw new TypeError('Live cyber feed requires a proxy URL');
  }
  const url = withLimitParam(proxyUrl.trim(), maxEvents);
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const { combined, timeoutSignal } = combineWithTimeout(
        signal,
        timeoutMs,
      );
      let response;
      try {
        response = await fetchImpl(url, {
          signal: combined,
          headers: { accept: 'application/json' },
        });
      } catch (error) {
        signal?.throwIfAborted(); // preserve abort semantics for the caller
        // Distinct from a refused/unreachable host: the proxy accepted the
        // connection and never answered. Same fallback path, honest reason.
        if (timeoutSignal?.aborted) {
          throw new Error(
            `Live cyber feed proxy timed out after ${timeoutMs}ms`,
          );
        }
        throw new Error(
          `Live cyber feed proxy unreachable: ${error?.message || error}`,
        );
      }
      signal?.throwIfAborted();
      if (!response.ok) {
        throw new Error(
          `Live cyber feed proxy HTTP ${response.status || 'error'}`,
        );
      }
      let payload;
      try {
        payload = await response.json();
      } catch {
        throw new Error('Live cyber feed proxy returned invalid JSON');
      }
      signal?.throwIfAborted();
      // Documented contract: fall back to the simulated feed whenever
      // !res.ok || !payload.live — so any of these is a hard failure here.
      if (
        !payload ||
        typeof payload !== 'object' ||
        !payload.live ||
        !Array.isArray(payload.events)
      ) {
        throw new Error(
          `Live cyber feed unavailable: ${payload?.error || 'malformed proxy response'}`,
        );
      }
      if (typeof payload.source === 'string' && payload.source) {
        console.log(`[Data:Cyber] Live feed contributors: ${payload.source}`);
      }
      return normalizeCyberEvents(payload.events);
    },
  };
}
