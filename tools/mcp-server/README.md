# Gods Eye View — localhost MCP server (v0)

Streamable HTTP MCP so chat agents (Cursor / Claude / ChatGPT / Grok-style) can
**present and control** the local globe. Camera and UI actions run in the
browser via `createGevActionRunner` — not through `/api/*` data proxies.

```
Chat agent --Streamable HTTP MCP--> gev-mcp (127.0.0.1)
                                      |
                               WS bridge /gev-bridge (loopback)
                                      |
                         GEV browser tab (runGevAction)
```

## Prerequisites

- Node.js matching the root `package.json` engines field
- Gods Eye View running in a browser tab (`npm run dev` or `./scripts/dev-fresh.sh`)
  - Default ports: **4173** (`dev-fresh.sh`) or **5173** (plain Vite). The bridge
    is outbound from the tab to `127.0.0.1:3850`, so either UI port works.

## Start

From the repository root:

```sh
npm run mcp
# or: npm run mcp:server
# or: npm --prefix tools/mcp-server start
```

Environment:

| Variable | Default | Notes |
| --- | --- | --- |
| `GEV_MCP_HOST` | `127.0.0.1` | **Hard-fail** if not loopback (`0.0.0.0` refused) |
| `GEV_MCP_PORT` | `3850` | MCP + bridge share this listen port |
| `GEV_MCP_TOKEN` | _(generated)_ | Bearer token (**default-on**). If unset, written to gitignored `.gev-mcp-token` |

Generate a token yourself:

```sh
openssl rand -hex 32
export GEV_MCP_TOKEN=...   # or put the same value in .gev-mcp-token
```

Endpoints:

- `POST http://127.0.0.1:3850/mcp` — Streamable HTTP MCP (Bearer required)
- `GET  http://127.0.0.1:3850/health` — liveness + bridge connected flag
- `WS   ws://127.0.0.1:3850/gev-bridge` — browser control bridge (loopback peers only)

## Client config examples

Replace `YOUR_TOKEN` with `GEV_MCP_TOKEN` or the contents of `.gev-mcp-token`.

### Cursor (`mcp.json`)

```json
{
  "mcpServers": {
    "gods-eye-view": {
      "url": "http://127.0.0.1:3850/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_TOKEN"
      }
    }
  }
}
```

### Claude Desktop / Claude Code (HTTP MCP)

```json
{
  "mcpServers": {
    "gods-eye-view": {
      "type": "http",
      "url": "http://127.0.0.1:3850/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_TOKEN"
      }
    }
  }
}
```

### ChatGPT / Grok-style custom MCP HTTP

Point the connector at `http://127.0.0.1:3850/mcp` with header
`Authorization: Bearer YOUR_TOKEN`. The server speaks MCP Streamable HTTP
(JSON response mode). It does not listen on the LAN.

## v0 tools

Shipped (names from `src/voice/actionSchemas.js`):

`fly_to_location`, `adjust_camera_zoom`, `zoom_to_globe`, `move_camera`,
`fly_route`, `frame_overhead`, `get_current_view_state`, `set_layer_visibility`,
`show_data_layers_menu`, `set_panel_open`, `set_map_stack`, `set_visual_style`,
`set_hud`, `control_scene`

Deferred (not registered): `control_cctv`, `control_radio`, `annotate_map`,
`clear_annotations`, `analyst_query`, `next_iss_pass`

Default **presentation profile** refuses `cctv` / `alpr-cameras` layer toggles
and the `cctv-panel`.

## Security summary

- Bind: loopback only (code hard-fail)
- Auth: Bearer token required on `/mcp`
- CORS: deny-by-default (preflight 403; no ACAO)
- Bridge: refuses non-loopback peers
- No tools read `.env` or return provider secrets
- Dedicated control channel — not piggybacked on `/api/*` data proxies

See root `SECURITY.md` § Localhost MCP.

## Follow-ups

- Optional tracking/context tools (`track_entity`, `get_entity_context`, …)
- Reviewed profile flag to allow CCTV/ALPR after Security sign-off
- Optional bridge token for shared-machine multi-user hosts
- Stdio transport wrapper if a client cannot speak Streamable HTTP

## Tests

```sh
npm --prefix tools/mcp-server test
```
