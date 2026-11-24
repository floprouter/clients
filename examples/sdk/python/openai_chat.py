"""The floprouter API through an SDK that accepts a custom base URL: the OpenAI Python SDK (non-streaming).

pip install openai
FLOPROUTER_API_KEY=fr_... python openai_chat.py
"""
import os
from openai import OpenAI


def wait_for_reply(gen_id, every=5, limit=300):
    """Polls a generation that is still running (a 202 "pending" answer) until it has the verified reply.

    GET /v1/generation?id= on the current API; GET /v1/sessions/{id} on an earlier one."""
    import json, time, urllib.error, urllib.request
    headers = {"Authorization": f"Bearer {os.environ.get('FLOPROUTER_API_KEY', '')}"}
    base = os.environ.get("FLOPROUTER_BASE_URL", "https://api.floprouter.com") + "/v1"
    t0 = time.time()
    while time.time() - t0 < limit:
        time.sleep(every)
        for path in (f"/generation?id={gen_id}", f"/sessions/{gen_id}"):
            try:
                with urllib.request.urlopen(urllib.request.Request(base + path, headers=headers), timeout=30) as r:
                    rec = json.loads(r.read())
            except urllib.error.HTTPError as e:
                if e.code == 404:
                    continue  # this router has no /generation: try the session record
                raise
            rec = rec.get("data", rec)
            reply = rec.get("reply")
            text = reply if isinstance(reply, str) else (reply or {}).get("content")
            if isinstance(text, str):
                return text
            status = (rec.get("flop") or {}).get("status") or rec.get("status")
            if status in ("failed", "refunded", "voided", "fraud"):
                raise SystemExit(f"generation {gen_id} ended {status} without a reply")
            break
    raise SystemExit(f"no reply yet for {gen_id}; look it up later with GET /v1/generation?id={gen_id}")


client = OpenAI(
    base_url=os.environ.get("FLOPROUTER_BASE_URL", "https://api.floprouter.com") + "/v1",
    api_key=os.environ.get("FLOPROUTER_API_KEY", "none"),
    timeout=300,
)

raw = client.chat.completions.with_raw_response.create(
    model=os.environ.get("FLOPROUTER_MODEL", "qwen/qwen3-8b"),
    messages=[{"role": "user", "content": "In one sentence, what is a payment channel?"}],
    max_tokens=64,
    # Router options travel in the body. Return as soon as the reply is verified; settlement follows on chain.
    extra_body={"flop": {"wait_for_settlement": False}},
)
if raw.http_response.status_code == 202:
    # "pending": no verified reply yet (an earlier API version answers this after about 85 s). The request carries
    # on; read the reply from the generation record.
    gen_id = raw.http_response.json()["id"]
    print(f"pending {gen_id}; polling")
    print(wait_for_reply(gen_id))
    raise SystemExit(0)
resp = raw.parse()

print(resp.choices[0].message.content)
flop = resp.model_extra.get("flop", {})  # session id, miner, escrow, payer, status
usage = resp.usage.model_extra if resp.usage else {}
print(f"cost={(usage or {}).get('cost')} FLOP session={flop.get('session_id')} miner={flop.get('miner')} status={flop.get('status')}")
