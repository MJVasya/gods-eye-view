import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  isInitializeRequest,
} from '@modelcontextprotocol/sdk/types.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { createServer } from 'node:http';
import { requireBearerAuth } from './auth.js';
import { assertLoopbackBindHost, isLoopbackRemoteAddress } from './bind.js';
import { createBridgeHub } from './bridgeHub.js';
import { listV0McpTools, isV0McpTool } from './toolCatalog.js';
import {
  admitPresentationAction,
  DEFERRED_MCP_TOOLS,
} from './presentationProfile.js';

function redactSecrets(value) {
  if (value == null) return value;
  if (typeof value === 'string') {
    // Never echo env-looking assignments or long hex tokens.
    if (
      /(?:API[_-]?KEY|SECRET|TOKEN|PASSWORD)\s*=/i.test(value) ||
      (/^[a-f0-9]{32,}$/i.test(value) && value.length >= 32)
    ) {
      return '[redacted]';
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (typeof value === 'object') {
    const out = {};
    for (const [key, nested] of Object.entries(value)) {
      if (
        /(?:api[_-]?key|secret|token|password|authorization|credential)/i.test(
          key,
        )
      ) {
        out[key] = '[redacted]';
      } else {
        out[key] = redactSecrets(nested);
      }
    }
    return out;
  }
  return value;
}

function textResult(payload, isError = false) {
  const safe = redactSecrets(payload);
  return {
    content: [
      {
        type: 'text',
        text:
          typeof safe === 'string' ? safe : JSON.stringify(safe, null, 2),
      },
    ],
    isError,
  };
}

function createMcpServer({ bridge }) {
  const server = new Server(
    { name: 'gods-eye-view', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: listV0McpTools(),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args =
      request.params.arguments && typeof request.params.arguments === 'object'
        ? request.params.arguments
        : {};

    if (DEFERRED_MCP_TOOLS.includes(name)) {
      return textResult(
        {
          ok: false,
          error: `Tool "${name}" is deferred from MCP v0 (Security). Use in-app controls instead.`,
        },
        true,
      );
    }
    if (!isV0McpTool(name)) {
      return textResult(
        { ok: false, error: `Unknown or unregistered MCP tool: ${name}` },
        true,
      );
    }

    const admission = admitPresentationAction(name, args);
    if (!admission.ok) {
      return textResult({ ok: false, action: name, error: admission.error }, true);
    }

    try {
      const result = await bridge.dispatchAction(name, args);
      return textResult({ ok: true, action: name, result: redactSecrets(result) });
    } catch (error) {
      return textResult(
        {
          ok: false,
          action: name,
          error: String(error?.message || error),
          code: error?.code || undefined,
        },
        true,
      );
    }
  });

  return server;
}

/**
 * Start localhost-only MCP (Streamable HTTP) + loopback bridge.
 * @param {{ host?: string, port?: number, token: string, bridgePath?: string }} options
 */
export async function startGevMcpServer({
  host = '127.0.0.1',
  port = 3850,
  token,
  bridgePath = '/gev-bridge',
} = {}) {
  const bindHost = assertLoopbackBindHost(host, 'MCP');
  const app = createMcpExpressApp({ host: bindHost });
  /** @type {Map<string, StreamableHTTPServerTransport>} */
  const transports = new Map();

  // CORS deny-by-default: never set ACAO; reject browser CORS preflight.
  app.use((req, res, next) => {
    if (req.method === 'OPTIONS') {
      res.statusCode = 403;
      res.end('CORS preflight refused');
      return;
    }
    // Strip any framework CORS headers if present.
    const originalSetHeader = res.setHeader.bind(res);
    res.setHeader = (name, value) => {
      if (/^access-control-/i.test(String(name))) return res;
      return originalSetHeader(name, value);
    };
    next();
  });

  app.use((req, res, next) => {
    if (!isLoopbackRemoteAddress(req.socket?.remoteAddress)) {
      res.statusCode = 403;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'MCP answers only loopback clients' }));
      return;
    }
    next();
  });

  app.get('/health', (_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        ok: true,
        service: 'gods-eye-view-mcp',
        bind: bindHost,
        bridge: bridge?.status?.() || null,
      }),
    );
  });

  app.use('/mcp', requireBearerAuth(token));

  const httpServer = createServer(app);
  const bridge = createBridgeHub({ server: httpServer, path: bridgePath });

  const getServer = () => createMcpServer({ bridge });

  app.post('/mcp', async (req, res) => {
    try {
      const sessionId = req.headers['mcp-session-id'];
      let transport = sessionId ? transports.get(String(sessionId)) : undefined;

      if (transport) {
        await transport.handleRequest(req, res, req.body);
        return;
      }

      if (!sessionId && isInitializeRequest(req.body)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          enableJsonResponse: true,
          onsessioninitialized: (id) => {
            transports.set(id, transport);
          },
        });
        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid) transports.delete(sid);
        };
        const server = getServer();
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
        return;
      }

      // Stateless tool calls without prior session: one-shot transport.
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      const server = getServer();
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      res.on('close', () => {
        transport.close();
        server.close();
      });
    } catch (error) {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'Internal server error' },
            id: null,
          }),
        );
      }
      console.error('[gev-mcp] request error:', error?.message || error);
    }
  });

  app.get('/mcp', (_req, res) => {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method not allowed.' },
        id: null,
      }),
    );
  });

  app.delete('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];
    const transport = sessionId ? transports.get(String(sessionId)) : undefined;
    if (transport) {
      await transport.handleRequest(req, res);
      transports.delete(String(sessionId));
      return;
    }
    res.statusCode = 404;
    res.end();
  });

  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, bindHost, () => resolve());
  });

  const address = httpServer.address();
  return {
    host: bindHost,
    port: typeof address === 'object' && address ? address.port : port,
    bridgePath,
    bridge,
    async close() {
      bridge.close();
      for (const transport of transports.values()) {
        try {
          transport.close();
        } catch {
          /* ignore */
        }
      }
      transports.clear();
      await new Promise((resolve, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
