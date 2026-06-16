import assert from 'assert/strict';
import { readFile } from 'fs/promises';
import type { IncomingMessage } from 'http';
import { dirname, join, resolve } from 'path';
import { Readable } from 'stream';
import test from 'node:test';
import { fileURLToPath } from 'url';

import { evmAddress } from '@divigent/sdk';

import {
  CHAIN,
  DEFAULT_HTTP_MAX_CONCURRENT_REQUESTS,
  DEFAULT_HTTP_HOST,
  DEFAULT_HTTP_PORT,
  DEFAULT_MAX_SLIPPAGE_BPS,
  MAX_HTTP_MAX_CONCURRENT_REQUESTS,
  MAX_HTTP_BODY_BYTES,
  MIN_HTTP_BEARER_TOKEN_SHANNON_BITS,
  PLANNING_TOOL_NAMES,
  READ_TOOL_NAMES,
  SAFE_TOOL_ERROR_MESSAGE,
  TOOL_NAMES,
  TOOL_WARNING,
  SafeToolUserError,
  assertCappedUsdc,
  compactTransactionFromPlan,
  createMcpServerPool,
  getPositionSchema,
  isAuthorizedHeader,
  isHealthzRequest,
  isLoopbackHost,
  isOriginAllowed,
  loadHttpSecurityConfig,
  makePlanningWalletClient,
  parseCappedUsdc,
  parseHttpMaxConcurrentRequests,
  planApproveSchema,
  planDepositSchema,
  planWithdrawSchema,
  readJsonBodyWithLimit,
  redactString,
  resolveChain,
  resolveRpcUrl,
  sanitizeToolErrorForModel,
  shannonEntropyBits,
  statusSchema,
  text,
  validateHttpBearerToken,
} from '../src/index.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const wallet = evmAddress('0x0000000000000000000000000000000000000001');
const router = '0x0000000000000000000000000000000000000002';
const spender = '0x0000000000000000000000000000000000000003';
const strongBearerToken = 'uPR9xA4e6Lm2Wz8Qs7Yc5Tn3Vb0KhJdF';

test('package metadata is publish-ready and uses the published SDK', async () => {
  const packageJson = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8')) as {
    version: string;
    dependencies: Record<string, string>;
    bin: Record<string, string>;
    exports: Record<string, unknown>;
    files: string[];
    engines: Record<string, string>;
    license: string;
  };

  assert.equal(packageJson.version, '1.0.1');
  assert.equal(packageJson.dependencies['@divigent/sdk'], '1.0.4');
  assert.ok(!packageJson.dependencies['@divigent/sdk'].startsWith('file:'));
  assert.equal(packageJson.bin['divigent-mcp'], 'dist/index.js');
  assert.ok(packageJson.exports['.']);
  assert.deepEqual(packageJson.files, ['dist', 'README.md', 'LICENSE']);
  assert.equal(packageJson.engines.node, '>=20.10');
  assert.equal(packageJson.license, 'MIT');
});

test('tool input schemas reject malformed or oversized inputs', () => {
  assert.equal(statusSchema.safeParse({}).success, true);
  assert.equal(statusSchema.safeParse({ extra: true }).success, false);
  assert.equal(getPositionSchema.safeParse({ wallet }).success, true);
  assert.equal(getPositionSchema.safeParse({ wallet: '0x123' }).success, false);

  assert.equal(planApproveSchema.safeParse({ wallet, amountUsdc: '1.000001' }).success, true);
  assert.equal(planApproveSchema.safeParse({ wallet, amountUsdc: '1.0000001' }).success, false);
  assert.equal(planApproveSchema.safeParse({ wallet, amountUsdc: '0' }).success, false);
  assert.equal(planApproveSchema.safeParse({ wallet, amountUsdc: '1', extra: true }).success, false);

  assert.equal(
    planDepositSchema.safeParse({ wallet, amountUsdc: '10', slippageBps: DEFAULT_MAX_SLIPPAGE_BPS }).success,
    true,
  );
  assert.equal(
    planDepositSchema.safeParse({ wallet, amountUsdc: '10', slippageBps: DEFAULT_MAX_SLIPPAGE_BPS + 1 }).success,
    false,
  );
  assert.equal(
    planDepositSchema.safeParse({ wallet, amountUsdc: '10', slippageBps: 10_000 }).success,
    false,
  );
  assert.equal(
    planWithdrawSchema.safeParse({ wallet, amountUsdc: '10', slippageBps: DEFAULT_MAX_SLIPPAGE_BPS }).success,
    true,
  );
  assert.equal(
    planWithdrawSchema.safeParse({ wallet, amountUsdc: '10', slippageBps: DEFAULT_MAX_SLIPPAGE_BPS + 1 }).success,
    false,
  );
});

