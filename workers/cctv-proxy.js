/**
 * CCTV camera proxy for Cloudflare Workers (production port of the dev-server
 * Vite plugin in `server/providers/cctv.js` + `server/providers/cctv/*`).
 *
 * Serves:
 *   GET /api/cctv/sources    — list all registered camera sources
 *   GET /api/cctv/health     — per-camera health/status report
 *   GET /api/cctv/stream/:id — stream info (feedType, URLs) for a camera
 *   GET /api/cctv/media/:id  — proxy live video/image media from upstream
 *   GET /api/cctv/frame/:id  — single frame with fallback chain
 *
 * Fallback chain: upstream image -> synthetic SVG. (The dev server has a
 * Google Street View middle leg; it needs a server-side API key, which cannot
 * ship to the edge, so it is deliberately dropped here.)
 *
 * PORTED vs DROPPED (vs the dev proxy):
 *   Ported: every keyless live open-data pack loader (austin, caltrans, tfl,
 *     ontario, fintraffic, drivebc, txdot, tarktee, nsw, calgary), catalog
 *     merge/dedupe + shared round-robin cap, single-flight 15-min in-memory
 *     catalog cache with serve-stale on empty refresh, frame fallback
 *     (upstream -> synthetic SVG), media proxy with sanitized Range
 *     forwarding + declared-size cap, health map with eviction cap, all five
 *     endpoint shapes verbatim.
 *   Dropped: `loadSourcesFromFile` / `CCTV_SOURCES_FILE` and the
 *     Tallinn + Warendorf file-catalog packs (node:fs/node:path — no disk on
 *     the edge); the `CCTV_SOURCES_JSON` env pack and every `process.env` kill
 *     switch/override (env unavailable — all live packs hardcoded enabled,
 *     defaults hardcoded); the Google Street View fallback leg (needs a
 *     server key); the shipped `cctv_ground_heights` sidecar join (fs-based,
 *     sources carry groundHeights: null instead); Node stream plumbing
 *     (`toReadable`/`watchDownstreamClose`/`proxyMediaResponse` on
 *     http.ServerResponse — the Worker instead returns streaming Responses
 *     directly; client disconnects abort via request.signal).
 *
 * Workers-safe: no node: imports, no fs, no Buffer, no process.env. Binary
 * work uses Uint8Array/TextEncoder/btoa/atob.
 */

/* ------------------------------------------------------------------ */
/* Constants (from server/providers/cctv/constants.js)                 */
/* ------------------------------------------------------------------ */

/** Austin Open Data portal endpoint for traffic camera records. */
const DEFAULT_AUSTIN_ROWS_URL =
  'https://data.austintexas.gov/api/views/b4k4-adkb/rows.json?accessType=DOWNLOAD';
/** Default cap on Austin cameras after distance-based prioritization. */
const DEFAULT_AUSTIN_MAX_SOURCES = 250;
/** Catalog-wide safety ceiling; shared round-robin across packs (see cap.js). */
const DEFAULT_CCTV_MAX_SOURCES = 4000;
/** Hard upper bound for the catalog cap; also sizes the health map. */
const CCTV_MAX_SOURCES_CEILING = 5000;
/** Reference point for Austin camera prioritization (Congress & 6th). */
const AUSTIN_DOWNTOWN = { lat: 30.2672, lon: -97.7431 };
/** TxDOT ITS: one keyless JSON catalog per district (25 districts statewide). */
const TXDOT_ORIGIN = 'https://its.txdot.gov';
const TXDOT_CCTV_STATUS_URL = (district) =>
  `${TXDOT_ORIGIN}/its/DistrictIts/GetCctvStatusListByDistrict?districtCode=${encodeURIComponent(district)}`;
/** Per-camera frame. Returns JSON `{snippet:<base64 jpeg>}`, not an image body. */
const TXDOT_CCTV_SNAPSHOT_URL = `${TXDOT_ORIGIN}/its/DistrictIts/GetCctvSnapshotByIcdId`;
/** Valid TxDOT district codes (the ITS map's own districtCodes list). */
const TXDOT_DISTRICTS = new Set([
  'ABL', 'AMA', 'ATL', 'AUS', 'BMT', 'BWD', 'BRY', 'CHS', 'CRP', 'DAL',
  'ELP', 'FTW', 'HOU', 'LRD', 'LBB', 'LFK', 'ODA', 'PAR', 'PHR', 'SJT',
  'SAT', 'TYL', 'WAC', 'WFS', 'YKM',
]);
/** Districts fetched by default: Austin (the reference camera city) and San Antonio. */
const DEFAULT_TXDOT_DISTRICTS = 'AUS,SAT';
const DEFAULT_TXDOT_MAX_SOURCES = 500;
/** Prioritization anchors: downtown cores of the metro districts a user can select. */
const TXDOT_ANCHORS = [
  { lat: 30.2672, lon: -97.7431 }, // Austin
  { lat: 29.4241, lon: -98.4936 }, // San Antonio
  { lat: 29.7604, lon: -95.3698 }, // Houston
  { lat: 32.7767, lon: -96.797 }, // Dallas
  { lat: 32.7555, lon: -97.3308 }, // Fort Worth
];
/** Ground-elevation priors in metres, by district. */
const TXDOT_DISTRICT_ELEVATION_M = Object.freeze({
  ABL: 520, AMA: 1099, ATL: 105, AUS: 149, BMT: 5, BWD: 425, BRY: 111,
  CHS: 250, CRP: 7, DAL: 131, ELP: 1140, FTW: 199, HOU: 15, LRD: 132,
  LBB: 992, LFK: 91, ODA: 890, PAR: 185, PHR: 30, SJT: 585, SAT: 198,
  TYL: 165, WAC: 143, WFS: 289, YKM: 70,
});
const TXDOT_DEFAULT_ELEVATION_M = 150;
const CALTRANS_CCTV_URL = (district) =>
  `https://cwwp2.dot.ca.gov/data/d${district}/cctv/cctvStatusD${String(district).padStart(2, '0')}.json`;
/** Districts fetched by default: SF Bay (4), LA (7), San Diego (11), Sacramento (3). */
const DEFAULT_CALTRANS_DISTRICTS = '4,7,11,3';
const DEFAULT_CALTRANS_MAX_SOURCES = 300;
/** Prioritization anchors: downtown cores of the four default metros. */
const CALTRANS_ANCHORS = [
  { lat: 37.7793, lon: -122.4193 }, // San Francisco
  { lat: 34.0537, lon: -118.2428 }, // Los Angeles
  { lat: 32.7157, lon: -117.1611 }, // San Diego
  { lat: 38.5816, lon: -121.4944 }, // Sacramento
];
/** TfL JamCams: one keyless list endpoint; frames live on a public S3 bucket. */
const TFL_JAMCAM_URL = 'https://api.tfl.gov.uk/Place/Type/JamCam';
const TFL_IMAGE_ORIGIN =
  'https://s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/';
const DEFAULT_TFL_MAX_SOURCES = 250;
const LONDON_CENTER = { lat: 51.5074, lon: -0.1278 };
/** Ontario 511: keyless CARS/511 camera catalog; frame URLs are still images. */
const ONTARIO_511_CAMERAS_URL =
  'https://511on.ca/api/v2/get/cameras?format=json&lang=en';
const ONTARIO_511_IMAGE_ORIGIN = 'https://511on.ca/map/Cctv/';
const DEFAULT_ONTARIO_MAX_SOURCES = 1000;
const ONTARIO_ANCHORS = [
  { lat: 43.4516, lon: -80.4925 }, // Kitchener
  { lat: 43.6532, lon: -79.3832 }, // Toronto
  { lat: 45.4215, lon: -75.6972 }, // Ottawa
  { lat: 43.2557, lon: -79.8711 }, // Hamilton
  { lat: 42.9849, lon: -81.2453 }, // London, Ontario
  { lat: 42.3149, lon: -83.0364 }, // Windsor
];
/** Fintraffic road weather cameras (Digitraffic): one keyless GeoJSON list. */
const FINTRAFFIC_STATIONS_URL =
  'https://tie.digitraffic.fi/api/weathercam/v1/stations';
/** Frames: `<origin><presetId>.jpg`. Preset ids are synthesized into this
 * origin rather than read from the payload, so no upstream field can steer the
 * frame proxy off-host. */
const FINTRAFFIC_IMAGE_ORIGIN = 'https://weathercam.digitraffic.fi/';
/** Digitraffic asks every client to identify itself on API calls. */
const DIGITRAFFIC_USER = 'gods-eye-view';
const DEFAULT_FINTRAFFIC_MAX_SOURCES = 300;
/** Ground-elevation prior, in metres, for stations that report no altitude. */
const FINTRAFFIC_GROUND_ELEVATION_M = 90;
/** Prioritization anchors along Finland's main road spine. */
const FINLAND_ANCHORS = [
  { lat: 60.1699, lon: 24.9384 }, // Helsinki
  { lat: 60.4518, lon: 22.2666 }, // Turku
  { lat: 61.4978, lon: 23.761 }, // Tampere
  { lat: 62.2426, lon: 25.7473 }, // Jyväskylä
  { lat: 62.8924, lon: 27.677 }, // Kuopio
  { lat: 65.0121, lon: 25.4651 }, // Oulu
  { lat: 66.5039, lon: 25.7294 }, // Rovaniemi
];
/** DriveBC highway cameras (British Columbia): keyless camera list. */
const DRIVEBC_WEBCAMS_URL = 'https://www.drivebc.ca/api/webcams/';
const DRIVEBC_IMAGE_URL = (id) =>
  `https://www.drivebc.ca/images/${id}.jpg`;
const DEFAULT_DRIVEBC_MAX_SOURCES = 250;
/** Prioritization anchors: downtown Vancouver and Victoria. */
const DRIVEBC_ANCHORS = [
  { lat: 49.2827, lon: -123.1207 }, // Vancouver
  { lat: 48.4284, lon: -123.3656 }, // Victoria
];
/** Transpordiamet / Tarktee road-weather cameras: keyless DATEX2 feeds. */
const TARKTEE_LOCATIONS_URL =
  'https://tarktee.transpordiamet.ee/api/v1/datex/roadCameraLocations';
const TARKTEE_IMAGES_URL =
  'https://tarktee.transpordiamet.ee/api/v1/datex/roadCameraImages';
const TARKTEE_IMAGE_ORIGIN = 'https://tarktee.transpordiamet.ee/images/';
const DEFAULT_TARKTEE_MAX_SOURCES = 179;
const TARKTEE_ANCHORS = [
  { lat: 59.437, lon: 24.753 }, // Tallinn
  { lat: 58.378, lon: 26.729 }, // Tartu
  { lat: 58.3859, lon: 24.4971 }, // Pärnu
  { lat: 59.3797, lon: 28.1791 }, // Narva
];
/** Live Traffic NSW (Transport for NSW): keyless public camera catalog. */
const NSW_CAMERAS_URL =
  'https://data.livetraffic.com/cameras/traffic-cam.json';
const NSW_IMAGE_ORIGIN = 'https://webcams.transport.nsw.gov.au/';
const DEFAULT_NSW_MAX_SOURCES = 250;
const SYDNEY_CENTER = { lat: -33.8688, lon: 151.2093 };
/**
 * The NSW webcam host answers non-browser clients with HTTP 200 and a short
 * HTML body instead of the frame, so the proxy identifies as a browser for
 * that one host.
 */
const NSW_IMAGE_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
/**
 * Longest NSW `view` sentence still usable as a label. NSW occasionally
 * repurposes `view` for a multi-paragraph works notice; real descriptions top
 * out around 120 characters.
 */
const NSW_MAX_VIEW_LABEL = 140;
/** Open Calgary traffic cameras: one keyless Socrata endpoint for the whole city. */
const DEFAULT_CALGARY_ROWS_URL =
  'https://data.calgary.ca/resource/k7p9-kppz.json?$limit=500';
/** The only origin Calgary camera frames may come from. */
const CALGARY_IMAGE_ORIGIN = 'https://trafficcam.calgary.ca/';
const DEFAULT_CALGARY_MAX_SOURCES = 220;
/** Centre Street / 7 Avenue: the prioritization anchor. */
const CALGARY_DOWNTOWN = { lat: 51.0461, lon: -114.0626 };
/** Hard ceiling on the Calgary catalog body. */
const CALGARY_MAX_CATALOG_BYTES = 4 * 1024 * 1024;

