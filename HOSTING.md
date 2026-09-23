# Hosting map

Updated: 2026-09-23

Three different surfaces share the God's Eye View name. Do not treat them as one app.

## 1. This repository (Cesium fork)

- Repo: `MJVasya/gods-eye-view` (private fork of `bilawalsidhu/gods-eye-view`)
- Default branch: `main` @ `2d72763` (20 Sep 2026) — includes `feat/localhost-mcp`
- Runtime: Vite 6 + Cesium 1.124, Node 24.14 / 26 only
- Real config: `server/standalone/vite.config.js`
- Live layers: `server/providers/*` same-origin proxies from the Vite process
- Client-visible keys only: `GOOGLE_MAPS_API_KEY`, `CESIUM_ION_TOKEN`
- MCP (`/gev-bridge`) is loopback + bearer token only. Do not publish it.

Upstream `main` has moved on (Recent Imagery, weather stack, tap-address SSRF contract, transit heading fixes). Rebase or merge before rewriting providers for Workers.

## 2. Cloudflare Pages you control (Cesium static SPA)

| URL | What it is |
| --- | --- |
| https://godseye.digishield.org | Production alias |
| https://gods-eye-view-df2.pages.dev | Project subdomain |
| Pages project | `gods-eye-view` |
| Production branch setting | `cyber-layer` |

This is a **static build of the Cesium client**. It can show the globe and HUD. It cannot run `server/providers/*` (OpenAI realtime token, AISStream, OpenSky OAuth, FIRMS, CCTV relay, GTFS protobuf decode). Those die without a Node broker or a Worker rewrite.

Do **not** `wrangler pages deploy` the Vite preview server.

Workable split if you want live data on Cloudflare:

1. Pages: `vite build` output only. Restrict Google / Cesium tokens by HTTP referrer + `assets:read`.
2. Workers + KV / Durable Object: one allowlisted proxy per `server/providers/*` route, body caps, per-IP limits. In-memory `GEV_RATELIMIT_*` will not survive isolates.
3. Gate `/api/realtime/token`, AIS websockets, and any Google server key with Cloudflare Access.
4. Keep MCP on localhost. Never put `/gev-bridge` on Pages.

## 3. Hormuz console (different codebase)

| URL | What it is |
| --- | --- |
| https://gods-eye-view.pages.dev | Three.js + OpenLayers Strait of Hormuz dashboard |

This is **not** this GitHub repo. It is a scenario console with hardcoded AIS, a LAN Situation Monitor (`http://192.168.68.115:8000`), browser OpenSky (CORS fail), and a low-res globe canvas.

It is also **not** the Pages project on the GoGoL.me Cloudflare account. Fixes for LAN API / OpenSky Worker / favicon / provenance belong in that Hormuz source tree, not here.

## 4. gev.pages.dev

Public Worker-proxy landing page (VLESS / Trojan). Not the globe. If that project is yours and unused for GEV, take it down and rotate the UUID. Do not reuse that hostname for the Cesium app.

## Local vs static vs Workers

| Mode | Command / host | Live layers | MCP |
| --- | --- | --- | --- |
| Local Vite | `npm run doctor` then `npm run dev` on loopback | Yes, via Node providers | Yes, localhost only |
| Static Pages | `npm run build` → Pages assets | No, except browser-safe public APIs (USGS) | No |
| Future Workers | Pages assets + Worker proxies | Yes, if each provider is rewritten | No |

## Branding

`index.html` uses `/logo.svg` from `public/logo.svg`. Kampanei crawler marks from the NetInfoShield branding pass are not in this repo. Put cache-busted names in `public/` of whichever tree actually deploys.

## Smoke checklist (Pages Cesium URL)

- `/logo.svg` returns `image/svg+xml`, not HTML
- `/favicon.ico` is not the SPA fallback HTML
- No `http://192.168.*` in shipped JS
- Situation / AIS / flights that need secrets stay at 0 or "unavailable" on static Pages — that is expected until Workers exist
