# @divigent/mcp-server

Read-only Model Context Protocol server for Divigent on Base mainnet.

Divigent is the treasury layer for x402 agent wallets. This MCP server helps an
assistant analyze wallet behavior and missed yield opportunity from public Base
USDC activity. It does not prepare, sign, broadcast, or execute transactions.

## Tools

| Tool | Purpose |
| --- | --- |
| `analyze_wallet_behavior` | Analyze Base mainnet USDC balance and payment behavior for a wallet |
| `analyze_missed_yield` | Estimate idle capital and missed yield opportunity for a wallet |

The server intentionally does not expose:

- private key inputs
- signing
- broadcasting
- transaction preparation
- calldata
- `send_calls`
- protocol rate or vault-recommendation tools
- deposit, withdraw, recall, sweep, or approval tools

## Install

Use Node.js 20 or newer.

```bash
npm install -g @divigent/mcp-server
```

Or run with npx:

```bash
npx -y @divigent/mcp-server
```

The published package depends on `@divigent/sdk@1.0.4`.

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `BASE_MAINNET_RPC_URL` | `https://mainnet.base.org` | Preferred Base mainnet RPC URL |
| `BASE_RPC_URL` | unset | Fallback Base mainnet RPC URL |
| `DIVIGENT_CHAIN` | unset | Optional compatibility guard; if set, must be `base` |
| `MCP_TRANSPORT` | `stdio` | `stdio` or `http` |
| `MCP_LOG_LEVEL` | `info` | `trace`, `debug`, `info`, `warn`, `error` |

HTTP-only:

| Variable | Default | Purpose |
| --- | --- | --- |
| `MCP_HOST` | `127.0.0.1` | HTTP bind host |
| `MCP_PORT` | `3000` | HTTP bind port |
| `MCP_HTTP_MAX_CONCURRENT_REQUESTS` | `16` | Maximum concurrent authenticated HTTP requests |
| `MCP_HTTP_BEARER_TOKEN` | unset | Required high-entropy bearer token for HTTP unless unsafe mode is explicit |
| `MCP_HTTP_ALLOWED_ORIGINS` | unset | Browser CORS allowlist; not an access-control mechanism |
| `MCP_HTTP_UNSAFE_ALLOW_UNAUTHENTICATED` | unset | Loopback-only local testing escape hatch |
| `MCP_HTTP_UNSAFE_ALLOW_PUBLIC_UNAUTHENTICATED` | unset | Additional explicit override for public unauthenticated development |

There is intentionally no private key environment variable.

This package is Base mainnet only. It does not infer chain from RPC variables.
Legacy `DIVIGENT_CHAIN=base-sepolia`, `BASE_SEPOLIA_RPC_URL`, and `READ_RPC_URL`
settings are rejected at startup so stale testnet configuration cannot silently
change the chain or RPC endpoint.

## Agent Flow

Base MCP is used separately for wallet discovery. Divigent MCP accepts the
wallet address and analyzes it.

```text
Base MCP get_wallets -> wallet address
Divigent MCP analyze_wallet_behavior(wallet)
Divigent MCP analyze_missed_yield(wallet)
Assistant explains the structured result
```

## Claude Code

From the project where you want Claude Code to use Divigent MCP, run:

```bash
claude mcp add --transport stdio divigent \
  --env BASE_MAINNET_RPC_URL=https://your-premium-base-rpc.example \
  --env MCP_LOG_LEVEL=error \
  -- npx -y @divigent/mcp-server
```

Verify the server is configured:

```bash
claude mcp list
claude mcp get divigent
```

Inside Claude Code, run `/mcp` and confirm `divigent` is connected.

Example prompts:

```text
Use Base MCP to get my wallet address, then use Divigent MCP to analyze wallet behavior.
```

```text
Use mcp__divigent__analyze_wallet_behavior for wallet 0xYourWalletAddress with lookbackDays 30.
```

```text
Use mcp__divigent__analyze_missed_yield for wallet 0xYourWalletAddress with lookbackDays 30 and assumedApy 0.045.
```

```text
Using the wallet from Base MCP get_wallets, ask Divigent MCP whether this x402 wallet has idle USDC and summarize the missed yield result.
```

## Claude Desktop

Add this to `claude_desktop_config.json`, then fully quit and reopen Claude
Desktop.

macOS path:

