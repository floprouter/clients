// Grant tools of the MCP server, in both modes, against a stub router (no chain): default mode never signs and has no
// renew_grant; opt-in mode exposes it and refuses everything but a due, same-caps renewal of an existing grant.
//   node test/renewal.mjs
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { buildGrantTx } from '../src/renewal.js';
import { mnemonicGenerate, cryptoWaitReady } from '@polkadot/util-crypto';
import { Keyring } from '@polkadot/keyring';

const DELEGATE = '5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty';
await cryptoWaitReady();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'floprouter-mcp-renewal-'));
const mnemonic = mnemonicGenerate(12);
const address = new Keyring({ type: 'sr25519', ss58Format: 42 }).addFromUri(mnemonic).address;
const seed = path.join(tmp, 'seed'); fs.writeFileSync(seed, mnemonic + '\n', { mode: 0o600 });

// same-caps rule (the module is the CLI's, byte for byte)
const fakeApi = { tx: { flopSessionKeys: { createSession: (...a) => ({ create: a }), revokeSession: (d) => ({ revoke: d }) }, utility: { batchAll: (c) => ({ batch: c }) } } };
const cur = { cap: 5n, tx: 1n, day: 2n, pallets: ['ComputeChannel'], active: true };
assert.throws(() => buildGrantTx(fakeApi, { delegate: DELEGATE, caps: { cap: 10n, tx: 1n, day: 2n }, durationBlocks: 10, current: cur, sameCaps: true }), /differ from the current grant/);

const grantRow = (over) => ({ owner: address, delegate: DELEGATE, state: 'active', active: true, spending_cap: '5', spent: '1', remaining: '4',
  per_tx_limit: '0.5', daily_cap: '2', epoch_room: '1.5', expires_at: new Date(Date.now() + 6 * 86400_000).toISOString(), ...over });
let grantData = [grantRow({})];
let renewalCall = { pallet: 'utility', method: 'batchAll', calls: [{ pallet: 'flopSessionKeys', method: 'revokeSession', args: [DELEGATE] },
  { pallet: 'flopSessionKeys', method: 'createSession', args: [DELEGATE, '1', '1', '1', 10, ['ComputeChannel']] }] };
const stub = http.createServer(async (req, res) => {
  let raw = ''; for await (const c of req) raw += c;
  const u = new URL(req.url, 'http://x');
  const send = (s, b, h = {}) => { res.writeHead(s, { 'content-type': 'application/json', ...h }); res.end(JSON.stringify(b)); };
  if (u.pathname === '/health') return send(200, { status: 'ok', network: 'devnet', genesis_hash: '0x' + '1'.repeat(64), rpc: ['ws://127.0.0.1:9'] });
  if (u.pathname === '/v1/grants' || u.pathname === '/v1/grants/sync') return send(200, { object: 'list', address, data: grantData });
  if (u.pathname === '/v1/grants/params') return send(200, { owner: address, delegate: DELEGATE, rpc: 'ws://127.0.0.1:9', limits: { max_session_duration_blocks: 864000 },
    amounts: { spending_cap: '5', per_tx_limit: '0.5', daily_cap: '2', duration_blocks: 864000 },
    call: { pallet: 'flopSessionKeys', method: 'createSession', args: [DELEGATE, '5000000000000000000', '500000000000000000', '2000000000000000000', 864000, ['ComputeChannel']] },
    renewal: true, renewal_call: renewalCall });
  if (u.pathname === '/v1/balance') return send(200, { address, balance: '1', available: '1', recent: [] });
  if (u.pathname === '/v1/key') return send(200, { data: { usage: 0 } });
  if (u.pathname === '/v1/chat/completions') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'x-generation-id': 'gen-abc' });
    res.write(`data: ${JSON.stringify({ id: 'gen-abc', model: 'a/b', choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: 'stop' }], usage: { total_tokens: 2, cost: 0.0105 }, flop: { session_id: 'gen-abc', status: 'settling' } })}\n\n`);
    return res.end('data: [DONE]\n\n');
  }
  return send(404, { error: { code: 404, message: 'no route', metadata: { reason: 'not_found' } } });
});
await new Promise((r) => stub.listen(0, '127.0.0.1', r));
const entry = fileURLToPath(new URL('../src/index.js', import.meta.url));
async function server(extraEnv) {
  const client = new Client({ name: 'renewal-test', version: '0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry], stderr: 'pipe',
    env: { ...process.env, FLOPROUTER_BASE_URL: `http://127.0.0.1:${stub.address().port}`, FLOPROUTER_API_KEY: 'fr_test', FLOPROUTER_CONFIG: '/nonexistent',
      FLOPROUTER_KEY_FILE: '', FLOPROUTER_SEED_FILE: '', FLOPROUTER_ALLOW_GRANT_RENEWAL: '', FLOPROUTER_SIGN_LOG: path.join(tmp, 'sign.log'), ...extraEnv } }));
  const call = async (name, args = {}) => { const r = await client.callTool({ name, arguments: args }); return { err: Boolean(r.isError), text: r.content[0].text, json: (() => { try { return JSON.parse(r.content[0].text); } catch { return null; } })() }; };
  const tools = (await client.listTools()).tools.map((t) => t.name);
  return { client, call, tools };
}

