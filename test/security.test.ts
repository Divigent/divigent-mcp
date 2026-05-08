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
  DEFAULT_HTTP_HOST,
  DEFAULT_HTTP_PORT,
  MAX_HTTP_BODY_BYTES,
  PLANNING_TOOL_NAMES,
  READ_TOOL_NAMES,
  TOOL_NAMES,
  TOOL_WARNING,
  compactTransactionFromPlan,
  getPositionSchema,
  isAuthorizedHeader,
  isOriginAllowed,
  loadHttpSecurityConfig,
  makePlanningWalletClient,
  parseCappedUsdc,
  planApproveSchema,
  planDepositSchema,
  planWithdrawSchema,
  readJsonBodyWithLimit,
  statusSchema,
  text,
} from '../src/index.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const wallet = evmAddress('0x0000000000000000000000000000000000000001');
const router = '0x0000000000000000000000000000000000000002';
const spender = '0x0000000000000000000000000000000000000003';

test('package metadata is publish-ready and uses the published beta SDK', async () => {
  const packageJson = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8')) as {
    dependencies: Record<string, string>;
    bin: Record<string, string>;
    exports: Record<string, unknown>;
    files: string[];
    engines: Record<string, string>;
    license: string;
  };

  assert.equal(packageJson.dependencies['@divigent/sdk'], '0.1.0-beta.3');
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
    planDepositSchema.safeParse({ wallet, amountUsdc: '10', slippageBps: 10_000 }).success,
    true,
  );
  assert.equal(
    planDepositSchema.safeParse({ wallet, amountUsdc: '10', slippageBps: 10_001 }).success,
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
});

test('HTTP bearer auth and unsafe mode behave explicitly', () => {
  assert.throws(() => loadHttpSecurityConfig({}), /requires MCP_HTTP_BEARER_TOKEN/);

  const config = loadHttpSecurityConfig({ MCP_HTTP_BEARER_TOKEN: 'test-token' });
  assert.equal(isAuthorizedHeader(undefined, config), false);
  assert.equal(isAuthorizedHeader('Bearer wrong-token', config), false);
  assert.equal(isAuthorizedHeader(['Bearer test-token'], config), false);
  assert.equal(isAuthorizedHeader('Bearer test-token', config), true);

  const unsafe = loadHttpSecurityConfig({ MCP_HTTP_UNSAFE_ALLOW_UNAUTHENTICATED: 'true' });
  assert.equal(isAuthorizedHeader(undefined, unsafe), true);
});

test('HTTP browser origins are denied unless allowlisted', () => {
  const config = loadHttpSecurityConfig({
    MCP_HTTP_BEARER_TOKEN: 'test-token',
    MCP_HTTP_ALLOWED_ORIGINS: 'http://localhost:3000,https://app.example',
  });
  const noAllowlist = loadHttpSecurityConfig({ MCP_HTTP_BEARER_TOKEN: 'test-token' });

  assert.equal(DEFAULT_HTTP_HOST, '127.0.0.1');
  assert.equal(DEFAULT_HTTP_PORT, 3000);
  assert.equal(isOriginAllowed(undefined, config), true);
  assert.equal(isOriginAllowed('https://app.example', config), true);
  assert.equal(isOriginAllowed('https://evil.example', config), false);
  assert.equal(isOriginAllowed(['https://app.example'], config), false);
  assert.equal(isOriginAllowed('https://app.example', noAllowlist), false);
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
  });
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
  assert.equal(structuredTx.to, router);
  assert.equal(typeof structuredTx.data, 'string');
  assert.ok((structuredTx.data as string).startsWith('0x'));
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
