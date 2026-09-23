import { ERROR_BACKOFF_INTERVAL } from './recordPolicy.js';
import { withSimulatedFallback } from './simulator.js';

/** Own military source acquisition, cancellation, freshness and error backoff. */
export function createIngestion({
  feed,
  applySnapshot,
  setSourceLabel,
  applyPendingTrackingRestore,
}) {
  const methods = {
    async update(viewer, { signal = null } = {}) {
      const nowMs = Date.now();
      const trackingRefreshEpoch = ++feed._trackingRefreshEpoch;
      feed._lastTrackingRefreshOutcome = {
        epoch: trackingRefreshEpoch,
        status: 'source-unavailable',
        ids: new Set(),
        source: feed._lastSource,
      };
      if (feed._retryAt && nowMs < feed._retryAt) {
        feed._backoff = true;
        return;
      }

      const resourceController = new AbortController();
      feed._activeUpdateControllers.add(resourceController);
      const updateSignal = signal
        ? AbortSignal.any([signal, resourceController.signal])
        : resourceController.signal;
      try {
        updateSignal.throwIfAborted();
        const snapshot = await feed._source.getSnapshot(
          {},
          { signal: updateSignal },
        );
        updateSignal.throwIfAborted();
        feed._lastStatus = snapshot.status ?? 200;
        feed._lastSource = snapshot.source;
        feed._lastCoverage = snapshot.coverage;
        setSourceLabel(feed._lastSource);
        // Honest simulated fallback: the wrapped source serves the seeded
        // fleet only while the live source is failing. Surfaced as
        // FALLBACK · SIMULATED via getStats(), never as live traffic.
        // Cleared automatically once the live source answers again.
        feed._simulated = snapshot.simulated === true;
        feed._fallbackReason = feed._simulated
          ? 'Live source unavailable — serving simulated feed'
          : null;
        feed._backoff = snapshot.stale || snapshot.freshness === 'unknown';
        feed._retryAt = 0;
        feed._lastError =
          snapshot.reason ||
          (snapshot.freshness === 'unknown'
            ? 'Source snapshot time unavailable'
            : null);
        const accepted = applySnapshot(snapshot, viewer);
        feed._count = accepted.count;
        feed._lastUpdate = snapshot.observedAtMs;
        feed._lastTrackingRefreshOutcome = {
          epoch: trackingRefreshEpoch,
          status: 'accepted',
          ids: accepted.ids,
          source: feed._lastSource,
        };
        console.log(`[Data:Military] Updated: ${feed._count} aircraft`);
        applyPendingTrackingRestore();
      } catch (e) {
        if (updateSignal.aborted || e?.name === 'AbortError') {
          throw new DOMException('Military update aborted', 'AbortError');
        }
        console.warn('[Data:Military] Fetch error:', e);
        feed._backoff = true;
        feed._retryAt =
          Date.now() + (e?.retryAfterMs ?? ERROR_BACKOFF_INTERVAL);
        feed._lastStatus = e?.status ?? null;
        if (e?.source) {
          feed._lastSource = e.source;
          setSourceLabel(feed._lastSource);
        }
        feed._lastError =
          e?.name === 'LiveSourceError' ? e.message : 'Live data unavailable';
      } finally {
        feed._activeUpdateControllers.delete(resourceController);
      }
    },
  };

  return { methods };
}

/** Construct an independent military source lifetime and status. */
export function createMilitaryFeed(source) {
  const feed = {};
  // The decorator tries the live source first and serves the seeded simulated
  // fleet (honestly labeled) only while live is failing.
  feed._source = withSimulatedFallback(source);
  feed._count = 0;
  feed._lastUpdate = null;
  feed._backoff = false;
  feed._retryAt = 0;
  feed._lastError = null;
  feed._activeUpdateControllers = new Set();
  feed._lastStatus = null;
  feed._lastSource = source?.label || 'Aircraft';
  feed._lastCoverage = null;
  /** @type {boolean} True while the on-screen traffic is simulated. */
  feed._simulated = false;
  /** @type {string|null} Human-readable simulated-fallback reason. */
  feed._fallbackReason = null;
  feed._trackingRefreshEpoch = 0;
  feed._lastTrackingRefreshOutcome = {
    epoch: 0,
    status: 'unavailable',
    ids: new Set(),
    source: feed._lastSource,
  };
  return feed;
}
