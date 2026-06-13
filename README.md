# @divigent/mcp-server

Model Context Protocol server for Divigent on Base mainnet and Base Sepolia.

The server exposes read tools and unsigned transaction planning tools. It never
loads a private key, never signs, and never broadcasts. Planning tools use an
address-only wallet-shaped object so the SDK can simulate from the user's
address and return calldata for an external wallet to review and submit.

## Tools

| Tool | Purpose |
| --- | --- |
| `divigent_check_yield` | Current Aave/Morpho rates, oracle-selected safe vault, oracle freshness, pause flag, and rate-decision block |
| `divigent_get_position` | Wallet USDC, dvUSDC, router allowance, and Divigent position |
| `divigent_status` | Oracle freshness, treasury, pause flag, TVL, allocation, withdrawal capacity |
| `divigent_plan_approve_usdc` | Unsigned USDC approval plan for the Divigent router |
| `divigent_plan_deposit` | Unsigned Divigent deposit plan, with allowance and approval requirement |
| `divigent_plan_withdraw` | Unsigned Divigent withdrawal plan by shares or desired USDC |

Intentionally not exposed:

- private key inputs
- signing
- `sendPlan`
- `deposit`
- `withdraw`
- `approveUsdc`
- governance or pause writes

## Install

```bash
npm install -g @divigent/mcp-server
```

This standalone server pins the published Divigent SDK package that exposes
read APIs and unsigned transaction planning APIs.

Run with npx:

```bash
npx -y @divigent/mcp-server
```

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `BASE_MAINNET_RPC_URL` | `https://mainnet.base.org` | Preferred Base mainnet RPC URL when `DIVIGENT_CHAIN=base` |
| `BASE_SEPOLIA_RPC_URL` | `https://sepolia.base.org` | Preferred Base Sepolia RPC URL when `DIVIGENT_CHAIN=base-sepolia` |
| `READ_RPC_URL` | unset | Fallback RPC URL |
| `BASE_RPC_URL` | unset | Fallback RPC URL |
| `DIVIGENT_CHAIN` | required | `base` or `base-sepolia`; never inferred from RPC URL variables |
| `DIVIGENT_ADDRESSES` | unset | Optional JSON address override |
| `DIVIGENT_MCP_MAX_PLAN_USDC` | `100` | Per-plan USDC cap for approval, deposit, target withdraw, and shares-withdraw preview |
| `MCP_TRANSPORT` | `stdio` | `stdio` or `http` |
| `MCP_LOG_LEVEL` | `info` | `trace`, `debug`, `info`, `warn`, `error` |

HTTP-only:

| Variable | Default | Purpose |
| --- | --- | --- |
| `MCP_HOST` | `127.0.0.1` | HTTP bind host |
| `MCP_PORT` | `3000` | HTTP bind port |
| `MCP_HTTP_BEARER_TOKEN` | unset | Required high-entropy bearer token for HTTP unless unsafe local mode is explicit |
| `MCP_HTTP_ALLOWED_ORIGINS` | unset | Comma-separated exact browser CORS origins; not an access-control mechanism |
| `MCP_HTTP_MAX_CONCURRENT_REQUESTS` | `16` | Concurrent authenticated POST handling limit, max `256` |
| `MCP_HTTP_UNSAFE_ALLOW_UNAUTHENTICATED` | unset | Loopback-only local testing escape hatch |
| `MCP_HTTP_UNSAFE_ALLOW_PUBLIC_UNAUTHENTICATED` | unset | Extra explicit override for public unauthenticated development only |

There is intentionally no `AGENT_PK`.

## Client Setup

Most desktop MCP clients run this server locally over stdio. They start the
`npx` command below, then communicate with the server over stdin/stdout. You do
not need to host a public HTTP endpoint for Claude, Cursor, or Codex desktop
testing.

Prerequisites:

- Node.js 20 or newer
- npm/npx available on PATH
- A Base RPC URL; the public mainnet default is `https://mainnet.base.org`

For mainnet testing, a dedicated or less rate-limited Base RPC provider is
recommended because the server verifies the configured Divigent contract stack
on startup.

For Base Sepolia testing, set `DIVIGENT_CHAIN=base-sepolia` and
`BASE_SEPOLIA_RPC_URL=https://sepolia.base.org`.

`DIVIGENT_CHAIN` is required. The server does not infer the chain from RPC URL
environment variables. If an explicit chain conflicts with a chain-specific RPC
variable, for example `DIVIGENT_CHAIN=base-sepolia` with
`BASE_MAINNET_RPC_URL`, startup fails instead of silently choosing a different
network.

### Claude Desktop

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
        "DIVIGENT_CHAIN": "base",
        "BASE_MAINNET_RPC_URL": "https://mainnet.base.org",
        "MCP_LOG_LEVEL": "error"
      }
    }
  }
}
```

### Claude Code

From the project where you want Claude Code to use Divigent MCP, run:

```bash
claude mcp add --transport stdio divigent \
  --env DIVIGENT_CHAIN=base \
  --env BASE_MAINNET_RPC_URL=https://mainnet.base.org \
  --env MCP_LOG_LEVEL=error \
  -- npx -y @divigent/mcp-server
