/**
 * @notice Divigent MCP server - read-only wallet analysis for Base agent wallets.
 *
 * The server has no private key, no wallet client, and no transaction execution
 * surface. Tools analyze wallet behavior and missed yield opportunity using
 * public Base mainnet data only.
 *
 * Transports:
 *   - stdio (default) - Claude Desktop, Claude Code, Cursor, MCP Inspector
 *   - http - stateless Streamable HTTP (port from MCP_PORT, default 3000)
 *
 * All diagnostic logging goes to stderr. stdout is reserved for the JSON-RPC
 * wire protocol on stdio.
 */

import { timingSafeEqual } from 'crypto';
import { realpathSync } from 'fs';
import type { IncomingMessage } from 'http';
import { isIP } from 'net';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  analyzeMissedYield,
  analyzeWalletBehavior,
  assertProtocolDeployed,
  evmAddress,
  type AnalyzeMissedYieldInput,
  type AnalyzeWalletBehaviorInput,
  type EvmAddress,
} from '@divigent/sdk';
import { z } from 'zod';

export const CHAIN = 'base' as const;
export const CHAIN_ID = 8453 as const;
export const DEFAULT_MAINNET_RPC_URL = 'https://mainnet.base.org';
export const DEFAULT_HTTP_HOST = '127.0.0.1';
export const DEFAULT_HTTP_PORT = 3000;
export const DEFAULT_HTTP_MAX_CONCURRENT_REQUESTS = 16;
export const MAX_HTTP_MAX_CONCURRENT_REQUESTS = 256;
export const MIN_HTTP_BEARER_TOKEN_LENGTH = 32;
export const MIN_HTTP_BEARER_TOKEN_SHANNON_BITS = 128;
export const MAX_HTTP_BODY_BYTES = 64 * 1024;
export const TOOL_NAMES = ['analyze_wallet_behavior', 'analyze_missed_yield'] as const;
export const SERVER_VERSION = '1.0.1';
export const SAFE_TOOL_ERROR_MESSAGE =
  'Divigent MCP tool failed while reading Base mainnet data. Error details were redacted; check MCP server logs.';

const LEVELS = ['trace', 'debug', 'info', 'warn', 'error'] as const;
type LogLevel = (typeof LEVELS)[number];

const ENV_LEVEL = ((): LogLevel => {
  const env = (process.env.MCP_LOG_LEVEL ?? 'info').toLowerCase();
  return (LEVELS as readonly string[]).includes(env) ? (env as LogLevel) : 'info';
})();

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
};

function log(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
  if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[ENV_LEVEL]) return;
  const ts = new Date().toISOString();
  const suffix = fields ? ` ${JSON.stringify(toLogSafe(fields))}` : '';
  process.stderr.write(`${ts} [${level.toUpperCase()}] ${message}${suffix}\n`);
}

const logger = {
  debug: (message: string, fields?: Record<string, unknown>) => log('debug', message, fields),
  info: (message: string, fields?: Record<string, unknown>) => log('info', message, fields),
  warn: (message: string, fields?: Record<string, unknown>) => log('warn', message, fields),
  error: (message: string, fields?: Record<string, unknown>) => log('error', message, fields),
};

type HttpSecurityConfig = {
  bearerToken: string | undefined;
  unsafeAllowUnauthenticated: boolean;
  unsafeAllowPublicUnauthenticated: boolean;
  allowedOrigins: ReadonlySet<string>;
};

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[(.*)\]$/, '$1');
  if (normalized === 'localhost' || normalized === '::1') return true;
  if (isIP(normalized) !== 4) return false;
  return normalized.split('.')[0] === '127';
}

function shannonEntropyBits(value: string): number {
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);

  let entropyPerChar = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropyPerChar -= probability * Math.log2(probability);
  }
  return entropyPerChar * value.length;
}

function isRepeatedPattern(value: string): boolean {
  for (let size = 1; size <= Math.floor(value.length / 2); size += 1) {
    if (value.length % size !== 0) continue;
    const pattern = value.slice(0, size);
    if (pattern.repeat(value.length / size) === value) return true;
  }
  return false;
}

