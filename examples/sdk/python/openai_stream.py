"""The floprouter API through an SDK that accepts a custom base URL: the OpenAI Python SDK (streaming).

Text arrives as the miner decodes it. It is provisional until the miner's signed receipt is verified at the end of
the turn; if that check failed, an error event would follow. The last chunk carries usage and the `flop` block.
"""
import os
from openai import OpenAI

client = OpenAI(
    base_url=os.environ.get("FLOPROUTER_BASE_URL", "https://api.floprouter.com") + "/v1",
    api_key=os.environ.get("FLOPROUTER_API_KEY", "none"),
    timeout=300,
)

stream = client.chat.completions.create(
    model=os.environ.get("FLOPROUTER_MODEL", "qwen/qwen3-8b"),
    messages=[{"role": "user", "content": "Name three uses of a GPU, comma separated."}],
    max_tokens=48,
    stream=True,
)

flop = None
for chunk in stream:
    if chunk.choices and chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="", flush=True)
    flop = (chunk.model_extra or {}).get("flop") or flop
print()
if flop:
    print(f"session={flop.get('session_id')} miner={flop.get('miner')} status={flop.get('status')}")
