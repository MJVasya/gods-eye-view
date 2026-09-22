/**
 * Cloudflare Pages Advanced Mode entrypoint.
 *
 * Routes `/api/cyber-feed*` to the live threat-feed proxy
 * (workers/cyber-feed-proxy.js); every other request is served from the
 * static build output via the Pages-provided ASSETS binding.
 *
 * For Direct Upload deploys this file is bundled (esbuild) and uploaded as
 * the `_worker.bundle` field of the deployment-create call — see
 * scripts/pages-direct-upload.py. For git-connected Pages projects, place
 * the bundled output at the root of the build output directory instead.
 */
import { handleCyberFeedRequest } from './workers/cyber-feed-proxy.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (
      url.pathname === '/api/cyber-feed' ||
      url.pathname.startsWith('/api/cyber-feed/')
    ) {
      return handleCyberFeedRequest(request, ctx);
    }
    return env.ASSETS.fetch(request);
  },
};
