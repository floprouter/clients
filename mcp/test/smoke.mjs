// Smoke test: start the server over stdio (and optionally streamable HTTP), list tools, call each read-only tool.
// Paid chat only with --paid.   node test/smoke.mjs [--paid] [--http]
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('../src/index.js', import.meta.url));
const paid = process.argv.includes('--paid');
const useHttp = process.argv.includes('--http');
const text = (r) => r.content?.map((c) => c.text).join('\n') ?? '';
let child;
const client = new Client({ name: 'floprouter-mcp-smoke', version: '0.0.0' });
if (useHttp) {
  child = spawn(process.execPath, [entry, '--http', '--port', '8794'], { env: process.env, stdio: ['ignore', 'inherit', 'inherit'] });
  await new Promise((r) => setTimeout(r, 800));
  await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:8794/mcp')));
} else {
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry], env: process.env, stderr: 'inherit' }));
}
const tools = await client.listTools();
console.log('tools:', tools.tools.map((t) => t.name).join(', '));
const call = async (name, args = {}) => {
  const t0 = Date.now();
  const r = await client.callTool({ name, arguments: args });
  const out = text(r);
  console.log(`\n== ${name} ${JSON.stringify(args)} -> ${r.isError ? 'ERROR' : 'ok'} in ${Date.now() - t0} ms\n${out.slice(0, 700)}${out.length > 700 ? ' ...' : ''}`);
  return { r, out };
};
await call('router_status');
const models = await call('list_models', { only_available: true });
const miners = await call('list_miners', { reachable: true, limit: 3 });
const first = JSON.parse(miners.out).miners?.[0]?.address;
if (first) await call('get_miner', { address: first }).then(({ out }) => out);
await call('session_status', { session_id: process.env.SMOKE_SESSION_ID || 'gen-does-not-exist' });
await call('account');
await call('generation', { id: 'gen-does-not-exist' });
if (paid) {
  const model = process.env.SMOKE_MODEL ?? JSON.parse(models.out).models?.[0]?.id ?? 'qwen/qwen3-8b';
  const { out } = await call('chat', { model, prompt: 'In one sentence: what is a payment channel?', max_tokens: 48, fallback_payer: 'credit' });
  const sid = JSON.parse(out).flop?.session_id ?? JSON.parse(out).generation_id;
  if (sid) { await call('session_status', { session_id: sid }); await call('generation', { id: sid }); }
}
await client.close();
child?.kill();