// ---- default mode: no signing tool, status and warnings only
{
  const { client, call, tools } = await server({});
  assert.ok(tools.includes('grant_status')); assert.ok(!tools.includes('renew_grant'), 'no renew_grant without opt-in');
  let r = await call('grant_status');
  assert.equal(r.json.state, 'active'); assert.equal(r.json.renewal_due, false); assert.ok(r.json.days_left > 5); assert.match(r.json.renewal_by_this_server, /^off/);
  r = await call('chat', { model: 'a/b', prompt: 'hi' });
  assert.equal(r.json.reply, 'hi'); assert.equal(r.json.grant_warning, undefined);
  grantData = [grantRow({ expires_at: new Date(Date.now() + 86400_000).toISOString() })];
  r = await call('grant_status'); assert.equal(r.json.renewal_due, true); assert.match(r.json.warning, /expires in 1\.0 days/);
  r = await call('chat', { model: 'a/b', prompt: 'hi' }); assert.match(r.json.grant_warning, /Renew it soon/);
  r = await call('account'); assert.match(r.json.grant_warning, /Renew it soon/);
  grantData = [grantRow({ remaining: '0.2' })];
  r = await call('grant_status'); assert.equal(r.json.renewal_due, true); assert.match(r.json.reason, /left of the spending cap/);
  // key variables alone do not enable signing
  await client.close();
  const s2 = await server({ FLOPROUTER_SEED_FILE: seed });
  assert.ok(!s2.tools.includes('renew_grant'), 'a key without FLOPROUTER_ALLOW_GRANT_RENEWAL=1 does not enable signing');
  await s2.client.close();
  const s3 = await server({ FLOPROUTER_ALLOW_GRANT_RENEWAL: '1' });
  assert.ok(!s3.tools.includes('renew_grant'), 'opt-in without a key file does not enable signing');
  await s3.client.close();
}

// ---- opt-in mode: renew_grant exists, says it signs, takes no key argument, refuses what is not a due same-caps renewal
{
  const { client, call, tools } = await server({ FLOPROUTER_SEED_FILE: seed, FLOPROUTER_ALLOW_GRANT_RENEWAL: '1' });
  assert.ok(tools.includes('renew_grant'));
  const def = (await client.listTools()).tools.find((t) => t.name === 'renew_grant');
  assert.match(def.description, /SIGNS A TRANSACTION/); assert.deepEqual(Object.keys(def.inputSchema.properties ?? {}), ['dry_run']);
  grantData = [grantRow({})];
  let r = await call('renew_grant'); assert.equal(r.json.action, 'skip', r.text);
  grantData = [];
  r = await call('renew_grant'); assert.equal(r.json.action, 'refused'); assert.match(r.json.reason, /needs the owner/);
  grantData = [grantRow({ state: 'revoked', active: false })];
  r = await call('renew_grant'); assert.equal(r.json.action, 'refused');
  grantData = [grantRow({ expires_at: new Date(Date.now() + 3600_000).toISOString() })];
  renewalCall = { pallet: 'utility', method: 'batchAll', calls: [{ pallet: 'balances', method: 'transferAll', args: [DELEGATE, false] }] };
  r = await call('renew_grant'); assert.equal(r.err, true); assert.match(r.text, /renewal other than revokeSession \+ createSession/);
  renewalCall = { pallet: 'utility', method: 'batchAll', calls: [{ pallet: 'flopSessionKeys', method: 'revokeSession', args: [DELEGATE] },
    { pallet: 'flopSessionKeys', method: 'createSession', args: [DELEGATE, '1', '1', '1', 10, ['ComputeChannel']] }] };
  // due: it goes to the chain to confirm before signing (the stub RPC is unreachable, so it stops with an error, unsigned)
  r = await call('renew_grant', { dry_run: true }); assert.equal(r.err, true);
  assert.ok(!fs.existsSync(path.join(tmp, 'sign.log')), 'nothing was signed');
  await client.close();
}
// ---- a wallet that does not own the API key: refused
{
  const other = path.join(tmp, 'other'); fs.writeFileSync(other, mnemonicGenerate(12) + '\n', { mode: 0o600 });
  const { client, call } = await server({ FLOPROUTER_SEED_FILE: other, FLOPROUTER_ALLOW_GRANT_RENEWAL: '1' });
  grantData = [grantRow({ expires_at: new Date(Date.now() + 3600_000).toISOString() })];
  const r = await call('renew_grant'); assert.equal(r.err, true); assert.match(r.text, /belongs to|parameters are for/);
  await client.close();
}
stub.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('mcp grant tests passed (default mode, opt-in mode, refusals)');
