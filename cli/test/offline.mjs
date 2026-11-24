// Offline tests: no network, no chain. node test/offline.mjs
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readGrantParams } from '../src/commands.js';
import { loadSigner, signChallenge } from '../src/wallet.js';
import { signatureVerify, mnemonicGenerate } from '@polkadot/util-crypto';

const bin = fileURLToPath(new URL('../bin/floprouter.js', import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'floprouter-test-'));

// 1. secrets are refused as arguments
for (const flag of ['--seed=abc', '--mnemonic', '--password=x', '--private-key']) {
  const r = spawnSync(process.execPath, [bin, 'login', flag], { encoding: 'utf8' });
  assert.equal(r.status, 1); assert.match(r.stderr, /never read from the command line/);
}
// 2. seed file -> signer; challenge signature verifies raw (and wrapped with --wrap-bytes)
const seed = path.join(tmp, 'seed'); fs.writeFileSync(seed, mnemonicGenerate(12) + '\n', { mode: 0o600 });
const pair = await loadSigner({ seedFile: seed });
const challenge = 'floprouter API key request\nAddress: x\nNonce: 1';
assert.ok(signatureVerify(challenge, await signChallenge(pair, challenge), pair.address).isValid);
assert.ok(signatureVerify(`<Bytes>${challenge}</Bytes>`, await signChallenge(pair, challenge, { wrap: true }), pair.address).isValid);
// 3. key file (encrypted) -> same address
const kf = path.join(tmp, 'key.json'); const pw = path.join(tmp, 'pw');
fs.writeFileSync(kf, JSON.stringify(pair.toJson('pw-123')), { mode: 0o600 }); fs.writeFileSync(pw, 'pw-123\n', { mode: 0o600 });
assert.equal((await loadSigner({ keyFile: kf, passwordFile: pw })).address, pair.address);
// 4. grant params normalisation (shape served by the router)
const p = readGrantParams({
  owner: pair.address, delegate: '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY',
  limits: { max_session_duration_blocks: 864000, allowed_pallets: ['ComputeChannel'] },
  amounts: { spending_cap: '5', per_tx_limit: '0.5', daily_cap: '2', duration_blocks: 864000 },
  call: { pallet: 'flopSessionKeys', method: 'createSession', args: ['5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY', '5000000000000000000', '500000000000000000', '2000000000000000000', 864000, ['ComputeChannel']] },
});
assert.equal(p.delegate, '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY');
assert.equal(p.callMethod, 'createSession');
assert.deepEqual(p.allowedPallets, ['ComputeChannel']);
assert.equal(p.spendingCap, '5'); assert.equal(p.argRaw.cap, '5000000000000000000'); assert.equal(p.durationBlocks, 864000);
// 5. help runs
assert.match(execFileSync(process.execPath, [bin, 'help'], { encoding: 'utf8' }), /floprouter 0\.1\.1/);

// 6. the CLI against a fake router in the earlier and the current API formats
const http = await import('node:http');
const { spawn } = await import('node:child_process');
const oldModel = { id: 'a/b', available: true, miners_ready: 2, miners_reachable: 3, params_billion: 8, pricing: { escrow_per_1000_tokens: '0.05', router_fee_percent: 5 } };
const newModel = { id: 'a/b', context_length: 10000, pricing: { prompt: '0.00005', completion: '0.00005' }, available: true,
  flop: { available: true, providers_ready: 2, providers_reachable: 3, params_billion: 8, escrow_per_1000_tokens: '0.05', router_fee_percent: 5, min_charge_per_request: '0.01' } };
