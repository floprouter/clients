"""The floprouter API through an SDK that accepts a custom base URL: the OpenAI Python SDK (non-streaming).

pip install openai
FLOPROUTER_API_KEY=fr_... python openai_chat.py
"""
import os
from openai import OpenAI

client = OpenAI(
    base_url=os.environ.get("FLOPROUTER_BASE_URL", "https://api.floprouter.com") + "/v1",
    api_key=os.environ.get("FLOPROUTER_API_KEY", "none"),
    timeout=300,
)

resp = client.chat.completions.create(
    model=os.environ.get("FLOPROUTER_MODEL", "qwen/qwen3-8b"),
    messages=[{"role": "user", "content": "In one sentence, what is a payment channel?"}],
    max_tokens=64,
    # Router options travel in the body. Return as soon as the reply is verified; settlement follows on chain.
    extra_body={"flop": {"wait_for_settlement": False}},
)

print(resp.choices[0].message.content)
flop = resp.model_extra.get("flop", {})  # session id, miner, escrow, payer, status
usage = resp.usage.model_extra if resp.usage else {}
print(f"cost={(usage or {}).get('cost')} FLOP session={flop.get('session_id')} miner={flop.get('miner')} status={flop.get('status')}")
