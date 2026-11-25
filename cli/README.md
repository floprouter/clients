# floprouter

Command-line client for the [floprouter API](https://floprouter.com). The floprouter API sends chat requests to GPU miners on FLOP Network and settles each one on chain, paid in FLOP.

Use it to browse miners and models, run chat requests, check what a request cost, and do the wallet steps on your own machine: creating an API key, signing the session-key grants (one signature, no deposit), and depositing or withdrawing FLOP.

Keys stay on your machine. The router only ever receives your address, a signature over its login challenge, and transactions you sign here, which go to the chain.

```bash
npx floprouter models
npx floprouter miners --reachable
npx floprouter login --key-file ./my-wallet.json      # or --seed-file, or a hidden prompt; ends with ONE grant signature
npx floprouter grant                                  # (later, or to renew) one signature: compute grant + fee grant, no deposit
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
| `balance` | Prepaid balance (available and held), deposit address, fee, the router fees (mode, accrued, collected, owed, last collection with an explorer link when the router names one, otherwise its transaction hash), withdrawals, compute and fee grant state, recent ledger entries |
| `key` | This API key: usage in FLOP (day, week, month), rate limits, payer mode. `key --show` prints the stored key itself |
| `login` | Signs the router's challenge and stores the new API key in `~/.config/floprouter/config.json` (mode 600). In grant mode (the default) it then asks for the one grant signature with the wallet it already unlocked, so a new user runs one command; it skips that when the grants are already active. Options: `--name`, `--payer grant\|credit`, `--show-key`, `--no-save`, `--no-grant` (skip the grant step), `--no-fee-grant` (compute-only grant). Without a terminal it needs `--yes` for the grant step, otherwise it prints the command to run |
| `keys`, `keys revoke <id>`, `keys payer <id> grant\|credit` | Manage your API keys |
| `logout` | Forget the stored key |
| `grant` | Signs the session-key grants in **one transaction, one signature**: a compute grant for the router's delegate (`ComputeChannel` only) and a fee grant for the router's fee delegate (`Balances` only), so no deposit is needed. It shows both grants, their caps, the delegates and the fee address before you confirm. A wallet that has the compute grant gets only the fee grant added; renewing replaces the grants in the same transaction (`revokeSession`, `createSession`, `createSession` in one `utility.batchAll`). The caps are the router's. `--no-fee-grant`: the earlier compute-only grant with your own caps (`--spending-cap --per-tx --daily-cap --days`), the router fee then comes from a deposit. `--revoke` revokes every grant to the router in one transaction. Also `--yes`; `--status [--json]` (compute grant, fee grant and fees); `--auto-renew` (below) |
| `miner endpoint <url>` | For miner operators: lists or changes the miner's session URL. It signs the router's endpoint challenge with the miner key on this machine, then prints the result: verified, not verified yet, unreachable, not verified, or rate limited. Works headless with `--key-file` and `--yes` |
| `miner status [<address>]` | The miner's availability, health and last check. With an API key of the miner address (`floprouter login --key-file <miner key>`), it also shows the miner's own listed URLs |
| `deposit <amount>` | Optional. Transfers FLOP from your wallet to the router's deposit address, after you confirm. Use it to prepay instead of the fee grant (or with `--no-fee-grant`), or to pay fees you owe |
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
- **What it signs.** With the router's fee grant (the default), the batch the router describes, checked before signing: `revokeSession` calls for grants this wallet is known to have made, the compute `createSession` (the compute caps must equal the grant's current caps) and the fee `createSession`, in one `utility.batchAll`. It builds the batch locally and requires the router's `call_data` to encode exactly the same. The compute caps must equal the grant's current caps and the new fee caps may not exceed those of the fee grant being replaced (otherwise it refuses and exits 1). A wallet that has no fee grant (compute-only, fees from a deposit) is renewed compute-only; adding the fee grant is for its owner to sign with `floprouter grant`. With `--no-fee-grant`: `revokeSession` plus `createSession` with the current caps, or a new `createSession`. Custom caps (`--spending-cap` and the rest) and the cap-room rule below apply to `--no-fee-grant` only.
- **Room versus time.** The chain carries the amount already spent over a renewal. When the reason is the spending cap, the new cap is the previous cap plus the amount spent, which keeps the same room. A low allowance for today is reported but never renewed: it returns on its own at the next daily epoch.
- **Keys.** It never prompts, and it refuses to run without `--key-file` or `--seed-file` (or `FLOPROUTER_KEY_FILE` / `FLOPROUTER_SEED_FILE`), and without `--yes` when there is no terminal.
- **Script output.** `--json` prints `{action: skip|wait|grant|renew|refused, reason, tx, ...}`; `--dry-run` shows what it would sign. `floprouter grant --status --json` returns the facts and what `--auto-renew` would do now.
- **Ready-made jobs:** `examples/keep-grant-alive.sh` (a cron line) and `examples/js/keep_grant_alive.mjs` (for agent frameworks).
- **The chain endpoint** comes from the router (`rpc` in `/v1/grants/params` or `/health`); `--rpc` is only for overriding it.

## Safety checks before signing

- The chain the RPC reports must have the genesis hash the router reports.
- `grant` signs only `flopSessionKeys.createSession` and `revokeSession`, in this exact shape: `utility.batchAll` of `revokeSession` (only for grants this wallet is known to have made), at most one `createSession` for the compute delegate with the allow-list `["ComputeChannel"]`, and exactly one `createSession` for the fee delegate with `["Balances"]`. Any other call, a second `Balances` grant, a different allow-list (an empty list would mean "all pallets" on this chain), caps that differ from the router's stated `call`, `amounts` and `fee_call`, or a per-session or daily cap above the total cap is refused. The batch is built locally and its encoding must equal the router's `call_data`. The chain scopes the fee grant to the `Balances` pallet and its caps; it cannot name the recipient, so the fee address is the router's own promise, shown before you sign.
- `deposit` refuses when the loaded wallet is not the wallet that owns the API key, because a deposit is credited to the sender.
- Every command that moves funds shows a summary and asks for confirmation. Without a terminal it needs `--yes`.
