/**
 * @notice Divigent MCP server - read tools + unsigned transaction planning.
 *
 * Single-file implementation. The server has NO private key and exposes NO
 * tool that signs, sends, or broadcasts a transaction. Planning tools pass a
 * wallet-shaped address object into the SDK so viem can simulate calls from the
 * user's address, then return unsigned calldata for an external wallet to
 * review and submit.
 *
 * Transports:
 *   - stdio (default) - Claude Desktop, Cursor, MCP Inspector
 *   - http - stateless Streamable HTTP (port from MCP_PORT, default 3000)
 *
 * All diagnostic logging goes to stderr. stdout is reserved for the JSON-RPC
 * wire protocol on stdio.
 */

import { timingSafeEqual } from 'crypto';
import { readFileSync, realpathSync } from 'fs';
import type { IncomingMessage } from 'http';
import { isIP } from 'net';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  Divigent,
  ZERO_ADDRESS,
  assertProtocolDeployed,
  evmAddress,
  formatUsdc,
  getChainConfig,
  parseUsdc,
  type ChainConfig,
  type DivigentConfig,
  type DivigentChain,
  type EvmAddress,
} from '@divigent/sdk';
import { createPublicClient, encodeFunctionData, http } from 'viem';
import type { Hex } from 'viem';
import { z } from 'zod';

export const SUPPORTED_CHAINS = ['base', 'base-sepolia'] as const satisfies readonly DivigentChain[];
export const DEFAULT_CHAIN: DivigentChain = 'base';
export const CHAIN = DEFAULT_CHAIN;
export const DEFAULT_MAINNET_RPC_URL = 'https://mainnet.base.org';
export const DEFAULT_SEPOLIA_RPC_URL = 'https://sepolia.base.org';
export const DEFAULT_RPC_URL = DEFAULT_MAINNET_RPC_URL;
export const DEFAULT_MAX_PLAN_USDC = '100';
export const DEFAULT_MAX_SLIPPAGE_BPS = 500;
export const DEFAULT_HTTP_HOST = '127.0.0.1';
export const DEFAULT_HTTP_PORT = 3000;
export const DEFAULT_HTTP_MAX_CONCURRENT_REQUESTS = 16;
export const MAX_HTTP_MAX_CONCURRENT_REQUESTS = 256;
export const MAX_HTTP_BODY_BYTES = 64 * 1024;
export const MIN_HTTP_BEARER_TOKEN_LENGTH = 32;
export const MIN_HTTP_BEARER_TOKEN_SHANNON_BITS = 128;
export const SAFE_TOOL_ERROR_MESSAGE =
  'Divigent MCP tool failed while reading chain data. Error details were redacted; check MCP server logs.';
export const TOOL_WARNING =
  'Unsigned transaction plan only. This MCP server cannot sign or broadcast; review chain, contract, calldata, amounts, minSharesOut, and minUsdcOut in a wallet you control before submitting. Base mainnet plans use real funds.';
export const READ_TOOL_NAMES = [
  'divigent_check_yield',
  'divigent_get_position',
  'divigent_status',
] as const;
export const PLANNING_TOOL_NAMES = [
  'divigent_plan_approve_usdc',
  'divigent_plan_deposit',
  'divigent_plan_withdraw',
] as const;
export const TOOL_NAMES = [...READ_TOOL_NAMES, ...PLANNING_TOOL_NAMES] as const;
const encodePlannedFunctionData = encodeFunctionData as unknown as (parameters: {
  abi: unknown;
  functionName: string;
  args: readonly unknown[];
}) => Hex;

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
  allowedOrigins: ReadonlySet<string>;
};

export function shannonEntropyBits(value: string): number {
  if (value.length === 0) return 0;
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
  for (let length = 1; length <= Math.floor(value.length / 2); length += 1) {
    if (value.length % length !== 0) continue;
    const pattern = value.slice(0, length);
    if (pattern.repeat(value.length / length) === value) return true;
  }
  return false;
}

