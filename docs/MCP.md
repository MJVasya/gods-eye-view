# Localhost MCP (Gods Eye View)

See the full runbook and client configs in [`tools/mcp-server/README.md`](../tools/mcp-server/README.md).

Quick start:

1. Start the app: `./scripts/dev-fresh.sh` (port **4173**) or `npm run dev` (port **5173**).
2. Start MCP: `npm run mcp` (binds **127.0.0.1:3850**, Bearer token default-on).
3. Point your MCP HTTP client at `http://127.0.0.1:3850/mcp` with `Authorization: Bearer <token>`.

The browser tab connects automatically to `ws://127.0.0.1:3850/gev-bridge` and
dispatches tools through `createGevActionRunner`. Overrides via `?gevMcpBridge=` or
`window.__GEV_MCP_BRIDGE_URL__` are restricted to **loopback WebSocket URLs only**
(`127.0.0.1` / `::1` / `localhost`); anything else is ignored. If no tab is connected,
tools return an actionable error.
