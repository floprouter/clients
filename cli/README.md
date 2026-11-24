# floprouter

Command-line client for the [floprouter API](https://floprouter.com). The floprouter API sends chat requests to GPU miners on FLOP Network and settles each one on chain, paid in FLOP.

Use it to browse miners and models, run chat requests, check what a request cost, and do the wallet steps on your own machine: creating an API key, signing the session-key grant, and depositing or withdrawing FLOP.

Keys stay on your machine. The router only ever receives your address, a signature over its login challenge, and transactions you sign here, which go to the chain.

```bash
npx floprouter models
npx floprouter miners --reachable
npx floprouter login --key-file ./my-wallet.json      # or --seed-file, or a hidden prompt
npx floprouter grant                                  # one signature: your wallet stays the on-chain payer
npx floprouter chat "What is a payment channel?"
npx floprouter generation <gen-id>                    # tokens, cost in FLOP, latency, reply
```

Requires Node 18.17 or later.

## Commands

| Command | Notes |
| - | - |
| `models [--available]` | Models, ready miners, the escrow per 1,000 tokens, the minimum per request, and the largest request served |
| `miners` | Every registered miner. Filters: `--reachable --ready --calibrated --model <id> --min-score <n>`. Sort: `--sort score\|settle_rate\|sessions\|stake\|latency\|capacity`, `--order asc\|desc`. Paging: `--limit --offset --all`. `--json` gives raw output |
| `miner <address>` | One miner in detail |
| `status` | Router health, network, payer |
| `chat [prompt]` | One-shot when a prompt is given or piped, interactive otherwise. See the options below |
| `session [<id>]` | One session's settlement state, or your recent sessions |
| `generation <id>` | One request's tokens, cost in FLOP, finish reason, latency and verified reply |
| `balance` | Prepaid balance (available and held), deposit address, fee, withdrawals, grant state, recent ledger entries |
| `key` | This API key: usage in FLOP (day, week, month), rate limits, payer mode. `key --show` prints the stored key itself |
| `login` | Signs the router's challenge and stores the new API key in `~/.config/floprouter/config.json` (mode 600). Options: `--name`, `--payer grant\|credit`, `--show-key`, `--no-save` |
| `keys`, `keys revoke <id>`, `keys payer <id> grant\|credit` | Manage your API keys |
| `logout` | Forget the stored key |
| `grant` | Builds and signs `flopSessionKeys.createSession` for the router's delegate. It allows `ComputeChannel` only and shows the caps before you confirm. While a grant is active, it signs the renewal instead: `revokeSession` and `createSession` in one transaction. Options: `--spending-cap --per-tx --daily-cap --days --revoke --yes`; `--status [--json]`; `--auto-renew` (below) |
| `miner endpoint <url>` | For miner operators: lists or changes the miner's session URL. It signs the router's endpoint challenge with the miner key on this machine, then prints the result: verified, not verified yet, unreachable, not verified, or rate limited. Works headless with `--key-file` and `--yes` |
| `miner status [<address>]` | The miner's availability, health and last check. With an API key of the miner address (`floprouter login --key-file <miner key>`), it also shows the miner's own listed URLs |
| `deposit <amount>` | Transfers FLOP from your wallet to the router's deposit address, after you confirm |
| `withdraw <amount\|all>` | Sends prepaid balance back to the wallet that owns the key (the only destination allowed), after you confirm |

`chat` options:

- `--model <id>`: the model. Default: the model with the most ready miners.
- `--fallback-model <id>`: models to try next when no miner serves the first. Repeat it for more.
- `--miner <address>`: pin a miner. Repeat or comma-separate to give an order. `--fallbacks` lets other miners step in if the pinned ones fail.
- `--sort reliability|latency|price|throughput`: the automatic order. `reliability` (the on-chain score) is the default.
- `--stream`: print text as the miner sends it. It is verified when the turn ends.
- `--max-tokens <n>`: the escrow, and so the price, follows `max_tokens`.
- `--system <text>`: a system prompt.
- `--payer grant|credit`: override the key's payer mode for this request. `--fallback-payer credit` runs in credit mode when no miner has a live signed offer for a grant-mode request.
- `--wait`: after the reply, poll until the on-chain settlement is final (2 to 5 minutes).
- `--json`: the raw response.

After each reply, a status line on stderr shows the session id, the miner, the cost in FLOP, the payer mode and the token count. It also shows any parameters the model ignored, and the model that answered when a fallback model was used. If the router has no verified reply within its response deadline (about 85 s), it answers "pending" and the CLI polls the session until the reply is there.

Wallet input: `--key-file <polkadot-js JSON>` (password prompted, or `--password-file`), `--seed-file <file>` (mnemonic, `0x` seed or secret URI), the environment variables `FLOPROUTER_KEY_FILE` / `FLOPROUTER_SEED_FILE`, or a hidden prompt. A seed or password is never accepted as a command-line argument. Use `--type ed25519` for ed25519 keys.

Global options: `--base-url` (`FLOPROUTER_BASE_URL`, default `https://api.floprouter.com`) and `--json`. The API key comes from `FLOPROUTER_API_KEY`, or from the file written by `login`.

## Keeping a grant alive (agents, cron)

The chain needs the owner's signature for every grant, so the router cannot renew one; the wallet's own key can. Run this every hour from cron, a systemd timer, CI or an agent loop:

```bash
floprouter grant --auto-renew --key-file ./wallet.json --password-file ./wallet.pw --yes   # or --seed-file
```

- **When it renews.** It reads the grant from the router and renews only when the grant is missing, revoked or expired, expires within `--renew-before` (default `2d`), or has less than `--min-remaining` FLOP of its spending cap left (default: the per-session limit).
- **When it does nothing.** In every other case it does nothing and exits 0. Before it signs, it confirms the state on chain, so a second run never renews twice.
- **What it signs.** A renewal is `revokeSession` plus `createSession` in one `utility.batchAll` with the current caps; a missing grant gets a new `createSession`. When the router describes the renewal, the CLI checks the description is exactly that batch.
- **Room versus time.** The chain carries the amount already spent over a renewal. When the reason is the spending cap, the new cap is the previous cap plus the amount spent, which keeps the same room. A low allowance for today is reported but never renewed: it returns on its own at the next daily epoch.
- **Keys.** It never prompts, and it refuses to run without `--key-file` or `--seed-file` (or `FLOPROUTER_KEY_FILE` / `FLOPROUTER_SEED_FILE`), and without `--yes` when there is no terminal.
- **Script output.** `--json` prints `{action: skip|wait|grant|renew, reason, tx, ...}`; `--dry-run` shows what it would sign. `floprouter grant --status --json` returns the facts and what `--auto-renew` would do now.
- **Ready-made jobs:** `examples/keep-grant-alive.sh` (a cron line) and `examples/js/keep_grant_alive.mjs` (for agent frameworks).
- **The chain endpoint** comes from the router (`rpc` in `/v1/grants/params` or `/health`); `--rpc` is only for overriding it.

## Safety checks before signing

- The chain the RPC reports must have the genesis hash the router reports.
- `grant` signs only `flopSessionKeys.createSession` with the allow-list `["ComputeChannel"]`. An empty list would mean "all pallets" on this chain, so it is refused. The router's suggested call must match its stated amounts, and the per-session and daily caps cannot exceed the total cap.
- `deposit` refuses when the loaded wallet is not the wallet that owns the API key, because a deposit is credited to the sender.
- Every command that moves funds shows a summary and asks for confirmation. Without a terminal it needs `--yes`.
