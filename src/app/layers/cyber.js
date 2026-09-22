import { createCyberLayer } from '../../layers/cyber/index.js';
import { overlayHost } from './overlayHost.js';
/** Wire simulated cyber threat intel to the application overlay host. */
export function createApplicationCyber(options) {
  return createCyberLayer({ overlayHost, ...options });
}
