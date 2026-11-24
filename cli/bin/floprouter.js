#!/usr/bin/env node
// floprouter CLI. Run `floprouter help`.
import { parseArgs } from 'node:util';
import { makeClient, DEFAULT_BASE_URL } from '../src/api.js';
import { configPath, dim, err, readConfig, red, writeConfig } from '../src/io.js';
import * as cmd from '../src/commands.js';

const VERSION = '0.1.2';

const HELP = `floprouter ${VERSION}: the floprouter API from the command line (chat with FLOP Network miners, paid in FLOP)

Usage: floprouter <command> [options]

Browse (no key needed)
  models [--available]                     models, ready miners, price per 1,000 tokens
  miners [filters]                         every registered miner with score and facts
      --reachable --ready --calibrated --model <id> --min-score <n>
      --sort score|settle_rate|sessions|stake|latency|capacity --order asc|desc
      --limit <n> --offset <n> --all
  miner <address>                          one miner in detail (availability, health, last check)
  status                                   router health, network, payer

Miner operators (sign with the miner key locally; works headless with --key-file and --yes)
  miner endpoint <https://host[:port]>     prove control of the miner account and list or change its session URL
      --key-file <miner key> | --seed-file <file>  [--password-file <file>] [--yes] [--json]
  miner status [<address>]                 your listing: availability, health, last check; your URLs with a key of the miner

Use (needs an API key)
  chat [prompt]                            one-shot if a prompt is given or piped, interactive otherwise
      --model <id>       default: the model with the most ready miners
      --fallback-model <id>  try this model next if no miner serves the first (repeatable; the API's \`models\` list)
      --miner <address>  pin a miner (repeat or comma-separate to give an order); default: auto
      --fallbacks        when pinned, allow other miners if the pinned ones fail
      --sort reliability|latency|price|throughput  auto-selection order (reliability: on-chain score, the default)
      --stream           print text as the miner decodes it (verified when the turn ends)
      --max-tokens <n> --system <text>
      --wait             after the reply, poll until the on-chain settlement is final (2-5 minutes)
      --payer grant|credit  override the payer mode of the key for this request
      --fallback-payer credit  in grant mode, run in credit mode when no miner has a live signed offer
  session [<id>]                           one session's settlement state, or your recent sessions
  generation <id>                          tokens, cost in FLOP, latency and reply of one request
  balance                                  prepaid balance, deposit address, withdrawals, grant state
  key                                      this API key: usage in FLOP, rate limits, payer mode
  withdraw <amount|all>                    send prepaid balance back to your wallet

Wallet (signs locally; keys never leave this machine)
  login                                    create an API key by signing the router's challenge
      --name <label> --payer grant|credit --show-key --no-save --wrap-bytes
  keys [revoke <id> | payer <id> grant|credit]   list, revoke or re-mode your API keys
  key --show                               print the stored API key itself
  logout                                   forget the stored API key
  grant                                    sign the one-time session-key grant (you stay the on-chain payer)
      --spending-cap <FLOP> --per-tx <FLOP> --daily-cap <FLOP> --days <n> --fee-float <FLOP> --max-float <FLOP>
      --revoke --status [--json]
      --auto-renew [--renew-before 2d] [--min-remaining <FLOP>] [--min-daily <FLOP>] [--dry-run] [--json]
                         renew only when needed (missing, revoked, expiring, nearly used up); for cron and agents
  deposit <amount>                         transfer FLOP from your wallet to your router balance

  Wallet options: --key-file <polkadot-js JSON>  or  --seed-file <file with mnemonic/seed>
                  (or FLOPROUTER_KEY_FILE / FLOPROUTER_SEED_FILE; otherwise a hidden prompt)
                  --password-file <file> --type sr25519|ed25519 --yes
                  --rpc <wss://...>  only to override the chain endpoint the router names

Global: --base-url <url> (FLOPROUTER_BASE_URL, default ${DEFAULT_BASE_URL})  --api-key-env <NAME>  --json
API key: FLOPROUTER_API_KEY, else the one saved by \`login\` in ${configPath()}
`;

