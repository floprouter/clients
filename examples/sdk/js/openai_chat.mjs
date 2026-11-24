// The floprouter API through an SDK that accepts a custom base URL: the OpenAI JS SDK (non-streaming).   npm i openai && node openai_chat.mjs
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: (process.env.FLOPROUTER_BASE_URL ?? 'https://api.floprouter.com') + '/v1',
  apiKey: process.env.FLOPROUTER_API_KEY ?? 'none',
  timeout: 300_000,
});

const { data: resp, response } = await client.chat.completions.create({
  model: process.env.FLOPROUTER_MODEL ?? 'qwen/qwen3-8b',
  messages: [{ role: 'user', content: 'In one sentence, what is a payment channel?' }],
  max_tokens: 64,
  // Router options are extra body fields. Return as soon as the reply is verified; settlement follows on chain.
  flop: { wait_for_settlement: false },
}).withResponse();

if (response.status === 202) {
  // "pending": no verified reply yet (an earlier API version answers this after about 85 s). The request carries on;
  // read the reply from the generation record.
  console.log(`pending ${resp.id}; polling`);
  console.log(await waitForReply(resp.id));
  process.exit(0);
}
console.log(resp.choices[0].message.content);
const { session_id, miner, escrow, status } = resp.flop ?? {};
console.log(`cost=${resp.usage?.cost} FLOP session=${session_id} miner=${miner} escrow=${escrow} status=${status}`);

/** Polls a generation that is still running (a 202 "pending" answer) until it has the verified reply.
 *  GET /v1/generation?id= on the current API; GET /v1/sessions/{id} on an earlier one. */
async function waitForReply(id, { everyMs = 5000, limitMs = 300_000 } = {}) {
  const base = (process.env.FLOPROUTER_BASE_URL ?? 'https://api.floprouter.com') + '/v1';
  const headers = { authorization: `Bearer ${process.env.FLOPROUTER_API_KEY ?? ''}` };
  for (const t0 = Date.now(); Date.now() - t0 < limitMs;) {
    await new Promise((r) => setTimeout(r, everyMs));
    for (const path of [`/generation?id=${id}`, `/sessions/${id}`]) {
      const r = await fetch(base + path, { headers });
      if (r.status === 404) continue;                       // this router has no /generation: try the session record
      const body = await r.json(); const rec = body.data ?? body;   // /generation wraps in data, /sessions does not
      const raw = rec.reply ?? null;
      const text = typeof raw === 'string' ? raw : raw?.content;
      if (typeof text === 'string') return text;
      const status = rec.flop?.status ?? rec.status;
      if (['failed', 'refunded', 'voided', 'fraud'].includes(status)) throw new Error(`generation ${id} ended ${status} without a reply`);
      break;
    }
  }
  throw new Error(`no reply yet for ${id}; look it up later with GET /v1/generation?id=${id}`);
}
