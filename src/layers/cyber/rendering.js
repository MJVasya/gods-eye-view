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
 * Build every entity for one update tick: one arc plus one destination
 * marker per rendered attack, capped at CYBER_MAX_ARCS arcs. All geometry
 * is static; per-frame cost stays near zero.
 * @param {Array<Object>} rows Normalized cyber records.
 * @param {number} nowMs Epoch ms for age fading.
 * @returns {Cesium.Entity[]}
 */
export function createCyberEntities(rows, nowMs) {
  const entities = [];
  for (const record of selectRenderCohort(rows)) {
    entities.push(createAttackArcEntity(record, nowMs));
    entities.push(createEndpointMarkerEntity(record, nowMs));
  }
  return entities;
}