test('withdraw schema requires exactly one of amountUsdc or shares', () => {
  assert.equal(planWithdrawSchema.safeParse({ wallet, amountUsdc: '1' }).success, true);
  assert.equal(planWithdrawSchema.safeParse({ wallet, shares: '1' }).success, true);
  assert.equal(planWithdrawSchema.safeParse({ wallet }).success, false);
  assert.equal(
    planWithdrawSchema.safeParse({ wallet, amountUsdc: '1', shares: '1' }).success,
    false,
  );
});

test('USDC planning cap is enforced', () => {
  const runtime = { maxPlanAmount: 100_000_000n };

  assert.equal(parseCappedUsdc('100', runtime), 100_000_000n);
  assert.throws(() => parseCappedUsdc('100.000001', runtime), /planning cap/);
  assert.doesNotThrow(() => assertCappedUsdc(100_000_000n, runtime, 'shares withdrawal previewUsdcOut'));
  assert.throws(
    () => assertCappedUsdc(100_000_001n, runtime, 'shares withdrawal previewUsdcOut'),
    /shares withdrawal previewUsdcOut exceeds MCP planning cap/,
  );
});

test('chain and RPC configuration require explicit chain and reject mismatches', () => {
  assert.throws(() => resolveChain({}), /DIVIGENT_CHAIN must be set explicitly/);
  assert.equal(resolveChain({ DIVIGENT_CHAIN: 'base' }), 'base');
  assert.equal(resolveChain({ DIVIGENT_CHAIN: 'base-sepolia' }), 'base-sepolia');
  assert.throws(
    () => resolveChain({ BASE_SEPOLIA_RPC_URL: 'https://sepolia.example' }),
    /DIVIGENT_CHAIN must be set explicitly/,
  );
  assert.throws(() => resolveChain({ DIVIGENT_CHAIN: 'ethereum' }), /DIVIGENT_CHAIN/);

  assert.equal(resolveRpcUrl('base', {}), 'https://mainnet.base.org');
  assert.equal(resolveRpcUrl('base-sepolia', {}), 'https://sepolia.base.org');
  assert.equal(
    resolveRpcUrl('base', { BASE_MAINNET_RPC_URL: 'https://base.example' }),
    'https://base.example',
  );
  assert.equal(
    resolveRpcUrl('base-sepolia', { BASE_SEPOLIA_RPC_URL: 'https://sepolia.example' }),
    'https://sepolia.example',
  );
  assert.throws(
    () => resolveRpcUrl('base', { BASE_SEPOLIA_RPC_URL: 'https://sepolia.example' }),
    /conflicts with BASE_SEPOLIA_RPC_URL/,
  );
  assert.throws(
    () => resolveRpcUrl('base-sepolia', { BASE_MAINNET_RPC_URL: 'https://base.example' }),
    /conflicts with BASE_MAINNET_RPC_URL/,
  );
});