export function validateHttpBearerToken(token: string): void {
  const weakTokenMessage =
    'MCP_HTTP_BEARER_TOKEN must be a generated high-entropy secret: at least 32 non-whitespace characters, not a placeholder, and estimated entropy >= 128 bits. Generate one with: openssl rand -hex 32';
  const normalized = token.toLowerCase();
  const placeholderTerms = [
    'admin',
    'bearer',
    'changeme',
    'change-me',
    'default',
    'divigent',
    'example',
    'password',
    'placeholder',
    'secret',
    'test',
    'token',
  ];

  if (
    token.length < MIN_HTTP_BEARER_TOKEN_LENGTH ||
    token.trim() !== token ||
    /\s/.test(token) ||
    isRepeatedPattern(token) ||
    placeholderTerms.some((term) => normalized.includes(term)) ||
    shannonEntropyBits(token) < MIN_HTTP_BEARER_TOKEN_SHANNON_BITS
  ) {
    throw new Error(weakTokenMessage);
  }
}

export function loadHttpSecurityConfig(
  env: NodeJS.ProcessEnv = process.env,
  host = env.MCP_HOST ?? DEFAULT_HTTP_HOST,
): HttpSecurityConfig {
  const bearerToken = env.MCP_HTTP_BEARER_TOKEN;
  const unsafeAllowUnauthenticated = env.MCP_HTTP_UNSAFE_ALLOW_UNAUTHENTICATED === 'true';
  const unsafeAllowPublicUnauthenticated =
    env.MCP_HTTP_UNSAFE_ALLOW_PUBLIC_UNAUTHENTICATED === 'true';
  const allowedOrigins = new Set(
    (env.MCP_HTTP_ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
  );

  if (!bearerToken && !unsafeAllowUnauthenticated) {
    throw new Error(
      'HTTP transport requires MCP_HTTP_BEARER_TOKEN. For local-only testing, set MCP_HTTP_UNSAFE_ALLOW_UNAUTHENTICATED=true explicitly.',
    );
  }
  if (bearerToken) validateHttpBearerToken(bearerToken);

  if (
    !bearerToken &&
    unsafeAllowUnauthenticated &&
    !isLoopbackHost(host) &&
    !unsafeAllowPublicUnauthenticated
  ) {
    throw new Error(
      'Unauthenticated HTTP transport is only allowed on loopback hosts. Set MCP_HTTP_BEARER_TOKEN for public bindings, or set MCP_HTTP_UNSAFE_ALLOW_PUBLIC_UNAUTHENTICATED=true for explicit public unauthenticated development.',
    );
  }

  return {
    bearerToken,
    unsafeAllowUnauthenticated,
    unsafeAllowPublicUnauthenticated,
    allowedOrigins,
  };
}

export function isAuthorizedHeader(
  authorization: string | string[] | undefined,
  config: HttpSecurityConfig,
): boolean {
  if (!config.bearerToken) return config.unsafeAllowUnauthenticated;
  if (Array.isArray(authorization)) return false;
  const prefix = 'Bearer ';
  if (!authorization?.startsWith(prefix)) return false;

  const candidateBytes = Buffer.from(authorization.slice(prefix.length).trim());
  const expectedBytes = Buffer.from(config.bearerToken);
  if (candidateBytes.length !== expectedBytes.length) return false;
  return timingSafeEqual(candidateBytes, expectedBytes);
}

export function isOriginAllowed(
  origin: string | string[] | undefined,
  config: HttpSecurityConfig,
): boolean {
  if (!origin) return true;
  if (Array.isArray(origin)) return false;
  if (config.allowedOrigins.size === 0) return false;
  return config.allowedOrigins.has(origin);
}

export const evmAddressField = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, 'must be a 0x-prefixed 20-byte hex address')
  .describe('0x-prefixed EVM address.');

