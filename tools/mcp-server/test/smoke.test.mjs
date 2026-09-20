import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertLoopbackBindHost } from '../src/bind.js';
import { startGevMcpServer } from '../src/mcpApp.js';
import net from 'node:net';

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

describe('MCP smoke', () => {
  it('binds 127.0.0.1, serves health, requires bearer, lists tools', async () => {
    const port = await freePort();
    const token = 'test-token-' + 'a'.repeat(40);
    const started = await startGevMcpServer({
      host: '127.0.0.1',
      port,
      token,
    });
    try {
      const health = await fetch(`http://127.0.0.1:${port}/health`);
      assert.equal(health.status, 200);
      const body = await health.json();
      assert.equal(body.ok, true);
      assert.equal(body.bridge.connected, false);

      const unauthorized = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'smoke', version: '0' },
          },
        }),
      });
      assert.equal(unauthorized.status, 401);

      const init = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'smoke', version: '0' },
          },
        }),
      });
      assert.ok(init.status >= 200 && init.status < 300, `init status ${init.status}`);
      const initJson = await init.json();
      assert.equal(initJson.result?.serverInfo?.name, 'gods-eye-view');
      const sessionId = init.headers.get('mcp-session-id');

      const listHeaders = {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        accept: 'application/json, text/event-stream',
      };
      if (sessionId) listHeaders['mcp-session-id'] = sessionId;

      // Some transports require initialized notification first.
      await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: listHeaders,
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'notifications/initialized',
        }),
      });

      const listed = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: listHeaders,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/list',
        }),
      });
      assert.ok(listed.status >= 200 && listed.status < 300);
      const listJson = await listed.json();
      const names = (listJson.result?.tools || []).map((t) => t.name);
      assert.ok(names.includes('fly_to_location'));
      assert.ok(!names.includes('control_cctv'));
      assert.ok(!names.includes('control_radio'));

      const call = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: listHeaders,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: {
            name: 'zoom_to_globe',
            arguments: {},
          },
        }),
      });
      const callJson = await call.json();
      const text = callJson.result?.content?.[0]?.text || '';
      assert.match(text, /No Gods Eye View browser session|bridge/i);
    } finally {
      await started.close();
    }
  });

  it('refuses non-loopback bind configuration', () => {
    assert.throws(() => assertLoopbackBindHost('0.0.0.0'), /refused/);
  });
});
