import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertLoopbackBridgeUrl,
  isLoopbackBridgeUrl,
} from './bridgeUrl.js';

describe('isLoopbackBridgeUrl', () => {
  it('admits loopback WebSocket URLs', () => {
    assert.equal(isLoopbackBridgeUrl('ws://127.0.0.1:3850/gev-bridge'), true);
    assert.equal(isLoopbackBridgeUrl('ws://localhost:3850/gev-bridge'), true);
    assert.equal(isLoopbackBridgeUrl('wss://127.0.0.1:3850/gev-bridge'), true);
    assert.equal(isLoopbackBridgeUrl('ws://[::1]:3850/gev-bridge'), true);
  });

  it('rejects non-loopback and non-ws URLs', () => {
    assert.equal(isLoopbackBridgeUrl('ws://0.0.0.0:3850/gev-bridge'), false);
    assert.equal(isLoopbackBridgeUrl('ws://192.168.1.10:3850/gev-bridge'), false);
    assert.equal(isLoopbackBridgeUrl('ws://example.com/gev-bridge'), false);
    assert.equal(isLoopbackBridgeUrl('http://127.0.0.1:3850/gev-bridge'), false);
    assert.equal(isLoopbackBridgeUrl('not-a-url'), false);
    assert.equal(isLoopbackBridgeUrl(''), false);
  });
});

describe('assertLoopbackBridgeUrl', () => {
  it('returns trimmed loopback URLs and throws otherwise', () => {
    assert.equal(
      assertLoopbackBridgeUrl(' ws://127.0.0.1:3850/gev-bridge '),
      'ws://127.0.0.1:3850/gev-bridge',
    );
    assert.throws(
      () => assertLoopbackBridgeUrl('ws://10.0.0.2:3850/x'),
      /refused non-loopback/,
    );
  });
});