const options = {
  json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' }, version: { type: 'boolean' },
  'base-url': { type: 'string' }, 'api-key-env': { type: 'string' },
  available: { type: 'boolean' },
  reachable: { type: 'boolean' }, ready: { type: 'boolean' }, calibrated: { type: 'boolean' }, model: { type: 'string', short: 'm' },
  'min-score': { type: 'string' }, sort: { type: 'string' }, order: { type: 'string' }, limit: { type: 'string' }, offset: { type: 'string' }, all: { type: 'boolean' },
  miner: { type: 'string', multiple: true }, 'fallback-model': { type: 'string', multiple: true }, 'fallback-payer': { type: 'string' }, fallbacks: { type: 'boolean' }, stream: { type: 'boolean', short: 's' },
  'max-tokens': { type: 'string' }, system: { type: 'string' }, wait: { type: 'boolean' }, payer: { type: 'string' },
  name: { type: 'string' }, 'show-key': { type: 'boolean' }, 'no-save': { type: 'boolean' }, 'wrap-bytes': { type: 'boolean' }, show: { type: 'boolean' },
  'spending-cap': { type: 'string' }, 'per-tx': { type: 'string' }, 'daily-cap': { type: 'string' }, days: { type: 'string' },
  'fee-float': { type: 'string' }, 'max-float': { type: 'string' }, 'auto-renew': { type: 'boolean' }, 'dry-run': { type: 'boolean' }, 'renew-before': { type: 'string' }, 'min-remaining': { type: 'string' }, 'min-daily': { type: 'string' }, revoke: { type: 'boolean' }, status: { type: 'boolean' },
  'key-file': { type: 'string' }, 'seed-file': { type: 'string' }, 'password-file': { type: 'string' }, type: { type: 'string' }, rpc: { type: 'string' }, yes: { type: 'boolean', short: 'y' },
};

async function main() {
  const argv = process.argv.slice(2);
  const secretFlag = argv.find((a) => /^--(seed|mnemonic|secret|private-key|suri|password)(=|$)/.test(a));
  if (secretFlag) throw new Error(`${secretFlag.split('=')[0]} is not accepted: secrets are never read from the command line. Use --seed-file, --key-file or the hidden prompt.`);
  const { values: o, positionals } = parseArgs({ args: argv, options, allowPositionals: true, strict: true });
  const [command = 'help', ...rest] = positionals;
  if (o.version) return console.log(VERSION);
  if (o.help || command === 'help') return process.stdout.write(HELP);

  const saved = readConfig();
  const baseUrl = o['base-url'] || process.env.FLOPROUTER_BASE_URL || saved.base_url || DEFAULT_BASE_URL;
  const apiKey = (o['api-key-env'] ? process.env[o['api-key-env']] : process.env.FLOPROUTER_API_KEY) || saved.api_key;
  const ctx = { api: makeClient({ baseUrl, apiKey, userAgent: `floprouter-cli/${VERSION}`, title: 'floprouter CLI' }) };

  switch (command) {
    case 'models': return cmd.models(ctx, o);
    case 'miners': return cmd.miners(ctx, o);
    case 'miner': return cmd.miner(ctx, o, rest[0], rest.slice(1));
    case 'status': case 'health': return cmd.health(ctx, o);
    case 'chat': return cmd.chat(ctx, o, rest);
    case 'session': case 'sessions': return cmd.session(ctx, o, rest[0]);
    case 'balance': return cmd.balance(ctx, o);
    case 'login': return cmd.login(ctx, o);
    case 'keys': return cmd.keys(ctx, o, rest);
    case 'key':
      if (!o.show) return cmd.keyInfo(ctx, o);
      if (!saved.api_key) throw new Error(`no key stored in ${configPath()}`);
      return console.log(saved.api_key);
    case 'generation': return cmd.generation(ctx, o, rest[0]);
    case 'withdraw': return cmd.withdraw(ctx, o, rest);
    case 'logout': writeConfig({ api_key: null, address: null }); return err(`removed the API key from ${configPath()}`);
    case 'grant': return cmd.grant(ctx, o);
    case 'deposit': return cmd.deposit(ctx, o, rest);
    default: throw new Error(`unknown command "${command}"; run floprouter help`);
  }
}

main().then(() => process.exit(process.exitCode ?? 0), (e) => {
  err(red(cmd.describe(e)));
  if (process.env.FLOPROUTER_DEBUG) err(dim(e?.stack ?? ''));
  process.exit(1);
});