export function validateHttpBearerToken(token: string): void {
  if (token.length < MIN_HTTP_BEARER_TOKEN_LENGTH) {
    throw new Error(
      `MCP_HTTP_BEARER_TOKEN must be at least ${MIN_HTTP_BEARER_TOKEN_LENGTH} characters`,
    );
  }
  if (/\s/.test(token)) {
    throw new Error('MCP_HTTP_BEARER_TOKEN must not contain whitespace');
  }
  if (isRepeatedPattern(token)) {
    throw new Error('MCP_HTTP_BEARER_TOKEN must not be a repeated pattern');
  }

  const lower = token.toLowerCase();
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
  if (placeholderTerms.some((term) => lower.includes(term))) {
    throw new Error('MCP_HTTP_BEARER_TOKEN looks like a placeholder or weak secret');
  }

  if (shannonEntropyBits(token) < MIN_HTTP_BEARER_TOKEN_SHANNON_BITS) {
    throw new Error(
      `MCP_HTTP_BEARER_TOKEN must have at least ${MIN_HTTP_BEARER_TOKEN_SHANNON_BITS} bits of estimated entropy`,
    );
  }
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  const unbracketed =
    normalized.startsWith('[') && normalized.endsWith(']')
      ? normalized.slice(1, -1)
      : normalized;

  if (unbracketed === 'localhost') return true;
  const ipType = isIP(unbracketed);
  if (ipType === 4) return unbracketed.startsWith('127.');
  if (ipType === 6) return unbracketed === '::1' || unbracketed === '0:0:0:0:0:0:0:1';
  return false;
}

export function loadHttpSecurityConfig(
  env: NodeJS.ProcessEnv = process.env,
  host = env.MCP_HOST ?? DEFAULT_HTTP_HOST,
): HttpSecurityConfig {
  const bearerToken =
    env.MCP_HTTP_BEARER_TOKEN !== undefined && env.MCP_HTTP_BEARER_TOKEN.length > 0
      ? env.MCP_HTTP_BEARER_TOKEN
      : undefined;
  const unsafeAllowUnauthenticated = env.MCP_HTTP_UNSAFE_ALLOW_UNAUTHENTICATED === 'true';
  const unsafeAllowPublicUnauthenticated =
    env.MCP_HTTP_UNSAFE_ALLOW_PUBLIC_UNAUTHENTICATED === 'true';
  const allowedOrigins = new Set(
    (env.MCP_HTTP_ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
  );

  if (bearerToken) validateHttpBearerToken(bearerToken);

  if (!bearerToken && !unsafeAllowUnauthenticated) {
    throw new Error(
      'HTTP transport requires MCP_HTTP_BEARER_TOKEN. For local-only testing, set MCP_HTTP_UNSAFE_ALLOW_UNAUTHENTICATED=true explicitly.',
    );
  }
  if (
    !bearerToken &&
    unsafeAllowUnauthenticated &&
    !isLoopbackHost(host) &&
    !unsafeAllowPublicUnauthenticated
  ) {
    throw new Error(
      'Unauthenticated HTTP transport is only allowed on loopback hosts. Set MCP_HTTP_BEARER_TOKEN for public bindings, or set MCP_HTTP_UNSAFE_ALLOW_PUBLIC_UNAUTHENTICATED=true for explicit public development use.',
    );
  }

  return { bearerToken, unsafeAllowUnauthenticated, allowedOrigins };
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

function isPositiveUsdcAmount(value: string): boolean {
  try {
    return parseUsdc(value) > 0n;
  } catch {
    return false;
  }
}

export const usdcAmountField = z
  .string()
  .max(40, 'must be 40 characters or fewer')
  .regex(/^\d+(\.\d{1,6})?$/, 'must be a decimal USDC string with max 6 decimals')
  .refine(isPositiveUsdcAmount, 'must be greater than 0')
  .describe('USDC amount as a decimal string, e.g. "100.50".');

export const sharesField = z
  .string()
  .max(78, 'must fit within a uint256 decimal string')
  .regex(/^\d+$/, 'must be an integer string of dvUSDC base units')
  .refine((value) => BigInt(value) > 0n, 'must be greater than 0')
  .describe('dvUSDC shares as an integer string of base units.');

export const slippageBpsField = z
  .number()
  .int()
  .min(0)
  .max(DEFAULT_MAX_SLIPPAGE_BPS)
  .optional()
  .describe('Optional slippage tolerance in basis points. Defaults to the SDK default.');

export const checkYieldSchema = z.object({}).strict();
export const statusSchema = z.object({}).strict();
export const getPositionSchema = z.object({ wallet: evmAddressField }).strict();
export const planApproveSchema = z.object({ wallet: evmAddressField, amountUsdc: usdcAmountField }).strict();
export const planDepositSchema = z.object({
  wallet: evmAddressField,
  amountUsdc: usdcAmountField,
  slippageBps: slippageBpsField,
}).strict();
export const planWithdrawSchema = z.object({
  wallet: evmAddressField,
  amountUsdc: usdcAmountField.optional(),
  shares: sharesField.optional(),
  slippageBps: slippageBpsField,
}).strict().refine(
  (args) => (args.amountUsdc === undefined) !== (args.shares === undefined),
  'Provide exactly one of amountUsdc or shares.',
);

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

function redactUrl(rawUrl: string): string {
  let candidate = rawUrl;
  let suffix = '';
  while (candidate.length > 0 && /[),.;!?]$/.test(candidate)) {
    suffix = `${candidate.at(-1) ?? ''}${suffix}`;
    candidate = candidate.slice(0, -1);
  }

  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return rawUrl;
    return `${parsed.protocol}//${parsed.host}/[REDACTED]${suffix}`;
  } catch {
    return rawUrl;
  }
}

