import { createGevActionRunner } from '../voice/gevActions.js';
import {
  assertLoopbackBridgeUrl,
  isLoopbackBridgeUrl,
} from './bridgeUrl.js';

const DEFAULT_BRIDGE_URL = 'ws://127.0.0.1:3850/gev-bridge';
const RECONNECT_MS = 2000;


/**
 * Connect the running browser session to the localhost MCP bridge.
 * Dispatches allowlisted actions through createGevActionRunner — not /api/*.
 */
export function startMcpBridgeClient({
  viewer,
  styleManager,
  dataManager,
  sceneDirector = null,
  annotations = null,
  placeSearch,
  floorServices,
  annotationResolver,
  searchNavigation,
  signal,
  bridgeUrl = readBridgeUrl(),
  createRunner = createGevActionRunner,
} = {}) {
  if (typeof WebSocket === 'undefined') {
    return { stop() {}, getStatus: () => ({ state: 'unsupported' }) };
  }

  let resolvedUrl;
  try {
    resolvedUrl = assertLoopbackBridgeUrl(bridgeUrl);
  } catch (error) {
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('[gev-mcp]', error.message);
    }
    return {
      stop() {},
      getStatus: () => ({ state: 'refused', bridgeUrl, error: String(error.message || error) }),
    };
  }

  const runner = createRunner({
    viewer,
    styleManager,
    dataManager,
    sceneDirector,
    annotations,
    placeSearch,
    floorServices,
    annotationResolver,
    searchNavigation,
  });

  let socket = null;
  let stopped = false;
  let reconnectTimer = null;
  let state = 'idle';

  const publish = (next) => {
    state = next;
  };

  const clearReconnect = () => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const scheduleReconnect = () => {
    if (stopped || signal?.aborted) return;
    clearReconnect();
    reconnectTimer = setTimeout(connect, RECONNECT_MS);
  };

  async function onActionMessage(message) {
    const { id, name, args } = message;
    try {
      const result = await runner(name, args && typeof args === 'object' ? args : {});
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'action-result', id, result }));
      }
    } catch (error) {
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(
          JSON.stringify({
            type: 'action-error',
            id,
            error: String(error?.message || error),
          }),
        );
      }
    }
  }

  function connect() {
    if (stopped || signal?.aborted) return;
    clearReconnect();
    try {
      socket = new WebSocket(resolvedUrl);
    } catch {
      publish('error');
      scheduleReconnect();
      return;
    }
    publish('connecting');
    socket.addEventListener('open', () => {
      publish('connected');
      socket.send(JSON.stringify({ type: 'hello', client: 'gev-browser' }));
    });
    socket.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (message?.type === 'action') void onActionMessage(message);
    });
    socket.addEventListener('close', () => {
      publish('disconnected');
      socket = null;
      scheduleReconnect();
    });
    socket.addEventListener('error', () => {
      // close handler schedules reconnect
    });
  }

  const onAbort = () => stop();
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) {
    return { stop() {}, getStatus: () => ({ state: 'stopped' }) };
  }

  function stop() {
    stopped = true;
    clearReconnect();
    signal?.removeEventListener('abort', onAbort);
    try {
      socket?.close();
    } catch {
      /* ignore */
    }
    socket = null;
    publish('stopped');
  }

  connect();

  return {
    stop,
    getStatus: () => ({ state, bridgeUrl: resolvedUrl }),
  };
}

function readBridgeUrl() {
  let candidate = DEFAULT_BRIDGE_URL;
  try {
    const fromQuery = new URLSearchParams(window.location.search).get(
      'gevMcpBridge',
    );
    if (fromQuery) candidate = fromQuery;
  } catch {
    /* ignore */
  }
  if (
    candidate === DEFAULT_BRIDGE_URL &&
    typeof window !== 'undefined' &&
    window.__GEV_MCP_BRIDGE_URL__
  ) {
    candidate = window.__GEV_MCP_BRIDGE_URL__;
  }
  if (!isLoopbackBridgeUrl(candidate)) {
    if (typeof console !== 'undefined' && console.warn) {
      console.warn(
        `[gev-mcp] Ignoring non-loopback bridge URL "${candidate}"; using ${DEFAULT_BRIDGE_URL}`,
      );
    }
    return DEFAULT_BRIDGE_URL;
  }
  return candidate.trim();
}
