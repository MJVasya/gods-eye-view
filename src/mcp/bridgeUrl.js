const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

/**
 * True when `url` is a WebSocket URL whose host is loopback only.
 * Rejects LAN/WAN hosts so ?gevMcpBridge= / __GEV_MCP_BRIDGE_URL__ cannot
 * point the browser at a remote control plane.
 */
export function isLoopbackBridgeUrl(url) {
  if (typeof url !== 'string' || !url.trim()) return false;
  let parsed;
  try {
    parsed = new URL(url.trim());
  } catch {
    return false;
  }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') return false;
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (LOOPBACK_HOSTS.has(host)) return true;
  if (host === '::ffff:127.0.0.1') return true;
  return false;
}

/**
 * Return a loopback WebSocket URL or throw.
 */
export function assertLoopbackBridgeUrl(url, label = 'MCP bridge URL') {
  if (!isLoopbackBridgeUrl(url)) {
    throw new Error(
      `${label} refused non-loopback WebSocket URL "${url ?? ''}". Only ws(s)://127.0.0.1, ::1, or localhost are allowed.`,
    );
  }
  return url.trim();
}
