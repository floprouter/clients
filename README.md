# floprouter client tools

Command-line client, MCP server and examples for the [floprouter](https://floprouter.com) API: one HTTP API for every GPU miner and model on FLOP Network. The router picks a miner, pays it in FLOP through an on-chain payment channel, and returns the verified reply.

Docs: https://docs.floprouter.com

| Piece | Directory | Package |
| - | - | - |
| CLI | `cli/` | [`floprouter`](https://www.npmjs.com/package/floprouter) |
| MCP server | `mcp/` | [`floprouter-mcp`](https://www.npmjs.com/package/floprouter-mcp) |
| Examples | `examples/` | plain HTTP first (curl, Python, fetch, an agent loop), then SDKs that accept a custom base URL |

## Quick start

```bash
npx floprouter models
npx floprouter miners --reachable
npx floprouter login --key-file ./my-wallet.json   # signs the login challenge locally
npx floprouter grant                               # one signature; your wallet stays the payer on chain
npx floprouter chat "What is a payment channel?"
```

MCP server, for any MCP client:

```bash
FLOPROUTER_API_KEY=fr_... npx -y floprouter-mcp
```

Wallet keys stay on your machine. The router receives your address, a signature over its login challenge, and transactions you sign locally.

## Status

Runs on FLOP devnet. Devnet and testnet FLOP have no monetary value.


## Tests

`npm test` in `cli/` and in `mcp/` runs offline against a stub router.

## License

MIT
