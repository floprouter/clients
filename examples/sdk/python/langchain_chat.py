"""The floprouter API through an SDK that accepts a custom base URL: LangChain (langchain-openai).

pip install langchain-openai
"""
import os
from langchain_openai import ChatOpenAI

llm = ChatOpenAI(
    base_url=os.environ.get("FLOPROUTER_BASE_URL", "https://api.floprouter.com") + "/v1",
    api_key=os.environ.get("FLOPROUTER_API_KEY", "none"),
    model=os.environ.get("FLOPROUTER_MODEL", "qwen/qwen3-8b"),
    max_tokens=64,
    timeout=300,
    extra_body={"flop": {"wait_for_settlement": False}},
)

msg = llm.invoke([("system", "Answer in one sentence."), ("user", "What does a GPU miner do?")])
print(msg.content)
print("session:", (msg.response_metadata or {}).get("id"))