/** Camera CATALOGS change rarely; 15 min keeps multi-megabyte upstream list refetches infrequent. Frames are fetched per-request and are unaffected. */
const CCTV_SOURCE_CACHE_MS = 15 * 60 * 1000;
/** Per-provider catalog-fetch timeout. */
const CCTV_SOURCE_FETCH_TIMEOUT_MS = 15 * 1000;
/** Individual CCTV image fetches must settle before the active 10-second client refresh cadence. */
const CCTV_FRAME_FETCH_TIMEOUT_MS = 8 * 1000;
/** Maximum buffered snapshot size. */
const CCTV_FRAME_MAX_BODY_BYTES = 16 * 1024 * 1024;
/** Deadline for upstream response headers; live bodies keep streaming afterward. */
const CCTV_MEDIA_FETCH_TIMEOUT_MS = 15 * 1000;
/** Declared size ceiling for fixed media responses. */
const CCTV_MEDIA_MAX_BODY_BYTES = 64 * 1024 * 1024;

/** Edge (Cache API) TTL for the semi-static sources list. Frames/media stay fresh. */
const SOURCES_EDGE_TTL_SECONDS = 300;

/* ------------------------------------------------------------------ */
/* Pure utils (from normalize.js + src/sources/cctvTypes.js +          */
/* src/data/directionText.js + server/providers/common/geo.js)          */
/* ------------------------------------------------------------------ */

/** FNV-1a 32-bit hash of a string (deterministic pseudo-random values). */
function hashSeed(text) {
  let h = 2166136261 >>> 0; // FNV offset basis
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619); // FNV prime
  }
  return h >>> 0;
}

/** Escape special XML/HTML characters for safe embedding in SVG text nodes. */
function escapeXml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Coerce a value to a finite number, returning fallback if NaN/Infinity. */
function toFiniteNumber(value, fallback = NaN) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

/**
 * Canonicalize a CCTV feed type string to one of:
 * 'image', 'mjpeg', 'mp4', 'webm', 'hls', or pass-through.
 */
function normalizeFeedType(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return 'image';
  if (raw === 'jpeg' || raw === 'jpg' || raw === 'png') return 'image';
  if (raw === 'mjpg') return 'mjpeg';
  if (raw === 'video') return 'mp4';
  if (raw === 'stream') return 'hls';
  return raw;
}

/** Check whether a normalized feed type represents streaming video. */
function isVideoFeedType(feedType) {
  return feedType === 'mp4' || feedType === 'webm' || feedType === 'hls';
}

/**
 * Convert a cardinal/intercardinal direction string to a compass heading.
 * See the dev docstring: dedicated direction fields pass `allowBare=true`;
 * free-form name text must NOT (bare cardinals there are street names).
 */
function directionToHeading(value, allowBare = false) {
  const text = String(value || '').trim().toUpperCase();
  if (!text) return NaN;
  if (/\bNORTHBOUND\b|\bNB\b/.test(text)) return 0;
  if (/\bSOUTHBOUND\b|\bSB\b/.test(text)) return 180;
  if (/\bEASTBOUND\b|\bEB\b/.test(text)) return 90;
  if (/\bWESTBOUND\b|\bWB\b/.test(text)) return 270;
  if (/\bNORTHEAST\b|\bNE\b/.test(text)) return 45;
  if (/\bNORTHWEST\b|\bNW\b/.test(text)) return 315;
  if (/\bSOUTHEAST\b|\bSE\b/.test(text)) return 135;
  if (/\bSOUTHWEST\b|\bSW\b/.test(text)) return 225;
  if (allowBare) {
    if (/\bNORTH\b/.test(text)) return 0;
    if (/\bSOUTH\b/.test(text)) return 180;
    if (/\bEAST\b/.test(text)) return 90;
    if (/\bWEST\b/.test(text)) return 270;
  }
  return NaN;
}

/** Haversine great-circle distance between two WGS-84 points, in kilometers. */
function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (value) => (value * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Normalize a column/field name to a lowercase snake_case key. */
function normalizeKey(text) {
  return String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * Parse a WKT POINT string (e.g. "POINT(-97.74 30.27)") into lat/lon.
 * WKT uses (lon lat) order; returned object uses {lat, lon}.
 */
function parsePointString(value) {
  const match = String(value || '').match(
    /POINT\s*\(\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*\)/i,
  );
  if (!match) return { lat: NaN, lon: NaN };
  return { lon: toFiniteNumber(match[1]), lat: toFiniteNumber(match[2]) };
}

/** Extract lat/lon from a variety of coordinate representations. */
function coerceLatLon(value) {
  if (!value) return { lat: NaN, lon: NaN };
  if (typeof value === 'string') return parsePointString(value);
  if (typeof value !== 'object') return { lat: NaN, lon: NaN };
  const lat = toFiniteNumber(
    value.latitude ?? value.lat ?? value.y ?? value.Latitude ?? value.Lat,
    NaN,
  );
  const lon = toFiniteNumber(
    value.longitude ??
      value.lon ??
      value.lng ??
      value.x ??
      value.Longitude ??
      value.Lon,
    NaN,
  );
  return { lat, lon };
}

/** Extract geographic coordinates from an Austin Open Data camera record. */
function extractAustinCoords(record) {
  const candidates = [
    record.location,
    record.coordinates,
    record.the_geom,
    record.point,
    record.geocoded_column,
  ];
  for (const candidate of candidates) {
    const parsed = coerceLatLon(candidate);
    if (Number.isFinite(parsed.lat) && Number.isFinite(parsed.lon))
      return parsed;
  }
  const lat = toFiniteNumber(
    record.latitude ?? record.lat ?? record.camera_latitude ?? record.location_latitude,
    NaN,
  );
  const lon = toFiniteNumber(
    record.longitude ?? record.lon ?? record.lng ?? record.camera_longitude ?? record.location_longitude,
    NaN,
  );
  return { lat, lon };
}

/** Extract a numeric camera ID from an Austin Open Data record. */
function extractAustinCameraId(record) {
  const preferredKeys = [
    'camera_id', 'cameraid', 'cam_id', 'device_id', 'intersection_id', 'id',
  ];
  for (const key of preferredKeys) {
    const value = record[key];
    if (value == null) continue;
    const asText = String(value).trim();
    if (!asText) continue;
    if (/^\d+$/.test(asText)) return asText;
  }
  for (const [key, value] of Object.entries(record)) {
    if (!/camera|cam|device/.test(key)) continue;
    if (!/id/.test(key)) continue;
    const asText = String(value || '').trim();
    if (!asText) continue;
    if (/^\d+$/.test(asText)) return asText;
  }
  return '';
}

/** Extract a human-readable camera name from an Austin record. */
function extractAustinName(record, cameraId) {
  const preferredKeys = [
    'camera_name', 'location_name', 'intersection_name', 'location',
    'cross_street', 'description', 'name',
  ];
  for (const key of preferredKeys) {
    const value = record[key];
    if (typeof value !== 'string') continue;
    const text = value.trim();
    if (text) return text;
  }
  return `Austin Camera ${cameraId}`;
}

/** Extract camera heading (compass bearing) from an Austin record. */
function extractAustinHeading(record) {
  const direct = toFiniteNumber(
    record.heading_deg ?? record.heading ?? record.bearing,
    NaN,
  );
  if (Number.isFinite(direct)) return ((direct % 360) + 360) % 360;

  // Dedicated direction fields: bare cardinal words ("West") are real facings.
  const directionKeys = ['direction', 'travel_direction', 'facing', 'facing_direction'];
  for (const key of directionKeys) {
    const heading = directionToHeading(record[key], true);
    if (Number.isFinite(heading)) return heading;
  }

  // Free-form name/intersection text: only explicit travel forms count — a bare
  // "West" here is a street name, not a facing.
  const nameProbe = [
    record.camera_name, record.location_name, record.intersection_name,
    record.location, record.cross_street, record.description, record.name,
  ]
    .filter(Boolean)
    .join(' ');
  const inferred = directionToHeading(nameProbe);
  if (Number.isFinite(inferred)) return inferred;

  return NaN;
}

/** Bounding-box sanity check: is this coordinate plausibly in the Austin metro area? */
function isLikelyAustinCoordinate(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  return lat >= 30.02 && lat <= 30.58 && lon >= -98.12 && lon <= -97.4;
}

/** Longest unselected camera label the HUD shows before it gets noisy. */
const CAMERA_CODE_MAX_CHARS = 28;

/**
 * Short display code for the unselected camera label ("CAM-<code>"): the
 * feed's own name for the camera, trimmed to CAMERA_CODE_MAX_CHARS.
 */
function cameraDisplayCode(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= CAMERA_CODE_MAX_CHARS) return clean;
  return `${clean.slice(0, CAMERA_CODE_MAX_CHARS - 1).trimEnd()}…`;
}

/** Finite, in range, and not the null island that Number(null) produces. */
function isPlausibleLatLon(lat, lon) {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lon) <= 180 &&
    !(lat === 0 && lon === 0)
  );
}

/** British Columbia bounding box (with the neighbouring border crossings). */
function isLikelyBcCoordinate(lat, lon) {
  return (
    isPlausibleLatLon(lat, lon) &&
    lat >= 48 && lat <= 60.5 && lon >= -139.5 && lon <= -114
  );
}

/** Texas bounding box. */
function isLikelyTexasCoordinate(lat, lon) {
  return (
    isPlausibleLatLon(lat, lon) &&
    lat >= 25.5 && lat <= 36.7 && lon >= -107 && lon <= -93.4
  );
}

/** New South Wales bounding box (incl. the ACT and Lord Howe Island). */
function isLikelyNswCoordinate(lat, lon) {
  return (
    isPlausibleLatLon(lat, lon) &&
    lat >= -38 && lat <= -28 && lon >= 140.9 && lon <= 159.2
  );
}

/** Calgary's municipal extent, with slack for the ring road. */
function isLikelyCalgaryCoordinate(lat, lon) {
  return (
    isPlausibleLatLon(lat, lon) &&
    lat >= 50.8 && lat <= 51.25 && lon >= -114.4 && lon <= -113.8
  );
}

/** Finland bounding box (generous around the observed catalog extent). */
function isLikelyFinlandCoordinate(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  return lat >= 59.5 && lat <= 70.5 && lon >= 19 && lon <= 32;
}

/** Human label for one Fintraffic preset (camera view). */
function fintrafficCameraName(stationName, stationId, presetId) {
  const base =
    String(stationName || '').replace(/_/g, ' ').trim() || `Fintraffic ${stationId}`;
  const view = String(presetId || '').slice(String(stationId || '').length);
  return view ? `${base} (view ${view})` : base;
}

/** Derive a deterministic fallback heading from a camera ID hash. */
function fallbackHeadingFromId(cameraId) {
  return (hashSeed(String(cameraId)) % 16) * 22.5;
}

/**
 * Convert a Socrata rows.json array row into a keyed object using column metadata.
 */
function rowArrayToObject(row, columns) {
  const record = {};
  for (let idx = 0; idx < columns.length; idx++) {
    const col = columns[idx];
    const key = normalizeKey(col.fieldName || col.name || `col_${idx}`);
    if (!key) continue;
    record[key] = row[idx];
  }
  return record;
}

/**
 * Distance-prioritizes cameras to a cap: keeps the maxCount cameras closest
 * to ANY of the given anchor points (min distance over anchors), tie-broken
 * by original array order.
 */
function prioritizeSources(cameras, maxCount, anchors) {
  const list = Array.isArray(cameras) ? cameras : [];
  const anchorList = (Array.isArray(anchors) ? anchors : []).filter(
    (a) => Number.isFinite(a?.lat) && Number.isFinite(a?.lon),
  );
  if (!anchorList.length) return list;
  const cap =
    Number.isFinite(maxCount) && maxCount > 0
      ? Math.min(maxCount, list.length)
      : list.length;

  const scored = list.map((camera, idx) => {
    const lat = Number(camera?.lat);
    const lon = Number(camera?.lon);
    const distKm =
      Number.isFinite(lat) && Number.isFinite(lon)
        ? Math.min(...anchorList.map((a) => haversineKm(lat, lon, a.lat, a.lon)))
        : Number.POSITIVE_INFINITY;
    return { camera, idx, distKm };
  });

  scored.sort((a, b) => {
    if (a.distKm !== b.distKm) return a.distKm - b.distKm;
    return a.idx - b.idx;
  });

  return scored.slice(0, cap).map((entry) => entry.camera);
}

