"""The floprouter API through an SDK that accepts a custom base URL: LangChain (langchain-openai).

pip install langchain-openai
"""
import os

import httpx
from langchain_openai import ChatOpenAI


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


# An earlier API version answers a slow request with 202 "pending" and the generation id; LangChain cannot read
# that body, so a response hook keeps the id and the reply is read from the generation record instead.
pending = {}


def remember_pending(response):
    if response.status_code == 202 and response.request.url.path.endswith("/chat/completions"):
        response.read()
        pending["id"] = response.json().get("id")


llm = ChatOpenAI(
    base_url=os.environ.get("FLOPROUTER_BASE_URL", "https://api.floprouter.com") + "/v1",
    api_key=os.environ.get("FLOPROUTER_API_KEY", "none"),
    model=os.environ.get("FLOPROUTER_MODEL", "qwen/qwen3-8b"),
    max_tokens=64,
    timeout=300,
    extra_body={"flop": {"wait_for_settlement": False}},
    http_client=httpx.Client(event_hooks={"response": [remember_pending]}, timeout=300),
)

try:
    msg = llm.invoke([("system", "Answer in one sentence."), ("user", "What does a GPU miner do?")])
except Exception:
    if not pending.get("id"):
        raise
    print(f"pending {pending['id']}; polling")
    print(wait_for_reply(pending["id"]))
    raise SystemExit(0)
print(msg.content)
print("session:", (msg.response_metadata or {}).get("id"))