export const lookbackDaysField = z
  .number()
  .int()
  .min(1)
  .max(90)
  .optional()
  .describe('Optional analysis window in days. Defaults to the SDK default.');

export const assumedApyField = z
  .number()
  .min(0)
  .max(1)
  .optional()
  .describe('Optional assumed yield APY as a decimal, e.g. 0.045 for 4.5%.');

export const minOperatingBalanceField = z
  .string()
  .max(40, 'must be 40 characters or fewer')
  .regex(/^\d+(\.\d{1,6})?$/, 'must be a decimal USDC string with max 6 decimals')
  .optional()
  .describe('Optional minimum operating balance to reserve, as a USDC decimal string.');

export const analyzeWalletBehaviorSchema = z.object({
  wallet: evmAddressField,
  lookbackDays: lookbackDaysField,
}).strict();

export const analyzeMissedYieldSchema = z.object({
  wallet: evmAddressField,
  lookbackDays: lookbackDaysField,
  assumedApy: assumedApyField,
  minOperatingBalance: minOperatingBalanceField,
}).strict();

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: Record<string, unknown>;
};

export function toJsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map((item) => toJsonSafe(item));
  if (value === null || typeof value !== 'object') return value;

  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (nested !== undefined) out[key] = toJsonSafe(nested);
  }
  return out;
}

function redactHttpUrlForLog(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    return `${url.protocol}//${url.host}/[REDACTED]`;
  } catch {
    return rawUrl.replace(
      /^(https?:\/\/)(?:[^/?#\s"']*@)?([^/?#\s"']+)[^\s"']*$/i,
      '$1$2/[REDACTED]',
    );
  }
}

export function redactString(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/https?:\/\/[^\s"']*/gi, (url) => redactHttpUrlForLog(url))
    .replace(/(0x)[a-fA-F0-9]{64}/g, '$1[REDACTED_SECRET]');
}

function toLogSafe(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map((item) => toLogSafe(item));
  if (value instanceof Error) {
    const out: Record<string, unknown> = {
      name: value.name,
      message: redactString(value.message),
    };
    if (value.stack) out.stack = redactString(value.stack).slice(0, 4_000);
    if (value.cause !== undefined) out.cause = toLogSafe(value.cause);
    return out;
  }
  if (value === null || typeof value !== 'object') return value;

  const out: Record<string, unknown> = {};
  for (const [nestedKey, nested] of Object.entries(value as Record<string, unknown>)) {
    if (nested === undefined) continue;
    if (/(authorization|bearer|token|secret|private|password|api[_-]?key|rpc[_-]?url)/i.test(nestedKey)) {
      out[nestedKey] = '[REDACTED]';
    } else {
      out[nestedKey] = toLogSafe(nested);
    }
  }
  return out;
}

export function sanitizeToolErrorForModel(_err: unknown): Error {
  return new Error(SAFE_TOOL_ERROR_MESSAGE);
}

function withSafeToolErrors<TArgs>(
  toolName: string,
  handler: (args: TArgs) => Promise<ToolResult> | ToolResult,
): (args: TArgs) => Promise<ToolResult> {
  return async (args) => {
    try {
      return await handler(args);
    } catch (err) {
      logger.warn('mcp tool handler failed', { tool: toolName, err });
      throw sanitizeToolErrorForModel(err);
    }
  };
}

export function text(data: Record<string, unknown>): ToolResult {
  const structuredContent = toJsonSafe(data) as Record<string, unknown>;
  return {
    structuredContent,
    content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }],
  };
}