/** Normalize a raw CCTV source item into a canonical shape with safe defaults. */
function normalizeSourceItem(item) {
  return {
    id: String(item.id || '').trim(),
    name: String(item.name || item.id || '').trim(),
    city: String(item.city || ''),
    cityId: String(item.cityId || ''),
    provider: String(item.provider || 'Configured CCTV Source'),
    lat: toFiniteNumber(item.lat),
    lon: toFiniteNumber(item.lon),
    headingDeg: toFiniteNumber(item.headingDeg),
    headingConfidence: String(item.headingConfidence || item.headingSource || '').toLowerCase(),
    pitchDeg: toFiniteNumber(item.pitchDeg),
    fovDeg: toFiniteNumber(item.fovDeg),
    rangeM: toFiniteNumber(item.rangeM),
    mountHeightM: toFiniteNumber(item.mountHeightM),
    groundElevationM: toFiniteNumber(item.groundElevationM),
    feedType: normalizeFeedType(item.feedType || item.type || ''),
    url: typeof item.url === 'string' ? item.url : '',
    snapshotUrl: typeof item.snapshotUrl === 'string' ? item.snapshotUrl : '',
    license: String(item.license || item.licenseNote || ''),
    credit: String(item.credit || '').trim(),
    code: cameraDisplayCode(
      item.code || String(item.name || '').toUpperCase() || item.id || '',
    ),
    sourceKind: String(item.sourceKind || item.kind || 'configured'),
    poseSource: item.poseSource === 'curated' ? 'curated' : undefined,
  };
}