export function redactString(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/https?:\/\/[^\s"'<>]+/gi, redactUrl)
    .replace(/(0x)[a-fA-F0-9]{64}/g, '$1[REDACTED_PRIVATE_KEY]');
}

function toLogSafe(value: unknown, key = ''): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map((item) => toLogSafe(item));
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Error) {
    return toJsonSafe({
      name: redactString(value.name),
      message: redactString(value.message),
      stack: value.stack ? redactString(value.stack) : undefined,
    });
  }

  const out: Record<string, unknown> = {};
  for (const [nestedKey, nested] of Object.entries(value as Record<string, unknown>)) {
    if (nested === undefined) continue;
    if (
      /(authorization|bearer|token|secret|private|password|api[_-]?key|rpc[_-]?url|read[_-]?rpc)/i.test(
        nestedKey,
      )
    ) {
      out[nestedKey] = '[REDACTED]';
    } else {
      out[nestedKey] = toLogSafe(nested, nestedKey);
    }
  }
  return key ? out : toJsonSafe(out);
}

export function text(data: Record<string, unknown>): ToolResult {
  const structuredContent = toJsonSafe(data) as Record<string, unknown>;
  return {
    structuredContent,
    content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }],
  };
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function recordString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`planned request missing string field '${key}'`);
  }
  return value;
}

function maybeAddress(value: unknown): string | undefined {
  if (typeof value === 'string') return evmAddress(value);
  if (value !== null && typeof value === 'object') {
    const address = (value as { address?: unknown }).address;
    if (typeof address === 'string') return evmAddress(address);
  }
  return undefined;
}

export function isSupportedChain(value: string): value is DivigentChain {
  return (SUPPORTED_CHAINS as readonly string[]).includes(value);
}

export function resolveChain(env: NodeJS.ProcessEnv = process.env): DivigentChain {
  const chain = env.DIVIGENT_CHAIN;
  if (!chain) {
    throw new Error(
      `DIVIGENT_CHAIN must be set explicitly to one of ${SUPPORTED_CHAINS.join(', ')}`,
    );
  }
  if (!isSupportedChain(chain)) {
    throw new Error(
      `DIVIGENT_CHAIN must be one of ${SUPPORTED_CHAINS.join(', ')}, got '${chain}'`,
    );
  }
  return chain;
}

function hasEnvValue(env: NodeJS.ProcessEnv, key: string): boolean {
  return env[key] !== undefined && String(env[key]).length > 0;
}

function validateRpcEnvironmentForChain(chain: DivigentChain, env: NodeJS.ProcessEnv): void {
  if (chain === 'base' && hasEnvValue(env, 'BASE_SEPOLIA_RPC_URL')) {
    throw new Error(
      'DIVIGENT_CHAIN=base conflicts with BASE_SEPOLIA_RPC_URL. Remove the Sepolia RPC URL or set DIVIGENT_CHAIN=base-sepolia.',
    );
  }
  if (chain === 'base-sepolia' && hasEnvValue(env, 'BASE_MAINNET_RPC_URL')) {
    throw new Error(
      'DIVIGENT_CHAIN=base-sepolia conflicts with BASE_MAINNET_RPC_URL. Remove the mainnet RPC URL or set DIVIGENT_CHAIN=base.',
    );
  }
}

export function resolveRpcUrl(
  chain: DivigentChain,
  env: NodeJS.ProcessEnv = process.env,
): string {
  validateRpcEnvironmentForChain(chain, env);
  if (chain === 'base') {
    return (
      env.BASE_MAINNET_RPC_URL ??
      env.BASE_RPC_URL ??
      env.READ_RPC_URL ??
      DEFAULT_MAINNET_RPC_URL
    );
  }

  return (
    env.BASE_SEPOLIA_RPC_URL ??
    env.READ_RPC_URL ??
    env.BASE_RPC_URL ??
    DEFAULT_SEPOLIA_RPC_URL
  );
}

