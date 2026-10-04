/**
 * Cloudflare Pages Advanced Mode entrypoint.
 *
 * Routes `/api/cyber-feed*` to the live threat-feed proxy
 * (workers/cyber-feed-proxy.js), `/api/cctv*` to the CCTV camera proxy
 * (workers/cctv-proxy.js), `/api/weather*` to the weather imagery proxy
 * (workers/weather-proxy.js — NOAA nowCOAST with Iowa State IEM fallbacks),
 * and `/api/cyclones*` to the cyclone advisory proxy
 * (workers/cyclone-proxy.js — NOAA NHC); every other request is served from
 * the static build output via the Pages-provided ASSETS binding.
 *
 * For Direct Upload deploys this file is bundled (esbuild) and uploaded as
 * the `_worker.bundle` field of the deployment-create call — see
 * scripts/pages-direct-upload.py. For git-connected Pages projects,
 * `npm run build` bundles it to `dist/_worker.js` automatically
 * (the `build:worker` step).
 */
import { handleCyberFeedRequest } from './workers/cyber-feed-proxy.js';
import { handleCctvRequest } from './workers/cctv-proxy.js';
import { handleWeatherRequest } from './workers/weather-proxy.js';
import { handleCycloneRequest } from './workers/cyclone-proxy.js';
import { handleFlightsRequest } from './workers/flights-proxy.js';
import { handleSpaceRequest } from './workers/space-proxy.js';
import { handleFireRequest } from './workers/fire-proxy.js';
import { handleRadioRequest } from './workers/radio-proxy.js';
import { handleMiscRequest } from './workers/misc-proxy.js';
import { handleTransitRequest } from './workers/transit-proxy.js';
import { handleKeyedRequest } from './workers/keyed-proxy.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (
      url.pathname === '/api/cyber-feed' ||
      url.pathname.startsWith('/api/cyber-feed/')
    ) {
      return handleCyberFeedRequest(request, ctx);
    }
    if (
      url.pathname === '/api/cctv' ||
      url.pathname.startsWith('/api/cctv/')
    ) {
      return handleCctvRequest(request, ctx);
    }
    if (
      url.pathname === '/api/weather' ||
      url.pathname.startsWith('/api/weather/')
    ) {
      return handleWeatherRequest(request, ctx);
    }
    if (
      url.pathname === '/api/cyclones' ||
      url.pathname.startsWith('/api/cyclones/')
    ) {
      return handleCycloneRequest(request, ctx);
    }
    if (
      url.pathname === '/api/opensky' ||
      url.pathname === '/api/opensky-track' ||
      url.pathname === '/api/adsblol' ||
      url.pathname.startsWith('/api/adsblol/')
    ) {
      return handleFlightsRequest(request, ctx);
    }
    if (
      url.pathname === '/api/celestrak' ||
      url.pathname.startsWith('/api/celestrak/') ||
      url.pathname === '/api/launches'
    ) {
      return handleSpaceRequest(request, ctx);
    }
    if (
      url.pathname === '/api/fire-perimeters' ||
      url.pathname.startsWith('/api/fire-perimeters/')
    ) {
      return handleFireRequest(request, ctx);
    }
    if (
      url.pathname === '/api/radio' ||
      url.pathname.startsWith('/api/radio/')
    ) {
      return handleRadioRequest(request, ctx);
    }
    if (
      url.pathname === '/api/route' ||
      url.pathname === '/api/gbfs' ||
      url.pathname.startsWith('/api/gbfs/') ||
      url.pathname === '/api/overpass'
    ) {
      return handleMiscRequest(request, ctx);
    }
    if (
      url.pathname === '/api/transit' ||
      url.pathname.startsWith('/api/transit/')
    ) {
      return handleTransitRequest(request, ctx);
    }
    if (
      url.pathname === '/api/tomtom' ||
      url.pathname.startsWith('/api/tomtom/') ||
      url.pathname === '/api/firms' ||
      url.pathname.startsWith('/api/firms/') ||
      url.pathname === '/api/google' ||
      url.pathname.startsWith('/api/google/') ||
      url.pathname === '/api/openai' ||
      url.pathname.startsWith('/api/openai/')
    ) {
      return handleKeyedRequest(request, env, ctx);
    }
    return env.ASSETS.fetch(request);
  },
};
