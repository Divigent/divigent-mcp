# @divigent/mcp-server

Model Context Protocol server for Divigent on Base Sepolia.

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

This standalone server pins the published beta SDK package that exposes
unsigned transaction planning APIs.

For beta testing, use the npm beta tag:

```bash
npx -y @divigent/mcp-server@beta
```

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `BASE_SEPOLIA_RPC_URL` | `https://sepolia.base.org` | Preferred Base Sepolia RPC URL |
| `READ_RPC_URL` | unset | Fallback RPC URL |
| `BASE_RPC_URL` | unset | Fallback RPC URL |
| `DIVIGENT_CHAIN` | `base-sepolia` | Must be `base-sepolia` in this beta |
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
- A Base Sepolia RPC URL; the public default is `https://sepolia.base.org`

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
      "args": ["-y", "@divigent/mcp-server@beta"],
      "env": {
        "BASE_SEPOLIA_RPC_URL": "https://sepolia.base.org",
        "MCP_LOG_LEVEL": "error"
      }
    }
  }
}
```

Example prompts:

```text
Use the Divigent MCP server to check Divigent protocol status on Base Sepolia.
```

```text
Use Divigent MCP to check current Aave and Morpho yields.
```

```text
Use Divigent MCP to plan, but not submit, a 1 USDC approval for wallet 0x...
```

### Cursor

Add this to your Cursor MCP configuration, then restart Cursor.

```json
{
  "mcpServers": {
    "divigent": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@divigent/mcp-server@beta"],
      "env": {
        "BASE_SEPOLIA_RPC_URL": "https://sepolia.base.org",
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
      "args": ["-y", "@divigent/mcp-server@beta"],
      "env": {
        "BASE_SEPOLIA_RPC_URL": "https://sepolia.base.org",
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
args = ["-y", "@divigent/mcp-server@beta"]

[mcp_servers.divigent.env]
BASE_SEPOLIA_RPC_URL = "https://sepolia.base.org"
MCP_LOG_LEVEL = "error"
```

## HTTP

```bash
BASE_SEPOLIA_RPC_URL=https://sepolia.base.org \
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