export function compactTransactionFromPlan(
  plan: { request: unknown },
  chain: DivigentChain = DEFAULT_CHAIN,
): Record<string, unknown> {
  const request = asRecord(plan.request, 'planned request');
  const abi = request.abi;
  const functionName = recordString(request, 'functionName');
  const args = Array.isArray(request.args) ? request.args : [];
  const chainConfig = getChainConfig(chain);
  const data = encodePlannedFunctionData({
    abi: abi as never,
    functionName,
    args,
  });

  const tx: Record<string, unknown> = {
    chain,
    chainId: chainConfig.id,
    to: recordString(request, 'address'),
    data,
    value: request.value ?? '0',
    functionName,
    args,
  };
  const account = maybeAddress(request.account);
  if (account !== undefined) tx.account = account;
  if (request.maxFeePerGas !== undefined) tx.maxFeePerGas = request.maxFeePerGas;
  if (request.maxPriorityFeePerGas !== undefined) {
    tx.maxPriorityFeePerGas = request.maxPriorityFeePerGas;
  }
  return tx;
}

function addressFromRecord(
  data: Record<string, unknown>,
  key: string,
  aliases: readonly string[] = [],
): EvmAddress {
  for (const candidate of [key, ...aliases]) {
    const value = data[candidate];
    if (typeof value === 'string' && value.length > 0) return evmAddress(value);
  }
  throw new Error(`DIVIGENT_ADDRESSES missing required address '${key}'`);
}

function loadAddressOverrides(): DivigentConfig['addresses'] | undefined {
  const addrFile = process.env.DIVIGENT_ADDRESSES;
  if (!addrFile) return undefined;

  const parsed = JSON.parse(readFileSync(addrFile, 'utf8')) as unknown;
  const data = asRecord(parsed, 'DIVIGENT_ADDRESSES JSON');
  const addresses = {
    router: addressFromRecord(data, 'router'),
    oracle: addressFromRecord(data, 'oracle'),
    feeCollector: addressFromRecord(data, 'feeCollector'),
    dvUsdc: addressFromRecord(data, 'dvUsdc'),
    usdc: addressFromRecord(data, 'usdc'),
    aavePool: addressFromRecord(data, 'aavePool'),
    aToken: addressFromRecord(data, 'aToken', ['aaveAToken']),
    steakhouseUSDCPrimeVault: addressFromRecord(data, 'steakhouseUSDCPrimeVault', ['morphoVault']),
  };
  logger.info('using custom addresses', { from: addrFile });
  return addresses;
}

type Runtime = {
  chain: DivigentChain;
  chainId: number;
  chainConfig: ChainConfig;
  readRpc: string;
  maxPlanAmount: bigint;
  addresses: DivigentConfig['addresses'] | undefined;
  readDivigent: Divigent;
  publicClient: DivigentConfig['publicClient'];
};

export async function loadRuntime(): Promise<Runtime> {
  const chain = resolveChain();
  const chainConfig = getChainConfig(chain);
  const readRpc = resolveRpcUrl(chain);
  const maxPlanAmount = parseUsdc(process.env.DIVIGENT_MCP_MAX_PLAN_USDC ?? DEFAULT_MAX_PLAN_USDC);
  const publicClient = createPublicClient({ chain: chainConfig.viemChain, transport: http(readRpc) });
  const addresses = loadAddressOverrides();

  if (!addresses) assertProtocolDeployed(chain);

  const config: DivigentConfig = {
    publicClient: publicClient as DivigentConfig['publicClient'],
    chain,
  };
  if (addresses) config.addresses = addresses;

  const readDivigent = Divigent.create(config);
  await readDivigent.verifyAddresses();

  logger.info('divigent MCP runtime initialised', {
    chain,
    chainId: chainConfig.id,
    maxPlanUsdc: formatUsdc(maxPlanAmount),
  });

  return {
    chain,
    chainId: chainConfig.id,
    chainConfig,
    readRpc,
    maxPlanAmount,
    addresses,
    readDivigent,
    publicClient: publicClient as DivigentConfig['publicClient'],
  };
}

export function makePlanningWalletClient(
  wallet: EvmAddress,
  chain: DivigentChain = DEFAULT_CHAIN,
): NonNullable<DivigentConfig['walletClient']> {
  return {
    account: { address: wallet, type: 'json-rpc' },
    chain: getChainConfig(chain).viemChain,
  } as unknown as NonNullable<DivigentConfig['walletClient']>;
}

