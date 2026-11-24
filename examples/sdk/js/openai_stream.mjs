// The floprouter API through an SDK that accepts a custom base URL: the OpenAI JS SDK (streaming). Text arrives as the miner decodes it and is verified
// against the miner's signed receipt at the end of the turn. The last chunk carries usage and the `flop` block.
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: (process.env.FLOPROUTER_BASE_URL ?? 'https://api.floprouter.com') + '/v1',
  apiKey: process.env.FLOPROUTER_API_KEY ?? 'none',
  timeout: 300_000,
});

const stream = await client.chat.completions.create({
  model: process.env.FLOPROUTER_MODEL ?? 'qwen/qwen3-8b',
  messages: [{ role: 'user', content: 'Name three uses of a GPU, comma separated.' }],
  max_tokens: 48,
  stream: true,
});

let flop;
for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? '');
  flop = chunk.flop ?? flop;
}
console.log(`\nsession=${flop?.session_id} miner=${flop?.miner} status=${flop?.status}`);
