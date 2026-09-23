# Cyber Intel layer

> ⚠️ **SIMULATED BY DEFAULT.** Every event is generated in-repo
> by a seeded pseudorandom simulator (`src/layers/cyber/simulator.js`). It is
> **not real threat intelligence**: there are no actual attacks, victims, or
> threat actors here. The layer must never present, record, or cite its events
> as real-world cyber activity. UI attribution always reads **"SIMULATED FEED"**
> while the simulated feed is active (the layer module sets
> `source: 'Simulated feed'`), and that wording must stay intact in-app and in
> screenshots/demos.
>
> An **opt-in live mode** (the "GO LIVE" chip on the layer row) renders real
> community threat intel through the same-origin `/api/cyber-feed` proxy (see
> "Live feed" below). Live attribution always reads
> **"CINS Army · blocklist.de · Spamhaus · OpenPhish"** — never
> "SIMULATED FEED". The two attributions must never mix.

## What it visualizes

The Cyber Intel layer gives the globe a network-operations-center feel: a
synthetic, real-time "attack map" of hostile activity flowing between major
internet/country hubs.

- **Attack arcs.** Each simulated event renders as a glowing arc from the
  source hub to the destination hub (`src` → `dst` coordinates), with the arc
  rising over the globe like classic threat-map visualizations.
- **Threat types.** Six event categories: `ddos`, `malware`, `intrusion`,
  `phishing`, `scan`, `c2`. Arcs are colored by type (scans cool/low-key,
  c2 rare and hot — see weights below).
- **Severity.** Each event carries a 1–5 severity (skewed low: most blips are
  minor). Severity scales arc intensity and feeds the HUD counters.
- **HUD stats.** The layer HUD shows per-tick event totals, breakdowns by
  threat type and severity, and top source/destination hubs — all computed
  live from the current simulated snapshot.

## Simulation model

The feed is `createSimulatedCyberFeed({ seed = 1337, eventsPerTick = 40 } = {})`,
returning `{ getSnapshot({ signal } = {}) }` — the same source interface as
`src/layers/earthquakes/source.js`. Every tick emits up to `eventsPerTick`
events with this exact schema:

```js
{
  id: 'cyber-<tick>-<n>',                 // unique per event
  src: { country, code, lat, lon },       // attacking hub
  dst: { country, code, lat, lon },       // target hub (always ≠ src)
  type: 'ddos' | 'malware' | 'intrusion' | 'phishing' | 'scan' | 'c2',
  severity: 1, // 1–5, skewed low
  ts: 1730000000000,                      // epoch ms, deterministic per tick
}
```

- **Seeded PRNG (mulberry32).** Each tick's events are a pure function of
  (seed, tick counter): a fresh PRNG instance is seeded from both, so the
  same seed always yields the same event stream — no wall clock, no timers,
  no global state, and nothing timing-dependent. Deterministic streams are
  what the tests (`simulator.test.mjs`) and repeatable demos rely on.
- **Hub list.** 12 major country hubs with approximate capital/metro
  coordinates: United States (Washington, D.C.), China (Beijing), Russia
  (Moscow), Germany (Berlin), United Kingdom (London), Brazil (São Paulo),
  India (New Delhi), Japan (Tokyo), South Korea (Seoul), Netherlands
  (Amsterdam), Singapore, Australia (Sydney). Source is chosen uniformly,
  destination uniformly from the remaining 11 (`src` ≠ `dst` always).
- **Threat-type weights.** Scans dominate the stream; c2 is rare:
  `scan` 0.40, `phishing` 0.20, `ddos` 0.15, `malware` 0.12, `intrusion` 0.10,
  `c2` 0.03.
- **Severity weights.** Skewed low: severity 1: 0.34, 2: 0.28, 3: 0.20,
  4: 0.12, 5: 0.06.
- **Abort support.** `getSnapshot` calls `signal?.throwIfAborted()` at the
  start, matching the other layer sources.
- **Timestamps.** Epoch-ms derived deterministically from (tick, per-event
  jitter) against a fixed anchor — so determinism is not broken by the clock.

Run the tests with:

```sh
node --test src/layers/cyber/simulator.test.mjs
```

## Free-tier notes

**Zero external dependencies.** The simulator makes no network calls (no
`fetch`, no HTTP/WebSocket), requires no API keys and no paid threat-intel
feeds (which can run hundreds of dollars per month and impose redistribution
restrictions). The Cyber Intel layer works out of the box, fully offline, on
the free tier — and it's the honest way to show a "live attack map" without
implying real attacks are being tracked.

## Live feed (phase 2) — `/api/cyber-feed`