```

Verify the server is configured:

```bash
claude mcp list
claude mcp get divigent
```

Inside Claude Code, run `/mcp` and confirm `divigent` is connected.

### Example Prompts

```text
Use the Divigent MCP server to check Divigent protocol status on Base.
```

```text
Use Divigent MCP to check current Aave and Morpho yields.
```

```text
Use Divigent MCP to get the Divigent position for wallet 0xYourWalletAddress.
```

```text
Use Divigent MCP to plan, but not submit, a 1 USDC approval for wallet 0xYourWalletAddress.
```

```text
Use Divigent MCP to plan, but not submit, a 1 USDC deposit for wallet 0xYourWalletAddress with 50 bps slippage.
```

```text
Use Divigent MCP to plan, but not submit, a withdrawal of 1 USDC for wallet 0xYourWalletAddress.
```

```text
Use mcp__divigent__divigent_plan_deposit with wallet 0xYourWalletAddress, amountUsdc 1, and slippageBps 50.
```

```text
Use mcp__divigent__divigent_plan_withdraw with wallet 0xYourWalletAddress and shares 1000000.
```

### Cursor

Add this to your Cursor MCP configuration, then restart Cursor.

```json
{
  "mcpServers": {
    "divigent": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@divigent/mcp-server"],
      "env": {
        "DIVIGENT_CHAIN": "base",
        "BASE_MAINNET_RPC_URL": "https://mainnet.base.org",
        "MCP_LOG_LEVEL": "error"
      }
    }
  }
}
```

### Codex

For Codex-style local MCP configuration, use the same stdio command:

```json
{
  "mcpServers": {
    "divigent": {
      "command": "npx",
      "args": ["-y", "@divigent/mcp-server"],
      "env": {
        "DIVIGENT_CHAIN": "base",
        "BASE_MAINNET_RPC_URL": "https://mainnet.base.org",
        "MCP_LOG_LEVEL": "error"
      }
    }
  }
}
```

If your Codex environment uses a TOML MCP config, the equivalent shape is:

```toml
[mcp_servers.divigent]
command = "npx"
args = ["-y", "@divigent/mcp-server"]

[mcp_servers.divigent.env]
DIVIGENT_CHAIN = "base"
BASE_MAINNET_RPC_URL = "https://mainnet.base.org"
MCP_LOG_LEVEL = "error"
```

## HTTP

```bash
DIVIGENT_CHAIN=base \
BASE_MAINNET_RPC_URL=https://mainnet.base.org \
MCP_TRANSPORT=http \
MCP_HTTP_BEARER_TOKEN="$(openssl rand -hex 32)" \
npx @divigent/mcp-server
```

The server exposes `POST /` and `POST /mcp` for stateless Streamable HTTP and
`GET /healthz` for liveness. HTTP binds to `127.0.0.1` by default, all routes
require bearer auth unless unsafe mode is explicitly set, and JSON request
bodies are capped at 64 KiB. Bearer tokens must be strong; use
`openssl rand -hex 32` to generate one.

Unauthenticated HTTP mode is only accepted on loopback hosts by default. Public
HTTP bindings must use `MCP_HTTP_BEARER_TOKEN`. The
`MCP_HTTP_UNSAFE_ALLOW_PUBLIC_UNAUTHENTICATED=true` override exists only for
explicit public development experiments.

`MCP_HTTP_ALLOWED_ORIGINS` is browser CORS configuration only. Non-browser MCP
clients such as curl, Python, Claude Desktop, Cursor, and Codex usually omit the
`Origin` header and are not restricted by CORS; use bearer auth, TLS, firewall
rules, and network placement for access control.

Authenticated POST work is bounded by `MCP_HTTP_MAX_CONCURRENT_REQUESTS`
(default `16`). For production, put remote deployments behind TLS and a reverse
proxy with per-IP rate limiting.

## Address Overrides

If using a private deployment, set `DIVIGENT_ADDRESSES` to a JSON file:

```json
{
  "router": "0x...",
  "oracle": "0x...",
  "feeCollector": "0x...",
  "dvUsdc": "0x...",
  "usdc": "0x...",
  "aavePool": "0x...",
  "aToken": "0x...",
  "steakhouseUSDCPrimeVault": "0x..."
}
```

The server verifies the configured contract stack at startup.

## Development

```bash
npm install
npm run typecheck
npm run build
npm test
```

## Security Model

- No private key is read from environment or disk.
- No MCP tool calls SDK broadcast methods.
- Planning tools return unsigned calldata and metadata only, with capped USDC
  plan amounts and capped slippage.
- `DIVIGENT_CHAIN` must be explicit; chain/RPC mismatches fail at startup.
- HTTP transport requires a strong bearer token by default.
- Unauthenticated HTTP mode is loopback-only unless a separate public unsafe
  override is set.
- Browser origins are denied unless explicitly allowlisted, but CORS is not
  access control for non-browser clients.
- HTTP JSON request bodies are capped at 64 KiB.
- Authenticated HTTP POST handling is bounded by a fixed server pool.
- Tool-handler errors are sanitized before they can be returned to the AI model.
- All diagnostics go to stderr so stdio JSON-RPC stdout remains clean.

## License

MIT