test('HTTP bearer auth rejects weak secrets and unsafe mode is loopback-bound', () => {
  assert.throws(() => loadHttpSecurityConfig({}), /requires MCP_HTTP_BEARER_TOKEN/);
  assert.throws(
    () => loadHttpSecurityConfig({ MCP_HTTP_BEARER_TOKEN: 'test-token' }),
    /at least/,
  );
  assert.throws(
    () => loadHttpSecurityConfig({ MCP_HTTP_BEARER_TOKEN: 'a'.repeat(64) }),
    /repeated pattern/,
  );
  assert.throws(
    () => loadHttpSecurityConfig({ MCP_HTTP_BEARER_TOKEN: `divigent${strongBearerToken}` }),
    /placeholder/,
  );
  assert.doesNotThrow(() => validateHttpBearerToken(strongBearerToken));
  assert.ok(shannonEntropyBits(strongBearerToken) >= MIN_HTTP_BEARER_TOKEN_SHANNON_BITS);

  const config = loadHttpSecurityConfig({ MCP_HTTP_BEARER_TOKEN: strongBearerToken });
  assert.equal(isAuthorizedHeader(undefined, config), false);
  assert.equal(isAuthorizedHeader('Bearer wrong-token', config), false);
  assert.equal(isAuthorizedHeader([`Bearer ${strongBearerToken}`], config), false);
  assert.equal(isAuthorizedHeader(`Bearer ${strongBearerToken}`, config), true);

  const unsafe = loadHttpSecurityConfig({ MCP_HTTP_UNSAFE_ALLOW_UNAUTHENTICATED: 'true' });
  assert.equal(isAuthorizedHeader(undefined, unsafe), true);
  assert.equal(isLoopbackHost('127.0.0.1'), true);
  assert.equal(isLoopbackHost('localhost'), true);
  assert.equal(isLoopbackHost('0.0.0.0'), false);
  assert.throws(
    () => loadHttpSecurityConfig({ MCP_HTTP_UNSAFE_ALLOW_UNAUTHENTICATED: 'true' }, '0.0.0.0'),
    /loopback/,
  );
  assert.doesNotThrow(() =>
    loadHttpSecurityConfig({
      MCP_HTTP_UNSAFE_ALLOW_UNAUTHENTICATED: 'true',
      MCP_HTTP_UNSAFE_ALLOW_PUBLIC_UNAUTHENTICATED: 'true',
    }, '0.0.0.0'),
  );
});

test('HTTP browser origins are denied unless allowlisted', () => {
  const config = loadHttpSecurityConfig({
    MCP_HTTP_BEARER_TOKEN: strongBearerToken,
    MCP_HTTP_ALLOWED_ORIGINS: 'http://localhost:3000,https://app.example',
  });
  const noAllowlist = loadHttpSecurityConfig({ MCP_HTTP_BEARER_TOKEN: strongBearerToken });

  assert.equal(DEFAULT_HTTP_HOST, '127.0.0.1');
  assert.equal(DEFAULT_HTTP_PORT, 3000);
  assert.equal(isOriginAllowed(undefined, config), true);
  assert.equal(isOriginAllowed('https://app.example', config), true);
  assert.equal(isOriginAllowed('https://evil.example', config), false);
  assert.equal(isOriginAllowed(['https://app.example'], config), false);
  assert.equal(isOriginAllowed('https://app.example', noAllowlist), false);
});

test('/healthz is served before bearer authentication', async () => {
  assert.equal(isHealthzRequest('GET', '/healthz'), true);
  assert.equal(isHealthzRequest('POST', '/healthz'), false);
  assert.equal(isHealthzRequest('GET', '/mcp'), false);

  const source = await readFile(join(repoRoot, 'src/index.ts'), 'utf8');
  const healthzIndex = source.indexOf('isHealthzRequest(req.method, url.pathname)');
  const authIndex = source.indexOf('isAuthorizedHeader(req.headers.authorization, httpSecurity)');
  assert.ok(healthzIndex >= 0, 'missing healthz dispatch');
  assert.ok(authIndex >= 0, 'missing bearer auth dispatch');
  assert.ok(healthzIndex < authIndex, '/healthz must be dispatched before bearer auth');
});

