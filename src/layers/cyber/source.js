import { normalizeCyberEvents } from './records.js';

/**
 * Request and validate a complete cyber threat snapshot before it can
 * replace displayed attacks. The simulated feed itself is injected —
 * anything exposing `getSnapshot({ signal })` works.
 */
export function createCyberSource({ feed } = {}) {
  if (!feed || typeof feed.getSnapshot !== 'function') {
    throw new TypeError(
      'Cyber source requires a feed exposing getSnapshot({ signal })',
    );
  }
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const snapshot = await feed.getSnapshot({ signal });
      signal?.throwIfAborted();
      const rows = normalizeCyberEvents(snapshot);
      if (!rows) throw new Error('Malformed cyber feed snapshot');
      return rows;
    },
  };
}
