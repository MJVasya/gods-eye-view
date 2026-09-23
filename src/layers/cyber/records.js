/**
 * Validate and normalize raw cyber feed events into plain records.
 *
 * Feed event schema (fixed contract):
 *   { id: string,
 *     src: { country: string, code: string, lat: number, lon: number,
 *            city?: string, region?: string, isp?: string, org?: string,
 *            asn?: string },
 *     dst: { country: string, code: string, lat: number, lon: number },
 *     type: 'ddos'|'malware'|'intrusion'|'phishing'|'scan'|'c2',
 *     severity: 1-5,
 *     ts: epochMs,
 *     ioc?: string,   // raw indicator (live proxy only)
 *     ref?: string }   // upstream provenance URL (live proxy only)
 *
 * Optional strings are kept when they are non-empty after trimming and
 * omitted otherwise; nothing is ever invented.
 *
 * Malformed events are rejected individually (skipped); a non-array snapshot
 * is rejected as a whole by returning null so the source can throw.
 * Duplicate ids keep their first occurrence so entity ids stay unique.
 */
export const CYBER_THREAT_TYPES = Object.freeze([
  'ddos',
  'malware',
  'intrusion',
  'phishing',
  'scan',
  'c2',
]);

const THREAT_TYPE_SET = new Set(CYBER_THREAT_TYPES);

function isEndpoint(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const { country, code, lat, lon } = value;
  return (
    typeof country === 'string' &&
    country.trim() !== '' &&
    typeof code === 'string' &&
    code.trim() !== '' &&
    Number.isFinite(lat) &&
    Math.abs(lat) <= 90 &&
    Number.isFinite(lon) &&
    Math.abs(lon) <= 180
  );
}

/**
 * Optional GeoIP enrichment carried on endpoints by the live proxy
 * (city/region/isp/org/asn from ip-api.com). Trimmed strings are kept;
 * absent, empty, or non-string values are omitted rather than invented —
 * consumers must render "n/a" honestly instead of guessing.
 */
const OPTIONAL_ENDPOINT_FIELDS = Object.freeze([
  'city',
  'region',
  'isp',
  'org',
  'asn',
]);

function cleanOptionalString(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function normalizeEndpoint(value) {
  const endpoint = {
    country: value.country.trim(),
    code: value.code.trim(),
    lat: value.lat,
    lon: value.lon,
  };
  for (const field of OPTIONAL_ENDPOINT_FIELDS) {
    const cleaned = cleanOptionalString(value[field]);
    if (cleaned !== undefined) endpoint[field] = cleaned;
  }
  return endpoint;
}

function normalizeEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return null;
  if (typeof event.id !== 'string' || event.id.trim() === '') return null;
  if (!isEndpoint(event.src) || !isEndpoint(event.dst)) return null;
  if (!THREAT_TYPE_SET.has(event.type)) return null;
  if (
    !Number.isInteger(event.severity) ||
    event.severity < 1 ||
    event.severity > 5
  )
    return null;
  if (!Number.isFinite(event.ts) || event.ts < 0) return null;
  const normalized = {
    id: event.id.trim(),
    src: normalizeEndpoint(event.src),
    dst: normalizeEndpoint(event.dst),
    type: event.type,
    severity: event.severity,
    ts: event.ts,
  };
  // Optional provenance extras (live proxy only). Kept as trimmed strings
  // so the click-to-inspect panel can show the real indicator; absent or
  // malformed extras are omitted, never fabricated.
  const ioc = cleanOptionalString(event.ioc);
  if (ioc !== undefined) normalized.ioc = ioc;
  const ref = cleanOptionalString(event.ref);
  if (ref !== undefined) normalized.ref = ref;
  return normalized;
}

/**
 * Validate a complete feed snapshot before it can replace displayed attacks.
 * @param {unknown} snapshot - Raw value from the feed's getSnapshot().
 * @returns {Array<Object>|null} Normalized records, or null when the
 *   snapshot itself is malformed (not an array).
 */
export function normalizeCyberEvents(snapshot) {
  if (!Array.isArray(snapshot)) return null;
  const rows = [];
  const seen = new Set();
  for (const event of snapshot) {
    const row = normalizeEvent(event);
    if (!row) continue; // reject malformed events individually
    if (seen.has(row.id)) continue; // keep first occurrence
    seen.add(row.id);
    rows.push(row);
  }
  return rows;
}
