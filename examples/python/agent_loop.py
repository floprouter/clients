"""A minimal agent loop on the floprouter API, over plain HTTP (Python standard library only).

FLOP models do not take `tools` yet, so the loop asks for one JSON action per turn, runs it locally and feeds the
result back. Every turn is one paid session; MAX_STEPS bounds the spend.

FLOPROUTER_API_KEY=fr_... python agent_loop.py
"""
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

BASE = os.environ.get("FLOPROUTER_BASE_URL", "https://api.floprouter.com") + "/v1"
KEY = os.environ.get("FLOPROUTER_API_KEY", "")
MODEL = os.environ.get("FLOPROUTER_MODEL", "qwen/qwen3-8b")
MAX_STEPS = int(os.environ.get("MAX_STEPS", "3"))

SYSTEM = (
    "You solve the task step by step using tools. Reply with exactly one JSON object and nothing else.\n"
    'To use the calculator: {"tool": "calc", "input": "<arithmetic expression>"}\n'
    'To finish: {"final": "<answer>"}'
)


def call(method, path, body=None):
    req = urllib.request.Request(BASE + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json", "X-Title": "agent_loop.py example"})
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        err = json.loads(e.read() or b"{}").get("error", {})
        reason = (err.get("metadata") or {}).get("reason") or err.get("code")
        raise SystemExit(f"HTTP {e.code} {reason}: {err.get('message')}")


def complete(messages):
    status, data = call("POST", "/chat/completions", {"model": MODEL, "messages": messages, "max_tokens": 96})
    if data.get("object") == "chat.completion.pending":          # no verified reply within ~85 s: poll the session
        for _ in range(36):
            time.sleep(5)
            _, s = call("GET", f"/sessions/{data['id']}")
            reply = s.get("reply")
            text = reply if isinstance(reply, str) else (reply or {}).get("content")   # string or {role, content}
            if isinstance(text, str):
                return text, data["id"], None
            if s.get("status") in ("failed", "refunded", "voided", "fraud"):
                raise SystemExit(f"session {data['id']} ended {s['status']}")
        raise SystemExit(f"no reply yet for {data['id']}")
    return data["choices"][0]["message"]["content"] or "", data.get("id"), (data.get("usage") or {}).get("cost")


def calc(expr):
    if not re.fullmatch(r"[0-9+\-*/(). ]{1,100}", expr) or "**" in expr:
        return "error: only arithmetic is allowed"
    return str(eval(expr, {"__builtins__": {}}, {}))  # input is restricted to arithmetic above


def parse_action(text):
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.S)  # some models emit a reasoning block
    m = re.search(r"\{.*\}", text, flags=re.S)
    try:
        return json.loads(m.group(0)) if m else None
    except json.JSONDecodeError:
        return None


def run(task):
    messages = [{"role": "system", "content": SYSTEM}, {"role": "user", "content": task}]
    for step in range(1, MAX_STEPS + 1):
        reply, gen_id, cost = complete(messages)
        print(f"step {step} [{gen_id}, cost {cost} FLOP]: {reply.strip()[:200]}")
        action = parse_action(reply)
        messages.append({"role": "assistant", "content": reply})
        if action and "final" in action:
            return str(action["final"])
        if action and action.get("tool") == "calc":
            messages.append({"role": "user", "content": f"calc result: {calc(str(action.get('input', '')))}"})
        else:
            messages.append({"role": "user", "content": "Reply with one JSON object as instructed."})
    return "(no final answer within MAX_STEPS)"


if __name__ == "__main__":
    print("answer:", run(sys.argv[1] if len(sys.argv) > 1 else "What is 17 * 23 + 4? Use the calculator."))
