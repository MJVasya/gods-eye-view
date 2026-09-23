import * as Cesium from 'cesium';
import {
  CYBER_MAX_ARCS,
  arcPositions,
  severityWidth,
  threatColor,
} from './model.js';

/** Arcs older than this fade to their minimum opacity. */
export const CYBER_ARC_TTL_MS = 5 * 60 * 1000;
/** Floor for age-faded opacity so old arcs stay faintly visible. */
const MIN_ARC_ALPHA = 0.12;

/**
 * Opacity from event age, computed once per update tick. Static value —
 * deliberately not a CallbackProperty, which would keep the render loop
 * and geometry tessellation alive every frame.
 */
export function ageAlpha(ts, nowMs) {
  const age = Math.max(0, nowMs - ts);
  const faded = 1 - age / CYBER_ARC_TTL_MS;
  return Math.min(1, Math.max(MIN_ARC_ALPHA, faded));
}

/**
 * Build the attack-arc entity for one normalized record: a raised
 * great-circle-ish polyline from source to destination, colored by threat
 * type, widened by severity, faded by age.
 */
export function createAttackArcEntity(record, nowMs) {
  const color = threatColor(record.type);
  return new Cesium.Entity({
    id: `cyber:arc:${record.id}`,
    polyline: {
      // Static positions — see ageAlpha. Nothing here re-evaluates per frame.
      positions: arcPositions(record.src, record.dst),
      width: severityWidth(record.severity),
      material: new Cesium.ColorMaterialProperty(
        color.withAlpha(ageAlpha(record.ts, nowMs)),
      ),
      arcType: Cesium.ArcType.NONE,
    },
    properties: {
      // Analyst seam (additive): plain values read back by getAnalystRecords.
      id: record.id,
      type: record.type,
      severity: record.severity,
      srcCode: record.src.code,
      srcCountry: record.src.country,
      srcLat: record.src.lat,
      srcLon: record.src.lon,
      dstCode: record.dst.code,
      dstCountry: record.dst.country,
      dstLat: record.dst.lat,
      dstLon: record.dst.lon,
      ts: record.ts,
    },
  });
}

/**
 * Build the destination pulse marker for one normalized record: a small
 * ground-clamped ellipse at the target, tinted by threat type.
 */
export function createEndpointMarkerEntity(record, nowMs) {
  const color = threatColor(record.type);
  const radius = 15000 * record.severity;
  const alpha = Math.min(1, Math.max(0.25, ageAlpha(record.ts, nowMs) + 0.2));
  return new Cesium.Entity({
    id: `cyber:dst:${record.id}`,
    position: Cesium.Cartesian3.fromDegrees(record.dst.lon, record.dst.lat),
    ellipse: {
      // Static axes — a CallbackProperty here would re-tessellate the
      // clamped ground geometry every frame.
      semiMajorAxis: radius,
      semiMinorAxis: radius,
      material: new Cesium.ColorMaterialProperty(color.withAlpha(alpha)),
      outline: true,
      outlineColor: color.withAlpha(Math.min(1, alpha + 0.2)),
      outlineWidth: 2,
      heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
    },
    properties: {
      id: record.id,
      type: record.type,
      severity: record.severity,
      dstCode: record.dst.code,
      dstCountry: record.dst.country,
      dstLat: record.dst.lat,
      dstLon: record.dst.lon,
      ts: record.ts,
    },
  });
}

/**
 * Build the attack-source marker for one normalized record: a small,
 * clickable point at the arc origin, tinted by threat type. This is the
 * primary click target for the location-intel panel; the arc itself is a
 * secondary target (see resolveCyberPickEventId).
 */
export function createSourceMarkerEntity(record, nowMs) {
  const color = threatColor(record.type);
  const alpha = Math.min(1, Math.max(0.35, ageAlpha(record.ts, nowMs) + 0.25));
  const properties = {
    id: record.id,
    type: record.type,
    severity: record.severity,
    srcCode: record.src.code,
    srcCountry: record.src.country,
    srcLat: record.src.lat,
    srcLon: record.src.lon,
    ts: record.ts,
  };
  // Optional GeoIP enrichment (live feed only) rides along so inspectors
  // can read it back; keys are omitted entirely when the feed did not
  // provide them — never filled in.
  for (const key of ['city', 'region', 'isp', 'org', 'asn']) {
    if (record.src[key] !== undefined) properties[key] = record.src[key];
  }
  if (record.ioc !== undefined) properties.ioc = record.ioc;
  if (record.ref !== undefined) properties.ref = record.ref;
  return new Cesium.Entity({
    id: `cyber:src:${record.id}`,
    position: Cesium.Cartesian3.fromDegrees(record.src.lon, record.src.lat),
    point: {
      // Static size — a CallbackProperty here would keep the render loop
      // alive every frame.
      pixelSize: 6 + record.severity * 2,
      color: color.withAlpha(alpha),
      outlineColor: color.withAlpha(Math.min(1, alpha + 0.3)),
      outlineWidth: 1,
      heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
    },
    properties,
  });
}

/**
 * Resolve a scene.pick() result to a cyber event id, or null.
 * Accepts the source marker (`cyber:src:<id>`) and the arc
 * (`cyber:arc:<id>`); anything else (destination markers, other layers,
 * primitives) is left alone.
 * @param {*} picked Result of viewer.scene.pick().
 * @returns {string|null} The event id, or null when not a cyber source/arc.
 */
export function resolveCyberPickEventId(picked) {
  const id = String(picked?.id?.id ?? picked?.id ?? '');
  for (const prefix of ['cyber:src:', 'cyber:arc:']) {
    if (id.startsWith(prefix)) {
      const eventId = id.slice(prefix.length);
      return eventId === '' ? null : eventId;
    }
  }
  return null;
}
/**
 * Rank records so the most severe, most recent attacks win render slots.
 * @param {Array<Object>} rows Normalized cyber records.
 * @param {number} [limit=CYBER_MAX_ARCS]
 * @returns {Array<Object>} At most `limit` rows, most severe first.
 */
export function selectRenderCohort(rows, limit = CYBER_MAX_ARCS) {
  const cap = Math.max(0, Math.floor(Number(limit) || 0));
  if (!Array.isArray(rows) || cap === 0) return [];
  return rows
    .slice()
    .sort(
      (a, b) =>
        b.severity - a.severity ||
        b.ts - a.ts ||
        String(a.id).localeCompare(String(b.id)),
    )
    .slice(0, cap);
}

/**
 * Build every entity for one update tick: one arc, one source marker, and
 * one destination marker per rendered attack, capped at CYBER_MAX_ARCS
 * arcs. All geometry is static; per-frame cost stays near zero.
 * @param {Array<Object>} rows Normalized cyber records.
 * @param {number} nowMs Epoch ms for age fading.
 * @returns {Cesium.Entity[]}
 */
export function createCyberEntities(rows, nowMs) {
  const entities = [];
  for (const record of selectRenderCohort(rows)) {
    entities.push(createAttackArcEntity(record, nowMs));
    entities.push(createSourceMarkerEntity(record, nowMs));
    entities.push(createEndpointMarkerEntity(record, nowMs));
  }
  return entities;
}
