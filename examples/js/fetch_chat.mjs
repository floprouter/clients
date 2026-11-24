// The floprouter API over plain HTTP with fetch (Node 18+, Deno, Bun, browsers). No dependencies.
//   FLOPROUTER_API_KEY=fr_... node fetch_chat.mjs [--stream]
// Paths: /v1/... (the same routes are also served under /api/v1/...).
const BASE = (process.env.FLOPROUTER_BASE_URL ?? 'https://api.floprouter.com') + '/v1';
const KEY = process.env.FLOPROUTER_API_KEY ?? '';
const stream = process.argv.includes('--stream');

const res = await fetch(`${BASE}/chat/completions`, {
  method: 'POST',
  headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json', 'x-title': 'fetch_chat.mjs example' },
  body: JSON.stringify({
    model: process.env.FLOPROUTER_MODEL ?? 'qwen/qwen3-8b',
    // models: ['qwen/qwen2.5-0.5b-instruct'],   // optional fallback list
    messages: [{ role: 'user', content: 'Name three uses of a GPU, comma separated.' }],
    max_tokens: 48,                              // the escrow (the price) follows max_tokens
    stream,
  }),
});
if (!res.ok) {
  const { error = {} } = await res.json().catch(() => ({}));
  // Current format: code = HTTP status, metadata.reason = the specific reason. Earlier servers: code = reason.
  throw new Error(`HTTP ${res.status} ${error.metadata?.reason ?? error.code}: ${error.message}`);
}
console.log('generation id:', res.headers.get('x-generation-id'));
const ignored = res.headers.get('x-floprouter-ignored-parameters');
if (ignored) console.log('ignored by the model:', ignored);

if (!stream) {
  const data = await res.json();   // leading spaces (the server's keep-alive while it waits) are fine for JSON
  // An error after a long wait arrives as a 200 body; error.code is the real status.
  if (data.error) { console.error(`HTTP ${data.error.code} ${data.error.metadata?.reason}: ${data.error.message}`); process.exit(1); }
  if (data.object === 'chat.completion.pending') {   // earlier API version: no verified reply within ~85 s
    console.log(`pending ${data.id}; polling`);
    console.log(await waitForReply(data.id));
    process.exit(0);
  }
  console.log(data.choices[0].message.content);
  console.log(`cost=${data.usage?.cost} FLOP session=${data.flop?.session_id} miner=${data.flop?.miner} status=${data.flop?.status}`);
} else {
  let buf = ''; let flop; let usage;
  const decoder = new TextDecoder();
  for await (const part of res.body) {
    buf += decoder.decode(part, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const event = buf.slice(0, i); buf = buf.slice(i + 2);
      for (const line of event.split('\n')) {
        if (!line.startsWith('data:')) continue;           // ": FLOPROUTER PROCESSING" keep-alive comments
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        const chunk = JSON.parse(payload);
        if (chunk.error) throw new Error(`stream error: ${chunk.error.message}`);   // the stream ends after it
        for (const c of chunk.choices ?? []) process.stdout.write(c.delta?.content ?? '');
        flop = chunk.flop ?? flop; usage = chunk.usage ?? usage;
      }
    }
  }
  console.log(`\ncost=${usage?.cost} FLOP session=${flop?.session_id} miner=${flop?.miner} status=${flop?.status}`);
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