/** UTF-8 string -> base64url (Worker-safe replacement for Buffer.toString('base64url')). */
function base64UrlEncode(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/* ------------------------------------------------------------------ */
/* Cap allocation (from server/providers/cctv/cap.js)                   */
/* ------------------------------------------------------------------ */

/**
 * Merge source packs under one cap without starving any of them. The cap is
 * filled ROUND-ROBIN — one camera from each pack per turn, in each pack's
 * own order. Duplicate ids resolve last-pack-wins.
 */
function allocateSourceCap(packs, maxCount) {
  const owner = new Map();
  for (const pack of packs) {
    for (const source of pack.sources) {
      if (!source?.id) continue;
      owner.set(source.id, { pack: pack.name, source });
    }
  }
  const lanes = packs.map((pack) => ({
    name: pack.name,
    queue: pack.sources.filter(
      (source) => source?.id && owner.get(source.id)?.source === source,
    ),
    next: 0,
    kept: 0,
  }));
  const total = lanes.reduce((sum, lane) => sum + lane.queue.length, 0);
  const limit = Math.min(total, Math.max(0, Math.floor(maxCount)));

  const sources = [];
  if (limit >= total) {
    for (const lane of lanes) {
      sources.push(...lane.queue);
      lane.kept = lane.queue.length;
    }
  } else {
    while (sources.length < limit) {
      for (const lane of lanes) {
        if (sources.length >= limit) break;
        if (lane.next >= lane.queue.length) continue;
        sources.push(lane.queue[lane.next]);
        lane.next += 1;
        lane.kept += 1;
      }
    }
  }
  return {
    sources,
    packs: lanes.map((lane) => ({
      name: lane.name,
      offered: lane.queue.length,
      kept: lane.kept,
    })),
  };
}

/* ------------------------------------------------------------------ */
/* Range sanitizer (from server/providers/cctv/range.js)               */
/* ------------------------------------------------------------------ */

/** Digits allowed per Range position — bounds parse cost and absurd offsets. */
const RANGE_MAX_DIGITS = 16;

/**
 * Validate, canonicalize and bound a client `Range` header before the media
 * route forwards it to a third-party camera host. Anything that is not a
 * single well-formed `bytes=` range is DROPPED ('' -> send no Range).
 */
function sanitizeCctvRangeHeader(value, maxBytes = CCTV_MEDIA_MAX_BODY_BYTES) {
  if (typeof value !== 'string') return '';
  const raw = value.trim();
  if (!raw) return '';

  const match = /^bytes=(\d*)-(\d*)$/i.exec(raw);
  if (!match) return '';

  const [, firstText, lastText] = match;
  if (firstText.length > RANGE_MAX_DIGITS || lastText.length > RANGE_MAX_DIGITS)
    return '';
  if (!firstText && !lastText) return '';

  // Suffix form: the final N bytes. N === 0 is unsatisfiable by definition.
  if (!firstText) {
    const suffix = Number(lastText);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return '';
    return `bytes=-${Math.min(suffix, maxBytes)}`;
  }

  const first = Number(firstText);
  if (!Number.isSafeInteger(first) || first < 0) return '';

  const ceiling = first + maxBytes - 1;
  if (!Number.isSafeInteger(ceiling)) return '';

  // Open-ended: everything from `first` on, bounded to one span.
  if (!lastText) return `bytes=${first}-${ceiling}`;

  const last = Number(lastText);
  if (!Number.isSafeInteger(last) || last < first) return '';
  return `bytes=${first}-${Math.min(last, ceiling)}`;
}

/* ------------------------------------------------------------------ */
/* Live open-data pack loaders (from server/providers/cctv/sources.js)  */
/* All packs hardcoded enabled; all env overrides dropped.             */
/* ------------------------------------------------------------------ */

/**
 * Fetch and parse Austin traffic camera records from the city Open Data portal.
 * Downloads the Socrata rows.json payload, converts each row to a keyed
 * record, extracts camera ID / coords / heading / name, validates against
 * the Austin bounding box, deduplicates by ID, then distance-prioritizes.
 */
export async function loadAustinSourcesFromOpenData() {
  const endpoint = DEFAULT_AUSTIN_ROWS_URL;
  try {
    const resp = await fetch(endpoint, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(CCTV_SOURCE_FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) {
      console.warn('[CCTV] Austin source download failed:', resp.status);
      return [];
    }
    const payload = await resp.json();
    const columns = Array.isArray(payload?.meta?.view?.columns)
      ? payload.meta.view.columns
      : [];
    const rows = Array.isArray(payload?.data) ? payload.data : [];
    if (!columns.length || !rows.length) return [];

    const cameras = [];
    for (const row of rows) {
      if (!Array.isArray(row)) continue;
      const record = rowArrayToObject(row, columns);
      const cameraId = extractAustinCameraId(record);
      if (!cameraId) continue;

      // Only live cameras: the dataset carries DESIRED (planned, not built),
      // REMOVED and VOID rows whose frame URLs never resolve. Tolerate a
      // missing column (keep the row) so a schema change fails open.
      const status = String(record.camera_status || '').trim().toUpperCase();
      if (status && status !== 'TURNED_ON') continue;

      const { lat, lon } = extractAustinCoords(record);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      if (!isLikelyAustinCoordinate(lat, lon)) continue;

      const extractedHeading = extractAustinHeading(record);
      const hasHeading = Number.isFinite(extractedHeading);
      const headingDeg = hasHeading ? extractedHeading : fallbackHeadingFromId(cameraId);
      cameras.push({
        id: cameraId,
        name: extractAustinName(record, cameraId),
        city: 'Austin',
        cityId: 'austin',
        provider: 'Austin Transportation & Public Works',
        lat,
        lon,
        headingDeg,
        headingConfidence: hasHeading ? 'high' : 'low',
        pitchDeg: hasHeading ? -24 : -18,
        fovDeg: hasHeading ? 56 : 44,
        rangeM: hasHeading ? 210 : 145,
        mountHeightM: hasHeading ? 10 : 8,
        groundElevationM: 150,
        feedType: 'image',
        url: `https://cctv.austinmobility.io/image/${encodeURIComponent(cameraId)}.jpg`,
        snapshotUrl: `https://cctv.austinmobility.io/image/${encodeURIComponent(cameraId)}.jpg`,
        sourceKind: 'austin-open-data',
        license: 'Public city traffic camera frame',
      });
    }

    const unique = Array.from(
      new Map(cameras.map((camera) => [camera.id, camera])).values(),
    );
    const maxCount = Math.max(8, Math.min(300, DEFAULT_AUSTIN_MAX_SOURCES));
    const prioritized = prioritizeSources(unique, maxCount, [AUSTIN_DOWNTOWN]);
    console.log(
      `[CCTV] Loaded Austin camera sources: ${unique.length} (using nearest ${prioritized.length})`,
    );
    return prioritized;
  } catch (error) {
    console.warn('[CCTV] Austin source download error:', error?.message || error);
    return [];
  }
}

/**
 * Fetch Caltrans CCTV cameras for the default districts. One official JSON
 * feed per district, identical schema statewide; keyless. Only inService
 * cameras with finite coords and a cwwp2.dot.ca.gov https image URL are kept
 * (the image-URL origin check is defense-in-depth). Districts fetch in
 * parallel and fail independently (Promise.allSettled).
 */
export async function loadCaltransSourcesFromOpenData() {
  const districts = String(DEFAULT_CALTRANS_DISTRICTS)
    .split(',')
    .map((token) => Number(token.trim()))
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= 12);
  if (!districts.length) return [];

  const settled = await Promise.allSettled(
    districts.map(async (district) => {
      const resp = await fetch(CALTRANS_CCTV_URL(district), {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(CCTV_SOURCE_FETCH_TIMEOUT_MS),
      });
      if (!resp.ok) throw new Error(`D${district} HTTP ${resp.status}`);
      const payload = await resp.json();
      const rows = Array.isArray(payload?.data) ? payload.data : [];
      return { district, rows };
    }),
  );

  const cameras = [];
  for (const result of settled) {
    if (result.status !== 'fulfilled') {
      console.warn(
        '[CCTV] Caltrans district fetch failed:',
        result.reason?.message || result.reason,
      );
      continue;
    }
    const { district, rows } = result.value;
    for (const row of rows) {
      const cctv = row?.cctv;
      if (!cctv || String(cctv.inService).toLowerCase() !== 'true') continue;
      const loc = cctv.location || {};
      const lat = toFiniteNumber(loc.latitude);
      const lon = toFiniteNumber(loc.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

      const imageUrl = String(cctv.imageData?.static?.currentImageURL || '');
      // Official-host pin. Also drops records with no still image.
      if (!imageUrl.startsWith('https://cwwp2.dot.ca.gov/')) continue;

      const locationName = String(loc.locationName || '').trim();
      // Leading token of locationName is the stable camera code ("TV102 -- I-580 : …").
      const codeMatch = /^([A-Za-z0-9_-]+)\s*--/.exec(locationName);
      const code = (codeMatch ? codeMatch[1] : `x${cameras.length}`).toLowerCase();
      const cameraId = `ca-d${district}-${code}`;

      // loc.direction is a dedicated field ("West", "South") → allow bare words.
      const heading = directionToHeading(loc.direction, true);
      const hasHeading = Number.isFinite(heading);
      const label =
        locationName.replace(/^([A-Za-z0-9_-]+)\s*--\s*/, '') ||
        `Caltrans D${district} ${code}`;
      cameras.push({
        id: cameraId,
        name: loc.nearbyPlace ? `${label} (${loc.nearbyPlace})` : label,
        city: String(loc.nearbyPlace || `Caltrans D${district}`),
        cityId: `ca-d${district}`,
        provider: 'Caltrans',
        lat,
        lon,
        headingDeg: hasHeading ? heading : fallbackHeadingFromId(cameraId),
        headingConfidence: hasHeading ? 'high' : 'low',
        pitchDeg: hasHeading ? -24 : -18,
        fovDeg: hasHeading ? 56 : 44,
        rangeM: hasHeading ? 210 : 145,
        mountHeightM: hasHeading ? 10 : 8,
        // loc.elevation is reported in FEET; convert to metres and clamp.
        groundElevationM: (() => {
          const ft = toFiniteNumber(loc.elevation, NaN);
          return Number.isFinite(ft)
            ? Math.max(-100, Math.min(4000, ft * 0.3048))
            : 150;
        })(),
        feedType: 'image',
        url: imageUrl,
        snapshotUrl: imageUrl,
        sourceKind: 'caltrans-open-data',
        license: 'Public Caltrans highway camera frame',
      });
    }
  }

  const maxCount = Math.max(8, Math.min(600, DEFAULT_CALTRANS_MAX_SOURCES));
  const prioritized = prioritizeSources(cameras, maxCount, CALTRANS_ANCHORS);
  console.log(
    `[CCTV] Loaded Caltrans camera sources: ${cameras.length} inService (using nearest ${prioritized.length})`,
  );
  return prioritized;
}

/**
 * Fetch TfL JamCams (London). Keyless anonymous (the optional TFL_APP_KEY
 * only raises the list-endpoint rate limit — no key on the edge, so the
 * anonymous path is used). Only `available === "true"` cameras with finite
 * coords and an image URL on the official bucket are kept.
 * Attribution: "Powered by TfL Open Data".
 */
export async function loadTflSourcesFromOpenData() {
  try {
    const resp = await fetch(TFL_JAMCAM_URL, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(CCTV_SOURCE_FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) {
      console.warn('[CCTV] TfL JamCam download failed:', resp.status);
      return [];
    }
    const places = await resp.json();
    if (!Array.isArray(places)) return [];

    const cameras = [];
    for (const place of places) {
      const props = {};
      for (const p of place?.additionalProperties || []) {
        if (p?.key) props[p.key] = p.value;
      }
      if (String(props.available).toLowerCase() !== 'true') continue;
      const lat = toFiniteNumber(place?.lat);
      const lon = toFiniteNumber(place?.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const imageUrl = String(props.imageUrl || '');
      if (!imageUrl.startsWith(TFL_IMAGE_ORIGIN)) continue; // official-bucket pin

      // "JamCams_00002.00865" → "tfl-00002.00865" (provider-stable id).
      const rawId = String(place?.id || '').replace(/^JamCams_/, '');
      if (!rawId) continue;
      const cameraId = `tfl-${rawId}`;

      cameras.push({
        id: cameraId,
        name: String(place?.commonName || `JamCam ${rawId}`),
        city: 'London',
        cityId: 'london',
        provider: 'Transport for London',
        lat,
        lon,
        // No heading signal at all in JamCam data → id-hash fallback, low confidence.
        headingDeg: fallbackHeadingFromId(cameraId),
        headingConfidence: 'low',
        pitchDeg: -18,
        fovDeg: 44,
        rangeM: 145,
        mountHeightM: 8,
        groundElevationM: 15, // Thames-basin prior; one-shot snap corrects.
        feedType: 'image', // stills-first (owner decision); props.videoUrl deliberately unused
        url: imageUrl,
        snapshotUrl: imageUrl,
        sourceKind: 'tfl-open-data',
        license: 'Powered by TfL Open Data',
      });
    }

    const maxCount = Math.max(8, Math.min(600, DEFAULT_TFL_MAX_SOURCES));
    const prioritized = prioritizeSources(cameras, maxCount, [LONDON_CENTER]);
    console.log(
      `[CCTV] Loaded TfL JamCam sources: ${cameras.length} available (using nearest ${prioritized.length})`,
    );
    return prioritized;
  } catch (error) {
    console.warn('[CCTV] TfL JamCam download error:', error?.message || error);
    return [];
  }
}

/**
 * Pin an Ontario 511 camera view URL to the official still-image host.
 * @returns {string} Canonical 511on.ca still URL, or '' if not accepted.
 */
function normalizeOntarioCctvUrl(value) {
  try {
    const parsed = new URL(String(value || '').trim());
    const match = /^\/map\/Cctv\/([^/?#]+)$/.exec(parsed.pathname);
    if (!match) return '';
    const host = parsed.hostname.toLowerCase();
    if (
      parsed.protocol !== 'https:' ||
      (host !== '511on.ca' && !host.endsWith('.traveliq.co'))
    ) {
      return '';
    }
    const viewId = decodeURIComponent(match[1]);
    if (!/^[A-Za-z0-9_.-]+$/.test(viewId)) return '';
    return `${ONTARIO_511_IMAGE_ORIGIN}${encodeURIComponent(viewId)}`;
  } catch {
    return '';
  }
}

/** Select the best Ontario 511 still view for a camera. */
function pickOntarioCctvView(views) {
  const enabled = (Array.isArray(views) ? views : [])
    .filter(
      (view) =>
        String(view?.Status || view?.status || '').trim().toLowerCase() ===
        'enabled',
    )
    .map((view) => ({
      url: normalizeOntarioCctvUrl(view?.Url || view?.url),
      description: String(view?.Description || view?.description || '').trim(),
    }))
    .filter((view) => view.url);
  if (!enabled.length) return null;
  return enabled.find((view) => !/\bdown\b/i.test(view.description)) || enabled[0];
}

/** Bounding-box sanity check for Ontario 511 rows. */
function isLikelyOntarioCoordinate(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  return lat >= 41.0 && lat <= 57.5 && lon >= -95.6 && lon <= -74.0;
}

/**
 * Fetch Ontario 511 CCTV cameras. Keyless: the catalog is exposed by the
 * public 511 API, while frame URLs are stable still-image endpoints under
 * 511on.ca/map/Cctv/. Only rows with finite Ontario coords and at least one
 * enabled official still view are kept.
 */
export async function loadOntarioSourcesFromOpenData() {
  try {
    const resp = await fetch(ONTARIO_511_CAMERAS_URL, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(CCTV_SOURCE_FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) {
      console.warn('[CCTV] Ontario 511 camera download failed:', resp.status);
      return [];
    }
    const rows = await resp.json();
    if (!Array.isArray(rows)) return [];

    const cameras = [];
    for (const row of rows) {
      const rawId = String(row?.Id ?? row?.id ?? '').trim();
      if (!rawId) continue;
      const lat = toFiniteNumber(row?.Latitude ?? row?.latitude);
      const lon = toFiniteNumber(row?.Longitude ?? row?.longitude);
      if (!isLikelyOntarioCoordinate(lat, lon)) continue;

      const view = pickOntarioCctvView(row?.Views || row?.views);
      if (!view) continue;

      const cameraId = `on-${rawId}`;
      const location = String(row?.Location || row?.location || '').trim();
      const roadway = String(row?.Roadway || row?.roadway || '').trim();
      const viewLabel =
        view.description && !/\bdown\b/i.test(view.description)
          ? view.description
          : '';
      const label = [location || roadway || `Ontario 511 Camera ${rawId}`, viewLabel]
        .filter(Boolean)
        .join(' - ');
      let heading = directionToHeading(row?.Direction ?? row?.direction, true);
      if (!Number.isFinite(heading)) {
        heading = directionToHeading(view.description, true);
      }
      const hasHeading = Number.isFinite(heading);

      cameras.push({
        id: cameraId,
        name: label,
        city: location || roadway || 'Ontario',
        cityId: 'ontario',
        provider: 'Ontario 511',
        lat,
        lon,
        headingDeg: hasHeading ? heading : fallbackHeadingFromId(cameraId),
        headingConfidence: hasHeading ? 'high' : 'low',
        pitchDeg: hasHeading ? -24 : -18,
        fovDeg: hasHeading ? 56 : 44,
        rangeM: hasHeading ? 210 : 145,
        mountHeightM: hasHeading ? 10 : 8,
        groundElevationM: 200,
        feedType: 'image',
        url: view.url,
        snapshotUrl: view.url,
        sourceKind: 'ontario-511-open-data',
        license: 'Open Government Licence - Ontario',
      });
    }

    const unique = Array.from(
      new Map(cameras.map((camera) => [camera.id, camera])).values(),
    );
    const maxCount = Math.max(8, Math.min(1000, DEFAULT_ONTARIO_MAX_SOURCES));
    const prioritized = prioritizeSources(unique, maxCount, ONTARIO_ANCHORS);
    console.log(
      `[CCTV] Loaded Ontario 511 camera sources: ${unique.length} enabled (using nearest ${prioritized.length})`,
    );
    return prioritized;
  } catch (error) {
    console.warn('[CCTV] Ontario 511 camera download error:', error?.message || error);
    return [];
  }
}

/**
 * Fetch Fintraffic road weather cameras (all of Finland) from Digitraffic.
 * Keyless; one GeoJSON station list per refresh, identifying itself with the
 * `Digitraffic-User` header the service asks for. One PRESET is one camera;
 * frame URLs are BUILT from the official image origin and a strictly-validated
 * preset id rather than read from the payload (pins the frame proxy by
 * construction); the catalog fetch refuses redirects (`redirect: 'manual'`).
 * Attribution: "Fintraffic / digitraffic.fi" (CC BY 4.0).
 */
export async function loadFintrafficSourcesFromOpenData() {
  try {
    const resp = await fetch(FINTRAFFIC_STATIONS_URL, {
      headers: {
        Accept: 'application/json',
        'Accept-Encoding': 'gzip',
        'Digitraffic-User': DIGITRAFFIC_USER,
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(CCTV_SOURCE_FETCH_TIMEOUT_MS),
    });
    if (resp.status >= 300 && resp.status < 400) {
      console.warn(
        '[CCTV] Fintraffic station list redirected; redirects are not followed',
      );
      return [];
    }
    if (!resp.ok) {
      console.warn('[CCTV] Fintraffic station download failed:', resp.status);
      return [];
    }
    const payload = await resp.json();
    const features = Array.isArray(payload?.features) ? payload.features : [];
    if (!features.length) return [];

    const cameras = [];
    let stationsSeen = 0;
    for (const feature of features) {
      const props = feature?.properties || {};
      const stationId = String(props.id || '').trim();
      if (!stationId) continue;
      // GATHERING is the only status that means "this station is collecting
      // images right now".
      if (String(props.collectionStatus || '').toUpperCase() !== 'GATHERING')
        continue;

      const coords = feature?.geometry?.coordinates;
      const lon = toFiniteNumber(coords?.[0]);
      const lat = toFiniteNumber(coords?.[1]);
      if (!isLikelyFinlandCoordinate(lat, lon)) continue;
      // Third coordinate is metres, but 0 means "not reported" rather than
      // sea level, so only a positive value is a real reading.
      const reportedElevation = toFiniteNumber(coords?.[2], 0);
      const groundElevationM =
        reportedElevation > 0
          ? Math.min(1400, reportedElevation)
          : FINTRAFFIC_GROUND_ELEVATION_M;

      stationsSeen += 1;
      for (const preset of props.presets || []) {
        if (preset?.inCollection !== true) continue;
        const presetId = String(preset?.id || '').trim();
        // Strict id shape (station id + two-digit view). Also the guard that
        // keeps a hostile id out of the synthesized frame URL's path.
        if (!/^C\d{7}$/.test(presetId)) continue;
        if (!presetId.startsWith(stationId)) continue;

        const cameraId = `fi-${presetId.toLowerCase()}`;
        const imageUrl = `${FINTRAFFIC_IMAGE_ORIGIN}${presetId}.jpg`;
        cameras.push({
          id: cameraId,
          name: fintrafficCameraName(props.name, stationId, presetId),
          city: 'Finland',
          cityId: 'finland',
          provider: 'Fintraffic',
          lat,
          lon,
          // Headingless personality, identical to TfL's.
          headingDeg: fallbackHeadingFromId(cameraId),
          headingConfidence: 'low',
          pitchDeg: -18,
          fovDeg: 44,
          rangeM: 145,
          mountHeightM: 8,
          groundElevationM,
          feedType: 'image',
          url: imageUrl,
          snapshotUrl: imageUrl,
          sourceKind: 'fintraffic-open-data',
          license: 'Fintraffic / digitraffic.fi (CC BY 4.0)',
        });
      }
    }

    const maxCount = Math.max(8, Math.min(600, DEFAULT_FINTRAFFIC_MAX_SOURCES));
    const prioritized = prioritizeSources(cameras, maxCount, FINLAND_ANCHORS);
    console.log(
      `[CCTV] Loaded Fintraffic camera sources: ${cameras.length} live presets across ${stationsSeen} stations (using nearest ${prioritized.length})`,
    );
    return prioritized;
  } catch (error) {
    console.warn('[CCTV] Fintraffic station download error:', error?.message || error);
    return [];
  }
}

/**
 * The DriveBC `credit` field mixes third-party image attribution ("Images
 * courtesy of TransLink") with operational notes ("relies on solar power").
 * Only the attribution kind is carried onto the camera, HTML stripped; the
 * rest is dropped.
 */
export function driveBcImageCredit(raw) {
  const text = String(raw || '')
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  return /courtesy|provided by|presented in cooperation|city of|parks canada/i.test(text)
    ? text
    : '';
}

/** DriveBC orientation codes (the eight compass points) as headings in degrees. */
const DRIVEBC_ORIENTATION_HEADINGS = Object.freeze({
  N: 0, NE: 45, E: 90, SE: 135, S: 180, SW: 225, W: 270, NW: 315,
});

/**
 * Fetch DriveBC highway cameras (British Columbia). Keyless: one list endpoint.
 * Only cameras that are switched on and published (`is_on` and
 * `should_appear`) with a positive integer id and finite coordinates are kept.
 * Frame URLs are built from that id on the official image host and are never
 * read from the payload. Orientation codes give a high-confidence heading;
 * `elevation` is metres above sea level. Attribution: Open Government Licence –
 * British Columbia.
 */
export async function loadDriveBcSourcesFromOpenData() {
  try {
    const resp = await fetch(DRIVEBC_WEBCAMS_URL, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(CCTV_SOURCE_FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) {
      console.warn('[CCTV] DriveBC camera download failed:', resp.status);
      return [];
    }
    const rows = await resp.json();
    if (!Array.isArray(rows)) return [];

    const cameras = [];
    for (const row of rows) {
      if (row?.is_on !== true || row?.should_appear !== true) continue;
      if (!Number.isSafeInteger(row.id) || row.id <= 0) continue;
      // GeoJSON point order: [longitude, latitude].
      const [lon, lat] = Array.isArray(row.location?.coordinates)
        ? row.location.coordinates
        : [];
      if (!isLikelyBcCoordinate(lat, lon)) continue;

      const cameraId = `drivebc-${row.id}`;
      const heading =
        DRIVEBC_ORIENTATION_HEADINGS[String(row.orientation || '').trim().toUpperCase()];
      const hasHeading = Number.isFinite(heading);
      const region = String(row.region_name || '').trim();
      const imageUrl = DRIVEBC_IMAGE_URL(row.id);
      const credit = driveBcImageCredit(row.credit);
      cameras.push({
        id: cameraId,
        name: String(row.name || '').trim() || `DriveBC camera ${row.id}`,
        // DriveBC regions: Lower Mainland, Vancouver Island, Southern Interior,
        // Northern, and "Border Cams" for the US crossings.
        city: region === 'Border Cams' ? 'BC Border' : region || 'British Columbia',
        cityId: 'british-columbia',
        provider: 'DriveBC',
        lat,
        lon,
        headingDeg: hasHeading ? heading : fallbackHeadingFromId(cameraId),
        headingConfidence: hasHeading ? 'high' : 'low',
        pitchDeg: hasHeading ? -24 : -18,
        fovDeg: hasHeading ? 56 : 44,
        rangeM: hasHeading ? 210 : 145,
        mountHeightM: hasHeading ? 10 : 8,
        // Clamped like Caltrans so a garbage value can't fling a camera
        // kilometres up; sea level is the prior for the coastal default anchors.
        groundElevationM: Number.isFinite(row.elevation)
          ? Math.max(-100, Math.min(4000, row.elevation))
          : 0,
        feedType: 'image',
        url: imageUrl,
        snapshotUrl: imageUrl,
        sourceKind: 'drivebc-open-data',
        license: 'DriveBC, Open Government Licence – British Columbia',
        credit,
      });
    }

    const maxCount = Math.max(8, Math.min(1200, DEFAULT_DRIVEBC_MAX_SOURCES));
    const prioritized = prioritizeSources(cameras, maxCount, DRIVEBC_ANCHORS);
    console.log(
      `[CCTV] Loaded DriveBC camera sources: ${cameras.length} published (using nearest ${prioritized.length})`,
    );
    return prioritized;
  } catch (error) {
    console.warn('[CCTV] DriveBC camera download error:', error?.message || error);
    return [];
  }
}

/**
 * Normalize one TxDOT district catalog into camera source objects. Split out
 * from the fetch so the shape handling is unit-testable without a network.
 *
 * The payload nests cameras under `roadwayCctvStatuses`, keyed by roadway.
 * Only `Device Online` rows register: an offline TxDOT device keeps serving a
 * stale frame that can be years old and would otherwise look live.
 */
export function normalizeTxdotDistrictPayload(payload, district) {
  const byRoadway = payload?.roadwayCctvStatuses;
  if (!byRoadway || typeof byRoadway !== 'object') return [];
  const code = String(district || '').toUpperCase();
  const groundElevationM =
    TXDOT_DISTRICT_ELEVATION_M[code] ?? TXDOT_DEFAULT_ELEVATION_M;
  const cameras = [];
  const seen = new Set();

  for (const rows of Object.values(byRoadway)) {
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      if (String(row?.statusDescription || '') !== 'Device Online') continue;
      if (row?.hasSnapshot === false) continue;
      // Coordinates must be present as numbers: Number(null) and Number('')
      // are both 0, which would silently park a camera on null island.
      const lat = typeof row?.latitude === 'number' ? row.latitude : NaN;
      const lon = typeof row?.longitude === 'number' ? row.longitude : NaN;
      if (!isLikelyTexasCoordinate(lat, lon)) continue;

      // icd_Id is the device key the snapshot endpoint takes and is unique
      // within a district. An interchange camera appears under both of its
      // roadways, so dedupe on it.
      const icdId = String(row?.icd_Id || '').trim();
      if (!icdId || seen.has(icdId)) continue;
      seen.add(icdId);

      const name = String(row?.name || icdId).trim();
      // Heading comes from an explicit travel token in the NAME ("US-290 EB"),
      // parsed in strict mode: bare cardinals are refused because Texas route
      // names are full of them ("N Lamar", "West Ave").
      const heading = directionToHeading(name, false);
      const hasHeading = Number.isFinite(heading);
      // The device key itself, base64url-encoded, so every distinct key gets
      // a distinct id (a hash or a slug can collide) and the key is
      // recoverable from the id.
      const cameraId = `txdot-${code.toLowerCase()}-${base64UrlEncode(icdId)}`;
      const snapshot = new URL(TXDOT_CCTV_SNAPSHOT_URL);
      snapshot.searchParams.set('icdId', icdId);
      snapshot.searchParams.set('districtCode', code);

      cameras.push({
        id: cameraId,
        name,
        city: String(row?.equipLoc?.roadway || code),
        cityId: `tx-${code.toLowerCase()}`,
        provider: 'TxDOT',
        lat,
        lon,
        headingDeg: hasHeading ? heading : fallbackHeadingFromId(cameraId),
        headingConfidence: hasHeading ? 'high' : 'low',
        pitchDeg: hasHeading ? -24 : -18,
        fovDeg: hasHeading ? 56 : 44,
        rangeM: hasHeading ? 210 : 145,
        // TxDOT mounts run tall on highway poles and mast arms.
        mountHeightM: hasHeading ? 12 : 10,
        groundElevationM,
        feedType: 'image',
        // JSON carrying a base64 JPEG; decoded for this origin only.
        url: snapshot.toString(),
        snapshotUrl: snapshot.toString(),
        sourceKind: 'txdot-its',
        license: 'Public TxDOT traffic camera data',
        code: cameraDisplayCode(icdId.toUpperCase()),
      });
    }
  }
  return cameras;
}

/**
 * Fetch TxDOT ITS highway cameras (Texas), keyless. One official JSON catalog
 * per default district, identical schema statewide; districts fetch in
 * parallel and fail independently.
 */
export async function loadTxdotSourcesFromOpenData() {
  const districts = [
    ...new Set(
      String(DEFAULT_TXDOT_DISTRICTS)
        .split(',')
        .map((token) => token.trim().toUpperCase())
        .filter((code) => TXDOT_DISTRICTS.has(code)),
    ),
  ];
  if (!districts.length) return [];

  const settled = await Promise.allSettled(
    districts.map(async (district) => {
      const resp = await fetch(TXDOT_CCTV_STATUS_URL(district), {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'gods-eye-view-cctv-proxy/1.0',
        },
        signal: AbortSignal.timeout(CCTV_SOURCE_FETCH_TIMEOUT_MS),
      });
      if (!resp.ok) throw new Error(`${district} HTTP ${resp.status}`);
      return { district, payload: await resp.json() };
    }),
  );

  const cameras = [];
  for (const result of settled) {
    if (result.status !== 'fulfilled') {
      console.warn(
        '[CCTV] TxDOT district fetch failed:',
        result.reason?.message || result.reason,
      );
      continue;
    }
    cameras.push(
      ...normalizeTxdotDistrictPayload(result.value.payload, result.value.district),
    );
  }

  const maxCount = Math.max(8, Math.min(2000, DEFAULT_TXDOT_MAX_SOURCES));
  const prioritized = prioritizeSources(cameras, maxCount, TXDOT_ANCHORS);
  console.log(
    `[CCTV] Loaded TxDOT camera sources: ${cameras.length} online across ${districts.join(',')} (using nearest ${prioritized.length})`,
  );
  return prioritized;
}

/**
 * Extract DATEX2 predefined-location id → {name, lat, lon} from Tarktee XML.
 */
export function parseTarkteeDatexLocations(xml) {
  const out = new Map();
  const blockRe =
    /<predefinedLocation\s+id="([^"]+)"[^>]*>([\s\S]*?)<\/predefinedLocation>/g;
  let match;
  while ((match = blockRe.exec(String(xml || ''))) !== null) {
    const id = match[1];
    const body = match[2];
    // Skip the group container (no coordinates of its own).
    const latMatch = /<latitude>\s*(-?\d+(?:\.\d+)?)\s*<\/latitude>/i.exec(body);
    const lonMatch = /<longitude>\s*(-?\d+(?:\.\d+)?)\s*<\/longitude>/i.exec(body);
    if (!latMatch || !lonMatch) continue;
    const lat = toFiniteNumber(latMatch[1]);
    const lon = toFiniteNumber(lonMatch[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const nameMatch = /<value\b[^>]*>\s*([^<]+?)\s*<\/value>/i.exec(body);
    const name = nameMatch ? nameMatch[1].trim() : id;
    out.set(id, { name, lat, lon });
  }
  return out;
}

/**
 * Extract DATEX2 traffic-view location id → HTTPS image URL from Tarktee XML.
 */
export function parseTarkteeDatexImages(xml) {
  const out = new Map();
  const blockRe = /<trafficView\b[^>]*>([\s\S]*?)<\/trafficView>/g;
  let match;
  while ((match = blockRe.exec(String(xml || ''))) !== null) {
    const body = match[1];
    const refMatch =
      /<linearPredefinedLocationReference\b[^>]*\bid="([^"]+)"/i.exec(body);
    const urlMatch = /<urlLinkAddress>\s*([^<\s]+)\s*<\/urlLinkAddress>/i.exec(body);
    if (!refMatch || !urlMatch) continue;
    const url = urlMatch[1].trim();
    if (!url.startsWith(TARKTEE_IMAGE_ORIGIN)) continue;
    out.set(refMatch[1], url);
  }
  return out;
}

/**
 * Fetch Estonian Transpordiamet / Tarktee road-weather cameras via DATEX2.
 * Locations and current still URLs are keyless public feeds. Only
 * https://tarktee.transpordiamet.ee/images/… URLs are registered.
 */
export async function loadTarkteeSourcesFromDatex() {
  try {
    const [locResp, imgResp] = await Promise.all([
      fetch(TARKTEE_LOCATIONS_URL, {
        headers: { Accept: 'application/xml,text/xml,*/*' },
        signal: AbortSignal.timeout(CCTV_SOURCE_FETCH_TIMEOUT_MS),
      }),
      fetch(TARKTEE_IMAGES_URL, {
        headers: { Accept: 'application/xml,text/xml,*/*' },
        signal: AbortSignal.timeout(CCTV_SOURCE_FETCH_TIMEOUT_MS),
      }),
    ]);
    if (!locResp.ok) {
      console.warn('[CCTV] Tarktee locations download failed:', locResp.status);
      return [];
    }
    if (!imgResp.ok) {
      console.warn('[CCTV] Tarktee images download failed:', imgResp.status);
      return [];
    }
    const [locXml, imgXml] = await Promise.all([locResp.text(), imgResp.text()]);
    const locations = parseTarkteeDatexLocations(locXml);
    const images = parseTarkteeDatexImages(imgXml);
    if (!locations.size || !images.size) {
      console.warn('[CCTV] Tarktee DATEX parse empty:', {
        locations: locations.size,
        images: images.size,
      });
      return [];
    }

    const cameras = [];
    for (const [locationId, loc] of locations.entries()) {
      const imageUrl = images.get(locationId);
      if (!imageUrl) continue;
      // Estonia bounding box (mainland + nearby islands).
      if (loc.lat < 57.4 || loc.lat > 59.9 || loc.lon < 21.5 || loc.lon > 28.4)
        continue;

      const numMatch = /\/images\/(\d+)\//.exec(imageUrl);
      const cameraId = numMatch
        ? `ee-tarktee-${numMatch[1]}`
        : `ee-tarktee-${locationId}`;
      cameras.push({
        id: cameraId,
        name: loc.name,
        city: loc.name,
        cityId: 'estonia',
        provider: 'Transpordiamet (Tarktee)',
        lat: loc.lat,
        lon: loc.lon,
        headingDeg: fallbackHeadingFromId(cameraId),
        headingConfidence: 'low',
        pitchDeg: -18,
        fovDeg: 44,
        rangeM: 145,
        mountHeightM: 8,
        groundElevationM: 40,
        feedType: 'image',
        url: imageUrl,
        snapshotUrl: imageUrl,
        sourceKind: 'tarktee-datex',
        license: 'Public Transpordiamet / Tarktee road weather camera data',
      });
    }

    const maxCount = Math.max(8, Math.min(300, DEFAULT_TARKTEE_MAX_SOURCES));
    const prioritized = prioritizeSources(cameras, maxCount, TARKTEE_ANCHORS);
    console.log(
      `[CCTV] Loaded Tarktee camera sources: ${cameras.length} with images (using nearest ${prioritized.length})`,
    );
    return prioritized;
  } catch (error) {
    console.warn('[CCTV] Tarktee DATEX download error:', error?.message || error);
    return [];
  }
}

/**
 * Label for one NSW camera: its `view` sentence when that is really a view
 * ("5 Ways at The Boulevarde looking west towards Sutherland"), else the
 * title ("5 Ways (Miranda)"). A works notice longer than NSW_MAX_VIEW_LABEL or
 * containing a line break is not a label.
 */
export function nswCameraLabel(props) {
  const view = String(props?.view || '').trim();
  const title = String(props?.title || '').trim();
  const viewIsALabel =
    view.length > 0 && view.length <= NSW_MAX_VIEW_LABEL && !/[\r\n]/.test(view);
  return viewIsALabel ? view : title;
}

/**
 * One Live Traffic NSW camera feature -> one catalog source, or null. Every
 * camera carries a compass `direction` ("N-E") and a `view` sentence.
 */
export function nswCameraToSource(feature) {
  const rawId = String(feature?.id || '').trim();
  if (!rawId) return null;
  const coords = feature?.geometry?.coordinates;
  // Numbers only: Number(null) and Number('') are 0, which would park a
  // camera on the equator.
  const lon = typeof coords?.[0] === 'number' ? coords[0] : NaN;
  const lat = typeof coords?.[1] === 'number' ? coords[1] : NaN;
  if (!isLikelyNswCoordinate(lat, lon)) return null;
  const props = feature?.properties || {};
  const url = String(props.href || '').trim();
  if (!url.startsWith(NSW_IMAGE_ORIGIN)) return null;
  // "N-E" -> "NE" for the compass lookup.
  const direction = String(props.direction || '').trim().toUpperCase().replace(/-/g, '');
  const heading = directionToHeading(direction, true);
  const hasHeading = Number.isFinite(heading);
  const cameraId = `nsw-${rawId}`;
  return {
    id: cameraId,
    name: nswCameraLabel(props) || `NSW ${rawId}`,
    city: String(props.region || 'New South Wales').replace(/_/g, ' '),
    cityId: 'nsw',
    provider: 'Live Traffic NSW',
    lat,
    lon,
    headingDeg: hasHeading ? heading : fallbackHeadingFromId(cameraId),
    headingConfidence: hasHeading ? 'high' : 'low',
    pitchDeg: hasHeading ? -24 : -18,
    fovDeg: hasHeading ? 56 : 44,
    rangeM: hasHeading ? 210 : 145,
    mountHeightM: hasHeading ? 10 : 8,
    groundElevationM: 25, // Sydney basin prior; the client's ground snap corrects.
    feedType: 'image',
    url,
    snapshotUrl: url,
    sourceKind: 'nsw-livetraffic',
    license: 'Live Traffic NSW — Transport for NSW, CC BY 4.0',
    code: cameraDisplayCode(String(props.title || '').toUpperCase() || rawId),
  };
}

/**
 * Fetch Live Traffic NSW cameras (New South Wales), keyless: the public
 * traffic-cam GeoJSON feed. Frames are stills on webcams.transport.nsw.gov.au.
 */
export async function loadNswSourcesFromOpenData() {
  try {
    const resp = await fetch(NSW_CAMERAS_URL, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'gods-eye-view-cctv-proxy/1.0',
      },
      signal: AbortSignal.timeout(CCTV_SOURCE_FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) {
      console.warn('[CCTV] NSW camera download failed:', resp.status);
      return [];
    }
    const body = await resp.json();
    const features = Array.isArray(body?.features) ? body.features : [];
    const cameras = features.map(nswCameraToSource).filter(Boolean);
    const maxCount = Math.max(8, Math.min(900, DEFAULT_NSW_MAX_SOURCES));
    const prioritized = prioritizeSources(cameras, maxCount, [SYDNEY_CENTER]);
    console.log(
      `[CCTV] Loaded NSW camera sources: ${cameras.length} (using nearest ${prioritized.length})`,
    );
    return prioritized;
  } catch (error) {
    console.warn('[CCTV] NSW camera download error:', error?.message || error);
    return [];
  }
}

/**
 * Read a fetch Response body as text with a hard byte cap. Rejects early on
 * an oversized Content-Length, then streams with a running cap. Returns the
 * text, or null when the cap is exceeded (canceling the stream).
 */
async function readCappedResponseText(response, maxBytes) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    try {
      await response.body?.cancel();
    } catch {
      /* no-op */
    }
    return null;
  }
  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    return new TextEncoder().encode(text).byteLength > maxBytes ? null : text;
  }
  const decoder = new TextDecoder();
  let out = '';
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          /* no-op */
        }
        return null;
      }
      out += decoder.decode(value, { stream: true });
    }
    return out + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