delete newModel.available;   // the deprecated top-level aliases are going away: test without them
const fake = (format) => http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (status, body, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
  const error = (status, reason, message) => send(status, format === 'new' ? { error: { code: status, message, metadata: { reason } } } : { error: { code: reason, message, type: 'x' } });
  if (url.pathname === '/v1/models') return send(200, { data: [format === 'new' ? newModel : oldModel] });
  if (url.pathname === '/v1/chat/completions') {
    let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
      const b = JSON.parse(body);
      if (b.model === 'grant/expired') return error(402, 'grant_expired', 'the grant expired');
      if (b.model === 'late/error') {   // current API: headers already sent, spaces, then an error as a 200 body
        res.writeHead(200, { 'content-type': 'application/json' }); res.write('   ');
        return res.end(JSON.stringify({ error: { code: 503, message: 'no provider completed the request', metadata: { reason: 'all_attempts_failed' } } }));
      }
      if (b.model === 'slow/model') return send(202, { id: 'gen-p11111', object: 'chat.completion.pending', poll: '/v1/sessions/gen-p11111' });
      if (b.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream', ...(format === 'new' ? { 'x-generation-id': 'gen-s1' } : {}) });
        res.write(': FLOPROUTER PROCESSING\n\n');
        res.write(`data: ${JSON.stringify({ id: 'gen-s1', model: 'a/b', choices: [{ index: 0, delta: { content: 'streamed' }, finish_reason: null }] })}\n\n`);
        if (b.model === 'mid/error') { res.end(`data: ${JSON.stringify(format === 'new' ? { error: { code: 502, message: 'miner went away', metadata: { reason: 'miner_failed' } }, choices: [{ delta: { content: '' }, finish_reason: 'error' }] } : { error: { code: 'miner_failed', message: 'miner went away' } })}\n\n`); return; }
        res.write(`data: ${JSON.stringify({ id: 'gen-s1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { total_tokens: 4, ...(format === 'new' ? { cost: 0.0105 } : {}) }, flop: { session_id: 'gen-s1', miner: '5Miner', status: 'settling', payer: { kind: 'session-key', mode: 'grant' } } })}\n\n`);
        return res.end('data: [DONE]\n\n');
      }
      send(200, { id: 'gen-1', model: b.models?.[0] ?? 'a/b', choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
        usage: { total_tokens: 4, ...(format === 'new' ? { cost: 0.0105, cost_details: { final: false } } : {}) },
        flop: { session_id: 'gen-1', miner: '5Miner', status: 'settling', escrow: '0.01', payer: { kind: 'session-key', mode: 'grant' } } },
      format === 'new' ? { 'x-generation-id': 'gen-1', 'x-floprouter-ignored-parameters': 'temperature' } : {});
    });
    return;
  }
  if (url.pathname === '/health') return send(200, { status: 'ok', network: 'devnet', finalized_block: 10, registry: { miners: 1, models: 1 }, endpoints: { verified: 1, verified_ready: 1 },
    payer: format === 'new' ? { router_wallet: '5Router', modes: ['grant', 'credit'], demo: false } : { kind: 'router-wallet', address: '5Router' },
    ...(format === 'new' ? { finality: { best_block: 14, finalized_block: 10, lag_blocks: 4, waiting: false } } : {}) });
  if (url.pathname === '/v1/balance') return send(200, { address: '5Me', balance: '1', available: '1', held: '0', deposit_address: '5Dep', fee_percent: 5, recent: [],
    withdrawals: format === 'new' ? { enabled: true, min: '0.01', recent: [{ status: 'sent', sent: '0.04', tx: '0xabc', created_at: 'now' }] } : undefined });
  if (url.pathname === '/v1/grants') return send(200, { object: 'list', data: [] });
  if (url.pathname === '/v1/balance/withdraw') return format === 'new'
    ? send(202, { object: 'withdrawal', id: 'wd-0000000000000001', status: 'submitted', requested: '0.05', tx: '0xabc', poll: '/v1/balance/withdrawals/wd-0000000000000001' })
    : error(404, 'not_found', 'no route');
  if (url.pathname === '/v1/balance/withdrawals/wd-0000000000000001') return send(200, { object: 'withdrawal', id: 'wd-0000000000000001', status: 'sent', requested: '0.05', sent: '0.047', chain_fee: '0.003', to: '5Me', tx: '0xabc' });
  if (url.pathname === '/v1/key') return format === 'new' ? send(200, { data: { usage: 0.5, usage_daily: 0.1, limit: null, flop: { key_id: 'key_1', address: '5Me', payer_mode: 'grant' } } }) : error(404, 'not_found', 'no route');
  if (url.pathname === '/v1/generation') return format === 'new' ? send(200, { data: { id: 'gen-1', total_cost: 0.0105, tokens_prompt: 3, tokens_completion: 1, flop: { status: 'settled' } } }) : error(404, 'not_found', 'no route');
  if (url.pathname === '/v1/sessions/gen-111111') return send(200, { session_id: 'gen-111111', status: 'settled' });
  if (url.pathname === '/v1/sessions/gen-p11111') return send(200, { session_id: 'gen-p11111', status: 'settling', miner: '5Miner', model: 'slow/model',
    reply: format === 'new' ? { role: 'assistant', content: 'late reply', finish_reason: 'stop' } : 'late reply' });
  return error(404, 'not_found', `no route ${req.method} ${url.pathname}`);
});
const run = (base, args) => new Promise((resolve) => {
  const c = spawn(process.execPath, [bin, ...args], { env: { ...process.env, FLOPROUTER_BASE_URL: base, FLOPROUTER_API_KEY: 'fr_test', FLOPROUTER_CONFIG: path.join(tmp, 'none.json'), NO_COLOR: '1' } });
  let out = ''; let errOut = ''; c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { errOut += d; });
  c.on('close', (code) => resolve({ code, out, err: errOut }));
});
for (const format of ['old', 'new']) {
  const srv = fake(format); await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  let r = await run(base, ['models']);
  assert.equal(r.code, 0); assert.match(r.out, /a\/b\s+yes\s+2\s+3\s+8B\s+0\.05/);
  r = await run(base, ['chat', '--model', 'a/b', '--fallback-model', 'c/d', 'hi']);
  assert.equal(r.code, 0, r.err); assert.match(r.out, /hello/); assert.match(r.err, /model c\/d \(fallback\)/);
  if (format === 'new') { assert.match(r.err, /cost 0\.0105 FLOP \(until settled\)/); assert.match(r.err, /ignored by this model: temperature/); }
  else assert.match(r.err, /escrow 0\.01 FLOP/);
  r = await run(base, ['chat', '--stream', '--model', 'a/b', 'hi']);
  assert.equal(r.code, 0, r.err); assert.match(r.out, /streamed/); assert.match(r.err, /session gen-s1/);
  r = await run(base, ['chat', '--stream', '--model', 'mid/error', 'hi']);
  assert.equal(r.code, 1); assert.match(r.err, /miner_failed: miner went away/);
  r = await run(base, ['chat', '--model', 'grant/expired', 'hi']);
  assert.equal(r.code, 1); assert.match(r.err, /the grant expired/); assert.match(r.err, /floprouter grant/);
  r = await run(base, ['key']);
  if (format === 'new') { assert.equal(r.code, 0); assert.match(r.out, /0\.5 FLOP/); } else { assert.equal(r.code, 1); assert.match(r.err, /does not offer GET \/v1\/key/); }
  r = await run(base, ['generation', format === 'new' ? 'gen-1' : 'gen-111111']);
  assert.equal(r.code, 0, r.err); assert.match(r.out, format === 'new' ? /0\.0105 FLOP/ : /settled/);
  r = await run(base, ['chat', '--model', 'slow/model', 'hi']);
  assert.equal(r.code, 0, r.err); assert.match(r.out, /late reply/); assert.match(r.err, /polling/);
  r = await run(base, ['status']);
  assert.equal(r.code, 0, r.err); assert.doesNotMatch(r.out, /undefined/); assert.match(r.out, /5Router/);
  if (format === 'new') assert.match(r.out, /4 blocks behind/);
  r = await run(base, ['balance']);
  assert.equal(r.code, 0, r.err); assert.match(r.out, /balance\s+1 FLOP/);
  if (format === 'new') assert.match(r.out, /withdrawal\s+sent 0\.04/);
  r = await run(base, ['chat', '--model', 'late/error', 'hi']);
  assert.equal(r.code, 1); assert.match(r.err, /all_attempts_failed: no provider completed/);
  r = await run(base, ['withdraw', '0.05', '--yes']);
  if (format === 'new') { assert.equal(r.code, 0, r.err); assert.match(r.err, /sent 0\.047 FLOP to 5Me/); } else { assert.equal(r.code, 1); assert.match(r.err, /does not offer withdrawals/); }
  r = await run(base, ['miner', 'nope']);
  assert.equal(r.code, 1); assert.match(r.err, /not a miner address/);
  srv.close();
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('offline tests passed (earlier and current API formats)');
