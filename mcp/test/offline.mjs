// Offline test: no network. A local fake router serves the earlier and the current API formats; the MCP server is
// driven over stdio against each and must give the same answers.   node test/offline.mjs
import assert from 'node:assert/strict';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readError, modelFacts, costOf } from '../src/api.js';

// --- unit: both error formats, both model formats
assert.deepEqual(readError({ code: 402, message: 'm', metadata: { reason: 'insufficient_balance', available: '0' } }, 402),
  { reason: 'insufficient_balance', message: 'm', metadata: { reason: 'insufficient_balance', available: '0' } });
assert.equal(readError({ code: 'insufficient_balance', message: 'm', type: 'invalid_request_error', available: '0' }, 402).reason, 'insufficient_balance');
assert.equal(readError({ code: 'insufficient_balance', available: '0' }, 402).metadata.available, '0');
assert.equal(readError({ code: 503, message: 'x' }, 503).reason, 'http_503');
const oldModel = { id: 'a/b', available: true, miners_ready: 2, miners_reachable: 3, params_billion: 8, pricing: { escrow_per_1000_tokens: '0.05', router_fee_percent: 5 } };
const newModel = { id: 'a/b', context_length: 10000, pricing: { prompt: '0.00005', completion: '0.00005' }, supported_parameters: ['max_tokens'],
  flop: { available: true, providers_ready: 2, providers_reachable: 3, params_billion: 8, escrow_per_1000_tokens: '0.05', router_fee_percent: 5, min_charge_per_request: '0.01' } };
for (const m of [oldModel, newModel]) {
  const f = modelFacts(m);
  assert.equal(f.available, true); assert.equal(f.ready, 2); assert.equal(f.reachable, 3); assert.equal(f.escrowPer1k, '0.05'); assert.equal(f.routerFeePercent, 5);
}
assert.equal(costOf({ usage: { cost: 0.0105 } }), '0.0105'); assert.equal(costOf({ usage: {} }), null);

// --- integration: the MCP server against a fake router in each format
const fake = (format) => http.createServer(async (req, res) => {
  let raw = ''; for await (const c of req) raw += c;
  const body = raw ? JSON.parse(raw) : {};
  const url = new URL(req.url, 'http://x'); if (process.env.DEBUG_FAKE) console.error(format, req.method, url.pathname);
  const send = (status, body, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
  const error = (status, reason, message) => send(status, format === 'new'
    ? { error: { code: status, message, metadata: { reason } } } : { error: { code: reason, message, type: 'invalid_request_error' } });
  if (url.pathname === '/v1/models') return send(200, { object: 'list', data: [format === 'new' ? newModel : oldModel] });
  if (url.pathname === '/v1/chat/completions') {
    // Streams (the MCP server always streams internally). New format: id in X-Generation-Id; old: only in chunks.
    res.writeHead(200, { 'content-type': 'text/event-stream', ...(format === 'new' ? { 'x-generation-id': body.model === 'slow/model' ? 'gen-p11111' : 'gen-abc123', 'x-floprouter-ignored-parameters': 'temperature' } : {}) });
    res.write(format === 'new' ? ': FLOPROUTER PROCESSING\n\n' : ': waiting\n\n');
    if (body.model === 'slow/model') { const t = setTimeout(() => res.end(), 4000); res.on('close', () => clearTimeout(t)); return; }
    const chunk = (o) => res.write(`data: ${JSON.stringify({ id: 'gen-abc123', object: 'chat.completion.chunk', model: 'a/b', ...o })}\n\n`);
    chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: 'hi' }, finish_reason: null }] });
    chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    chunk({ choices: format === 'new' ? [{ index: 0, delta: { content: '' }, finish_reason: 'stop' }] : [],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4, ...(format === 'new' ? { cost: 0.0105, cost_details: { final: false } } : {}) },
      flop: { session_id: 'gen-abc123', status: 'settling', miner: '5Miner', escrow: '0.01', payer: { kind: 'session-key', mode: 'grant' }, ...(format === 'new' ? { ignored_parameters: ['temperature'] } : {}) } });
    return res.end('data: [DONE]\n\n');
  }
  if (url.pathname === '/v1/key') return format === 'new' ? send(200, { data: { usage: 0.5, limit: null, flop: { key_id: 'key_1' } } }) : error(404, 'not_found', 'no route GET /v1/key');
  if (url.pathname === '/v1/balance') return send(200, { address: '5Me', balance: '1', available: '1', recent: [] });
  if (url.pathname === '/v1/grants') return send(200, { object: 'list', data: [] });
  if (url.pathname === '/v1/generation') return format === 'new' ? send(200, { data: { id: url.searchParams.get('id'), total_cost: 0.0105 } }) : error(404, 'not_found', 'no route GET /v1/generation');
  if (url.pathname === '/v1/sessions/gen-abc123') return send(200, { session_id: 'gen-abc123', status: 'settled' });
  if (url.pathname.startsWith('/v1/sessions/')) return error(404, 'session_not_found', 'no such session');
  if (url.pathname === '/v1/balance/withdraw') return format === 'new' ? error(402, 'insufficient_balance', 'not enough') : error(404, 'not_found', 'no route');
  return error(404, 'not_found', `no route ${req.method} ${url.pathname}`);
});