/** Parse a fetch() JSON response only after enforcing a hard byte cap. */
async function readCappedResponseJson(response, maxBytes) {
  const text = await readCappedResponseText(response, maxBytes);
  return text === null ? null : JSON.parse(text);
}

/**
 * Upgrade a catalog frame URL to HTTPS and pin it to the City of Calgary host.
 *
 * Most rows ship `http://`; the host answers HTTPS and 301-redirects there, so
 * upgrading avoids a redirect on every frame fetch. Anything not on the
 * official origin is refused rather than proxied.
 */
export function normalizeCalgaryImageUrl(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  parsed.protocol = 'https:';
  const upgraded = parsed.toString();
  return upgraded.startsWith(CALGARY_IMAGE_ORIGIN) ? upgraded : null;
}

/**
 * Stable camera id from a frame URL. The dataset carries no id column; the
 * frame filename ("loc86.jpg") is the only stable per-camera token. Falls back
 * to a slug of the whole path so a filename-scheme change degrades to a
 * still-stable id rather than dropping the camera.
 */
export function calgaryCameraId(imageUrl) {
  const text = String(imageUrl ?? '').trim();
  if (!text) return null;
  let path;
  try {
    path = new URL(text).pathname;
  } catch {
    return null;
  }
  const numbered = path.match(/loc(\d+)\.jpg$/i);
  if (numbered) return `calgary-${numbered[1]}`;
  const slug = path
    .replace(/^\/+|\.[a-z0-9]+$/gi, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .toLowerCase();
  return slug ? `calgary-${slug}` : null;
}

/**
 * Label for one Calgary camera: the intersection an operator recognises
 * ("Bow Trail / 37 Street SW"), used verbatim including its quadrant suffix,
 * which is part of the street address. It must never be read as a facing.
 */
export function calgaryCameraName(record, cameraId) {
  const location = String(record?.camera_location ?? '').trim();
  if (location) return location;
  const described = String(record?.camera_url?.description ?? '').trim();
  if (described) return described;
  return `Calgary Camera ${String(cameraId).replace(/^calgary-/, '')}`;
}

/**
 * One Open Calgary row -> one catalog source, or null.
 *
 * NO HEADING IS DERIVED FROM THE RECORD: the `quadrant` ("NE"/"NW/SE"/"NW/NE")
 * and the location's quadrant suffix are Calgary's address grid, not a camera
 * bearing. Headings use the shared id-hash fallback at low confidence, exactly
 * as headingless TfL and Fintraffic cameras do.
 */
export function calgaryCameraToSource(record) {
  if (!record || typeof record !== 'object') return null;
  const coordinates = record?.point?.coordinates;
  if (!Array.isArray(coordinates) || coordinates.length < 2) return null;
  const lon = toFiniteNumber(coordinates[0]);
  const lat = toFiniteNumber(coordinates[1]);
  if (!isLikelyCalgaryCoordinate(lat, lon)) return null;

  const imageUrl = normalizeCalgaryImageUrl(record?.camera_url?.url);
  if (!imageUrl) return null;
  const cameraId = calgaryCameraId(imageUrl);
  if (!cameraId) return null;
  const name = calgaryCameraName(record, cameraId);

  return {
    id: cameraId,
    name,
    city: 'Calgary',
    cityId: 'calgary',
    provider: 'The City of Calgary',
    lat,
    lon,
    headingDeg: fallbackHeadingFromId(cameraId),
    headingConfidence: 'low',
    pitchDeg: -18,
    fovDeg: 44,
    rangeM: 145,
    mountHeightM: 8,
    // Calgary sits high on the prairie; the client's one-shot ground snap
    // corrects this prior wherever 3D tiles are loaded.
    groundElevationM: 1045,
    feedType: 'image',
    url: imageUrl,
    snapshotUrl: imageUrl,
    sourceKind: 'calgary-open-data',
    license:
      'Contains information licensed under the Open Government Licence – City of Calgary',
    code: cameraDisplayCode(name.toUpperCase()),
  };
}

/**
 * Fetch City of Calgary traffic cameras from Open Calgary (Socrata dataset
 * `k7p9-kppz`), keyless. Frames are stills on trafficcam.calgary.ca.
 */
export async function loadCalgarySourcesFromOpenData() {
  try {
    const resp = await fetch(DEFAULT_CALGARY_ROWS_URL, {
      headers: { Accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(CCTV_SOURCE_FETCH_TIMEOUT_MS),
    });
    // A response this loader will not read still owns its transport until the
    // body is released, so every rejection path cancels before returning.
    const discard = async () => {
      try {
        await resp.body?.cancel();
      } catch {
        /* no-op */
      }
      return [];
    };
    if (resp.status >= 300 && resp.status < 400) {
      console.warn('[CCTV] Calgary catalog redirected; redirects are not followed');
      return discard();
    }
    if (!resp.ok) {
      console.warn('[CCTV] Calgary camera download failed:', resp.status);
      return discard();
    }
    const rows = await readCappedResponseJson(resp, CALGARY_MAX_CATALOG_BYTES);
    if (!Array.isArray(rows)) return [];
    const cameras = [];
    const seen = new Set();
    for (const record of rows) {
      const camera = calgaryCameraToSource(record);
      if (!camera || seen.has(camera.id)) continue;
      seen.add(camera.id);
      cameras.push(camera);
    }
    const maxCount = Math.max(8, Math.min(400, DEFAULT_CALGARY_MAX_SOURCES));
    const prioritized = prioritizeSources(cameras, maxCount, [CALGARY_DOWNTOWN]);
    console.log(
      `[CCTV] Loaded Calgary camera sources: ${cameras.length} (using nearest ${prioritized.length})`,
    );
    return prioritized;
  } catch (error) {
    console.warn('[CCTV] Calgary camera download error:', error?.message || error);
    return [];
  }
}

/* ------------------------------------------------------------------ */
/* Catalog: merge, dedupe, cap, cache (from catalog.js)                 */
/* File/env packs dropped (fs + process.env unavailable on the edge);   */
/* every live pack is enabled. Ground-height sidecar dropped (fs).      */
/* ------------------------------------------------------------------ */

/** Live open-data packs, in merge order. Each pack fails independently (allSettled). */
const LIVE_PACKS = [
  { name: 'austin', load: loadAustinSourcesFromOpenData },
  { name: 'caltrans', load: loadCaltransSourcesFromOpenData },
  { name: 'tfl', load: loadTflSourcesFromOpenData },
  { name: 'ontario', load: loadOntarioSourcesFromOpenData },
  { name: 'fintraffic', load: loadFintrafficSourcesFromOpenData },
  { name: 'drivebc', load: loadDriveBcSourcesFromOpenData },
  { name: 'txdot', load: loadTxdotSourcesFromOpenData },
  { name: 'tarktee', load: loadTarkteeSourcesFromDatex },
  { name: 'nsw', load: loadNswSourcesFromOpenData },
  { name: 'calgary', load: loadCalgarySourcesFromOpenData },
];

/** Cached merged + normalized CCTV source list. */
let _cctvSourceCache = [];
/** Epoch-ms when the source cache was last refreshed. */
let _cctvSourceCacheAt = 0;
/** In-flight refresh, shared by concurrent callers so a post-TTL burst
 * launches ONE refetch, not one per request. */
let _cctvSourceInflight = null;

/**
 * Assemble and cache the merged CCTV source list.
 *
 * Merges every live pack, deduplicates by ID, shares the catalog cap fairly
 * across packs round-robin, and caches for CCTV_SOURCE_CACHE_MS. Always
 * resolves (loaders self-catch to []); on a fully-empty refresh with a good
 * prior catalog it serves stale rather than blanking the CCTV layer.
 */
export async function getCctvSources() {
  const now = Date.now();
  if (_cctvSourceCache.length && now - _cctvSourceCacheAt <= CCTV_SOURCE_CACHE_MS) {
    return _cctvSourceCache;
  }
  if (_cctvSourceInflight) return _cctvSourceInflight;
  _cctvSourceInflight = refreshCctvSources().finally(() => {
    _cctvSourceInflight = null;
  });
  return _cctvSourceInflight;
}

async function refreshCctvSources() {
  const liveResults = await Promise.allSettled(
    LIVE_PACKS.map((pack) =>
      // Invoked inside the promise so a loader that throws synchronously is
      // isolated like any other failed pack instead of rejecting the refresh.
      Promise.resolve().then(() => pack.load()),
    ),
  );
  // Live packs first so file/env overrides win on duplicate IDs; each pack
  // keeps its own priority order and the catalog cap is shared fairly.
  const normalizePack = (name, items) => ({
    name,
    sources: items
      .filter((item) => item && typeof item === 'object')
      .map((item) => normalizeSourceItem(item))
      .filter((item) => item.id),
  });
  const packs = LIVE_PACKS.map((pack, index) =>
    normalizePack(
      pack.name,
      liveResults[index]?.status === 'fulfilled' ? liveResults[index].value : [],
    ),
  );
  const maxCount = DEFAULT_CCTV_MAX_SOURCES;
  const allocation = allocateSourceCap(packs, maxCount);
  const trimmed = allocation.packs.filter((pack) => pack.kept < pack.offered);
  if (trimmed.length) {
    const detail = trimmed
      .map((pack) => `${pack.name} ${pack.kept}/${pack.offered}`)
      .join(', ');
    console.warn(
      `[CCTV] source catalog exceeds cap ${maxCount}; shared round-robin across packs (${detail}).`,
    );
  }
  if (allocation.sources.length > 0 || _cctvSourceCache.length === 0) {
    _cctvSourceCache = allocation.sources;
  } else {
    // Every source came back empty (all live packs timed out / upstream
    // outage) but a good catalog is already cached — serve it stale rather
    // than blanking every CCTV route. The timestamp still advances, which
    // (with single-flight) bounds load on a persistently-down upstream.
    console.warn(
      `[CCTV] source refresh returned empty; serving ${_cctvSourceCache.length} stale cameras`,
    );
  }
  _cctvSourceCacheAt = Date.now();
  return _cctvSourceCache;
}

/* ------------------------------------------------------------------ */
/* Media helpers (from server/providers/cctv/media.js)                 */
/* Node stream plumbing dropped; binary work via Uint8Array/atob.      */
/* ------------------------------------------------------------------ */

/**
 * Generate a synthetic SVG billboard image for a CCTV camera placeholder.
 * 960x540, deterministic gradient (hue from camera ID hash), scanline
 * overlay, HUD-style grid, and text labels (name, city, ID, status,
 * timestamp). Used when no upstream image is available.
 */
export function buildSyntheticCctvSvg({ cameraId, label, city, status }) {
  const seed = hashSeed(`${cameraId}:${label}:${city}`);
  const hue = seed % 360;
  const hue2 = (hue + 46) % 360;
  const now = new Date();
  const ts = now.toISOString().replace('T', ' ').replace('Z', 'Z').slice(0, 20);
  const safeLabel = escapeXml(label);
  const safeCity = escapeXml(city || 'GLOBAL GRID');
  const safeId = escapeXml(cameraId);
  const safeStatus = escapeXml(status || 'SYNTHETIC');

  return `
<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="hsl(${hue}, 35%, 10%)" />
      <stop offset="60%" stop-color="hsl(${hue2}, 42%, 6%)" />
      <stop offset="100%" stop-color="#020509" />
    </linearGradient>
    <radialGradient id="flare" cx="0.22" cy="0.24" r="0.78">
      <stop offset="0%" stop-color="hsla(${hue2}, 100%, 65%, 0.35)" />
      <stop offset="100%" stop-color="hsla(${hue2}, 100%, 40%, 0)" />
    </radialGradient>
    <pattern id="scan" width="8" height="8" patternUnits="userSpaceOnUse">
      <rect width="8" height="8" fill="transparent" />
      <rect y="0" width="8" height="1" fill="rgba(255,255,255,0.08)" />
      <rect y="4" width="8" height="1" fill="rgba(255,255,255,0.05)" />
    </pattern>
  </defs>
  <rect width="960" height="540" fill="url(#bg)" />
  <rect width="960" height="540" fill="url(#flare)" />
  <rect width="960" height="540" fill="url(#scan)" />
  <g stroke="rgba(123,233,255,0.25)" stroke-width="1" fill="none">
    <path d="M60 460 Q300 300 520 420 T900 320" />
    <path d="M100 160 Q340 40 620 130 T920 90" />
    <path d="M20 280 Q220 230 390 270 T760 250" />
  </g>
  <g fill="none" stroke="rgba(180,248,255,0.2)" stroke-width="1">
    <rect x="70" y="80" width="820" height="380" rx="8" />
    <line x1="70" y1="270" x2="890" y2="270" />
    <line x1="480" y1="80" x2="480" y2="460" />
  </g>
  <g fill="#9cefff" font-family="JetBrains Mono, monospace" text-transform="uppercase">
    <text x="74" y="54" font-size="16" letter-spacing="2">CCTV FEED PLACEHOLDER</text>
    <text x="74" y="512" font-size="14" letter-spacing="1.5">${safeLabel} · ${safeCity}</text>
    <text x="646" y="512" font-size="13" letter-spacing="1.2">${safeId}</text>
    <text x="704" y="54" font-size="15" letter-spacing="2">${escapeXml(ts)}</text>
    <text x="74" y="486" font-size="13" letter-spacing="1.3">${safeStatus}</text>
  </g>
</svg>`.trim();
}

/**
 * Read a snapshot incrementally as Uint8Array chunks, retaining at most
 * maxBytes. Every retained chunk is an OWNED copy: a chunk can be a small
 * view over a much larger backing ArrayBuffer, and keeping the view would
 * retain that whole allocation while the byte accounting only counted the
 * view. Returns null when the body is too large or unreadable.
 */
async function readCappedResponseBytes(upstream, maxBytes) {
  const declared = Number(upstream.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    try {
      await upstream.body?.cancel();
    } catch {
      /* no-op */
    }
    return null;
  }
  if (!upstream.body) return null;
  const chunks = [];
  let total = 0;
  const keep = (chunk) => {
    const view =
      chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    total += view.byteLength;
    if (total > maxBytes) return false;
    chunks.push(view.slice());
    return true;
  };
  if (typeof upstream.body[Symbol.asyncIterator] === 'function') {
    for await (const chunk of upstream.body) {
      if (!keep(chunk)) {
        try {
          await upstream.body.cancel();
        } catch {
          /* no-op */
        }
        return null;
      }
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  }
  const reader =
    typeof upstream.body.getReader === 'function'
      ? upstream.body.getReader()
      : null;
  if (!reader) return null;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!keep(value)) {
        try {
          await reader.cancel();
        } catch {
          /* already closed */
        }
        return null;
      }
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  } finally {
    reader.releaseLock();
  }
}

/** Decode a canonical base64 string to Uint8Array (atob-based, no Buffer). */
function base64ToBytes(base64) {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Redirect hops the frame path will follow, and only within the same host. */
const MAX_SAME_HOST_REDIRECTS = 2;

/**
 * Fetch a registered frame URL following redirects ONLY within the original
 * origin (scheme, host and port; at most MAX_SAME_HOST_REDIRECTS hops).
 * Default redirect-following would let an upstream steer a host-pinned
 * request, and its host-specific headers, to any origin, another port, or a
 * plaintext downgrade.
 */
export async function fetchWithinHost(url, init, fetchImpl = fetch) {
  let current;
  try {
    current = new URL(url);
  } catch {
    return null;
  }
  const origin = current.origin;
  for (let hop = 0; hop <= MAX_SAME_HOST_REDIRECTS; hop++) {
    const upstream = await fetchImpl(current.toString(), {
      ...init,
      redirect: 'manual',
    });
    // Anything that is not a 3xx (including a test double with no status) is
    // the final answer.
    const status = Number(upstream?.status);
    if (!(status >= 300 && status < 400)) return upstream;
    const location = upstream.headers.get('location');
    try {
      await upstream.body?.cancel();
    } catch {
      /* no-op */
    }
    if (!location || hop === MAX_SAME_HOST_REDIRECTS) return null;
    let next;
    try {
      next = new URL(location, current);
    } catch {
      return null;
    }
    if (next.origin !== origin) return null;
    current = next;
  }
  return null;
}

/**
 * Image hosts that only serve frames to browser-identified clients, keyed by
 * exact hostname. Every other upstream sees the proxy's own identifying
 * User-Agent.
 */
const CCTV_IMAGE_USER_AGENT_BY_HOST = Object.freeze({
  [new URL(NSW_IMAGE_ORIGIN).hostname]: NSW_IMAGE_USER_AGENT,
});

/** User-Agent for one upstream frame request. */
export function cctvUpstreamUserAgent(url) {
  try {
    return (
      CCTV_IMAGE_USER_AGENT_BY_HOST[new URL(url).hostname] ||
      'gods-eye-view-cctv-proxy/1.0'
    );
  } catch {
    return 'gods-eye-view-cctv-proxy/1.0';
  }
}

/**
 * Fetch one upstream CCTV image within the frame-refresh budget.
 *
 * A timeout is treated like every other upstream miss so the caller can
 * continue through the fallback chain. `fetchImpl` and `timeoutMs` are
 * injectable only to keep the timeout contract unit-testable.
 */
export async function fetchCctvImageFromUpstream(
  url,
  {
    fetchImpl = fetch,
    timeoutMs = CCTV_FRAME_FETCH_TIMEOUT_MS,
    maxBytes = CCTV_FRAME_MAX_BODY_BYTES,
  } = {},
) {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort(
      new DOMException('CCTV upstream frame fetch timed out', 'TimeoutError'),
    );
  }, timeoutMs);
  try {
    const upstream = await fetchWithinHost(
      url,
      {
        headers: { 'User-Agent': cctvUpstreamUserAgent(url) },
        signal: controller.signal,
      },
      fetchImpl,
    );
    if (!upstream) return null;
    const contentType = upstream.headers.get('content-type') || '';
    if (!upstream.ok || !contentType.startsWith('image/')) {
      controller.abort();
      return null;
    }
    const body = await readCappedResponseBytes(upstream, maxBytes);
    if (!body) return null;
    return { ok: true, body, contentType };
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
    controller.abort();
  }
}