export function validateChainEnvironment(env: NodeJS.ProcessEnv = process.env): void {
  if (env.DIVIGENT_CHAIN !== undefined && env.DIVIGENT_CHAIN !== CHAIN) {
    throw new Error(
      `DIVIGENT_CHAIN must be '${CHAIN}' for this Base-mainnet-only MCP server, got '${env.DIVIGENT_CHAIN}'. Remove stale testnet configuration before starting.`,
    );
  }

  if (env.BASE_SEPOLIA_RPC_URL !== undefined) {
    throw new Error(
      'BASE_SEPOLIA_RPC_URL is not supported by this Base-mainnet-only MCP server. Use BASE_MAINNET_RPC_URL or BASE_RPC_URL.',
    );
  }

  if (env.READ_RPC_URL !== undefined) {
    throw new Error(
      'READ_RPC_URL is a legacy RPC variable and is not supported. Use BASE_MAINNET_RPC_URL or BASE_RPC_URL.',
    );
  }
}

export function resolveRpcUrl(env: NodeJS.ProcessEnv = process.env): string {
  validateChainEnvironment(env);
  return env.BASE_MAINNET_RPC_URL ?? env.BASE_RPC_URL ?? DEFAULT_MAINNET_RPC_URL;
}

type Runtime = {
  chain: typeof CHAIN;
  chainId: typeof CHAIN_ID;
  readRpc: string;
};

export async function loadRuntime(): Promise<Runtime> {
  assertProtocolDeployed(CHAIN);
  const readRpc = resolveRpcUrl();

  logger.info('divigent MCP runtime initialised', {
    chain: CHAIN,
    chainId: CHAIN_ID,
    rpcSource: readRpc === DEFAULT_MAINNET_RPC_URL ? 'default' : 'env',
  });

  return {
    chain: CHAIN,
    chainId: CHAIN_ID,
    readRpc,
  };
}

export function parsePort(value: string): number {
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`MCP_PORT must be an integer from 1 to 65535, got '${value}'`);
  }
  return port;
}

export function parseHttpMaxConcurrentRequests(value: string): number {
  const maxConcurrentRequests = Number.parseInt(value, 10);
  if (
    !/^\d+$/.test(value) ||
    !Number.isInteger(maxConcurrentRequests) ||
    maxConcurrentRequests < 1 ||
    maxConcurrentRequests > MAX_HTTP_MAX_CONCURRENT_REQUESTS
  ) {
    throw new Error(
      `MCP_HTTP_MAX_CONCURRENT_REQUESTS must be an integer from 1 to ${MAX_HTTP_MAX_CONCURRENT_REQUESTS}, got '${value}'`,
    );
  }
  return maxConcurrentRequests;
}

type JsonBodyReadResult =
  | { ok: true; body: unknown }
  | { ok: false; status: number; error: string };

export async function readJsonBodyWithLimit(
  req: IncomingMessage,
  maxBytes = MAX_HTTP_BODY_BYTES,
): Promise<JsonBodyReadResult> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > maxBytes) {
      req.destroy();
      return { ok: false, status: 413, error: 'request body too large' };
    }
    chunks.push(buffer);
  }

  try {
    return { ok: true, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown };
  } catch {
    return { ok: false, status: 400, error: 'invalid json' };
  }
}

function walletBehaviorInput(
  runtime: Runtime,
  wallet: EvmAddress,
  lookbackDays: number | undefined,
): AnalyzeWalletBehaviorInput {
  const input: AnalyzeWalletBehaviorInput = {
    wallet,
    chainId: runtime.chainId,
    rpcUrl: runtime.readRpc,
  };
  if (lookbackDays !== undefined) input.lookbackDays = lookbackDays;
  return input;
}

function missedYieldInput(
  runtime: Runtime,
  args: z.infer<typeof analyzeMissedYieldSchema>,
): AnalyzeMissedYieldInput {
  const input: AnalyzeMissedYieldInput = {
    wallet: evmAddress(args.wallet),
    chainId: runtime.chainId,
    rpcUrl: runtime.readRpc,
  };
  if (args.lookbackDays !== undefined) input.lookbackDays = args.lookbackDays;
  if (args.assumedApy !== undefined) input.assumedApy = args.assumedApy;
  if (args.minOperatingBalance !== undefined) input.minOperatingBalance = args.minOperatingBalance;
  return input;
}

