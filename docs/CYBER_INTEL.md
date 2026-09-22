# Cyber Intel layer

> ⚠️ **ALL DATA IN THIS LAYER IS SIMULATED.** Every event is generated in-repo
> by a seeded pseudorandom simulator (`src/layers/cyber/simulator.js`). It is
> **not real threat intelligence**: there are no actual attacks, victims, or
> threat actors here. The layer must never present, record, or cite its events
> as real-world cyber activity. UI attribution always reads **"SIMULATED FEED"**
> (the layer module sets `source: 'Simulated feed'`), and that wording must
> stay intact in-app and in screenshots/demos.

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

## Attribution

- In-app layer credit: **`Simulated feed`** (registered by the layer module —
  see DATA_SOURCES.md "In-app attribution"; also listed in
  [DATA_SOURCES.md](DATA_SOURCES.md#simulated-sources-generated-locally--not-real-data)).
- Everywhere the layer is documented or demoed, use the same language:
  **"SIMULATED FEED"** — never "live", "real-time threat data", or any wording
  that suggests genuine threat intelligence.
