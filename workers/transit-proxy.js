/**
 * Transit proxy for Cloudflare Workers / Pages `_worker.js`.
 *
 * Thin adapter around the existing `createTransitService` (src/sources/
 * transitService.js), which is already worker-safe: pure JS, GTFS-RT
 * protobuf decoded in-process, returns WHATWG Response objects.
 *
 * Serves:
 *   GET /api/transit/feeds            — registered keyless feed catalog
 *   GET /api/transit/vehicles/{id}    — VehiclePositions snapshot
 *   GET /api/transit/trail/{id}      — vehicle trail history
 *
 * All feeds are keyless, openly licensed GTFS-Realtime (see
 * src/data/transitFeeds.js). 15 s per-feed cache, backoff on failure.
 *
 * NOTE: the service is created lazily on first request, not at module
 * scope — its constructor starts a setInterval sweeper, and Workers
 * forbid timers in global scope.
 */
import { createTransitService } from '../src/sources/transitService.js';

let service = null;

export async function handleTransitRequest(request) {
  try {
    if (!service) service = createTransitService();
    return await service.handle({ url: request.url, method: request.method });
  } catch {
    return new Response(JSON.stringify({ error: 'transit_unavailable' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
