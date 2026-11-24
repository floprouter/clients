"""The floprouter API over plain HTTP, with only the Python standard library.

FLOPROUTER_API_KEY=fr_... python http_chat.py [--stream]

Paths: /v1/... (the same routes are also served under /api/v1/...).
"""
import json
import os
import sys
import urllib.error
import urllib.request

BASE = os.environ.get("FLOPROUTER_BASE_URL", "https://api.floprouter.com") + "/v1"
KEY = os.environ.get("FLOPROUTER_API_KEY", "")
MODEL = os.environ.get("FLOPROUTER_MODEL", "qwen/qwen3-8b")
STREAM = "--stream" in sys.argv


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



body = {
    "model": MODEL,
    # "models": ["qwen/qwen2.5-0.5b-instruct"],   # optional fallback list, tried when no miner serves MODEL
    "messages": [{"role": "user", "content": "In one sentence, what is a payment channel?"}],
    "max_tokens": 64,          # the escrow (the price) follows max_tokens
    "stream": STREAM,
}
req = urllib.request.Request(
    BASE + "/chat/completions",
    data=json.dumps(body).encode(),
    headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json", "X-Title": "http_chat.py example"},
)
try:
    resp = urllib.request.urlopen(req, timeout=300)
except urllib.error.HTTPError as e:
    err = json.loads(e.read() or b"{}").get("error", {})
    # Current format: code = HTTP status, metadata.reason = the specific reason. Earlier servers: code = reason.
    reason = (err.get("metadata") or {}).get("reason") or err.get("code")
    sys.exit(f"HTTP {e.code} {reason}: {err.get('message')}")

print("generation id:", resp.headers.get("X-Generation-Id"))
if resp.headers.get("X-Floprouter-Ignored-Parameters"):
    print("ignored by the model:", resp.headers["X-Floprouter-Ignored-Parameters"])

if not STREAM:
    data = json.loads(resp.read())   # leading spaces (the server's keep-alive while it waits) are fine for JSON
    if "error" in data:              # an error after a long wait arrives as a 200 body; error.code is the real status
        err = data["error"]
        sys.exit(f"HTTP {err.get('code')} {(err.get('metadata') or {}).get('reason')}: {err.get('message')}")
    if data.get("object") == "chat.completion.pending":   # earlier API version: no verified reply within ~85 s
        print(f"pending {data['id']}; polling")
        print(wait_for_reply(data["id"]))
        sys.exit(0)
    print(data["choices"][0]["message"]["content"])
    usage, flop = data.get("usage", {}), data.get("flop", {})
    print(f"cost={usage.get('cost')} FLOP session={flop.get('session_id')} miner={flop.get('miner')} status={flop.get('status')}")
else:
    flop = usage = None
    for raw in resp:                      # server-sent events, one "data: {...}" line per chunk
        line = raw.decode().strip()
        if not line.startswith("data:"):
            continue                      # ": FLOPROUTER PROCESSING" keep-alive comments and blank lines
        payload = line[5:].strip()
        if payload == "[DONE]":
            break
        chunk = json.loads(payload)
        if "error" in chunk:              # mid-stream error: the stream ends here
            sys.exit(f"\nstream error: {chunk['error'].get('message')}")
        for choice in chunk.get("choices", []):
            print(choice.get("delta", {}).get("content") or "", end="", flush=True)
        flop = chunk.get("flop") or flop
        usage = chunk.get("usage") or usage
    print()
    if flop:
        print(f"cost={(usage or {}).get('cost')} FLOP session={flop.get('session_id')} miner={flop.get('miner')} status={flop.get('status')}")
