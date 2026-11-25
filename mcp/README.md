# floprouter-mcp

MCP server for the [floprouter API](https://floprouter.com). It lets an AI agent list FLOP Network models and miners, run chat requests on GPU miners paid in FLOP, and check generations, sessions, balance and grant state.

It never handles wallet keys. Create an API key, sign a grant, and deposit or withdraw with the `floprouter` CLI.

## Run

```bash
npx -y floprouter-mcp                 # stdio (what desktop and IDE clients use)
npx -y floprouter-mcp --http          # streamable HTTP on http://127.0.0.1:8792/mcp  (--port, --host)
```

| Variable | Meaning |
| - | - |
| `FLOPROUTER_API_KEY` | API key (`fr_...`). If it is not set, the key saved by `floprouter login` is used. Without a key, only the read-only tools work. |
| `FLOPROUTER_BASE_URL` | Default `https://api.floprouter.com` |
| `FLOPROUTER_TOOL_BUDGET_MS` | How long `chat` waits for the reply before it returns the generation id to check later. Default 50000, under the 60 s at which MCP clients commonly time a tool out |
| `FLOPROUTER_PROGRESS_BUDGET_MS` | When the client asks for progress (sends a progress token), `chat` reports progress every 10 s and waits up to this long instead. Default 240000; clients that reset their timeout on progress then get the reply directly |
| `FLOPROUTER_TIMEOUT_MS` | Per-request timeout for the other tools, default 300000 |
| `FLOPROUTER_SETTLE_WAIT_MS` | How long `chat` polls when `wait_for_settlement` is true, default 300000 |

In HTTP mode, each request may carry its own key in `Authorization: Bearer fr_...`. Otherwise the server falls back to the configured key. Keep the default `127.0.0.1` bind unless every caller should share that key.

## Tools

| Tool | What it does | Moves funds |
| - | - | - |
| `list_models` | Models, ready and reachable miner counts, escrow per 1,000 tokens, minimum per request, largest request served | no |
| `list_miners` | Miners with score, rank, settle rate, sessions, strikes, calibration and reachability. Filters: `reachable`, `ready`, `model`, `min_score`, `sort`, `limit`, `offset` | no |
| `get_miner` | One miner in detail | no |
| `chat` | One paid chat request. Inputs: `prompt` or `messages`, `model`, optional `fallback_models`, `miner` (pin one or a list), `allow_fallbacks`, `max_tokens`, `payer`, `fallback_payer`, `wait_for_settlement`. Returns the reply, `generation_id`, cost in FLOP, ignored parameters, and the session (miner, escrow, payer) | spends FLOP |
| `generation` | One request by id: tokens, cost in FLOP, finish reason, latency, verified reply | no |
| `session_status` | Settlement state of a session | no |
| `account` | Balance (available, held, deposit address, fee, recent ledger, withdrawals), this key's usage and limits, grant state | no |
| `grant_status` | The session-key grant: state, expiry, days left, cap left, today's room, whether renewal is due | no |
| `renew_grant` | **Only in opt-in mode (below). Signs a transaction with the configured wallet.** Renews the grant when it is due, with the same caps | signs |
| `withdraw` | Sends prepaid balance back to the wallet that owns the key | to the owner only |
| `router_status` | Network, sync state and payer | no |

`chat` returns once the miner's reply is verified, typically in 10 to 40 s (often 1 to 2 minutes when a channel has to be opened without an offer). If that takes longer than the tool budget, it returns `pending: true` with the `generation_id`. The request carries on and can be read with `generation` a minute later. The on-chain settlement follows 2 to 5 minutes after the reply; check it with `session_status`.

## Grant warnings and opt-in renewal

By default this server never touches a wallet key. `chat` and `account` results carry a `grant_warning` when the grant has under 2 days left or is nearly used up, so the agent can tell its user in time. Only the user's wallet can sign a new grant, with `floprouter grant`, or unattended with `floprouter grant --auto-renew`.

**Opt-in signing.** Set **both** a key file and the switch in the server's configuration, never in a tool call:

| Variable | Meaning |
| - | - |
| `FLOPROUTER_KEY_FILE` (or `FLOPROUTER_SEED_FILE`) | The wallet that owns the API key. Add `FLOPROUTER_PASSWORD_FILE` if the key file is encrypted |
| `FLOPROUTER_ALLOW_GRANT_RENEWAL=1` | Exposes `renew_grant` |
| `FLOPROUTER_AUTO_RENEW=1` | Also renew automatically before a `chat` when the grant is due |
| `FLOPROUTER_RENEW_BEFORE` | Renewal window, default `2d` |
| `FLOPROUTER_SIGN_LOG` | Where each signature is logged (default `~/.config/floprouter/mcp-signatures.log`, mode 600). Each signature is also logged on stderr |

Signing needs the polkadot packages, which the CLI brings: run the server as `npx -y -p floprouter -p floprouter-mcp floprouter-mcp`.

`renew_grant` runs the same code as `floprouter grant --auto-renew` (one shared module), with stricter rules:

- It renews only when due: expiring within the window, or expired.
- It signs only `utility.batchAll[revokeSession, createSession]` to the router's delegate, with exactly the current caps and only `ComputeChannel`.
- It never creates a grant from nothing and never raises a cap. A grant that is nearly used up is reported, and the user is asked to raise the cap themselves: the chain carries the amount spent over a renewal, so the same caps would not restore room.
- It refuses any other renewal the router describes.
- It never takes a key or seed as a tool argument.
- `dry_run: true` shows what it would sign.

## Client configuration

Replace `fr_...` with your key, or leave the `env` block out if you ran `floprouter login` on the same machine.

**Claude Code**

```bash
claude mcp add floprouter --scope user -e FLOPROUTER_API_KEY=fr_... -- npx -y floprouter-mcp
```

**Claude Desktop** (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "floprouter": {
      "command": "npx",
      "args": ["-y", "floprouter-mcp"],
      "env": { "FLOPROUTER_API_KEY": "fr_..." }
    }
  }
}
```

**Cursor** (`~/.cursor/mcp.json`, or `.cursor/mcp.json` in a project)

```json
{
  "mcpServers": {
    "floprouter": {
      "command": "npx",
      "args": ["-y", "floprouter-mcp"],
      "env": { "FLOPROUTER_API_KEY": "fr_..." }
    }
  }
}
```

**Codex** (`~/.codex/config.toml`)

```toml
[mcp_servers.floprouter]
command = "npx"
args = ["-y", "floprouter-mcp"]
env = { FLOPROUTER_API_KEY = "fr_..." }
```

**Any client that speaks streamable HTTP:** start `npx -y floprouter-mcp --http` and point the client at `http://127.0.0.1:8792/mcp`. For Claude Code: `claude mcp add --transport http floprouter http://127.0.0.1:8792/mcp`.
