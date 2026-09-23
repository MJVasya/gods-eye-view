/**
 * Source-marker entity tests (phase 3b click-to-inspect).
 *
 * Rendering imports the real `cesium` package; when it cannot be resolved
 * (e.g. a checkout without node_modules) these hooks fall back to the
 * local ./cesium-test-stub.mjs so the entity-shape tests still run
 * headless. The stub passes `point` graphics through on Entity.
 */
import { register } from 'node:module';
import assert from 'node:assert/strict';
import test from 'node:test';

const stubUrl = new URL('./cesium-test-stub.mjs', import.meta.url).href;
register(
  `data:text/javascript,${encodeURIComponent(`
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'cesium') {
    try {
      return await nextResolve(specifier, context);
    } catch {
      return { url: ${JSON.stringify(stubUrl)}, shortCircuit: true };
    }
  }
  return nextResolve(specifier, context);
}
`)}`,
);

const {
  createAttackArcEntity,
  createSourceMarkerEntity,
  createEndpointMarkerEntity,
  createCyberEntities,
  resolveCyberPickEventId,
} = await import('./rendering.js');
const { CYBER_MAX_ARCS } = await import('./model.js');

const endpoint = (code, country, lat, lon, extras = {}) => ({
  code,
  country,
  lat,
  lon,
  ...extras,
});
const attack = (id, overrides = {}) => ({
  id,
  src: endpoint('RU', 'Russia', 55.7, 37.6),
  dst: endpoint('US', 'United States', 38.9, -77.0),
  type: 'ddos',
  severity: 4,
  ts: 1758550000000,
  ...overrides,
});
const prop = (entity, key) => entity.properties[key]?.getValue();

test('source marker carries the cyber:src: id and a point at the origin', () => {
  const marker = createSourceMarkerEntity(attack('s1'), 1758550001000);
  assert.equal(marker.id, 'cyber:src:s1');
  assert.ok(marker.position, 'marker needs a position');
  assert.ok(marker.point, 'marker needs point graphics');
  assert.ok(marker.point.pixelSize > 0);
  // Severity steps the marker size, like arcs step width.
  const small = createSourceMarkerEntity(
    attack('s2', { severity: 1 }),
    1758550001000,
  );
  assert.ok(marker.point.pixelSize > small.point.pixelSize);
});

test('source marker properties carry src geo, enrichment, and provenance', () => {
  const record = attack('s1', {
    src: endpoint('DE', 'Germany', 52.5, 13.4, {
      city: 'Frankfurt am Main',
      region: 'Hesse',
      isp: 'Example ISP',
      org: 'Example Org',
      asn: 'AS12345',
    }),
    ioc: '1.2.3.4',
    ref: 'https://cinsscore.com/',
  });
  const marker = createSourceMarkerEntity(record, 1758550001000);
  assert.equal(prop(marker, 'id'), 's1');
  assert.equal(prop(marker, 'type'), 'ddos');
  assert.equal(prop(marker, 'severity'), 4);
  assert.equal(prop(marker, 'srcCode'), 'DE');
  assert.equal(prop(marker, 'srcCountry'), 'Germany');
  assert.equal(prop(marker, 'srcLat'), 52.5);
  assert.equal(prop(marker, 'srcLon'), 13.4);
  assert.equal(prop(marker, 'city'), 'Frankfurt am Main');
  assert.equal(prop(marker, 'region'), 'Hesse');
  assert.equal(prop(marker, 'isp'), 'Example ISP');
  assert.equal(prop(marker, 'org'), 'Example Org');
  assert.equal(prop(marker, 'asn'), 'AS12345');
  assert.equal(prop(marker, 'ioc'), '1.2.3.4');
  assert.equal(prop(marker, 'ref'), 'https://cinsscore.com/');
});

test('source marker omits enrichment keys the feed did not provide', () => {
  const marker = createSourceMarkerEntity(attack('s1'), 1758550001000);
  for (const key of ['city', 'region', 'isp', 'org', 'asn', 'ioc', 'ref']) {
    assert.equal(key in marker.properties, false, `unexpected ${key}`);
  }
});

test('createCyberEntities emits arc + source marker + dst marker per record', () => {
  const rows = [attack('a1'), attack('a2')];
  const entities = createCyberEntities(rows, 1758550001000);
  assert.equal(entities.length, 6);
  assert.deepEqual(
    entities.map((e) => e.id),
    [
      'cyber:arc:a1',
      'cyber:src:a1',
      'cyber:dst:a1',
      'cyber:arc:a2',
      'cyber:src:a2',
      'cyber:dst:a2',
    ],
  );
});

test('cohort cap still limits arcs with three entities each', () => {
  const rows = [];
  for (let i = 0; i < CYBER_MAX_ARCS + 10; i++) {
    rows.push(attack(`cap-${i}`));
  }
  const entities = createCyberEntities(rows, 1758550001000);
  assert.equal(entities.length, CYBER_MAX_ARCS * 3);
  const arcs = entities.filter((e) => String(e.id).startsWith('cyber:arc:'));
  assert.equal(arcs.length, CYBER_MAX_ARCS);
});

test('pick resolution accepts source markers and arcs only', () => {
  const now = 1758550001000;
  const marker = createSourceMarkerEntity(attack('m1'), now);
  const arc = createAttackArcEntity(attack('m1'), now);
  const dst = createEndpointMarkerEntity(attack('m1'), now);
  // scene.pick returns the entity as `id` for data-source entities.
  assert.equal(resolveCyberPickEventId({ id: marker }), 'm1');
  assert.equal(resolveCyberPickEventId({ id: arc }), 'm1');
  assert.equal(resolveCyberPickEventId({ id: dst }), null);
  // Raw string ids (unit shorthand) resolve the same way.
  assert.equal(resolveCyberPickEventId({ id: 'cyber:src:abc' }), 'abc');
  assert.equal(resolveCyberPickEventId({ id: 'cyber:arc:abc' }), 'abc');
  assert.equal(resolveCyberPickEventId({ id: 'cyber:dst:abc' }), null);
  // Anything else is left alone.
  assert.equal(resolveCyberPickEventId({ id: { id: 'other-1' } }), null);
  assert.equal(resolveCyberPickEventId({ id: 'other-1' }), null);
  assert.equal(resolveCyberPickEventId({}), null);
  assert.equal(resolveCyberPickEventId(null), null);
  assert.equal(resolveCyberPickEventId(undefined), null);
  assert.equal(resolveCyberPickEventId({ id: 'cyber:src:' }), null);
});
