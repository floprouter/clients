#!/usr/bin/env bash
# The floprouter API with curl.   ./curl.sh models | miners | chat | stream | headers | pinned <miner> | session <id> | generation <id> | key | balance
# Paths: /v1/... (the same routes are also served under /api/v1/...).
# Env: FLOPROUTER_BASE_URL (default https://api.floprouter.com), FLOPROUTER_API_KEY, FLOPROUTER_MODEL (default qwen/qwen3-8b)
set -euo pipefail
BASE="${FLOPROUTER_BASE_URL:-https://api.floprouter.com}"
MODEL="${FLOPROUTER_MODEL:-qwen/qwen3-8b}"
AUTH=(-H "Authorization: Bearer ${FLOPROUTER_API_KEY:-}")

case "${1:-chat}" in
  models)  curl -s "$BASE/v1/models" ;;
  miners)  curl -s "$BASE/v1/miners?reachable=true&ready=true&view=full&limit=5" ;;
  session)    curl -s "${AUTH[@]}" "$BASE/v1/sessions/$2" ;;
  generation) curl -s "${AUTH[@]}" "$BASE/v1/generation?id=$2" ;;      # tokens, cost in FLOP, latency, reply
  key)        curl -s "${AUTH[@]}" "$BASE/v1/key" ;;                   # this key's usage in FLOP and limits
  balance)    curl -s "${AUTH[@]}" "$BASE/v1/balance" ;;
  headers)
    # Response headers: X-Generation-Id, and X-Floprouter-Ignored-Parameters for parameters the model ignores
    # (temperature here: sampling is fixed by each model's decode policy on chain).
    curl -s -D - -o /dev/null "$BASE/v1/chat/completions" "${AUTH[@]}" -H 'Content-Type: application/json' -d '{
      "model": "'"$MODEL"'",
      "messages": [{"role": "user", "content": "Say hello."}],
      "max_tokens": 16,
      "temperature": 0.2
    }' ;;
  chat)
    # Returns as soon as the reply is verified (typically 10-40 s); the settlement follows on chain.
    # "models" is an optional fallback list; usage.cost is in FLOP (escrow + router fee; the escrow follows max_tokens).
    curl -s "$BASE/v1/chat/completions" "${AUTH[@]}" -H 'Content-Type: application/json' -d '{
      "model": "'"$MODEL"'",
      "models": ["qwen/qwen2.5-0.5b-instruct"],
      "messages": [{"role": "user", "content": "In one sentence, what is a payment channel?"}],
      "max_tokens": 64,
      "flop": {"wait_for_settlement": false}
    }' ;;
  stream)
    # Server-sent events: ": FLOPROUTER PROCESSING" keep-alive comments, text deltas as the miner decodes (verified at the end
    # of the turn), a final chunk with usage and the flop block, then data: [DONE].
    curl -sN "$BASE/v1/chat/completions" "${AUTH[@]}" -H 'Content-Type: application/json' -d '{
      "model": "'"$MODEL"'",
      "messages": [{"role": "user", "content": "Name three uses of a GPU, comma separated."}],
      "max_tokens": 48,
      "stream": true
    }' ;;
  pinned)
    # Pin one miner (address from ./curl.sh miners). provider.only = only these miners, no fallback.
    curl -s "$BASE/v1/chat/completions" "${AUTH[@]}" -H 'Content-Type: application/json' -d '{
      "model": "'"$MODEL"'",
      "messages": [{"role": "user", "content": "Say hello."}],
      "max_tokens": 16,
      "provider": {"only": ["'"${2:?miner address}"'"]},
      "flop": {"wait_for_settlement": false}
    }' ;;
  *) echo "usage: $0 models|miners|chat|stream|headers|pinned <miner>|session <id>|generation <id>|key|balance" >&2; exit 2 ;;
esac
