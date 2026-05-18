# @divigent/mcp-server

Model Context Protocol server for Divigent on Base mainnet and Base Sepolia.

The server exposes read tools and unsigned transaction planning tools. It never
loads a private key, never signs, and never broadcasts. Planning tools use an
address-only wallet-shaped object so the SDK can simulate from the user's
address and return calldata for an external wallet to review and submit.

## Tools

| Tool | Purpose |
| --- | --- |
| `divigent_check_yield` | Current Aave/Morpho rates and oracle-selected safe vault |
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
| `BASE_MAINNET_RPC_URL` | `https://mainnet.base.org` | Preferred Base mainnet RPC URL |
| `BASE_SEPOLIA_RPC_URL` | `https://sepolia.base.org` | Preferred Base Sepolia RPC URL when `DIVIGENT_CHAIN=base-sepolia` |
| `READ_RPC_URL` | unset | Fallback RPC URL |
| `BASE_RPC_URL` | unset | Fallback RPC URL |
| `DIVIGENT_CHAIN` | `base` | `base` or `base-sepolia` |
| `DIVIGENT_ADDRESSES` | unset | Optional JSON address override |
| `DIVIGENT_MCP_MAX_PLAN_USDC` | `100` | Per-plan amount cap for approval/deposit/target withdraw |
| `MCP_TRANSPORT` | `stdio` | `stdio` or `http` |
| `MCP_LOG_LEVEL` | `info` | `trace`, `debug`, `info`, `warn`, `error` |

HTTP-only:

| Variable | Default | Purpose |
| --- | --- | --- |
| `MCP_HOST` | `127.0.0.1` | HTTP bind host |
| `MCP_PORT` | `3000` | HTTP bind port |
| `MCP_HTTP_BEARER_TOKEN` | unset | Required for HTTP unless unsafe mode is explicit |
| `MCP_HTTP_ALLOWED_ORIGINS` | unset | Comma-separated exact browser origins |
| `MCP_HTTP_UNSAFE_ALLOW_UNAUTHENTICATED` | unset | Local testing escape hatch |

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

Legacy configs that only set `BASE_SEPOLIA_RPC_URL` and do not set
`DIVIGENT_CHAIN`, `BASE_MAINNET_RPC_URL`, or `BASE_RPC_URL` continue to resolve
to Base Sepolia.

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
bodies are capped at 64 KiB. Put remote deployments behind TLS.

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
- Planning tools return unsigned calldata and metadata only.
- HTTP transport requires bearer auth by default.
- Browser origins are denied unless explicitly allowlisted.
- HTTP JSON request bodies are capped at 64 KiB.
- All diagnostics go to stderr so stdio JSON-RPC stdout remains clean.

## License

MIT
