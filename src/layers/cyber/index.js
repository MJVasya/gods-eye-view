import * as Cesium from 'cesium';
import {
  CYBER_OVERLAY_SOURCE_ID,
  CYBER_OVERLAY_COHORT_LIMIT,
  CYBER_OVERLAY_COLLISION_CAPACITY,
  CYBER_THREAT_TYPES,
  createCyberOverlayEntry,
  mapCyberAnalystRecord,
  selectCyberOverlayCohort,
  threatColor,
} from './model.js';
import {
  clusterLabelRecords,
  createCyberEntities,
  selectRenderCohort,
  resolveCyberPickEventId,
} from './rendering.js';
import { LIVE_FEED_LABEL } from './liveFeed.js';
import {
  openCyberIntelPanel,
  closeCyberIntelPanel,
} from '../../ui/cyberIntelPanel.js';
export * from './model.js';
export { createCyberSource } from './source.js';

/** In-app attribution while the simulated feed is active (the default). */
const SIMULATED_FEED_LABEL = 'Simulated feed';

/** Own one cyber-threat display and its refresh lifecycle. */
export function createCyberLayer({
  source,
  overlayHost,
  liveSource = null,
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Cyber layer requires a snapshot source');
  if (liveSource != null && typeof liveSource?.getSnapshot !== 'function') {
    throw new TypeError(
      'Cyber live source must expose getSnapshot({ signal })',
    );
  }
  if (!overlayHost) throw new TypeError('Cyber layer requires an overlay host');
  let _viewer = null;
  let _request = null;
  let _dataSource = null;
  let _count = 0;
  let _byType = emptyByType();
  let _topSources = [];
  let _topDestinations = [];
  let _lastUpdate = null;
  let _lastError = null;
  let _enabled = false;
  // Feed mode: 'simulated' is always the default; 'live' (real community
  // threat intel via the same-origin proxy) only activates through an
  // explicit user toggle (setFeedMode).
  let _feedMode = 'simulated';
  let _activeSource = source;
  let _rowControlsListener = null;
  // Retained attack records from the last published tick (id → { record,
  // feedMode, sourceLabel }), backing getCyberEvent() for the click-to-
  // inspect intel panel. Reset on every feed switch so attribution can
  // never mix.
  const _records = new Map();
  // LEFT_CLICK pick handler for source markers/arcs; installed in init()
  // only when the viewer exposes a canvas (headless tests skip it).
  let _clickHandler = null;

  const notifyRowControls = () => {
    try {
      _rowControlsListener?.();
    } catch {
      /* listener removal/notification is best effort */
    }
  };

  /** Drop in-flight and on-screen data when the feed changes, so simulated
   *  arcs are never shown under the live label (or vice versa). */
  function resetFeedState() {
    _request?.abort();
    _request = null;
    _dataSource?.entities.removeAll();
    overlayHost.clearSource(CYBER_OVERLAY_SOURCE_ID);
    _records.clear();
    // A panel opened for the previous feed would show stale data under the
    // new attribution — dismiss it with the feed.
    closeCyberIntelPanel();
    _count = 0;
    _byType = emptyByType();
    _topSources = [];
    _topDestinations = [];
    _lastUpdate = null;
    _lastError = null;
  }

  /**
   * Install the LEFT_CLICK pick handler on the viewer's canvas. LEFT_CLICK
   * only fires on non-drag clicks, so globe rotate/zoom are unaffected.
   * Source markers (and arcs) open the intel panel; empty space dismisses
   * it. Skipped when the viewer has no canvas (headless tests).
   */
  function installPickHandler() {
    const canvas = _viewer?.scene?.canvas;
    if (!canvas || typeof Cesium.ScreenSpaceEventHandler !== 'function') return;
    if (_clickHandler) return;
    _clickHandler = new Cesium.ScreenSpaceEventHandler(canvas);
    _clickHandler.setInputAction((click) => {
      try {
        const picked = _viewer?.scene?.pick?.(click?.position);
        const eventId = resolveCyberPickEventId(picked);
        if (eventId) {
          const entry = layer.getCyberEvent(eventId);
          if (entry) openCyberIntelPanel(entry);
          else closeCyberIntelPanel();
        } else {
          closeCyberIntelPanel();
        }
      } catch (error) {
        console.warn('[Data:Cyber] Pick handling failed:', error);
      }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  function removePickHandler() {
    try {
      _clickHandler?.destroy();
    } catch {
      /* handler teardown is best effort */
    }
    _clickHandler = null;
  }

  const layer = {
    id: 'cyber',
    name: 'Cyber Intel',
    icon: '🛡️',
    // Mutable: setFeedMode swaps this between the simulated and live labels.
    // The layer panel prefers stats.source, which mirrors this value.
    source: SIMULATED_FEED_LABEL,
    updateInterval: 5000,

    init(viewer) {
      if (_viewer) throw new Error('Cyber layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('cyber');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _count = 0;
      _byType = emptyByType();
      _topSources = [];
      _topDestinations = [];
      _lastUpdate = null;
      _lastError = null;
      _enabled = false;
      overlayHost.setVisible(CYBER_OVERLAY_SOURCE_ID, false);
      installPickHandler();
      console.log('[Data:Cyber] Initialized');
    },

    enable(viewer) {
      _enabled = true;
      // No continuous-render hold: arcs and markers are static geometry now,
      // so the layer has no per-frame animator to keep the render loop alive.
      if (_dataSource) _dataSource.show = true;
      overlayHost.setVisible(CYBER_OVERLAY_SOURCE_ID, true);
    },

    disable(viewer) {
      _request?.abort();
      _request = null;
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
      overlayHost.clearSource(CYBER_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(CYBER_OVERLAY_SOURCE_ID, false);
    },

    async update(viewer) {
      if (!_enabled || !_dataSource) return false;
      _request?.abort();
      const request = new AbortController();
      _request = request;

      // Publish one fetched snapshot to the globe entities, the overlay
      // host, and the HUD stats.
      const publish = (rows) => {
        // Belt-and-braces dedupe: entity ids must be unique within the
        // data source even if a custom source skips normalization.
        const seen = new Set();
        const deduped = [];
        for (const row of rows || []) {
          if (!row || seen.has(row.id)) continue;
          seen.add(row.id);
          deduped.push(row);
        }

        const nowMs = Date.now();
        const nextEntities = createCyberEntities(deduped, nowMs);
        const overlayEntries = [];
        for (const { record, suppressed } of clusterLabelRecords(
          selectRenderCohort(deduped),
          { limit: CYBER_OVERLAY_COHORT_LIMIT },
        )) {
          overlayEntries.push(
            createCyberOverlayEntry({
              id: record.id,
              position: Cesium.Cartesian3.fromDegrees(
                record.dst.lon,
                record.dst.lat,
              ),
              type: record.type,
              severity: record.severity,
              dstCode: record.dst.code,
              accent: threatColor(record.type).toCssColorString(),
              clusterCount: suppressed,
            }),
          );
        }

        _dataSource.entities.removeAll();
        for (const entity of nextEntities) _dataSource.entities.add(entity);
        if (_enabled) {
          overlayHost.setEntries(
            CYBER_OVERLAY_SOURCE_ID,
            selectCyberOverlayCohort(overlayEntries),
            {
              cohortLimit: CYBER_OVERLAY_COHORT_LIMIT,
              collisionCapacity: CYBER_OVERLAY_COLLISION_CAPACITY,
              moving: false,
            },
          );
        }

        _count = deduped.length;
        _byType = aggregateByType(deduped);
        _topSources = topEndpoints(deduped, 'src');
        _topDestinations = topEndpoints(deduped, 'dst');
        // Retain the published rows for click-to-inspect, capturing the
        // feed mode and its attribution label at publish time so the intel
        // panel can never mix simulated and live attributions.
        _records.clear();
        for (const row of deduped) {
          _records.set(row.id, {
            id: row.id,
            record: row,
            feedMode: _feedMode,
            sourceLabel: layer.source,
          });
        }
        _lastUpdate = nowMs;
        _lastError = null;
        console.log(`[Data:Cyber] Updated: ${_count} attacks`);
      };

      try {
        const rows = await _activeSource.getSnapshot({
          signal: request.signal,
        });
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        publish(rows);
        return true;
      } catch (e) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        if (_feedMode === 'live') {
          // Documented live-feed contract: fall back to the simulated feed
          // whenever the proxy is unreachable or reports live:false. The
          // mode switch flips attribution (and the toggle chip) back to
          // simulated, so simulated arcs are never presented as live intel.
          const reason = e?.message || 'Cyber source unavailable';
          console.warn(
            `[Data:Cyber] Live feed failed (${reason}); falling back to simulated feed.`,
          );
          layer.setFeedMode('simulated');
          // The mode switch aborted `request`; retry once with the
          // simulated source on a fresh controller.
          const retry = new AbortController();
          _request = retry;
          try {
            const rows = await _activeSource.getSnapshot({
              signal: retry.signal,
            });
            if (retry.signal.aborted || _request !== retry || !_enabled)
              return false;
            publish(rows);
            // Keep the fallback note until the next successful tick.
            _lastError = `Live feed unavailable (${reason}); showing simulated feed.`;
            return true;
          } catch (retryError) {
            if (retry.signal.aborted || _request !== retry || !_enabled)
              return false;
            console.warn('[Data:Cyber] Fetch error:', retryError);
            _lastError = retryError?.message || 'Cyber source unavailable';
            return false;
          } finally {
            if (_request === retry) _request = null;
          }
        }
        console.warn('[Data:Cyber] Fetch error:', e);
        _lastError = e?.message || 'Cyber source unavailable';
        return false;
      } finally {
        if (_request === request) _request = null;
      }
    },

    destroy(viewer = _viewer) {
      _request?.abort();
      _request = null;
      removePickHandler();
      closeCyberIntelPanel();
      _records.clear();
      _viewer = null;
      _enabled = false;
      overlayHost.clearSource(CYBER_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(CYBER_OVERLAY_SOURCE_ID, false);
      if (_dataSource) {
        viewer.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
      _count = 0;
      _byType = emptyByType();
      _topSources = [];
      _topDestinations = [];
      _lastUpdate = null;
      _lastError = null;
    },

    /**
     * Snapshot the layer's in-memory attack records as plain JSON-safe
     * objects for the analyst query engine. On-demand only (called at most
     * once per spoken query) — zero per-frame cost, no listeners, no caching.
     * Returns [] while the layer is disabled or empty.
     * @param {number} [maxCount=2000] - Maximum records to return (truncation).
     * @returns {Array<Object>} See mapCyberAnalystRecord for the record shape.
     */
    getAnalystRecords(maxCount = 2000) {
      if (!_dataSource || !_dataSource.show) return [];
      const entities = _dataSource.entities.values;
      if (!entities.length) return [];
      const limit = Number.isFinite(maxCount)
        ? Math.max(1, Math.floor(maxCount))
        : 2000;
      const now = Cesium.JulianDate.now();
      const result = [];
      for (const entity of entities) {
        if (result.length >= limit) break;
        if (!String(entity.id || '').startsWith('cyber:arc:')) continue;
        const p = entity.properties;
        result.push(
          mapCyberAnalystRecord(
            {
              id: p?.id?.getValue(now),
              type: p?.type?.getValue(now),
              severity: p?.severity?.getValue(now),
              srcCode: p?.srcCode?.getValue(now),
              srcCountry: p?.srcCountry?.getValue(now),
              srcLat: p?.srcLat?.getValue(now),
              srcLon: p?.srcLon?.getValue(now),
              dstCode: p?.dstCode?.getValue(now),
              dstCountry: p?.dstCountry?.getValue(now),
              dstLat: p?.dstLat?.getValue(now),
              dstLon: p?.dstLon?.getValue(now),
              ts: p?.ts?.getValue(now),
            },
            result.length,
          ),
        );
      }
      return result;
    },

    getStats() {
      return {
        count: _count,
        byType: { ..._byType },
        topSources: _topSources.map((entry) => ({ ...entry })),
        topDestinations: _topDestinations.map((entry) => ({ ...entry })),
        lastUpdate: _lastUpdate,
        error: _lastError,
        simulated: _feedMode === 'simulated',
        feedMode: _feedMode,
        source: layer.source,
      };
    },

    /**
     * Switch the threat-intel feed. 'simulated' (default) renders the
     * in-repo seeded simulator; 'live' renders real community threat intel
     * (CINS Army, blocklist.de, Spamhaus, OpenPhish) through the same-origin
     * proxy. Live mode is strictly opt-in — nothing calls
     * this except the layer's own UI toggle. Switching clears in-flight and
     * on-screen data so the two attributions can never mix on screen.
     * @param {'simulated'|'live'} mode
     */
    setFeedMode(mode) {
      if (mode !== 'simulated' && mode !== 'live') {
        throw new TypeError(`Unknown cyber feed mode: ${mode}`);
      }
      if (mode === 'live' && !liveSource) {
        throw new Error('Live cyber feed is not configured for this layer');
      }
      if (mode === _feedMode) return mode;
      _feedMode = mode;
      _activeSource = mode === 'live' ? liveSource : source;
      layer.source = mode === 'live' ? LIVE_FEED_LABEL : SIMULATED_FEED_LABEL;
      resetFeedState();
      notifyRowControls();
      console.log(`[Data:Cyber] Feed mode: ${mode} (${layer.source})`);
      return mode;
    },

    /** Current feed mode: 'simulated' (default) or 'live'. */
    getFeedMode() {
      return _feedMode;
    },

    /**
     * Retained event for the click-to-inspect intel panel: the normalized
     * record plus the feed mode and attribution label captured when it was
     * published. Returns a copy so panel reads can't mutate layer state;
     * null when the id isn't in the last published tick.
     * @param {string} id Event id (the suffix of `cyber:src:<id>`).
     * @returns {{ id: string, record: object, feedMode: string, sourceLabel: string }|null}
     */
    getCyberEvent(id) {
      const entry = _records.get(id);
      if (!entry) return null;
      return {
        id: entry.id,
        feedMode: entry.feedMode,
        sourceLabel: entry.sourceLabel,
        record: {
          ...entry.record,
          src: { ...entry.record.src },
          dst: { ...entry.record.dst },
        },
      };
    },

    /**
     * Most recently published retained event, in the same shape as
     * getCyberEvent(). Lets voice control ("open panel") show the intel
     * panel for the latest attack without a globe click. Null when empty.
     */
    getLatestCyberEvent() {
      const keys = [..._records.keys()];
      if (keys.length === 0) return null;
      return layer.getCyberEvent(keys[keys.length - 1]);
    },

    ...(liveSource
      ? {
          /**
           * Row chip for the opt-in live-feed toggle. Rendered only when the
           * layer was constructed with a live source; the panel re-reads
           * this descriptor on every click, so a stale row can never apply
           * an inverted toggle.
           */
          getRowControls() {
            const live = _feedMode === 'live';
            return {
              chips: [
                {
                  id: 'cyber-feed-mode',
                  label: live ? 'LIVE ●' : 'GO LIVE',
                  title: live
                    ? `LIVE — real threat intel (${LIVE_FEED_LABEL}) via the same-origin proxy. One tap returns to the simulated feed.`
                    : 'GO LIVE — one tap switches to the live threat-intel feed (real IOCs via the same-origin proxy). The simulated feed stays the default.',
                  active: live,
                  state: live ? 'active' : 'idle',
                  onClick: () => layer.setFeedMode(live ? 'simulated' : 'live'),
                },
              ],
              legend: [],
            };
          },

          /**
           * Install the panel's row re-render callback so the toggle chip
           * repaints immediately when the feed mode changes.
           * @param {(() => void)|null} listener
           */
          setRowControlsListener(listener) {
            _rowControlsListener =
              typeof listener === 'function' ? listener : null;
          },
        }
      : {}),
  };
  return layer;
}

function emptyByType() {
  const byType = {};
  for (const type of CYBER_THREAT_TYPES) byType[type] = 0;
  return byType;
}

function aggregateByType(rows) {
  const byType = emptyByType();
  for (const row of rows) {
    if (row.type in byType) byType[row.type] += 1;
  }
  return byType;
}

/**
 * Rank endpoint countries by attack volume: at most 5 entries, most
 * attacks first, country code as the stable tie-break.
 */
function topEndpoints(rows, side) {
  const counts = new Map();
  for (const row of rows) {
    const endpoint = row[side];
    if (!endpoint) continue;
    const key = endpoint.code;
    const entry = counts.get(key) || {
      code: endpoint.code,
      country: endpoint.country,
      count: 0,
    };
    entry.count += 1;
    counts.set(key, entry);
  }
  return [...counts.values()]
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code))
    .slice(0, 5);
}
