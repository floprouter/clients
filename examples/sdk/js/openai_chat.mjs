// The floprouter API through an SDK that accepts a custom base URL: the OpenAI JS SDK (non-streaming).   npm i openai && node openai_chat.mjs
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: (process.env.FLOPROUTER_BASE_URL ?? 'https://api.floprouter.com') + '/v1',
  apiKey: process.env.FLOPROUTER_API_KEY ?? 'none',
  timeout: 300_000,
});

const resp = await client.chat.completions.create({
  model: process.env.FLOPROUTER_MODEL ?? 'qwen/qwen3-8b',
  messages: [{ role: 'user', content: 'In one sentence, what is a payment channel?' }],
  max_tokens: 64,
  // Router options are extra body fields. Return as soon as the reply is verified; settlement follows on chain.
  flop: { wait_for_settlement: false },
});

console.log(resp.choices[0].message.content);
const { session_id, miner, escrow, status } = resp.flop ?? {};
console.log(`cost=${resp.usage?.cost} FLOP session=${session_id} miner=${miner} escrow=${escrow} status=${status}`);