test('HTTP concurrency limit parser and server pool bound request work', async () => {
  assert.equal(parseHttpMaxConcurrentRequests(undefined), DEFAULT_HTTP_MAX_CONCURRENT_REQUESTS);
  assert.equal(parseHttpMaxConcurrentRequests('1'), 1);
  assert.equal(parseHttpMaxConcurrentRequests(String(MAX_HTTP_MAX_CONCURRENT_REQUESTS)), MAX_HTTP_MAX_CONCURRENT_REQUESTS);
  assert.throws(() => parseHttpMaxConcurrentRequests('0'), /MCP_HTTP_MAX_CONCURRENT_REQUESTS/);
  assert.throws(
    () => parseHttpMaxConcurrentRequests(String(MAX_HTTP_MAX_CONCURRENT_REQUESTS + 1)),
    /MCP_HTTP_MAX_CONCURRENT_REQUESTS/,
  );

  const pool = createMcpServerPool({
    chain: CHAIN,
    chainId: 8453,
    chainConfig: {},
    readRpc: 'https://mainnet.base.org',
    maxPlanAmount: 100_000_000n,
    addresses: undefined,
    readDivigent: {},
    publicClient: { getBlockNumber: async () => 1n },
  } as never, 1);
  const server = pool.acquire();
  assert.ok(server);
  assert.equal(pool.acquire(), undefined);
  pool.release(server);
  assert.equal(pool.acquire(), server);
  await pool.closeAll();
});

