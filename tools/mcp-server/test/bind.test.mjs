import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertLoopbackBindHost,
  isLoopbackRemoteAddress,
} from '../src/bind.js';

describe('assertLoopbackBindHost', () => {
  it('accepts 127.0.0.1 and localhost', () => {
    assert.equal(assertLoopbackBindHost('127.0.0.1'), '127.0.0.1');
    assert.equal(assertLoopbackBindHost('localhost'), '127.0.0.1');
    assert.equal(assertLoopbackBindHost('::1'), '::1');
  });

  it('hard-fails 0.0.0.0 and LAN hosts', () => {
    assert.throws(() => assertLoopbackBindHost('0.0.0.0'), /refused non-loopback/);
    assert.throws(() => assertLoopbackBindHost('::'), /refused non-loopback/);
    assert.throws(() => assertLoopbackBindHost('192.168.1.10'), /refused non-loopback/);
  });
});

describe('isLoopbackRemoteAddress', () => {
  it('admits loopback peers only', () => {
    assert.equal(isLoopbackRemoteAddress('127.0.0.1'), true);
    assert.equal(isLoopbackRemoteAddress('::1'), true);
    assert.equal(isLoopbackRemoteAddress('::ffff:127.0.0.1'), true);
    assert.equal(isLoopbackRemoteAddress('10.0.0.2'), false);
    assert.equal(isLoopbackRemoteAddress(''), false);
  });
});
