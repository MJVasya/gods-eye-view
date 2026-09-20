import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const TOKEN_ENV = 'GEV_MCP_TOKEN';
const TOKEN_FILE_NAME = '.gev-mcp-token';

/**
 * Resolve the required MCP bearer token.
 * Default-on: if unset, generate once into a gitignored repo-root file and
 * print only the file path (never the token value).
 * @param {{ env?: NodeJS.ProcessEnv, repoRoot: string, writeFile?: boolean }} options
 */
export function resolveMcpToken({
  env = process.env,
  repoRoot,
  writeFile = true,
} = {}) {
  const fromEnv = String(env[TOKEN_ENV] || '').trim();
  if (fromEnv) {
    return { token: fromEnv, source: 'env', path: null };
  }
  const tokenPath = path.join(repoRoot, TOKEN_FILE_NAME);
  try {
    const existing = fs.readFileSync(tokenPath, 'utf8').trim();
    if (existing) {
      return { token: existing, source: 'file', path: tokenPath };
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (!writeFile) {
    throw new Error(
      `${TOKEN_ENV} is required (default-on). Generate with: openssl rand -hex 32`,
    );
  }
  const token = randomBytes(32).toString('hex');
  fs.writeFileSync(tokenPath, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(tokenPath, 0o600);
  } catch {
    /* best-effort on platforms without chmod */
  }
  return { token, source: 'generated', path: tokenPath };
}

/** Compare bearer tokens in constant time. */
export function tokensEqual(expected, provided) {
  const a = Buffer.from(String(expected || ''), 'utf8');
  const b = Buffer.from(String(provided || ''), 'utf8');
  if (a.length === 0 || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Extract Bearer token from an Authorization header.
 * @param {string | string[] | undefined} header
 */
export function parseBearerToken(header) {
  const raw = Array.isArray(header) ? header[0] : header;
  const value = String(raw || '').trim();
  const match = /^Bearer\s+(\S+)$/i.exec(value);
  return match ? match[1] : null;
}

/**
 * Express/connect middleware: require Authorization Bearer matching token.
 * Does not echo the token or env contents.
 */
export function requireBearerAuth(token) {
  return (req, res, next) => {
    const provided = parseBearerToken(req.headers?.authorization);
    if (!tokensEqual(token, provided)) {
      res.statusCode = 401;
      res.setHeader('WWW-Authenticate', 'Bearer');
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32001, message: 'Unauthorized' },
          id: null,
        }),
      );
      return;
    }
    next();
  };
}

export { TOKEN_ENV, TOKEN_FILE_NAME };
