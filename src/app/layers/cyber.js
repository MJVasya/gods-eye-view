import { createCyberLayer } from '../../layers/cyber/index.js';
import { createCyberSource } from '../../layers/cyber/source.js';
import { createLiveCyberFeed } from '../../layers/cyber/liveFeed.js';
import { overlayHost } from './overlayHost.js';

/**
 * Wire cyber threat intel to the application overlay host.
 *
 * The simulated feed stays the default. The live feed (real community threat
 * intel from CINS Army, blocklist.de, Spamhaus and OpenPhish, fetched through
 * the same-origin `/api/cyber-feed` proxy — keyless, no browser CORS involved)
 * is constructed here but only activates when the user explicitly opts in via
 * the layer's row toggle; the layer module owns the mode switch and its
 * attribution labels.
 */
export function createApplicationCyber(options) {
  const liveSource = createCyberSource({ feed: createLiveCyberFeed() });
  return createCyberLayer({ overlayHost, liveSource, ...options });
}