export function buildServer(runtime: Runtime, options: { log?: boolean } = {}): McpServer {
  const server = new McpServer({
    name: 'divigent-mcp',
    version: SERVER_VERSION,
  });

  server.registerTool(
    'analyze_wallet_behavior',
    {
      description:
        'Read-only analysis of Base mainnet USDC wallet behavior for x402 agent wallets.',
      inputSchema: analyzeWalletBehaviorSchema,
    },
    withSafeToolErrors('analyze_wallet_behavior', async (args) => {
      const wallet = evmAddress(args.wallet);
      const report = await analyzeWalletBehavior(
        walletBehaviorInput(runtime, wallet, args.lookbackDays),
      );
      return text({
        tool: 'analyze_wallet_behavior',
        chain: runtime.chain,
        chainId: runtime.chainId,
        wallet,
        report,
        safety: {
          readOnly: true,
          execution: false,
        },
      });
    }),
  );

  server.registerTool(
    'analyze_missed_yield',
    {
      description:
        'Read-only estimate of idle USDC and missed yield opportunity for a Base mainnet wallet.',
      inputSchema: analyzeMissedYieldSchema,
    },
    withSafeToolErrors('analyze_missed_yield', async (args) => {
      const wallet = evmAddress(args.wallet);
      const report = await analyzeMissedYield(missedYieldInput(runtime, args));
      return text({
        tool: 'analyze_missed_yield',
        chain: runtime.chain,
        chainId: runtime.chainId,
        wallet,
        report,
        safety: {
          readOnly: true,
          execution: false,
        },
      });
    }),
  );

  if (options.log !== false) logger.info('mcp server constructed', { tools: [...TOOL_NAMES] });
  return server;
}

type McpServerPool = {
  capacity: number;
  active: number;
  available: number;
  acquire(): McpServer | undefined;
  release(server: McpServer): void;
  closeAll(): Promise<void>;
};

export function createMcpServerPool(runtime: Runtime, size: number): McpServerPool {
  const all = Array.from({ length: size }, () => buildServer(runtime, { log: false }));
  const available = [...all];
  const inUse = new Set<McpServer>();

  return {
    get capacity() {
      return all.length;
    },
    get active() {
      return inUse.size;
    },
    get available() {
      return available.length;
    },
    acquire() {
      const server = available.pop();
      if (!server) return undefined;
      inUse.add(server);
      return server;
    },
    release(server) {
      if (!inUse.delete(server)) return;
      available.push(server);
    },
    async closeAll() {
      await Promise.all(all.map((server) => server.close()));
    },
  };
}

async function runStdio(runtime: Runtime): Promise<void> {
  const server = buildServer(runtime);
  const stdio = new StdioServerTransport();
  await server.connect(stdio);
  logger.info('mcp server listening on stdio');
}