/**
 * Fetch and decode a TxDOT ITS / TransGuide snapshot.
 *
 * TxDOT returns JSON with a base64-encoded JPEG in `snippet`, rather than
 * returning image/jpeg directly.
 */
export async function fetchTxdotSnapshot(
  url,
  {
    fetchImpl = fetch,
    timeoutMs = CCTV_FRAME_FETCH_TIMEOUT_MS,
    maxBytes = CCTV_FRAME_MAX_BODY_BYTES,
  } = {},
) {
  if (!url) return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (
    parsed.origin !== 'https://its.txdot.gov' ||
    parsed.pathname !== '/its/DistrictIts/GetCctvSnapshotByIcdId'
  ) {
    return null;
  }
  // Base64 inflates by 4/3; the JSON envelope adds a few bytes of framing.
  const maxEnvelopeBytes = Math.ceil((maxBytes * 4) / 3) + 4096;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // The snapshot endpoint answers directly; a redirect is not followed, so
    // the origin/path pin above holds for the request that is actually made.
    const upstream = await fetchImpl(parsed.toString(), {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'gods-eye-view-cctv-proxy/1.0',
      },
      signal: controller.signal,
      redirect: 'manual',
    });
    if (!upstream.ok) return null;
    const envelope = await readCappedResponseBytes(upstream, maxEnvelopeBytes);
    if (!envelope) return null;
    let payload;
    try {
      payload = JSON.parse(new TextDecoder().decode(envelope));
    } catch {
      return null;
    }
    let snippet =
      typeof payload?.snippet === 'string' ? payload.snippet.trim() : '';
    if (!snippet) return null;
    snippet = snippet.replace(/^data:image\/jpeg;base64,/i, '');
    // Canonical base64 only (4-char groups, padding only at the end):
    // atob() silently skips junk, which would let a non-image body decode
    // into "something".
    if (
      snippet.length > maxEnvelopeBytes ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        snippet,
      )
    ) {
      return null;
    }
    const body = base64ToBytes(snippet);
    if (body.length < 4 || body.length > maxBytes) return null;
    if (body[0] !== 0xff || body[1] !== 0xd8 || body[2] !== 0xff) return null;
    return { ok: true, body, contentType: 'image/jpeg' };
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
    controller.abort();
  }
}

