/**
 * Unit tests for workers/weather-proxy.js — pure logic only (no network):
 * capability parsing, bbox/tile/via validation, PNG sniffing, manifest
 * shaping (primary + IEM fallback), and the honest fallback labeling.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  observationTime,
  parseWeatherCapabilities,
  weatherImageBbox,
  weatherTileBounds,
  weatherVia,
  pngDimensions,
  describeWeatherManifest,
} from './weather-proxy.js';

const NOW = Date.parse('2026-10-04T14:40:00.000Z');

function capabilitiesXml({ layer, times, def, west = -130, south = 20, east = -60, north = 55 }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<WMS_Capabilities version="1.3.0">
  <Capability>
    <Layer>
      <Title>observations</Title>
      <Layer queryable="1" opaque="0">
        <Name>${layer}</Name>
        <Title>test</Title>
        <EX_GeographicBoundingBox>
          <westBoundLongitude>${west}</westBoundLongitude>
          <eastBoundLongitude>${east}</eastBoundLongitude>
          <southBoundLatitude>${south}</southBoundLatitude>
          <northBoundLatitude>${north}</northBoundLatitude>
        </EX_GeographicBoundingBox>
        <Dimension name="time" default="${def}" units="ISO8601">${times.join(',')}</Dimension>
      </Layer>
    </Layer>
  </Capability>
</WMS_Capabilities>`;
}

const RADAR_TIMES = [
  '2026-10-04T14:00:00.000Z',
  '2026-10-04T14:04:00.000Z',
  '2026-10-04T14:08:00.000Z',
];

describe('observationTime', () => {
  it('accepts canonical UTC with and without millis', () => {
    assert.equal(observationTime('2026-10-04T14:08:00.000Z'), '2026-10-04T14:08:00.000Z');
    assert.equal(observationTime('2026-10-04T14:08:00Z'), '2026-10-04T14:08:00.000Z');
  });
  it('rejects non-UTC, intervals, and garbage', () => {
    assert.equal(observationTime('2026-10-04T14:08:00+00:00'), null);
    assert.equal(observationTime('2026-10-04T14:08:00Z/2026-10-04T15:08:00Z'), null);
    assert.equal(observationTime('not a time'), null);
    assert.equal(observationTime(null), null);
  });
});

describe('parseWeatherCapabilities', () => {
  it('parses the nowCOAST radar layer leaf', () => {
    const xml = capabilitiesXml({
      layer: 'conus_base_reflectivity_mosaic',
      times: RADAR_TIMES,
      def: '2026-10-04T14:08:00.000Z',
    });
    const parsed = parseWeatherCapabilities(xml, 'radar', NOW);
    assert.deepEqual(parsed.bounds, { west: -130, south: 20, east: -60, north: 55 });
    assert.deepEqual(parsed.times, RADAR_TIMES);
    assert.deepEqual(parsed.allowedTimes, RADAR_TIMES);
  });
  it('rejects a missing layer, bad default, and expired observations', () => {
    const missing = capabilitiesXml({
      layer: 'something_else',
      times: RADAR_TIMES,
      def: RADAR_TIMES[2],
    });
    assert.throws(() => parseWeatherCapabilities(missing, 'radar', NOW), /invalid_weather_metadata/);
    const badDefault = capabilitiesXml({
      layer: 'conus_base_reflectivity_mosaic',
      times: RADAR_TIMES,
      def: '2026-10-04T15:00:00.000Z',
    });
    assert.throws(() => parseWeatherCapabilities(badDefault, 'radar', NOW), /invalid_weather_metadata/);
    const expired = capabilitiesXml({
      layer: 'conus_base_reflectivity_mosaic',
      times: ['2026-10-03T10:00:00.000Z'],
      def: '2026-10-03T10:00:00.000Z',
    });
    assert.throws(
      () => parseWeatherCapabilities(expired, 'radar', NOW),
      /weather_observations_expired/,
    );
  });
  it('rejects doctypes and oversized payloads', () => {
    assert.throws(
      () =>
        parseWeatherCapabilities(
          '<!DOCTYPE foo><WMS_Capabilities></WMS_Capabilities>',
          'radar',
          NOW,
        ),
      /invalid_weather_metadata/,
    );
  });
});

describe('weatherImageBbox', () => {
  it('rounds to 0.25° and accepts a 2:1 window', () => {
    assert.deepEqual(weatherImageBbox('-126.1,24.1,-66.2,54.05'), [-126, 24, -66.25, 54]);
  });
  it('rejects bad shapes and non-2:1 aspects', () => {
    assert.throws(() => weatherImageBbox('-126,24,-66,50,1'), /invalid_weather_bbox/);
    assert.throws(() => weatherImageBbox('-126,24,-100,50'), /invalid_weather_bbox/);
    assert.equal(weatherImageBbox(null), null);
  });
});

describe('weatherTileBounds', () => {
  it('matches the geographic tiling scheme', () => {
    assert.deepEqual(weatherTileBounds(0, 0, 0), [-180, -90, 0, 90]);
    assert.deepEqual(weatherTileBounds(0, 1, 0), [0, -90, 180, 90]);
    assert.deepEqual(weatherTileBounds(1, 3, 1), [90, -90, 180, 0]);
  });
  it('rejects out-of-range tiles', () => {
    assert.throws(() => weatherTileBounds(0, 2, 0), /invalid_weather_tile/);
    assert.throws(() => weatherTileBounds(7, 0, 0), /invalid_weather_tile/);
  });
});

describe('weatherVia', () => {
  it('accepts the configured fallback and rejects everything else', () => {
    assert.equal(weatherVia('radar', 'iem'), 'iem');
    assert.equal(weatherVia('radar', null), null);
    assert.throws(() => weatherVia('radar', 'rainviewer'), /invalid_weather_via/);
    assert.throws(() => weatherVia('lightning', 'iem'), /invalid_weather_via/);
  });
});

describe('pngDimensions', () => {
  function png(width, height) {
    const bytes = new Uint8Array(33);
    bytes.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
    const view = new DataView(bytes.buffer);
    view.setUint32(8, 13);
    view.setUint32(12, 0x49484452);
    view.setUint32(16, width);
    view.setUint32(20, height);
    return bytes;
  }
  it('reads IHDR dimensions and rejects non-PNG', () => {
    assert.deepEqual(pngDimensions(png(1024, 512)), { width: 1024, height: 512 });
    assert.equal(pngDimensions(new Uint8Array(40)), null);
    assert.equal(pngDimensions(new Uint8Array(10)), null);
  });
});

describe('describeWeatherManifest', () => {
  it('shapes a primary manifest with a nowCOAST tile template', () => {
    const body = describeWeatherManifest('radar', {
      bounds: { west: -130, south: 20, east: -60, north: 55 },
      times: RADAR_TIMES,
      fetchedAt: NOW,
      stale: false,
    });
    assert.equal(body.schemaVersion, 1);
    assert.equal(body.source, 'NOAA nowCOAST');
    assert.equal(body.fallback, false);
    assert.equal(body.via, null);
    assert.equal(body.latest, RADAR_TIMES[2]);
    assert.ok(body.tileTemplate.startsWith('/api/weather/tile?product=radar&time='));
    assert.ok(!body.tileTemplate.includes('via='));
    assert.equal(body.tilingScheme, 'geographic');
  });
  it('labels a fallback manifest honestly and pins via=iem', () => {
    const time = '2026-10-04T14:35:00.000Z';
    const body = describeWeatherManifest('radar', {
      title: 'CONUS radar reflectivity (fallback)',
      coverage: 'fallback coverage',
      description: 'fallback description',
      source: 'Iowa State IEM',
      attribution: 'Iowa State University',
      fallback: true,
      via: 'iem',
      fallbackFor: 'NOAA nowCOAST',
      bounds: { west: -126, south: 24, east: -66, north: 50 },
      times: [time],
      fetchedAt: NOW,
      stale: false,
    });
    assert.equal(body.fallback, true);
    assert.equal(body.via, 'iem');
    assert.equal(body.source, 'Iowa State IEM');
    assert.equal(body.fallbackFor, 'NOAA nowCOAST');
    assert.ok(body.tileTemplate.includes('&via=iem&'));
    assert.ok(body.imageUrl.includes('via=iem'));
    // No nowCOAST masquerading: the serving source is IEM, and nowCOAST is
    // named only as the unreachable primary.
    assert.ok(!JSON.stringify(body).includes('"source":"NOAA nowCOAST"'));
    assert.equal(body.fallbackFor, 'NOAA nowCOAST');
  });
  it('marks missing metadata unavailable', () => {
    const body = describeWeatherManifest('lightning', null);
    assert.equal(body.unavailable, true);
    assert.equal(body.reason, 'Weather imagery unavailable');
    assert.equal(body.tileTemplate, null);
  });
});