const entry = fileURLToPath(new URL('../src/index.js', import.meta.url));
const results = {};
for (const format of ['old', 'new']) {
  const srv = fake(format); await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const client = new Client({ name: 'offline', version: '0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry], stderr: 'ignore',
    env: { ...process.env, FLOPROUTER_BASE_URL: `http://127.0.0.1:${srv.address().port}`, FLOPROUTER_API_KEY: 'fr_test', FLOPROUTER_CONFIG: '/nonexistent', FLOPROUTER_TOOL_BUDGET_MS: '1500' } }));
  const call = async (name, args = {}) => { const r = await client.callTool({ name, arguments: args }); return { err: Boolean(r.isError), text: r.content[0].text }; };
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['account', 'chat', 'generation', 'get_miner', 'grant_status', 'list_miners', 'list_models', 'router_status', 'session_status', 'withdraw']);
  const models = JSON.parse((await call('list_models')).text).models[0];
  assert.equal(models.escrow_per_1000_tokens, '0.05'); assert.equal(models.miners_ready, 2);
  const chatR = await call('chat', { model: 'a/b', prompt: 'hi', fallback_models: ['c/d'] }); if (chatR.err) console.error(format, chatR.text);
  const chat = JSON.parse(chatR.text);
  assert.equal(chat.reply, 'hi'); assert.equal(chat.generation_id, 'gen-abc123');
  const slow = JSON.parse((await call('chat', { model: 'slow/model', prompt: 'hi' })).text);
  assert.equal(slow.pending, true); assert.equal(slow.generation_id, format === 'new' ? 'gen-p11111' : null);
  const sess = await call('session_status', { session_id: 'gen-missing' });
  assert.equal(sess.err, true); assert.match(sess.text, /404 session_not_found/);
  const acct = JSON.parse((await call('account')).text);
  const gen = JSON.parse((await call('generation', { id: 'gen-abc123' })).text);
  const wd = await call('withdraw', { amount: '1' });
  results[format] = { cost: chat.cost_flop, ignored: chat.ignored_parameters, key: acct.key, gen, wd };
  await client.close(); srv.close();
}
assert.equal(results.old.cost, null); assert.equal(results.new.cost, '0.0105');
assert.deepEqual(results.new.ignored, ['temperature']); assert.deepEqual(results.old.ignored, []);
assert.match(results.old.key.unavailable, /does not offer/); assert.equal(results.new.key.flop.key_id, 'key_1');
assert.match(results.old.gen.note, /no \/v1\/generation/); assert.equal(results.old.gen.session.status, 'settled'); assert.equal(results.new.gen.total_cost, 0.0105);
assert.match(results.old.wd.text, /does not offer withdrawals/); assert.equal(results.new.wd.err, true); assert.match(results.new.wd.text, /402 insufficient_balance/);
console.log('mcp offline tests passed (earlier and current API formats)');