async function runHttp(runtime: Runtime): Promise<void> {
  const { StreamableHTTPServerTransport } = await import(
    '@modelcontextprotocol/sdk/server/streamableHttp.js'
  );
  const httpServerModule = await import('http');

  const port = parsePort(process.env.MCP_PORT ?? String(DEFAULT_HTTP_PORT));
  const host = process.env.MCP_HOST ?? DEFAULT_HTTP_HOST;
  const httpSecurity = loadHttpSecurityConfig(process.env, host);
  const maxConcurrentRequests = parseHttpMaxConcurrentRequests(
    process.env.MCP_HTTP_MAX_CONCURRENT_REQUESTS ??
      String(DEFAULT_HTTP_MAX_CONCURRENT_REQUESTS),
  );
  const serverPool = createMcpServerPool(runtime, maxConcurrentRequests);
  logger.info('mcp http server pool constructed', {
    capacity: serverPool.capacity,
    tools: [...TOOL_NAMES],
  });

  const httpServer = httpServerModule.createServer(async (req, res) => {
    let server: McpServer | undefined;
    let transport:
      | InstanceType<typeof StreamableHTTPServerTransport>
      | undefined;
    let closedTransport = false;
    const closeTransport = async (): Promise<void> => {
      if (closedTransport) return;
      closedTransport = true;
      if (transport) await transport.close();
      if (server) await server.close();
    };

    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);

      if (url.pathname !== '/' && url.pathname !== '/mcp' && url.pathname !== '/healthz') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }

      const origin = req.headers.origin;
      if (!isOriginAllowed(origin, httpSecurity)) {
        res.writeHead(403, { 'Content-Type': 'application/json', Vary: 'Origin' });
        res.end(JSON.stringify({ error: 'origin not allowed' }));
        return;
      }
      if (origin && typeof origin === 'string') {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
      }

      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Headers': 'authorization, content-type, mcp-session-id',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
        });
        res.end();
        return;
      }

      if (!isAuthorizedHeader(req.headers.authorization, httpSecurity)) {
        res.writeHead(401, {
          'Content-Type': 'application/json',
          'WWW-Authenticate': 'Bearer realm="divigent-mcp"',
        });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/healthz') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }

      if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'method not allowed' }));
        return;
      }

      server = serverPool.acquire();
      if (!server) {
        res.writeHead(503, {
          'Content-Type': 'application/json',
          'Retry-After': '1',
        });
        res.end(JSON.stringify({ error: 'server busy' }));
        return;
      }

      const parsedBody = await readJsonBodyWithLimit(req);
      if (!parsedBody.ok) {
        res.writeHead(parsedBody.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: parsedBody.error }));
        return;
      }

      const transportOptions = {
        sessionIdGenerator: undefined,
      } as unknown as ConstructorParameters<typeof StreamableHTTPServerTransport>[0];
      transport = new StreamableHTTPServerTransport(transportOptions);
      res.once('close', () => {
        void closeTransport();
      });
      await server.connect(transport as unknown as Parameters<McpServer['connect']>[0]);
      await transport.handleRequest(req, res, parsedBody.body);
    } catch (err) {
      logger.error('http request failed', {
        err: err instanceof Error ? err.message : String(err),
      });
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal error' }));
      }
    } finally {
      try {
        await closeTransport();
      } catch (err) {
        logger.warn('http transport cleanup failed', {
          err: err instanceof Error ? err.message : String(err),
        });
      }
      if (server) serverPool.release(server);
    }
  });

  httpServer.listen(port, host, () => {
    logger.info('mcp server listening on http', {
      host,
      port,
      auth: httpSecurity.bearerToken ? 'bearer' : 'unsafe-disabled',
      maxConcurrentRequests: serverPool.capacity,
    });
  });

  const shutdown = (signal: string): void => {
    logger.info('shutting down', { signal });
    httpServer.close((err) => {
      if (err) logger.error('http close error', { err: err.message });
      serverPool.closeAll()
        .catch((closeErr) => {
          logger.error('mcp server pool close error', {
            err: closeErr instanceof Error ? closeErr.message : String(closeErr),
          });
        })
        .finally(() => process.exit(err ? 1 : 0));
    });
    setTimeout(() => process.exit(1), 5_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

export async function main(): Promise<void> {
  const runtime = await loadRuntime();
  const transport = (process.env.MCP_TRANSPORT ?? 'stdio').toLowerCase();

  if (transport === 'stdio') {
    await runStdio(runtime);
    return;
  }

  if (transport === 'http') {
    await runHttp(runtime);
    return;
  }

  throw new Error(`Unknown MCP_TRANSPORT '${transport}'. Use 'stdio' or 'http'.`);
}

function isMainModule(metaUrl = import.meta.url, argv1 = process.argv[1]): boolean {
  if (argv1 === undefined) return false;
  return realpathSync(fileURLToPath(metaUrl)) === realpathSync(resolve(argv1));
}

if (isMainModule()) {
  process.on('unhandledRejection', (reason) => {
    logger.error('unhandled rejection', {
      reason: reason instanceof Error ? reason.message : String(reason),
    });
  });

  main().catch((err) => {
    logger.error('fatal', {
      err: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  });
}
