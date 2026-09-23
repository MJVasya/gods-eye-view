import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCyberEvents, CYBER_THREAT_TYPES } from './records.js';

const endpoint = (overrides = {}) => ({
  country: 'United States',
  code: 'US',
  lat: 38.9,
  lon: -77.0,
  ...overrides,
});

const event = (overrides = {}) => ({
  id: 'attack-1',
  src: endpoint({ country: 'Russia', code: 'RU', lat: 55.7, lon: 37.6 }),
  dst: endpoint(),
  type: 'ddos',
  severity: 4,
  ts: 1758550000000,
  ...overrides,
});

test('accepts a fully valid event and normalizes whitespace', () => {
  const rows = normalizeCyberEvents([
    event({ id: '  attack-9  ', src: endpoint({ code: '  DE ' }) }),
  ]);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    id: 'attack-9',
    src: { country: 'United States', code: 'DE', lat: 38.9, lon: -77.0 },
    dst: { country: 'United States', code: 'US', lat: 38.9, lon: -77.0 },
    type: 'ddos',
    severity: 4,
    ts: 1758550000000,
  });
});

test('accepts every contracted threat type', () => {
  assert.deepEqual(CYBER_THREAT_TYPES, [
    'ddos',
    'malware',
    'intrusion',
    'phishing',
    'scan',
    'c2',
  ]);
  for (const type of CYBER_THREAT_TYPES) {
    const rows = normalizeCyberEvents([event({ id: type, type })]);
    assert.equal(rows.length, 1, `type ${type} rejected`);
    assert.equal(rows[0].type, type);
  }
});

test('accepts boundary severities and coordinates', () => {
  for (const severity of [1, 5]) {
    assert.equal(normalizeCyberEvents([event({ severity })]).length, 1);
  }
  const rows = normalizeCyberEvents([
    event({ src: endpoint({ lat: -90, lon: -180 }), dst: endpoint({ lat: 90, lon: 180 }) }),
  ]);
  assert.equal(rows.length, 1);
});

test('rejects malformed events individually, keeping valid ones', () => {
  const bad = [
    event({ id: 'x1', type: 'ransomware' }),
    event({ id: 'x2', type: 'DDoS' }),
    event({ id: 'x3', severity: 0 }),
    event({ id: 'x4', severity: 6 }),
    event({ id: 'x5', severity: 2.5 }),
    event({ id: 'x6', severity: '3' }),
    event({ id: 'x7', severity: NaN }),
    event({ id: 'x8', ts: -1 }),
    event({ id: 'x9', ts: NaN }),
    event({ id: 'x10', ts: '1758550000000' }),
    event({ id: 'x11', ts: Infinity }),
    event({ id: '', }),
    event({ id: 42 }),
    event({ id: 'x14', src: null }),
    event({ id: 'x15', dst: [] }),
    event({ id: 'x16', src: endpoint({ lat: 91 }) }),
    event({ id: 'x17', src: endpoint({ lat: -91 }) }),
    event({ id: 'x18', dst: endpoint({ lon: 181 }) }),
    event({ id: 'x19', dst: endpoint({ lon: -181 }) }),
    event({ id: 'x20', src: endpoint({ lat: NaN }) }),
    event({ id: 'x21', src: endpoint({ country: '' }) }),
    event({ id: 'x22', src: endpoint({ country: '   ' }) }),
    event({ id: 'x23', dst: endpoint({ code: '' }) }),
    event({ id: 'x24', dst: endpoint({ code: 7 }) }),
    null,
    undefined,
    42,
    'attack',
    [],
    { id: 'x30', src: endpoint(), dst: endpoint() }, // missing type/severity/ts
  ];
  const rows = normalizeCyberEvents([event({ id: 'good' }), ...bad]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'good');
});

test('returns null for a non-array snapshot, [] for an empty one', () => {
  assert.equal(normalizeCyberEvents(null), null);
  assert.equal(normalizeCyberEvents(undefined), null);
  assert.equal(normalizeCyberEvents({}), null);
  assert.equal(normalizeCyberEvents('[]'), null);
  assert.deepEqual(normalizeCyberEvents([]), []);
});

test('deduplicates by id, keeping the first occurrence', () => {
  const rows = normalizeCyberEvents([
    event({ id: 'dup', severity: 5 }),
    event({ id: 'dup', severity: 1 }),
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].severity, 5);
});

test('normalized rows are plain JSON-safe data', () => {
  const rows = normalizeCyberEvents([event()]);
  assert.deepEqual(JSON.parse(JSON.stringify(rows)), rows);
});

test('passes through GeoIP enrichment on endpoints, trimmed', () => {
  const rows = normalizeCyberEvents([
    event({
      src: endpoint({
        city: '  Frankfurt am Main ',
        region: 'Hesse',
        isp: 'Example ISP GmbH',
        org: 'Example Org',
        asn: 'AS12345',
      }),
    }),
  ]);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].src, {
    country: 'United States',
    code: 'US',
    lat: 38.9,
    lon: -77.0,
    city: 'Frankfurt am Main',
    region: 'Hesse',
    isp: 'Example ISP GmbH',
    org: 'Example Org',
    asn: 'AS12345',
  });
});

test('drops malformed enrichment fields instead of inventing values', () => {
  const rows = normalizeCyberEvents([
    event({
      src: endpoint({
        city: '   ',
        region: '',
        isp: 42,
        org: null,
        asn: ['AS1'],
        bogus: 'ignored',
      }),
    }),
  ]);
  assert.equal(rows.length, 1);
  // No enrichment keys survive; the event itself is still valid.
  assert.deepEqual(rows[0].src, {
    country: 'United States',
    code: 'US',
    lat: 38.9,
    lon: -77.0,
  });
  assert.equal('bogus' in rows[0].src, false);
});

test('passes through ioc/ref provenance extras, trimmed', () => {
  const rows = normalizeCyberEvents([
    event({ ioc: '  1.12.229.231 ', ref: 'https://cinsscore.com/ ' }),
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ioc, '1.12.229.231');
  assert.equal(rows[0].ref, 'https://cinsscore.com/');
});

test('drops malformed ioc/ref extras, keeping the event', () => {
  const rows = normalizeCyberEvents([
    event({ ioc: '   ', ref: 42 }),
  ]);
  assert.equal(rows.length, 1);
  assert.equal('ioc' in rows[0], false);
  assert.equal('ref' in rows[0], false);
});

test('omits enrichment entirely for plain hub endpoints', () => {
  const rows = normalizeCyberEvents([event()]);
  assert.equal(rows.length, 1);
  assert.deepEqual(Object.keys(rows[0].src).sort(), [
    'code',
    'country',
    'lat',
    'lon',
  ]);
});
