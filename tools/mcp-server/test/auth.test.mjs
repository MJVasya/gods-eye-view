import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  parseBearerToken,
  resolveMcpToken,
  tokensEqual,
} from '../src/auth.js';

describe('MCP bearer auth', () => {
  it('parses Bearer tokens', () => {
    assert.equal(parseBearerToken('Bearer abc'), 'abc');
    assert.equal(parseBearerToken('bearer abc'), 'abc');
    assert.equal(parseBearerToken('Basic abc'), null);
  });

  it('compares tokens safely', () => {
    assert.equal(tokensEqual('abc', 'abc'), true);
    assert.equal(tokensEqual('abc', 'abd'), false);
    assert.equal(tokensEqual('abc', 'ab'), false);
  });

  it('reads env token without writing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-mcp-'));
    const resolved = resolveMcpToken({
      env: { GEV_MCP_TOKEN: 'from-env-token-value-32chars!!' },
      repoRoot: dir,
      writeFile: false,
    });
    assert.equal(resolved.source, 'env');
    assert.equal(resolved.token, 'from-env-token-value-32chars!!');
  });

  it('generates a file token when unset', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-mcp-'));
    const resolved = resolveMcpToken({ env: {}, repoRoot: dir, writeFile: true });
    assert.equal(resolved.source, 'generated');
    assert.ok(resolved.token.length >= 32);
    assert.equal(
      fs.readFileSync(resolved.path, 'utf8').trim(),
      resolved.token,
    );
    const again = resolveMcpToken({ env: {}, repoRoot: dir, writeFile: true });
    assert.equal(again.source, 'file');
    assert.equal(again.token, resolved.token);
  });
});