/* ------------------------------------------------------------------ */
/* Health tracking (in-memory map with eviction cap)                    */
/* ------------------------------------------------------------------ */

/** @type {Map<string,{id:string,status:string,sourceKind:string,label:string,message:string,updatedAt:number}>} */
const health = new Map();
/** Cap on health map entries to prevent unbounded growth. Sized to the
 * CCTV_MAX_SOURCES ceiling so health/status observability is never evicted
 * for any catalog the proxy can actually serve. */
const HEALTH_MAX_ENTRIES = CCTV_MAX_SOURCES_CEILING;

/** Update the health entry for a camera, evicting the oldest entry if at capacity. */
export function setHealth(cameraId, patch) {
  // Evict oldest entries if the health map grows beyond the cap
  if (!health.has(cameraId) && health.size >= HEALTH_MAX_ENTRIES) {
    const oldest = health.keys().next().value;
    health.delete(oldest);
  }
  const prev = health.get(cameraId) || {};
  health.set(cameraId, {
    id: cameraId,
    status: patch.status || prev.status || 'unknown',
    sourceKind: patch.sourceKind || prev.sourceKind || 'unknown',
    label: patch.label || prev.label || '',
    message: patch.message || prev.message || '',
    updatedAt: Date.now(),
  });
}

/** Snapshot all camera health entries as an array. */
export function listHealth() {
  return Array.from(health.values());
}

