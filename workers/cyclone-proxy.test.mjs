/**
 * Unit tests for workers/cyclone-proxy.js — pure logic only (no network):
 * NHC status parsing and GIS geometry attachment, ported from
 * server/providers/cyclones.js.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCycloneStatus,
  attachCycloneGeometry,
} from './cyclone-proxy.js';

const NOW = Date.parse('2026-10-04T15:00:00.000Z');

function statusPayload(storms) {
  return { activeStorms: storms };
}

function storm(id = 'al142026') {
  return {
    id,
    name: 'Test Storm',
    classification: 'HU',
    longitudeNumeric: -60.5,
    latitudeNumeric: 25.3,
    lastUpdate: '2026-10-04T14:00:00.000Z',
    intensity: '90',
    pressure: '970',
    movementDir: '300',
    movementSpeed: '12',
    forecastAdvisory: {
      issuance: '2026-10-04T14:30:00.000Z',
      advNum: '12A',
      url: 'https://www.nhc.noaa.gov/text/MIATCPAT2.shtml',
    },
  };
}

describe('parseCycloneStatus', () => {
  it('parses a valid NHC active-storms payload', () => {
    const storms = parseCycloneStatus(statusPayload([storm()]), NOW);
    assert.equal(storms.length, 1);
    const s = storms[0];
    assert.equal(s.id, 'al142026');
    assert.equal(s.basin, 'AL');
    assert.deepEqual(s.position, { longitude: -60.5, latitude: 25.3 });
    assert.equal(s.advisoryNumber, '12A');
    assert.equal(s.windKt, 90);
    assert.equal(s.geometryStatus, 'pending');
    assert.equal(
      s.advisoryUrl,
      'https://www.nhc.noaa.gov/text/MIATCPAT2.shtml',
    );
  });
  it('accepts NHC advisories posted before their synoptic-hour issuance', () => {
    // NHC posts each 03/09/15/21Z package ~30 min early; the issue time is
    // legitimately in the near future.
    const early = {
      ...storm(),
      lastUpdate: '2026-10-04T15:00:00.000Z',
      forecastAdvisory: {
        ...storm().forecastAdvisory,
        issuance: '2026-10-04T15:00:00.000Z',
      },
    };
    const at = Date.parse('2026-10-04T14:35:00.000Z'); // 25 min early
    const [s] = parseCycloneStatus(statusPayload([early]), at);
    assert.equal(s.advisoryNumber, '12A');
  });
  it('still rejects far-future timestamps', () => {
    const future = {
      ...storm(),
      forecastAdvisory: {
        ...storm().forecastAdvisory,
        issuance: '2026-10-04T16:00:00.000Z',
      },
    };
    assert.throws(
      () =>
        parseCycloneStatus(
          statusPayload([future]),
          Date.parse('2026-10-04T14:35:00.000Z'),
        ),
      /invalid_cyclone_data/,
    );
  });
  it('rejects bad ids, far-future issuances, and off-domain advisory links', () => {
    assert.throws(
      () => parseCycloneStatus(statusPayload([{ ...storm(), id: 'xx1' }]), NOW),
      /invalid_cyclone_data/,
    );
    assert.throws(
      () =>
        parseCycloneStatus(
          statusPayload([
            {
              ...storm(),
              forecastAdvisory: {
                ...storm().forecastAdvisory,
                issuance: '2026-10-05T15:00:00.000Z',
              },
            },
          ]),
          NOW,
        ),
      /invalid_cyclone_data/,
    );
    const [s] = parseCycloneStatus(
      statusPayload([
        {
          ...storm(),
          forecastAdvisory: {
            ...storm().forecastAdvisory,
            url: 'https://evil.example.com/text/MIATCPAT2.shtml',
          },
        },
      ]),
      NOW,
    );
    assert.equal(s.advisoryUrl, null);
  });
  it('accepts an empty storm list (off-season)', () => {
    assert.deepEqual(parseCycloneStatus(statusPayload([]), NOW), []);
  });
});

describe('attachCycloneGeometry', () => {
  function feature(idpSource, advnum, geom, extra = {}) {
    return {
      type: 'Feature',
      properties: { idp_source: idpSource, advisnum: advnum, ...extra },
      geometry: geom,
    };
  }
  function collection(features) {
    return { type: 'FeatureCollection', features };
  }
  it('attaches points, track, and cone for a matching advisory', () => {
    const storms = parseCycloneStatus(statusPayload([storm()]), NOW);
    const idp = 'al142026-12A_5day';
    const points = collection([
      feature(`${idp}_pts`, '12A', { type: 'Point', coordinates: [-60.5, 25.3] }, { tau: 0, maxwind: 90, gust: 110 }),
      feature(`${idp}_pts`, '12A', { type: 'Point', coordinates: [-61.5, 26.3] }, { tau: 12, maxwind: 95, gust: 115 }),
    ]);
    const track = collection([
      feature(`${idp}_lin`, '12A', {
        type: 'LineString',
        coordinates: [
          [-60.5, 25.3],
          [-61.5, 26.3],
        ],
      }),
    ]);
    const cone = collection([
      feature(`${idp}_pgn`, '12A', {
        type: 'Polygon',
        coordinates: [
          [
            [-61, 25],
            [-60, 25],
            [-60, 26],
            [-61, 26],
            [-61, 25],
          ],
        ],
      }),
    ]);
    const [s] = attachCycloneGeometry(storms, [points, track, cone]);
    assert.equal(s.geometryStatus, 'current');
    assert.equal(s.geometryAdvisoryNumber, '12A');
    assert.equal(s.forecastPoints.length, 2);
    assert.deepEqual(s.forecastPoints[0].tauHours, 0);
    assert.equal(s.track.type, 'LineString');
    assert.equal(s.cone.type, 'Polygon');
  });
  it('leaves geometry pending when the advisory does not match', () => {
    const storms = parseCycloneStatus(statusPayload([storm()]), NOW);
    const idp = 'al142026-11A_5day'; // older advisory
    const points = collection([
      feature(`${idp}_pts`, '11A', { type: 'Point', coordinates: [-60.5, 25.3] }, { tau: 0 }),
    ]);
    const track = collection([
      feature(`${idp}_lin`, '11A', {
        type: 'LineString',
        coordinates: [
          [-60.5, 25.3],
          [-61.5, 26.3],
        ],
      }),
    ]);
    const cone = collection([
      feature(`${idp}_pgn`, '11A', {
        type: 'Polygon',
        coordinates: [
          [
            [-61, 25],
            [-60, 25],
            [-60, 26],
            [-61, 26],
            [-61, 25],
          ],
        ],
      }),
    ]);
    const [s] = attachCycloneGeometry(storms, [points, track, cone]);
    assert.equal(s.geometryStatus, 'pending');
    assert.equal(s.track, null);
  });
  it('rejects exceeded transfer limits and mismatched geometry kinds', () => {
    const storms = parseCycloneStatus(statusPayload([storm()]), NOW);
    assert.throws(
      () =>
        attachCycloneGeometry(storms, [
          { type: 'FeatureCollection', exceededTransferLimit: true, features: [] },
          collection([]),
          collection([]),
        ]),
      /invalid_cyclone_data/,
    );
  });
});