```bash
~/Library/Application Support/Claude/claude_desktop_config.json
```

```json
{
  "mcpServers": {
    "divigent": {
      "command": "npx",
      "args": ["-y", "@divigent/mcp-server"],
      "env": {
        "BASE_MAINNET_RPC_URL": "https://your-premium-base-rpc.example",
        "MCP_LOG_LEVEL": "error"
      }
    }
  }
}
```

## Cursor

Add this to your Cursor MCP configuration, then restart Cursor.

```json
{
  "mcpServers": {
    "divigent": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@divigent/mcp-server"],
      "env": {
        "BASE_MAINNET_RPC_URL": "https://your-premium-base-rpc.example",
        "MCP_LOG_LEVEL": "error"
      }
    }
  }
}
```

## Codex

Use the same stdio command in your local MCP config:

```json
{
  "mcpServers": {
    "divigent": {
      "command": "npx",
      "args": ["-y", "@divigent/mcp-server"],
      "env": {
        "BASE_MAINNET_RPC_URL": "https://your-premium-base-rpc.example",
        "MCP_LOG_LEVEL": "error"
      }
    }
  }
}
```

If your Codex environment uses a TOML MCP config:

```toml
[mcp_servers.divigent]
command = "npx"
args = ["-y", "@divigent/mcp-server"]

[mcp_servers.divigent.env]
BASE_MAINNET_RPC_URL = "https://your-premium-base-rpc.example"
MCP_LOG_LEVEL = "error"
```

## HTTP

HTTP is intended for controlled local or internal deployments. It binds to
`127.0.0.1` by default and requires bearer auth unless unsafe mode is explicitly
set. The unauthenticated testing escape hatch is rejected when `MCP_HOST` is not
loopback unless `MCP_HTTP_UNSAFE_ALLOW_PUBLIC_UNAUTHENTICATED=true` is also set.

```bash
BASE_MAINNET_RPC_URL=https://your-premium-base-rpc.example \
MCP_TRANSPORT=http \
MCP_HTTP_BEARER_TOKEN="$(openssl rand -hex 32)" \
npx @divigent/mcp-server
```

`MCP_HTTP_BEARER_TOKEN` must be a generated secret with at least 32
non-whitespace characters and enough estimated entropy. Placeholder values such
as `test-token`, `password`, or repeated patterns are rejected at startup.

`MCP_HTTP_ALLOWED_ORIGINS` only controls browser CORS checks. It does not
restrict non-browser MCP clients, `curl`, scripts, servers, or desktop clients,
which commonly omit the `Origin` header. Use bearer auth and network controls
for access control.

The server exposes `POST /` and `POST /mcp` for stateless Streamable HTTP and
`GET /healthz` for liveness. Browser origins are denied unless explicitly
allowlisted, JSON request bodies are capped at 64 KiB, and authenticated POST
work is bounded by `MCP_HTTP_MAX_CONCURRENT_REQUESTS`. Requests above that
process limit receive `503 server busy`; put remote deployments behind TLS and
reverse-proxy rate limiting.

## Development

```bash
npm install
npm run typecheck
npm run typecheck:test
npm run build
npm test
npm audit --audit-level=high
npm pack --dry-run
```

## Security Model

- Base mainnet only, chainId `8453`.
- No chain auto-inference; stale Sepolia or legacy chain/RPC variables fail startup.
- No private key is read from environment or disk.
- No wallet client is created.
- No transaction planning, agent-controlled slippage, or calldata is returned.
- No MCP tool calls SDK write, planning, signing, or broadcast methods.
- Numeric USDC values are returned as strings from the SDK report.
- HTTP transport requires bearer auth by default.
- HTTP bearer tokens must be generated high-entropy secrets.
- Unauthenticated HTTP mode is loopback-only unless a separate public unsafe override is set.
- Browser origins are denied unless explicitly allowlisted; absent `Origin` headers from non-browser clients are not blocked by CORS.
- `MCP_HTTP_ALLOWED_ORIGINS` is browser CORS policy only and does not replace bearer auth, firewalling, or reverse-proxy access control.
- HTTP JSON request bodies are capped at 64 KiB.
- HTTP POST handling uses a bounded prebuilt MCP server pool and returns 503 when saturated.
- All diagnostics go to stderr so stdio JSON-RPC stdout remains clean.

## License

MIT
