import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { isLoopbackRemoteAddress } from './bind.js';

const DEFAULT_ACTION_TIMEOUT_MS = 60_000;

/**
 * Loopback-only WebSocket hub: MCP tools → browser runGevAction.
 * Refuses non-loopback peers (same philosophy as admitKeySetupRequest).
 */
export function createBridgeHub({
  server,
  path = '/gev-bridge',
  actionTimeoutMs = DEFAULT_ACTION_TIMEOUT_MS,
} = {}) {
  const wss = new WebSocketServer({
    noServer: true,
    // Clients are the local GEV browser tab only.
    clientTracking: true,
  });
  /** @type {Map<string, { resolve: Function, reject: Function, timer: NodeJS.Timeout }>} */
  const pending = new Map();
  /** @type {import('ws').WebSocket | null} */
  let browserClient = null;

  function clearPending(errorMessage) {
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(errorMessage));
      pending.delete(id);
    }
  }

  function attachBrowser(ws) {
    if (browserClient && browserClient !== ws) {
      try {
        browserClient.close(4000, 'replaced by newer session');
      } catch {
        /* ignore */
      }
    }
    browserClient = ws;
    ws.send(JSON.stringify({ type: 'hello-ok', protocol: 1 }));
  }

  function handleMessage(ws, raw) {
    let message;
    try {
      message = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (!message || typeof message !== 'object') return;
    if (message.type === 'hello') {
      attachBrowser(ws);
      return;
    }
    if (message.type === 'action-result' || message.type === 'action-error') {
      const entry = pending.get(message.id);
      if (!entry) return;
      clearTimeout(entry.timer);
      pending.delete(message.id);
      if (message.type === 'action-error') {
        entry.reject(new Error(String(message.error || 'Action failed')));
      } else {
        entry.resolve(message.result);
      }
    }
  }

  function onUpgrade(req, socket, head) {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (url.pathname !== path) {
      socket.destroy();
      return;
    }
    const remote = req.socket?.remoteAddress;
    if (!isLoopbackRemoteAddress(remote)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  }

  wss.on('connection', (ws, req) => {
    if (!isLoopbackRemoteAddress(req.socket?.remoteAddress)) {
      ws.close(1008, 'loopback only');
      return;
    }
    ws.on('message', (data) => handleMessage(ws, data));
    ws.on('close', () => {
      if (browserClient === ws) {
        browserClient = null;
        clearPending(
          'Gods Eye View browser bridge disconnected. Keep the app open and ensure the MCP bridge client is running.',
        );
      }
    });
  });

  server.on('upgrade', onUpgrade);

  async function dispatchAction(name, args = {}) {
    if (!browserClient || browserClient.readyState !== 1) {
      const error = new Error(
        'No Gods Eye View browser session is connected to the MCP bridge. Start the app (npm run dev or ./scripts/dev-fresh.sh — typically http://localhost:4173 or :5173), keep the tab open, and confirm the bridge status in the console.',
      );
      error.code = 'GEV_MCP_NO_BROWSER';
      throw error;
    }
    const id = randomUUID();
    const payload = JSON.stringify({ type: 'action', id, name, args });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Action "${name}" timed out waiting for the browser`));
      }, actionTimeoutMs);
      pending.set(id, { resolve, reject, timer });
      try {
        browserClient.send(payload);
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(error);
      }
    });
  }

  function status() {
    return {
      connected: Boolean(browserClient && browserClient.readyState === 1),
      pending: pending.size,
      path,
    };
  }

  function close() {
    clearPending('MCP bridge shutting down');
    server.off('upgrade', onUpgrade);
    for (const client of wss.clients) {
      try {
        client.close();
      } catch {
        /* ignore */
      }
    }
    wss.close();
    browserClient = null;
  }

  return { dispatchAction, status, close, path };
}
