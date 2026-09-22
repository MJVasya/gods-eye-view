# Deploying the Cyber Intel app to Cloudflare Pages

> Status (2026-09-22): **deployed and verified.** All free tier, no secrets.

## What is live

| Item | Value |
|---|---|
| Pages project | `gods-eye-view` (account `f9ed887c50c448dcd30081d653c39d13`) |
| Production URL | **https://gods-eye-view-df2.pages.dev** |
| Latest deployment | https://b5126117.gods-eye-view-df2.pages.dev |
| Production branch | `cyber-layer` |
| Proxy endpoint | **https://gods-eye-view-df2.pages.dev/api/cyber-feed** |

⚠️ The bare `gods-eye-view.pages.dev` subdomain belongs to a *different*
Cloudflare account's project — Cloudflare auto-suffixed ours with `-df2`.
Always use the `-df2` URLs above.

## Architecture

Cloudflare Pages **Advanced Mode**: a single `_worker.js` (repo root) handles
every request — `/api/cyber-feed*` goes to the threat-feed proxy
(`workers/cyber-feed-proxy.js`), everything else is served from the static
build via the Pages-provided `ASSETS` binding. One deployment, same origin,
no CORS problem, no custom domain needed.

```
browser ──► https://gods-eye-view-df2.pages.dev/
                ├─ /api/cyber-feed ──► proxy ──► CINS / blocklist.de /
                │                                  Spamhaus DROP / OpenPhish
                │                                  (+ ip-api.com GeoIP batch)
                └─ /* ──► static SPA (dist/)
```

## Redeploy (normal path)

```sh
npm run build
python3 scripts/pages-direct-upload.py --project gods-eye-view --branch cyber-layer
```

The script replicates `wrangler pages deploy` against the Direct Upload API
(no wrangler needed; auth via the connected `custom.cloudflare` credential):

1. Bundles repo-root `_worker.js` with esbuild → `dist/_worker.js`
   (also the artifact a future git-connected Pages project would use).
2. Hashes every file in `dist/` with wrangler's exact content hash
   (`blake3(base64(content) + ext)[:32]` — asserted against wrangler's own
   test vector at startup; requires the `blake3` pip package).
3. Creates the Pages project if missing (`production_branch` = `--branch`).
4. Uploads only missing assets via the JWT flow
   (`upload-token` → `check-missing` → `assets/upload` → `upsert-hashes`).
5. Creates the deployment (multipart: `manifest` + `branch` + `_worker.bundle`,
   where `_worker.bundle` is the Worker-upload form wrapping the bundle).
6. Polls until the deployment succeeds and prints the URLs.

`npm run build` wipes `dist/` (including the bundled `_worker.js`), so always
re-run the script after a rebuild — it regenerates everything it needs.

## Dashboard fallback (if the API path ever fails)

If the API token lacks Pages permission, do this by hand:

**SPA (Upload assets):**
1. Cloudflare dashboard → **Workers & Pages** → **Create** → **Pages** tab → **Upload assets**.
2. Name the project `gods-eye-view`, continue.
3. Drag in the contents of `dist/` **plus** the bundled `_worker.js`
   (build it first: `node_modules/.bin/esbuild _worker.js --bundle --format=esm --platform=neutral --outfile=dist/_worker.js`, then upload the whole `dist/` folder).
4. Deploy. The `_worker.js` file in the upload switches the project to
   Advanced Mode automatically; `/api/cyber-feed` will be served by it.

**Standalone proxy Worker (optional alternate):**
1. **Workers & Pages** → **Create** → **Workers** → **Create Worker**,
   name it `cyber-feed-proxy`.
2. Replace the starter code with `workers/cyber-feed-proxy.js` (it exports a
   default `fetch` handler; no bindings, no secrets) and deploy.
   Or: `npx wrangler deploy` from the repo root (uses `wrangler.toml`).
3. To expose it at `/api/cyber-feed` on a custom domain, add a route:
   **Workers** → `cyber-feed-proxy` → **Settings** → **Domains & Routes** →
   **Add** → route `cyber.example.com/api/cyber-feed*` (needs a zone on the
   account). The Pages Advanced-Mode path above is preferred — it needs no
   custom domain.

## Free-tier notes

- Pages: unlimited requests/sites on the free plan.
- Workers (proxy runs inside the Pages deployment): 100k requests/day free —
  the 60 s edge cache keeps real usage to ~1 upstream round-trip per minute
  per PoP, far below the limit.
- All upstream APIs are keyless and free: CINS, blocklist.de, Spamhaus DROP,
  OpenPhish, ip-api.com batch (45 req/min free).
- abuse.ch ThreatFox/URLhaus were evaluated and **rejected**: both now require
  a personal Auth-Key (signup), which violates the no-secrets constraint.

## Troubleshooting

- **Wrong site on `gods-eye-view.pages.dev`** — that bare subdomain is another
  account's project. Ours is `gods-eye-view-df2.pages.dev` (see the
  `subdomain` field on the project).
- **`/api/cyber-feed` returns the SPA HTML** — the `_worker.bundle` didn't
  attach; redeploy via the script and confirm the deploy log shows the
  worker bundle step.
- **502 `{"live": false, ...}`** — all upstreams failed simultaneously; the
  layer should fall back to the simulated feed (see docs/CYBER_INTEL.md).
  Check upstream reachability from the sandbox with curl.
