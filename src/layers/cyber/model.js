import * as Cesium from 'cesium';
import { CYBER_THREAT_TYPES } from './records.js';

export const CYBER_OVERLAY_SOURCE_ID = 'cyber';
export const CYBER_OVERLAY_COHORT_LIMIT = 96;
export const CYBER_OVERLAY_COLLISION_CAPACITY = 48;
/** Upper bound on attack arcs rendered at once; the rest still count in stats. */
export const CYBER_MAX_ARCS = 300;

export { CYBER_THREAT_TYPES, normalizeCyberEvents } from './records.js';

/**
 * Threat type → display color. Chosen for contrast on a dark globe;
 * all six types are visually distinct from one another.
 */
export function threatColor(type) {
  switch (type) {
    case 'ddos':
      return Cesium.Color.RED;
    case 'malware':
      return Cesium.Color.ORANGE;
    case 'intrusion':
      return Cesium.Color.MAGENTA;
    case 'phishing':
      return Cesium.Color.YELLOW;
    case 'scan':
      return Cesium.Color.CYAN;
    case 'c2':
      return Cesium.Color.LIME;
    default:
      return Cesium.Color.GRAY;
  }
}

/** Polyline width in pixels, stepped by severity. */
export function severityWidth(severity) {
  switch (severity) {
    case 1:
      return 2;
    case 2:
      return 3;
    case 3:
      return 4;
    case 4:
      return 6;
    default:
      return 8;
  }
}

const ARC_SEGMENTS = 48;
/** Midpoint lift as a fraction of the great-circle distance. */
const ARC_LIFT_FACTOR = 0.3;
/** Minimum lift so short hops still read as arcs. */
const ARC_MIN_LIFT_M = 50000;

function toUnit(x, y, z) {
  const length = Math.hypot(x, y, z) || 1;
  return [x / length, y / length, z / length];
}

/**
 * Sample a raised arc between two lat/lon endpoints. Points follow the
 * great circle with a midpoint lift proportional to the endpoint distance,
 * so long-haul attacks arc higher than local ones. Pure geometry — the
 * result is static Cartesian3 positions with no per-frame cost.
 * @param {{lat:number,lon:number}} a Source endpoint.
 * @param {{lat:number,lon:number}} b Destination endpoint.
 * @param {number} [segments=48] Number of samples along the arc.
 * @returns {Cesium.Cartesian3[]} positions from source to destination.
 */
export function arcPositions(a, b, segments = ARC_SEGMENTS) {
  const count = Math.max(2, Math.floor(Number(segments) || ARC_SEGMENTS));
  const p0 = Cesium.Cartesian3.fromDegrees(a.lon, a.lat, 0);
  const p1 = Cesium.Cartesian3.fromDegrees(b.lon, b.lat, 0);
  const radius = Cesium.Cartesian3.magnitude(p0) || 6378137;
  const [ux0, uy0, uz0] = toUnit(p0.x, p0.y, p0.z);
  const [ux1, uy1, uz1] = toUnit(p1.x, p1.y, p1.z);
  const dot = Math.min(1, Math.max(-1, ux0 * ux1 + uy0 * uy1 + uz0 * uz1));
  const angle = Math.acos(dot);
  const lift = Math.max(ARC_MIN_LIFT_M, angle * radius * ARC_LIFT_FACTOR);
  const positions = [];
  for (let i = 0; i <= count; i++) {
    const t = i / count;
    let dx, dy, dz;
    if (angle < 1e-6) {
      // Coincident endpoints: straight radial lift.
      dx = ux0;
      dy = uy0;
      dz = uz0;
    } else {
      // Spherical linear interpolation between the unit vectors.
      const sinAngle = Math.sin(angle);
      const w0 = Math.sin((1 - t) * angle) / sinAngle;
      const w1 = Math.sin(t * angle) / sinAngle;
      [dx, dy, dz] = toUnit(
        ux0 * w0 + ux1 * w1,
        uy0 * w0 + uy1 * w1,
        uz0 * w0 + uz1 * w1,
      );
    }
    const height = lift * Math.sin(Math.PI * t);
    positions.push(
      new Cesium.Cartesian3(
        dx * (radius + height),
        dy * (radius + height),
        dz * (radius + height),
      ),
    );
  }
  return positions;
}

/**
 * Build the source-owned presentation for one attack label.
 * @param {object} input
 * @param {string} input.id Stable event id.
 * @param {Cesium.Cartesian3} input.position Destination anchor.
 * @param {string} input.type Threat type.
 * @param {number} input.severity 1-5.
 * @param {string} input.dstCode Destination country code.
 * @param {string} input.accent Source-owned threat color as CSS.
 * @returns {object}
 */
export function createCyberOverlayEntry({
  id,
  position,
  type,
  severity,
  dstCode,
  accent,
  clusterCount = 0,
}) {
  const merged = Math.max(0, Math.floor(Number(clusterCount) || 0));
  return {
    id: String(id),
    position,
    variant: 'label',
    title:
      `${String(type).toUpperCase()} → ${String(dstCode || '').toUpperCase()}` +
      (merged > 0 ? ` +${merged}` : ''),
    accent,
    priority: Math.round(Number(severity) || 0) * 1000,
    collisionGroup: 'ambient-label',
    paintLane: 'ambient-label',
    interactive: false,
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
    gapPx: 15,
    verticalOnly: true,
    placement: 'above',
  };
}

/** Keep the most severe attacks, with stable identity as the tie-break. */
export function selectCyberOverlayCohort(
  entries,
  limit = CYBER_OVERLAY_COHORT_LIMIT,
) {
  const cap = Math.max(
    0,
    Math.min(CYBER_OVERLAY_COHORT_LIMIT, Math.floor(Number(limit) || 0)),
  );
  if (!Array.isArray(entries) || cap === 0) return [];
  return entries
    .slice()
    .sort(
      (a, b) =>
        b.priority - a.priority || String(a.id).localeCompare(String(b.id)),
    )
    .slice(0, cap);
}

/**
 * Map one attack's raw plain values to a JSON-safe analyst record
 * (analyst query engine seam). Pure — no Cesium types. Missing/unknown
 * fields are null, never NaN/undefined.
 * @param {Object|null|undefined} raw - Plain values pulled off the entity.
 * @param {number} [index=0] - Position in the snapshot (fallback id only).
 * @returns {{id:string,type:string|null,severity:number|null,
 *   srcCode:string|null,srcCountry:string|null,srcLat:number|null,srcLon:number|null,
 *   dstCode:string|null,dstCountry:string|null,dstLat:number|null,dstLon:number|null,
 *   timeMs:number|null}}
 */
export function mapCyberAnalystRecord(raw, index = 0) {
  const num = (v) => (Number.isFinite(v) ? v : null);
  const text = (v) => {
    const t = String(v ?? '').trim();
    return t || null;
  };
  const type = text(raw?.type);
  return {
    id: text(raw?.id) || `CYBER-${String(index).padStart(4, '0')}`,
    type: CYBER_THREAT_TYPES.includes(type) ? type : null,
    severity: num(raw?.severity),
    srcCode: text(raw?.srcCode),
    srcCountry: text(raw?.srcCountry),
    srcLat: num(raw?.srcLat),
    srcLon: num(raw?.srcLon),
    dstCode: text(raw?.dstCode),
    dstCountry: text(raw?.dstCountry),
    dstLat: num(raw?.dstLat),
    dstLon: num(raw?.dstLon),
    timeMs: num(raw?.ts),
  };
}