export function planningDivigent(runtime: Runtime, wallet: EvmAddress): Divigent {
  const config: DivigentConfig = {
    publicClient: runtime.publicClient,
    walletClient: makePlanningWalletClient(wallet, runtime.chain),
    chain: runtime.chain,
  };
  if (runtime.addresses) config.addresses = runtime.addresses;
  return Divigent.create(config);
}

export function parseCappedUsdc(value: string, runtime: Pick<Runtime, 'maxPlanAmount'>): bigint {
  const amount = parseUsdc(value);
  assertCappedUsdc(amount, runtime, 'amountUsdc');
  return amount;
}

export class SafeToolUserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SafeToolUserError';
  }
}

export function assertCappedUsdc(
  amount: bigint,
  runtime: Pick<Runtime, 'maxPlanAmount'>,
  label: string,
): void {
  if (amount > runtime.maxPlanAmount) {
    throw new SafeToolUserError(
      `${label} exceeds MCP planning cap of ${formatUsdc(runtime.maxPlanAmount)} USDC`,
    );
  }
}

export function sanitizeToolErrorForModel(err: unknown): Error {
  if (err instanceof SafeToolUserError) return err;
  return new Error(SAFE_TOOL_ERROR_MESSAGE);
}

type ToolHandler<TArgs> = (args: TArgs) => Promise<ToolResult> | ToolResult;

function withSafeToolErrors<TArgs>(toolName: string, handler: ToolHandler<TArgs>): ToolHandler<TArgs> {
  return async (args: TArgs) => {
    try {
      return await handler(args);
    } catch (err) {
      logger.warn('mcp tool handler failed', { tool: toolName, err });
      throw sanitizeToolErrorForModel(err);
    }
  };
}

export function parsePort(value: string): number {
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`MCP_PORT must be an integer from 1 to 65535, got '${value}'`);
  }
  return port;
}

export function parseHttpMaxConcurrentRequests(value: string | undefined): number {
  if (value === undefined || value.length === 0) return DEFAULT_HTTP_MAX_CONCURRENT_REQUESTS;
  const parsed = Number.parseInt(value, 10);
  if (
    !Number.isInteger(parsed) ||
    parsed < 1 ||
    parsed > MAX_HTTP_MAX_CONCURRENT_REQUESTS
  ) {
    throw new Error(
      `MCP_HTTP_MAX_CONCURRENT_REQUESTS must be an integer from 1 to ${MAX_HTTP_MAX_CONCURRENT_REQUESTS}, got '${value}'`,
    );
  }
  return parsed;
}