/* ------------------------------------------------------------------ */
/* Route resolution + response helpers                                  */
/* ------------------------------------------------------------------ */

/**
 * Resolve an /api/cctv request path to a route descriptor. The `_worker.js`
 * mounts this handler at `/api/cctv`; the prefix is stripped before matching.
 *
 * @param {string} pathname - Full request pathname (e.g. '/api/cctv/frame/abc').
 * @returns {{route:'sources'|'health'|'stream'|'media'|'frame', id:string}|{route:'notfound'}}
 */
export function resolveCctvRoute(pathname) {
  let sub = String(pathname || '');
  if (sub === '/api/cctv') sub = '/';
  else if (sub.startsWith('/api/cctv/')) sub = sub.slice('/api/cctv'.length);
  else return { route: 'notfound' };

  if (sub === '/sources') return { route: 'sources' };
  if (sub === '/health') return { route: 'health' };
  if (sub.startsWith('/stream/')) {
    const id = decodeURIComponent(sub.replace('/stream/', '').trim()) || 'camera';
    return { route: 'stream', id };
  }
  if (sub.startsWith('/media/')) {
    const id = decodeURIComponent(sub.replace('/media/', '').trim()) || 'camera';
    return { route: 'media', id };
  }
  if (sub.startsWith('/frame/')) {
    const id = decodeURIComponent(sub.replace('/frame/', '').trim()) || 'camera';
    return { route: 'frame', id };
  }
  return { route: 'notfound' };
}

/**
 * Pure fallback-chain decision for the frame route. Given whether the
 * upstream image fetch succeeded, picks the response kind. The dev proxy's
 * Street View middle leg is intentionally absent here (it needs a server-side
 * API key, which cannot ship to the edge).
 *
 * @param {{upstreamOk:boolean, hasConfiguredUrl:boolean}} state
 * @returns {'upstream'|'synthetic'}
 */
export function selectFrameFallback({ upstreamOk, hasConfiguredUrl }) {
  if (upstreamOk) return 'upstream';
  void hasConfiguredUrl; // status text only; the fallback is always synthetic
  return 'synthetic';
}

function jsonResponse(payload, status = 200, cacheControl = 'no-store') {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': cacheControl,
    },
  });
}

/** Build a JSON payload describing stream info (feedType, URLs) for a camera. */
function buildStreamPayload(source, cameraId) {
  const feedType = normalizeFeedType(source?.feedType || 'image');
  return {
    id: cameraId,
    feedType,
    mediaUrl: isVideoFeedType(feedType)
      ? `/api/cctv/media/${encodeURIComponent(cameraId)}`
      : null,
    frameUrl: `/api/cctv/frame/${encodeURIComponent(cameraId)}`,
    provider: source?.provider || '',
    sourceKind: source?.sourceKind || (source?.url ? 'configured' : 'fallback'),
  };
}

/** Project a normalized source to the exact /sources list shape the client expects. */
function projectSource(source) {
  return {
    id: source.id,
    name: source.name,
    city: source.city,
    cityId: source.cityId,
    provider: source.provider,
    lat: source.lat,
    lon: source.lon,
    headingDeg: source.headingDeg,
    headingConfidence: source.headingConfidence || '',
    pitchDeg: source.pitchDeg,
    fovDeg: source.fovDeg,
    rangeM: source.rangeM,
    mountHeightM: source.mountHeightM,
    groundElevationM: source.groundElevationM,
    feedType: normalizeFeedType(source.feedType),
    sourceKind: source.sourceKind || (source.url ? 'configured' : 'fallback'),
    poseSource: source.poseSource,
    license: source.license,
    credit: source.credit || '',
    code: source.code || '',
    // No shipped ground-height sidecar on the edge (fs unavailable).
    groundHeights: null,
  };
}

/* ------------------------------------------------------------------ */
/* Endpoint handlers                                                    */
/* ------------------------------------------------------------------ */

async function handleSources(request, ctx) {
  const sources = await getCctvSources();
  const payload = { sources: sources.map(projectSource) };
  const body = JSON.stringify(payload);
  const response = new Response(body, {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': `public, max-age=${SOURCES_EDGE_TTL_SECONDS}`,
    },
  });
  // The catalog changes rarely: share it at the edge. Frames/media/health
  // stay fresh (never edge-cached).
  try {
    const cache = caches.default;
    const cacheKey = new Request(
      `${new URL(request.url).origin}/api/cctv/sources`,
      { method: 'GET' },
    );
    const put = cache.put(cacheKey, response.clone()).catch(() => {});
    if (ctx?.waitUntil) ctx.waitUntil(put);
    else await put;
  } catch {
    /* Cache API unavailable — serve the live payload anyway. */
  }
  return response;
}

async function handleFrame(request, cameraId) {
  const sources = await getCctvSources();
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const source = sourceById.get(cameraId);
  const url = new URL(request.url);

  const label = url.searchParams.get('label') || source?.name || cameraId;
  const city = url.searchParams.get('city') || source?.city || '';

  // Only use server-registered upstream URLs — never accept client-supplied URLs
  // (prevents SSRF via ?upstream= query parameter)
  const upstreamCandidate =
    source?.snapshotUrl ||
    (!isVideoFeedType(normalizeFeedType(source?.feedType))
      ? source?.url
      : '');

  const upstreamImage =
    source?.sourceKind === 'txdot-its'
      ? await fetchTxdotSnapshot(upstreamCandidate)
      : await fetchCctvImageFromUpstream(upstreamCandidate);

  const fallback = selectFrameFallback({
    upstreamOk: Boolean(upstreamImage?.ok),
    hasConfiguredUrl: Boolean(source?.url),
  });

  if (fallback === 'upstream') {
    setHealth(cameraId, {
      status: 'ok',
      sourceKind: 'snapshot',
      label: source?.provider || 'Configured source',
      message: 'Upstream snapshot active',
    });
    return new Response(upstreamImage.body, {
      status: 200,
      headers: {
        'content-type': upstreamImage.contentType,
        'cache-control': 'no-store',
        'x-cctv-source': 'upstream-image',
      },
    });
  }

  const svg = buildSyntheticCctvSvg({
    cameraId,
    label,
    city,
    status: source?.url ? 'UPSTREAM UNAVAILABLE' : 'NO UPSTREAM CONFIGURED',
  });
  setHealth(cameraId, {
    status: 'degraded',
    sourceKind: 'synthetic',
    label: source?.provider || 'Synthetic fallback',
    message: source?.url ? 'Upstream unavailable' : 'No source configured',
  });
  return new Response(svg, {
    status: 200,
    headers: {
      'content-type': 'image/svg+xml',
      'cache-control': 'no-store',
      'x-cctv-source': 'synthetic',
    },
  });
}

async function handleMedia(request, cameraId) {
  const sources = await getCctvSources();
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const source = sourceById.get(cameraId);
  const mediaUrl = source?.url || '';
  const feedType = normalizeFeedType(source?.feedType || 'image');

  if (!mediaUrl || !/^https?:\/\//i.test(mediaUrl)) {
    setHealth(cameraId, {
      status: 'degraded',
      sourceKind: 'fallback',
      label: source?.provider || 'No upstream URL',
      message: 'No stream URL configured',
    });
    return jsonResponse({ error: 'No media URL configured for this camera' }, 404);
  }

  // The viewer going away must take the upstream request with them; the
  // header deadline bounds how long a slow camera can hold the Worker.
  const upstreamHeaders = {
    'User-Agent': 'gods-eye-view-cctv-proxy/1.0',
  };
  // Never forward the client's own string: a Range this proxy does not
  // accept is dropped and the request proceeds without one.
  const requestRange = sanitizeCctvRangeHeader(request.headers.get('range'));
  if (requestRange) upstreamHeaders.Range = requestRange;

  let upstream;
  try {
    upstream = await fetch(mediaUrl, {
      headers: upstreamHeaders,
      signal: AbortSignal.any([
        AbortSignal.timeout(CCTV_MEDIA_FETCH_TIMEOUT_MS),
        request.signal,
      ]),
    });
  } catch (error) {
    if (request.signal.aborted) {
      // The viewer left before headers arrived. That is not a camera fault
      // and there is nobody to answer.
      return new Response(null, { status: 499 });
    }
    const timedOut =
      error?.name === 'AbortError' || error?.name === 'TimeoutError';
    setHealth(cameraId, {
      status: 'degraded',
      sourceKind: 'upstream',
      label: source?.provider || 'Configured source',
      message: error?.message || 'Media fetch failed',
    });
    return jsonResponse(
      { error: timedOut ? 'Upstream media timeout' : 'Media proxy failed' },
      timedOut ? 504 : 502,
    );
  }

  const contentType = upstream.headers.get('content-type') || '';
  if (!upstream.ok) {
    try {
      await upstream.body?.cancel();
    } catch {
      /* already closed */
    }
    setHealth(cameraId, {
      status: 'degraded',
      sourceKind: 'upstream',
      label: source?.provider || 'Configured source',
      message: `Upstream HTTP ${upstream.status}`,
    });
    return jsonResponse({ error: `Upstream returned ${upstream.status}` }, upstream.status);
  }

  // Cheap defense: reject an upstream that DECLARES an oversized fixed body.
  // Live MJPEG/HLS streams are unbounded by design and send no content-length,
  // so they stream through normally (never buffered).
  const declaredLength = Number(upstream.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > CCTV_MEDIA_MAX_BODY_BYTES) {
    try {
      await upstream.body?.cancel();
    } catch {
      /* no-op */
    }
    return jsonResponse({ error: 'Upstream media exceeds size cap' }, 502);
  }

  if (
    isVideoFeedType(feedType) &&
    !(contentType.startsWith('video/') || contentType.includes('mpegurl'))
  ) {
    setHealth(cameraId, {
      status: 'degraded',
      sourceKind: 'upstream',
      label: source?.provider || 'Configured source',
      message: `Unexpected media type ${contentType || 'unknown'}`,
    });
  } else {
    setHealth(cameraId, {
      status: 'ok',
      sourceKind: isVideoFeedType(feedType) ? 'live' : 'snapshot',
      label: source?.provider || 'Configured source',
      message: isVideoFeedType(feedType)
        ? 'Live stream connected'
        : 'Snapshot feed connected',
    });
  }

  const passthrough = {
    'content-type': contentType || 'application/octet-stream',
    'cache-control': upstream.headers.get('cache-control') || 'no-store',
    'x-cctv-source': isVideoFeedType(feedType) ? 'live-media' : 'upstream-image',
  };
  const contentLength = upstream.headers.get('content-length');
  const contentRange = upstream.headers.get('content-range');
  const acceptRanges = upstream.headers.get('accept-ranges');
  if (contentLength) passthrough['content-length'] = contentLength;
  if (contentRange) passthrough['content-range'] = contentRange;
  if (acceptRanges) passthrough['accept-ranges'] = acceptRanges;

  // The Worker returns the upstream body as a stream: the client disconnect
  // cancels it via request.signal wiring on the fetch above.
  return new Response(upstream.body, {
    status: upstream.status,
    headers: passthrough,
  });
}

/**
 * Handle /api/cctv* — shared by the Pages `_worker.js` and the standalone
 * Worker. `ctx` is optional; when present its `waitUntil` is used to finish
 * the edge-cache write after responding.
 */
export async function handleCctvRequest(request, ctx) {
  const url = new URL(request.url);
  const resolved = resolveCctvRoute(url.pathname);
  try {
    switch (resolved.route) {
      case 'sources':
        return await handleSources(request, ctx);
      case 'health':
        return jsonResponse({ cameras: listHealth() });
      case 'stream': {
        const sources = await getCctvSources();
        const sourceById = new Map(sources.map((s) => [s.id, s]));
        return jsonResponse(
          buildStreamPayload(sourceById.get(resolved.id), resolved.id),
        );
      }
      case 'media':
        return await handleMedia(request, resolved.id);
      case 'frame':
        return await handleFrame(request, resolved.id);
      default:
        return jsonResponse({ error: 'not found' }, 404);
    }
  } catch (error) {
    console.error('[CCTV Proxy]', error?.message || String(error));
    return jsonResponse({ error: 'CCTV proxy error' }, 500);
  }
}

/** Standalone-Worker entrypoint: `wrangler deploy` serves /api/cctv*. */
export default {
  async fetch(request, env, ctx) {
    return handleCctvRequest(request, ctx);
  },
};
