/** Addresses this process may bind for MCP / bridge listeners. */
export const LOOPBACK_BIND_HOSTS = Object.freeze(
  new Set(['127.0.0.1', '::1', 'localhost']),
);

/**
 * Hard-fail unless the listen host is loopback.
 * Security: MCP and the control bridge must never bind LAN/WAN interfaces.
 * @param {string | undefined} host
 * @param {string} label
 * @returns {string} normalized bind host (`127.0.0.1` or `::1`)
 */
export function assertLoopbackBindHost(host, label = 'MCP') {
  const raw = String(host ?? '127.0.0.1').trim().toLowerCase();
  if (!raw || raw === '0.0.0.0' || raw === '::' || raw === '[::]') {
    throw new Error(
      `${label} refused non-loopback bind "${host ?? ''}". Set GEV_MCP_HOST=127.0.0.1 (LAN exposure is not supported).`,
    );
  }
  if (!LOOPBACK_BIND_HOSTS.has(raw)) {
    throw new Error(
      `${label} refused non-loopback bind "${host}". Only 127.0.0.1 / ::1 / localhost are allowed.`,
    );
  }
  if (raw === 'localhost') return '127.0.0.1';
  return raw === '::1' ? '::1' : '127.0.0.1';
}

/** Socket addresses that count as this machine (mirror key-setup). */
export const LOOPBACK_REMOTE_ADDRESSES = Object.freeze(
  new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']),
);

/** True when a connected peer is on loopback. */
export function isLoopbackRemoteAddress(remoteAddress) {
  return LOOPBACK_REMOTE_ADDRESSES.has(String(remoteAddress || ''));
}
