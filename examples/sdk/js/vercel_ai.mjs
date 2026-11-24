// The floprouter API through an SDK that accepts a custom base URL: the Vercel AI SDK.   npm i ai @ai-sdk/openai-compatible && node vercel_ai.mjs [--stream]
import { generateText, streamText } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

// An earlier API version answers a slow request with 202 "pending" and the generation id. The SDK cannot read that
// body, so this fetch wrapper keeps the id, and the reply is then read from the generation record.
let pendingId = null;
const fetchKeepingPending = async (url, init) => {
  const r = await fetch(url, init);
  if (r.status === 202) pendingId = (await r.clone().json()).id ?? null;
  return r;
};

const floprouter = createOpenAICompatible({
  name: 'floprouter',
  fetch: fetchKeepingPending,
  baseURL: (process.env.FLOPROUTER_BASE_URL ?? 'https://api.floprouter.com') + '/v1',
  apiKey: process.env.FLOPROUTER_API_KEY ?? 'none',
});
const model = floprouter(process.env.FLOPROUTER_MODEL ?? 'qwen/qwen3-8b');
// Fields under providerOptions.floprouter are sent in the request body.
const providerOptions = { floprouter: { flop: { wait_for_settlement: false } } };

if (process.argv.includes('--stream')) {
  // streamText reports errors through onError (the text stream just ends), so set the exit code there.
  let failed = null;
  const result = streamText({ model, prompt: 'Name three uses of a GPU, comma separated.', maxOutputTokens: 48, providerOptions,
    onError: ({ error }) => { failed = error; } });
  for await (const text of result.textStream) process.stdout.write(text);
  console.log();
  if (failed) { console.error(`error: ${failed?.message ?? failed}`); process.exit(1); }
} else {
  try {
    const { text, response } = await generateText({ model, prompt: 'In one sentence, what is a payment channel?', maxOutputTokens: 64, providerOptions });
    console.log(text);
    console.log('session:', response.id);
  } catch (e) {
    if (!pendingId) { console.error(`error: ${e?.message ?? e}`); process.exit(1); }
    console.log(`pending ${pendingId}; polling`);
    console.log(await waitForReply(pendingId));
  }
}

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