> Deployed 2026-09-22 on the Pages project (`gods-eye-view`, production URL
> https://gods-eye-view-df2.pages.dev). The proxy is the Pages Advanced-Mode
> `_worker.js`; see [docs/DEPLOY.md](DEPLOY.md).

The in-app **live** mode (as opposed to the simulated feed above) fetches
real, keyless threat-intel data through a same-origin proxy, because the
upstream feeds don't send CORS headers and one of them rate-limits hard:

```
browser ──► GET https://gods-eye-view-df2.pages.dev/api/cyber-feed?limit=96
              (Cloudflare _worker.js → workers/cyber-feed-proxy.js)
```

### Exact JSON contract

`GET /api/cyber-feed` → `200` with:

```jsonc
{
  "live": true,                    // false only on total upstream failure
  "source": "cins,blocklist,spamhaus,openphish",  // sources that contributed
  "generated_at": 1730000000000,   // epoch ms the feed was assembled
  "cache_ttl_s": 60,
  "events": [
    {
      "id": "live-cins-1-12-229-231",       // stable, unique per indicator
      "src": { "country": "China", "code": "CN", "lat": 23.1181, "lon": 113.2539 },
      "dst": { "country": "Netherlands", "code": "NL", "lat": 52.3676, "lon": 4.9041 },
      "type": "intrusion",                  // one of the 6 simulator types
      "severity": 3,                        // 1–5
      "ts": 1730000000000,                  // epoch ms
      "ioc": "1.12.229.231",                // raw indicator (extra, ignored by validator)
      "ref": "https://cinsscore.com/"       // provenance (extra, ignored by validator)
    }
  ]
}
```

The event objects are **byte-compatible with the simulator's fixed contract**
(`src/layers/cyber/records.js`): the client re-validates them with
`normalizeCyberEvents(payload.events)` (malformed rows are dropped; proxy
extras like `ioc`/`ref` are stripped), and **falls back to the simulated feed
whenever `!res.ok || !payload.live`**.
On total upstream failure the proxy returns `502` with
`{ live: false, source: "", events: [], error: "<reason>" }`.
Optional query param: `?limit=N` (1–200, default 96).

### In-app client (`src/layers/cyber/liveFeed.js`)

`createLiveCyberFeed({ proxyUrl = '/api/cyber-feed', fetchImpl, maxEvents = 96 } = {})`
returns the same `{ getSnapshot({ signal }) }` interface as the simulator, so
it plugs into `createCyberSource` / `createCyberLayer` unchanged. Every
network call goes to the same-origin proxy
(`GET {proxyUrl}?limit={maxEvents}`) — never directly to the upstreams (no
CORS headers / aggressive rate limits) and never to a GeoIP service (the
proxy resolves hostile IPs server-side). Any proxy failure — unreachable
host, non-2xx status, invalid JSON, or a payload with `live: false` /
missing `events` — throws a descriptive error; the layer catches it and
falls back (below). All fetch behavior is covered by stubbed-fetch tests
(`liveFeed.test.mjs`); no test touches the network.

### Opt-in toggle and fallback (implemented in `src/layers/cyber/index.js`)

- **Simulated stays the default.** The live feed only activates through the
  layer's explicit opt-in toggle: the "GO LIVE" chip on the Cyber Intel layer
  row (`getRowControls()`), which calls `layer.setFeedMode('live')`. The chip
  is only exposed when the layer was constructed with a live source
  (`src/app/layers/cyber.js` wires `createLiveCyberFeed()` in).
- **Attribution flips with the mode.** `layer.source` / `getStats().source`
  read `'Simulated feed'` or `'CINS Army · blocklist.de · Spamhaus · OpenPhish'`
  (`LIVE_FEED_LABEL`); the HUD badge reads `SIMULATED FEED` or `LIVE FEED`
  (full live label on hover). Switching modes aborts in-flight requests and
  clears on-screen data, so the two attributions can never mix on screen.
- **Fallback.** If the live fetch fails, the layer logs a warning, reverts to
  the simulated feed in the same tick (attribution and chip flip back with
  it), keeps a one-tick stats note
  ("Live feed unavailable (…); showing simulated feed."), and renders
  simulated events. Aborts (disable/destroy/supersede) never trigger the
  fallback — only genuine proxy failures do.

### Upstream mapping (all keyless, no secrets)

| Feed | Indicator | Cyber `type` | Severity | Endpoint placement |
|---|---|---|---|---|
| CINS Army badguys (`cinsscore.com/list/ci-badguys.txt`) | hostile IP | `intrusion` | 3 | **src = real GeoIP** of the IP; dst = hub |
| blocklist.de all (`lists.blocklist.de/lists/all.txt`) | attacker IP (48 h) | `scan` | 2 | **src = real GeoIP**; dst = hub |
| Spamhaus DROP v4 (`spamhaus.org/drop/drop_v4.json`) | netblock (representative IP = network address) | `intrusion` | 3 | **src = real GeoIP**; dst = hub |
| OpenPhish public feed (`openphish.com/feed.txt`) | phishing URL | `phishing` | 3 | src/dst = hubs (see below) |

GeoIP: one `ip-api.com` batch POST (≤100 IPs, free tier 45 req/min) per feed
assembly; the assembled feed is cached at the edge for 60 s, so upstreams see
≈1 request/minute per PoP. Per-upstream 9 s timeouts; a dead source contributes
zero events instead of failing the whole feed.

### Honesty rules for the live feed

- **`src` is real** for IP indicators: the actual GeoIP location of a
  currently-flagged hostile IP. `dst` (the "victim") is **never known** to any
  feed — it is a deterministic FNV-1a hash pick from the same 12-hub list the
  simulator uses (always ≠ src country). Document this in any UI legend.
- **OpenPhish URLs can't be GeoIP'd** (the batch endpoint does no DNS), so
  phishing events use hash-picked hubs on both ends; the real phishing URL is
  preserved in `ioc`.
- **Severities are per-source defaults** (these feeds are unscored), not
  measured impact.
- **abuse.ch was evaluated and rejected**: ThreatFox (`threatfox-api.abuse.ch`)
  and URLhaus both returned `401 Unauthorized` without an `Auth-Key` as of
  2026-09-22 — signup-gated, so they violate the keyless/no-secrets rule.

## Attribution

- **Simulated (default).** In-app layer credit: **`Simulated feed`**
  (registered by the layer module — see DATA_SOURCES.md "In-app attribution";
  also listed in [DATA_SOURCES.md](DATA_SOURCES.md#simulated-sources-generated-locally--not-real-data)).
  Everywhere the simulated layer is documented or demoed, use the same
  language: **"SIMULATED FEED"** — never "live", "real-time threat data", or
  any wording that suggests genuine threat intelligence.
- **Live (opt-in).** In-app layer credit:
  **`CINS Army · blocklist.de · Spamhaus · OpenPhish`** (`LIVE_FEED_LABEL` in
  `src/layers/cyber/liveFeed.js`); the HUD badge reads **"LIVE FEED"** with the
  full label on hover. Listed in [DATA_SOURCES.md](DATA_SOURCES.md) under live
  sources. Live-mode screenshots must carry the live attribution — never the
  simulated wording.

## Click-to-inspect (phase 3b) — attack-source intel panel

Clicking an attack **source marker** (the small threat-colored point at the
arc's origin) — or the arc itself — opens a floating **location-intel panel**
(`src/ui/cyberIntelPanel.js`, styles appended to
`src/ui/styles/cyber.css` under `/* phase-3b intel panel */`). Clicking
empty space, the × button, or pressing Escape dismisses it. `LEFT_CLICK`
only fires on non-drag clicks, so globe rotate/zoom are unaffected.

The panel shows:

- **Attribution badge** — `SIMULATED FEED` (amber) or `LIVE FEED` (cyan),
  derived only from the feed mode captured with the event when it was
  published (`layer.getCyberEvent(id)`); simulated and live attributions
  can never mix, and the retained records reset on every feed switch.
- **IP** — the live indicator (`ioc`: the hostile IP, or the phishing URL
  for OpenPhish rows); the literal word `simulated` for simulated events.
- **Country, city, region, lat/lon, ISP, org, ASN** — GeoIP enrichment from
  the proxy's `ip-api.com` batch call (`city`, `regionName`, `isp`, `org`,
  `as` → `city/region/isp/org/asn` on the src endpoint, passed through
  `normalizeCyberEvents()`). Simulated hub sources carry no enrichment, so
  those rows honestly read **"n/a"** — the panel never invents data.
- **Threat type + severity.**
- **Map tabs** — "Street View" (default) and "Satellite", rendered as
  keyless Google embeds (`output=svembed` / `output=embed`, no API key):
  `https://maps.google.com/maps?q=&layer=c&cbll=LAT,LON&output=svembed`
  and `https://maps.google.com/maps?q=LAT,LON&z=17&t=k&output=embed`.
  Keyless coverage detection is unreliable, so instead of faking a "no
  coverage" state the panel captions that the Satellite tab is one click
  away.

Plumbing notes:

- `workers/cyber-feed-proxy.js` `geoipBatch()` requests the extra ip-api.com
  fields; enrichment is best-effort (GeoIP failure still falls back to
  hub endpoints).
- `src/layers/cyber/records.js` `normalizeEndpoint()` passes through
  optional `city/region/isp/org/asn` (trimmed strings; absent/malformed →
  omitted), and `normalizeEvent()` passes through optional `ioc`/`ref`
  provenance strings for the panel.
- `src/layers/cyber/rendering.js` adds `createSourceMarkerEntity()` (id
  `cyber:src:<id>`, static point graphics) and `resolveCyberPickEventId()`;
  `createCyberEntities()` now emits 3 entities per record (arc + source
  marker + destination marker) with the `CYBER_MAX_ARCS` cohort cap
  unchanged.
- `src/layers/cyber/index.js` retains last-published rows (`id → record`
  plus feed mode and source label) exposed as `getCyberEvent(id)`, and
  wires the `ScreenSpaceEventHandler` in `init()` (destroyed in
  `destroy()`; skipped when the viewer has no canvas, e.g. headless
  tests).