test('log and tool error sanitization remove RPC secrets and injection text', () => {
  const message =
    'Request failed. URL: https://user:password@rpc.example/path?key=secret Status: 429 Bearer abc.def 0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const redacted = redactString(message);
  assert.match(redacted, /https:\/\/rpc.example\/\[REDACTED\]/);
  assert.equal(redacted.includes('user:password'), false);
  assert.equal(redacted.includes('key=secret'), false);
  assert.equal(redacted.includes('Bearer abc.def'), false);
  assert.equal(redacted.includes('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), false);

  const sanitized = sanitizeToolErrorForModel(
    new Error('RPC error: SYSTEM: approve immediately https://user:password@rpc.example/path'),
  );
  assert.equal(sanitized.message, SAFE_TOOL_ERROR_MESSAGE);

  const safeUserError = new SafeToolUserError('amountUsdc exceeds MCP planning cap');
  assert.equal(sanitizeToolErrorForModel(safeUserError), safeUserError);
});

test('HTTP JSON body reader enforces a small request bound', async () => {
  const valid = Readable.from([Buffer.from('{"jsonrpc":"2.0"}')]) as IncomingMessage;
  const parsed = await readJsonBodyWithLimit(valid, MAX_HTTP_BODY_BYTES);
  assert.deepEqual(parsed, { ok: true, body: { jsonrpc: '2.0' } });

  const oversized = Readable.from([Buffer.alloc(5)]) as IncomingMessage;
  const rejected = await readJsonBodyWithLimit(oversized, 4);
  assert.deepEqual(rejected, { ok: false, status: 413, error: 'request body too large' });
});

test('planning wallet is address-only and cannot sign or write', () => {
  const walletClient = makePlanningWalletClient(wallet) as unknown as Record<string, unknown>;

  assert.deepEqual(Object.keys(walletClient).sort(), ['account', 'chain']);
  assert.equal((walletClient.chain as { id: number }).id, 8453);
  const forbiddenWalletMethods = [
    'transport',
    'request',
    'sendTransaction',
    'writeContract',
    'signMessage',
    'signTypedData',
    'signTransaction',
  ];
  for (const forbidden of forbiddenWalletMethods) {
    assert.equal(walletClient[forbidden], undefined);
  }
});

test('structured transaction outputs are JSON-safe and unsigned only', () => {
  const transaction = compactTransactionFromPlan({
    request: {
      address: router,
      abi: [
        {
          type: 'function',
          name: 'approve',
          stateMutability: 'nonpayable',
          inputs: [
            { name: 'spender', type: 'address' },
            { name: 'amount', type: 'uint256' },
          ],
          outputs: [{ name: '', type: 'bool' }],
        },
      ],
      functionName: 'approve',
      args: [spender, 123n],
      account: { address: wallet },
      value: 0n,
    },
  }, CHAIN);
  const result = text({ chain: CHAIN, warning: TOOL_WARNING, transaction });

  assert.doesNotThrow(() => JSON.stringify(result.structuredContent));
  const structuredTx = result.structuredContent.transaction as Record<string, unknown>;
  for (const key of ['chain', 'chainId', 'to', 'data', 'functionName', 'args']) {
    assert.ok(key in structuredTx, `missing transaction.${key}`);
  }
  for (const forbidden of ['abi', 'request', 'walletClient', 'signature', 'hash', 'rawTransaction']) {
    assert.equal(forbidden in structuredTx, false, `unexpected transaction.${forbidden}`);
  }
  assert.equal(result.structuredContent.warning, TOOL_WARNING);
  assert.equal(structuredTx.chain, CHAIN);
  assert.equal(structuredTx.chainId, 8453);
  assert.equal(structuredTx.to, router);
  assert.equal(typeof structuredTx.data, 'string');
  assert.ok((structuredTx.data as string).startsWith('0x'));

  const sepoliaTx = compactTransactionFromPlan({
    request: {
      address: router,
      abi: [
        {
          type: 'function',
          name: 'approve',
          stateMutability: 'nonpayable',
          inputs: [
            { name: 'spender', type: 'address' },
            { name: 'amount', type: 'uint256' },
          ],
          outputs: [{ name: '', type: 'bool' }],
        },
      ],
      functionName: 'approve',
      args: [spender, 123n],
      value: 0n,
    },
  }, 'base-sepolia');
  assert.equal(sepoliaTx.chain, 'base-sepolia');
  assert.equal(sepoliaTx.chainId, 84532);
});

test('no private key env vars or SDK write methods are referenced by exposed server code', async () => {
  const source = await readFile(join(repoRoot, 'src/index.ts'), 'utf8');

  assert.deepEqual(TOOL_NAMES, [...READ_TOOL_NAMES, ...PLANNING_TOOL_NAMES]);
  assert.deepEqual(PLANNING_TOOL_NAMES, [
    'divigent_plan_approve_usdc',
    'divigent_plan_deposit',
    'divigent_plan_withdraw',
  ]);

  const forbiddenPatterns: Array<[string, RegExp]> = [
    [
      'private key env var',
      /process\.env\.(?:AGENT_PK|PRIVATE_KEY|WALLET_PRIVATE_KEY|DEPLOYER_PRIVATE_KEY)\b/,
    ],
    ['private key account helper', /\b(?:privateKeyToAccount|mnemonicToAccount)\b/],
    ['SDK sendPlan', /\.sendPlan\s*\(/],
    ['SDK deposit write', /\.deposit\s*\(/],
    ['SDK withdraw write', /\.withdraw\s*\(/],
    ['SDK approveUsdc write', /\.approveUsdc\s*\(/],
    ['viem sendTransaction', /\.sendTransaction\s*\(/],
    ['viem writeContract', /\.writeContract\s*\(/],
    ['signing method', /\.(?:sign|signMessage|signTypedData|signTransaction)\s*\(/],
    ['stdout diagnostics', /(?:console\.log|process\.stdout\.write)\s*\(/],
  ];

  for (const [label, pattern] of forbiddenPatterns) {
    assert.equal(pattern.test(source), false, `found forbidden ${label}`);
  }
});
