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
import { createCyberEntities, selectRenderCohort } from './rendering.js';
export * from './model.js';
export { createCyberSource } from './source.js';

/** Own one cyber-threat display and its refresh lifecycle. */
export function createCyberLayer({ source, overlayHost } = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Cyber layer requires a snapshot source');
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

  const layer = {
    id: 'cyber',
    name: 'Cyber Intel',
    icon: '🛡️',
    source: 'Simulated feed',
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
      try {
        const rows = await source.getSnapshot({ signal: request.signal });
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;

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
        for (const record of selectRenderCohort(deduped)) {
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
        _lastUpdate = nowMs;
        _lastError = null;
        console.log(`[Data:Cyber] Updated: ${_count} attacks`);
        return true;
      } catch (e) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
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
        simulated: true,
      };
    },
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
