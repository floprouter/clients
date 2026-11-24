// The floprouter API through an SDK that accepts a custom base URL: the Vercel AI SDK.   npm i ai @ai-sdk/openai-compatible && node vercel_ai.mjs [--stream]
import { generateText, streamText } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

const floprouter = createOpenAICompatible({
  name: 'floprouter',
  baseURL: (process.env.FLOPROUTER_BASE_URL ?? 'https://api.floprouter.com') + '/v1',
  apiKey: process.env.FLOPROUTER_API_KEY ?? 'none',
});
const model = floprouter(process.env.FLOPROUTER_MODEL ?? 'qwen/qwen3-8b');
// Fields under providerOptions.floprouter are sent in the request body.
const providerOptions = { floprouter: { flop: { wait_for_settlement: false } } };

if (process.argv.includes('--stream')) {
  const result = streamText({ model, prompt: 'Name three uses of a GPU, comma separated.', maxOutputTokens: 48, providerOptions });
  for await (const text of result.textStream) process.stdout.write(text);
  console.log();
} else {
  const { text, response } = await generateText({ model, prompt: 'In one sentence, what is a payment channel?', maxOutputTokens: 64, providerOptions });
  console.log(text);
  console.log('session:', response.id);
}