export function isHealthzRequest(method: string | undefined, pathname: string): boolean {
  return method === 'GET' && pathname === '/healthz';
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

export function buildServer(
  runtime: Runtime,
  options: { log?: boolean } = {},
): McpServer {
  const divigent = runtime.readDivigent;
  const server = new McpServer({
    name: 'divigent-mcp',
    version: '1.0.1',
  });

  server.registerTool(
    'divigent_check_yield',
    {
      description:
        "Read current Aave/Morpho yield rates and the oracle's current safe optimal vault.",
      inputSchema: checkYieldSchema,
    },
    withSafeToolErrors('divigent_check_yield', async () => {
      const [optimal, allRates, oracleStatus, depositsPaused, rateDecisionBlock] = await Promise.all([
        divigent.getOptimalVault(),
        divigent.getAllRates(),
        divigent.oracleStatus(),
        divigent.depositsPaused(),
        runtime.publicClient.getBlockNumber(),
      ]);
      return text({
        chain: runtime.chain,
        chainId: runtime.chainId,
        rateDecisionBlock,
        oracle: {
          fresh: oracleStatus.fresh,
          lastObservationTime: oracleStatus.lastObservationTime,
        },
        depositsPaused,
        optimal: {
          vault: optimal.vault,
          vaultType: optimal.vaultType,
          twarRatePerSecondRay: optimal.twarRate,
        },
        allRates: allRates.map((rate) => ({
          vault: rate.vault,
          vaultType: rate.vaultType,
          twarRatePerSecondRay: rate.twarRate,
          spotRatePerSecondRay: rate.spotRate,
          isSafe: rate.isSafe,
        })),
      });
    }),
  );

  server.registerTool(
    'divigent_get_position',
    {
      description:
        'Read wallet position, liquid USDC, dvUSDC shares, and Divigent router allowance.',
      inputSchema: getPositionSchema,
    },
    withSafeToolErrors('divigent_get_position', async (args) => {
      const wallet = evmAddress(args.wallet);
      const [position, liquid, allowance, shares] = await Promise.all([
        divigent.getPosition(wallet),
        divigent.usdcBalance(wallet),
        divigent.usdcAllowance(wallet),
        divigent.dvUsdcBalance(wallet),
      ]);
      return text({
        chain: runtime.chain,
        chainId: runtime.chainId,
        wallet,
        liquidUsdc: formatUsdc(liquid),
        liquidUsdcAtomic: liquid,
        routerAllowanceUsdc: formatUsdc(allowance),
        routerAllowanceUsdcAtomic: allowance,
        depositedUsdc: formatUsdc(position.depositedUSDC),
        depositedUsdcAtomic: position.depositedUSDC,
        currentValueUsdc: formatUsdc(position.currentValue),
        currentValueUsdcAtomic: position.currentValue,
        accruedYieldUsdc: formatUsdc(position.accruedYield),
        accruedYieldUsdcAtomic: position.accruedYield,
        dvUsdcShares: shares,
      });
    }),
  );

  server.registerTool(
    'divigent_status',
    {
      description:
        'Read protocol health: oracle freshness, deposits pause flag, TVL cap, total assets, allocation, treasury, and withdraw capacity.',
      inputSchema: statusSchema,
    },
    withSafeToolErrors('divigent_status', async () => {
      const [
        oracleStatus,
        treasuryStatus,
        depositsPaused,
        currentTvlCap,
        totalAssets,
        pricePerShare,
        allocation,
        withdrawCapacity,
      ] = await Promise.all([
        divigent.oracleStatus(),
        divigent.treasuryStatus(),
        divigent.depositsPaused(),
        divigent.currentTVLCap(),
        divigent.totalVaultAssets(),
        divigent.pricePerShare(),
        divigent.getCurrentAllocation(),
        divigent.withdrawCapacity(),
      ]);
      const rotationPending = treasuryStatus.pending !== ZERO_ADDRESS;
      return text({
        chain: runtime.chain,
        chainId: runtime.chainId,
        addresses: divigent.addresses,
        oracle: {
          fresh: oracleStatus.fresh,
          lastObservationTime: oracleStatus.lastObservationTime,
        },
        treasury: {
          current: treasuryStatus.current,
          rotationPending,
          ...(rotationPending && {
            pending: treasuryStatus.pending,
            effectiveAt: treasuryStatus.effectiveAt,
          }),
        },
        depositsPaused,
        tvlCapUsdc: formatUsdc(currentTvlCap),
        tvlCapUsdcAtomic: currentTvlCap,
        totalAssetsUsdc: formatUsdc(totalAssets),
        totalAssetsUsdcAtomic: totalAssets,
        pricePerShare,
        allocation: {
          aaveAssetsUsdc: formatUsdc(allocation.aaveAssets),
          aaveAssetsUsdcAtomic: allocation.aaveAssets,
          morphoAssetsUsdc: formatUsdc(allocation.morphoAssets),
          morphoAssetsUsdcAtomic: allocation.morphoAssets,
        },
        withdrawCapacity: {
          aaveAssetsHeldUsdc: formatUsdc(withdrawCapacity.aaveAssetsHeld),
          aaveAssetsHeldUsdcAtomic: withdrawCapacity.aaveAssetsHeld,
          aaveIdleLiquidityUsdc: formatUsdc(withdrawCapacity.aaveIdleLiquidity),
          aaveIdleLiquidityUsdcAtomic: withdrawCapacity.aaveIdleLiquidity,
          aaveWithdrawCapUsdc: formatUsdc(withdrawCapacity.aaveWithdrawCap),
          aaveWithdrawCapUsdcAtomic: withdrawCapacity.aaveWithdrawCap,
          morphoAssetsHeldUsdc: formatUsdc(withdrawCapacity.morphoAssetsHeld),
          morphoAssetsHeldUsdcAtomic: withdrawCapacity.morphoAssetsHeld,
          morphoWithdrawCapUsdc: formatUsdc(withdrawCapacity.morphoWithdrawCap),
          morphoWithdrawCapUsdcAtomic: withdrawCapacity.morphoWithdrawCap,
          morphoReachable: withdrawCapacity.morphoReachable,
          totalWithdrawCapUsdc: formatUsdc(withdrawCapacity.totalWithdrawCap),
          totalWithdrawCapUsdcAtomic: withdrawCapacity.totalWithdrawCap,
        },
      });
    }),
  );

  server.registerTool(
    'divigent_plan_approve_usdc',
    {
      description:
        'Plan an unsigned USDC approval for the Divigent router. Does not sign or broadcast.',
      inputSchema: planApproveSchema,
    },
    withSafeToolErrors('divigent_plan_approve_usdc', async (args) => {
      const wallet = evmAddress(args.wallet);
      const amount = parseCappedUsdc(args.amountUsdc, runtime);
      const plan = await planningDivigent(runtime, wallet).planApproveUsdc(amount);
      return text({
        chain: runtime.chain,
        chainId: runtime.chainId,
        warning: TOOL_WARNING,
        action: 'approveUsdc',
        wallet,
        token: plan.token,
        spender: plan.spender,
        amountUsdc: formatUsdc(plan.amount),
        amountUsdcAtomic: plan.amount,
        approvalAmountUsdc: formatUsdc(plan.approvalAmount),
        approvalAmountUsdcAtomic: plan.approvalAmount,
        simulationResult: plan.simulationResult,
        note: plan.approvalAmount > plan.amount
          ? 'Approval amount includes a one-atomic-unit USDC buffer from the SDK to avoid exact-allowance deposit edge cases.'
          : 'Approval amount matches requested amount.',
        transaction: compactTransactionFromPlan(plan, runtime.chain),
      });
    }),
  );

  server.registerTool(
    'divigent_plan_deposit',
    {
      description:
        'Plan an unsigned Divigent deposit. Returns approval requirement and unsigned calldata. Does not sign or broadcast.',
      inputSchema: planDepositSchema,
    },
    withSafeToolErrors('divigent_plan_deposit', async (args) => {
      const wallet = evmAddress(args.wallet);
      const amount = parseCappedUsdc(args.amountUsdc, runtime);
      const plan = await planningDivigent(runtime, wallet).planDeposit({
        wallet,
        amount,
        ...(args.slippageBps !== undefined && { slippageBps: args.slippageBps }),
      });
      return text({
        chain: runtime.chain,
        chainId: runtime.chainId,
        warning: TOOL_WARNING,
        action: 'deposit',
        wallet,
        amountUsdc: formatUsdc(plan.amount),
        amountUsdcAtomic: plan.amount,
        previewShares: plan.previewShares,
        minSharesOut: plan.minSharesOut,
        slippageBps: plan.slippageBps,
        allowanceUsdc: formatUsdc(plan.allowance),
        allowanceUsdcAtomic: plan.allowance,
        approvalRequiredUsdc: formatUsdc(plan.approvalRequired),
        approvalRequiredUsdcAtomic: plan.approvalRequired,
        needsApproval: plan.approvalRequired > 0n,
        simulated: plan.simulated,
        simulatedSharesOut: plan.simulatedSharesOut,
        note: plan.approvalRequired > 0n
          ? 'Deposit was not simulated because current router allowance is insufficient. Call divigent_plan_approve_usdc first.'
          : 'Deposit was simulated successfully at current chain state.',
        transaction: compactTransactionFromPlan(plan, runtime.chain),
      });
    }),
  );

  server.registerTool(
    'divigent_plan_withdraw',
    {
      description:
        'Plan an unsigned Divigent withdrawal by exact shares or desired net USDC. Does not sign or broadcast.',
      inputSchema: planWithdrawSchema,
    },
    withSafeToolErrors('divigent_plan_withdraw', async (args) => {
      const wallet = evmAddress(args.wallet);
      if (args.amountUsdc !== undefined && args.shares !== undefined) {
        throw new SafeToolUserError('Pass either amountUsdc or shares, not both.');
      }
      if (args.amountUsdc === undefined && args.shares === undefined) {
        throw new SafeToolUserError('Provide one of amountUsdc or shares.');
      }

      const planner = planningDivigent(runtime, wallet);
      let shares: bigint;
      let desiredUsdc: bigint | undefined;
      if (args.amountUsdc !== undefined) {
        desiredUsdc = parseCappedUsdc(args.amountUsdc, runtime);
        shares = await divigent.previewWithdrawNet(desiredUsdc, wallet);
      } else {
        shares = BigInt(args.shares as string);
        const estimatedUsdcOut = await planner.previewRedeem(shares, wallet);
        assertCappedUsdc(estimatedUsdcOut, runtime, 'shares withdrawal previewUsdcOut');
      }

      const plan = await planner.planWithdraw({
        wallet,
        shares,
        ...(args.slippageBps !== undefined && { slippageBps: args.slippageBps }),
      });
      return text({
        chain: runtime.chain,
        chainId: runtime.chainId,
        warning: TOOL_WARNING,
        action: 'withdraw',
        wallet,
        mode: desiredUsdc !== undefined ? 'desiredUsdc' : 'shares',
        desiredUsdc: desiredUsdc !== undefined ? formatUsdc(desiredUsdc) : undefined,
        desiredUsdcAtomic: desiredUsdc,
        shares: plan.shares,
        previewUsdcOut: formatUsdc(plan.previewUsdcOut),
        previewUsdcOutAtomic: plan.previewUsdcOut,
        minUsdcOut: formatUsdc(plan.minUsdcOut),
        minUsdcOutAtomic: plan.minUsdcOut,
        slippageBps: plan.slippageBps,
        simulatedUsdcOut: formatUsdc(plan.simulatedUsdcOut),
        simulatedUsdcOutAtomic: plan.simulatedUsdcOut,
        transaction: compactTransactionFromPlan(plan, runtime.chain),
      });
    }),
  );

  if (options.log ?? true) logger.info('mcp server constructed', { tools: 6 });
  return server;
}

type McpServerPool = {
  acquire: () => McpServer | undefined;
  release: (server: McpServer) => void;
  closeAll: () => Promise<void>;
};

export function createMcpServerPool(
  runtime: Runtime,
  size = DEFAULT_HTTP_MAX_CONCURRENT_REQUESTS,
): McpServerPool {
  if (
    !Number.isInteger(size) ||
    size < 1 ||
    size > MAX_HTTP_MAX_CONCURRENT_REQUESTS
  ) {
    throw new Error(
      `MCP server pool size must be an integer from 1 to ${MAX_HTTP_MAX_CONCURRENT_REQUESTS}`,
    );
  }

  const servers = Array.from({ length: size }, () => buildServer(runtime, { log: false }));
  const available = [...servers];
  const leased = new Set<McpServer>();

  return {
    acquire: () => {
      const server = available.pop();
      if (!server) return undefined;
      leased.add(server);
      return server;
    },
    release: (server) => {
      if (!leased.delete(server)) return;
      available.push(server);
    },
    closeAll: async () => {
      await Promise.allSettled(servers.map((server) => server.close()));
      available.length = 0;
      leased.clear();
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
    process.env.MCP_HTTP_MAX_CONCURRENT_REQUESTS,
  );
  const serverPool = createMcpServerPool(runtime, maxConcurrentRequests);

  const httpServer = httpServerModule.createServer(async (req, res) => {
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

      if (isHealthzRequest(req.method, url.pathname)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
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

      if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'method not allowed' }));
        return;
      }

      const server = serverPool.acquire();
      if (!server) {
        res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '1' });
        res.end(JSON.stringify({ error: 'server busy' }));
        return;
      }

      let released = false;
      const releaseServer = async (): Promise<void> => {
        if (released) return;
        released = true;
        try {
          await server.close();
        } catch (err) {
          logger.warn('mcp pooled server close failed', { err });
        } finally {
          serverPool.release(server);
        }
      };

      try {
        const parsedBody = await readJsonBodyWithLimit(req);
        if (!parsedBody.ok) {
          res.writeHead(parsedBody.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: parsedBody.error }));
          return;
        }

        const transportOptions = {
          sessionIdGenerator: undefined,
        } as unknown as ConstructorParameters<typeof StreamableHTTPServerTransport>[0];
        const transport = new StreamableHTTPServerTransport(transportOptions);
        await server.connect(transport as unknown as Parameters<McpServer['connect']>[0]);
        res.once('close', () => {
          void releaseServer();
        });
        await transport.handleRequest(req, res, parsedBody.body);
      } finally {
        await releaseServer();
      }
    } catch (err) {
      logger.error('http request failed', { err });
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal error' }));
      }
    }
  });

  httpServer.listen(port, host, () => {
    logger.info('mcp server listening on http', {
      host,
      port,
      auth: httpSecurity.bearerToken ? 'bearer' : 'unsafe-disabled',
      maxConcurrentRequests,
    });
  });

  const shutdown = (signal: string): void => {
    logger.info('shutting down', { signal });
    httpServer.close((err) => {
      void (async () => {
        await serverPool.closeAll();
        if (err) logger.error('http close error', { err });
        process.exit(err ? 1 : 0);
      })();
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
