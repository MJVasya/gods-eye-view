/**
 * Validate and normalize raw cyber feed events into plain records.
 *
 * Feed event schema (fixed contract):
 *   { id: string,
 *     src: { country: string, code: string, lat: number, lon: number },
 *     dst: { country: string, code: string, lat: number, lon: number },
 *     type: 'ddos'|'malware'|'intrusion'|'phishing'|'scan'|'c2',
 *     severity: 1-5,
 *     ts: epochMs }
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

function normalizeEndpoint(value) {
  return {
    country: value.country.trim(),
    code: value.code.trim(),
    lat: value.lat,
    lon: value.lon,
  };
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
  return {
    id: event.id.trim(),
    src: normalizeEndpoint(event.src),
    dst: normalizeEndpoint(event.dst),
    type: event.type,
    severity: event.severity,
    ts: event.ts,
  };
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
