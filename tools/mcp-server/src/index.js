#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveMcpToken, TOKEN_ENV, TOKEN_FILE_NAME } from './auth.js';
import { assertLoopbackBindHost } from './bind.js';
import { startGevMcpServer } from './mcpApp.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');

async function main() {
  const host = assertLoopbackBindHost(
    process.env.GEV_MCP_HOST || '127.0.0.1',
    'MCP',
  );
  const port = Number.parseInt(process.env.GEV_MCP_PORT || '3850', 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('GEV_MCP_PORT must be an integer 1–65535');
  }

  const { token, source, path: tokenPath } = resolveMcpToken({ repoRoot });
  if (source === 'generated') {
    console.error(
      `[gev-mcp] Generated ${TOKEN_ENV} into ${TOKEN_FILE_NAME} (gitignored). Pass it as Authorization: Bearer <token> from your MCP client. Do not commit this file.`,
    );
    console.error(`[gev-mcp] Token file: ${tokenPath}`);
  } else if (source === 'file') {
    console.error(
      `[gev-mcp] Using bearer token from ${TOKEN_FILE_NAME} (set ${TOKEN_ENV} to override).`,
    );
  } else {
    console.error(`[gev-mcp] Using bearer token from ${TOKEN_ENV}.`);
  }

  const started = await startGevMcpServer({ host, port, token });
  console.error(
    `[gev-mcp] Streamable HTTP MCP on http://${started.host}:${started.port}/mcp`,
  );
  console.error(
    `[gev-mcp] Browser bridge WS on ws://${started.host}:${started.port}${started.bridgePath} (loopback only)`,
  );
  console.error(
    '[gev-mcp] Start Gods Eye View in a browser tab so tools can drive the globe.',
  );

  const shutdown = async () => {
    try {
      await started.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error(`[gev-mcp] ${error?.message || error}`);
  process.exit(1);
});
