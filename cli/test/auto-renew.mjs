// Tests for `grant --auto-renew` and `grant --status --json`: every decision branch (pure), and the CLI against a stub
// router for the paths that need no chain. The signing path is covered by a live run (see the CLI README).
//   node test/auto-renew.mjs
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { decideRenewal, grantFacts, parseDuration } from '../src/commands.js';
import { buildGrantTx, grantWarning } from '../src/renewal.js';
import { mnemonicGenerate, cryptoWaitReady } from '@polkadot/util-crypto';
import { Keyring } from '@polkadot/keyring';

const bin = fileURLToPath(new URL('../bin/floprouter.js', import.meta.url));
const DELEGATE = '5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty';
const day = 86400;

// ---- 1. durations
assert.equal(parseDuration('2d'), 2 * day); assert.equal(parseDuration('12h'), 43200); assert.equal(parseDuration('90m'), 5400);
assert.equal(parseDuration('3600'), 3600); assert.equal(parseDuration('30s'), 30); assert.throws(() => parseDuration('soon'));

// ---- 2. every decision branch
const healthy = { state: 'active', active: true, spendingCap: 5, spent: 1, remaining: 4, perTxLimit: 0.5, dailyCap: 2, dayRoom: 1.5, expiresInSec: 6 * day };
const cases = [
  ['missing', { state: 'none' }, 'grant'],
  ['assigned only', { state: 'assigned' }, 'grant'],
  ['revoked', { state: 'revoked', active: false }, 'grant'],
  ['expired (state)', { ...healthy, state: 'expired' }, 'renew'],
  ['expired (time)', { ...healthy, expiresInSec: -10 }, 'renew'],
  ['expiring within the window', { ...healthy, expiresInSec: day }, 'renew'],
  ['total nearly used up', { ...healthy, remaining: 0.3 }, 'renew'],
  ['daily room low: reported, never renewed (the chain keeps the day spend)', { ...healthy, dayRoom: 0.2 }, 'skip'],
  ['waiting for finality', { state: 'waiting_for_finality' }, 'wait'],
  ['healthy', healthy, 'skip'],
];
for (const [name, f, want] of cases) assert.equal(decideRenewal(f).action, want, name);
assert.equal(decideRenewal({ ...healthy, expiresInSec: day }, { renewBeforeSec: 12 * 3600 }).action, 'skip', 'shorter window');
assert.equal(decideRenewal({ ...healthy, remaining: 0.3 }, { minRemaining: 0.1 }).action, 'skip', 'lower total threshold');
assert.match(decideRenewal({ ...healthy, dayRoom: 0.2 }).note, /next daily epoch/); assert.equal(decideRenewal({ ...healthy, dayRoom: 0.2 }, { minDaily: 0 }).note, undefined);
assert.equal(decideRenewal({ ...healthy, remaining: 0.3 }).capRoom, true);
assert.match(decideRenewal({ ...healthy, expiresInSec: day }).reason, /expires in 1\.0 days, within the 2\.0 days window/);

// ---- 2b. same-caps renewals refuse changed caps, other pallets, and creating from nothing
const fakeApi = { tx: { flopSessionKeys: { createSession: (...a) => ({ create: a }), revokeSession: (d) => ({ revoke: d }) }, utility: { batchAll: (c) => ({ batch: c }) } } };
const cur = { cap: 5n, tx: 1n, day: 2n, pallets: ['ComputeChannel'], active: true };
const same = buildGrantTx(fakeApi, { delegate: DELEGATE, caps: { cap: 5n, tx: 1n, day: 2n }, durationBlocks: 100, current: cur, sameCaps: true });
assert.equal(same.renew, true); assert.equal(same.tx.batch.length, 2); assert.equal(same.tx.batch[0].revoke, DELEGATE);
assert.deepEqual(same.tx.batch[1].create, [DELEGATE, 5n, 1n, 2n, 100, ['ComputeChannel']]);
assert.throws(() => buildGrantTx(fakeApi, { delegate: DELEGATE, caps: { cap: 6n, tx: 1n, day: 2n }, durationBlocks: 100, current: cur, sameCaps: true }), /differ from the current grant/);
assert.throws(() => buildGrantTx(fakeApi, { delegate: DELEGATE, caps: { cap: 5n, tx: 1n, day: 3n }, durationBlocks: 100, current: cur, sameCaps: true }), /differ from the current grant/);
assert.throws(() => buildGrantTx(fakeApi, { delegate: DELEGATE, caps: { cap: 5n, tx: 1n, day: 2n }, durationBlocks: 100, current: { ...cur, pallets: [] }, sameCaps: true }), /only \["ComputeChannel"\] is renewed/);
assert.throws(() => buildGrantTx(fakeApi, { delegate: DELEGATE, caps: { cap: 5n, tx: 1n, day: 2n }, durationBlocks: 100, current: null, sameCaps: true }), /needs a current grant/);
assert.equal(buildGrantTx(fakeApi, { delegate: DELEGATE, caps: { cap: 5n, tx: 1n, day: 2n }, durationBlocks: 100, current: null, sameCaps: false }).renew, false);
assert.equal(grantWarning(healthy), null); assert.match(grantWarning({ ...healthy, expiresInSec: 3600 }), /expires in 1\.0 hours/);

// ---- 3. router views into facts
const now = Date.parse('2026-11-24T10:00:00Z');
const view = { object: 'list', address: 'x', data: [{ owner: 'x', delegate: DELEGATE, state: 'active', active: true, spending_cap: '5', spent: '1.2', remaining: '3.8',
  per_tx_limit: '0.5', daily_cap: '2', epoch_room: '1.9', expires_at: '2026-11-30T10:00:00.000Z', sessions_left_estimate: 190 }] };
const f = grantFacts(view, DELEGATE, now);
assert.equal(f.remaining, 3.8); assert.equal(f.dayRoom, 1.9); assert.equal(f.expiresInSec, 6 * day); assert.equal(decideRenewal(f).action, 'skip');
assert.equal(grantFacts({ data: [] }, DELEGATE).state, 'none');

// ---- 4. the CLI against a stub router
await cryptoWaitReady();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'floprouter-autorenew-'));
const mnemonic = mnemonicGenerate(12);
const address = new Keyring({ type: 'sr25519', ss58Format: 42 }).addFromUri(mnemonic).address;
const seed = path.join(tmp, 'seed'); fs.writeFileSync(seed, mnemonic + '\n', { mode: 0o600 });

let grantView = view;
let paramsExtra = {};
let syncs = 0;
const stub = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const send = (s, b) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
  if (!/^Bearer fr_/.test(req.headers.authorization ?? '') && u.pathname !== '/health') return send(401, { error: { code: 401, message: 'key required', metadata: { reason: 'unauthorized' } } });
  if (u.pathname === '/health') return send(200, { status: 'ok', network: 'devnet', genesis_hash: '0x' + '1'.repeat(64), rpc: ['ws://127.0.0.1:9'] });
  if (u.pathname === '/v1/grants/sync') { syncs++; return send(200, { ...grantView, address }); }
  if (u.pathname === '/v1/grants') return send(200, { ...grantView, address });
  if (u.pathname === '/v1/grants/params') {
    return send(200, { owner: address, delegate: DELEGATE, rpc: 'ws://127.0.0.1:9', limits: { max_session_duration_blocks: 864000, allowed_pallets: ['ComputeChannel'] },
      amounts: { spending_cap: '5', per_tx_limit: '0.5', daily_cap: '2', duration_blocks: 864000 },
      call: { pallet: 'flopSessionKeys', method: 'createSession', args: [DELEGATE, '5000000000000000000', '500000000000000000', '2000000000000000000', 864000, ['ComputeChannel']] },
      renewal: true, renewal_call: { pallet: 'utility', method: 'batchAll', calls: [{ pallet: 'flopSessionKeys', method: 'revokeSession', args: [DELEGATE] },
        { pallet: 'flopSessionKeys', method: 'createSession', args: [DELEGATE, '5000000000000000000', '500000000000000000', '2000000000000000000', 864000, ['ComputeChannel']] }] },
      ...paramsExtra });
  }
  return send(404, { error: { code: 404, message: 'no route', metadata: { reason: 'not_found' } } });
});
await new Promise((r) => stub.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${stub.address().port}`;
const run = (args, env = {}) => new Promise((resolve) => {
  const c = spawn(process.execPath, [bin, ...args], { env: { ...process.env, FLOPROUTER_BASE_URL: base, FLOPROUTER_API_KEY: 'fr_test', FLOPROUTER_CONFIG: path.join(tmp, 'none.json'), NO_COLOR: '1', FLOPROUTER_KEY_FILE: '', FLOPROUTER_SEED_FILE: '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; let err = ''; c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { err += d; });
  c.on('close', (code) => resolve({ code, out, err }));
});

// healthy: exit 0, nothing signed, JSON says skip
let r = await run(['grant', '--auto-renew', '--seed-file', seed, '--yes', '--json']);
assert.equal(r.code, 0, r.err); assert.match(r.err, /grant ok: active/); assert.equal(JSON.parse(r.out).action, 'skip');
// the same again: still a no-op (idempotent)
r = await run(['grant', '--auto-renew', '--seed-file', seed, '--yes']);
assert.equal(r.code, 0); assert.match(r.err, /Nothing to do/);
// waiting for finality: exit 0
grantView = { data: [{ delegate: DELEGATE, state: 'waiting_for_finality', active: false, pending: { best_block: 10, finalized_block: 5, at_best: 'active' } }] };
r = await run(['grant', '--auto-renew', '--seed-file', seed, '--yes', '--json']);
assert.equal(r.code, 0, r.err); assert.equal(JSON.parse(r.out).action, 'wait');
// no key file or seed file: refused, never prompts
r = await run(['grant', '--auto-renew', '--yes']);
assert.equal(r.code, 1); assert.match(r.err, /needs --key-file or --seed-file/);
// no terminal and no --yes: refused
r = await run(['grant', '--auto-renew', '--seed-file', seed]);
assert.equal(r.code, 1); assert.match(r.err, /needs --yes/);
// no API key: refused
r = await run(['grant', '--auto-renew', '--seed-file', seed, '--yes'], { FLOPROUTER_API_KEY: '' });
assert.equal(r.code, 1); assert.match(r.err, /floprouter login/);
// encrypted key file without a password file: refused, no prompt
const kf = path.join(tmp, 'key.json');
fs.writeFileSync(kf, JSON.stringify(new Keyring({ type: 'sr25519', ss58Format: 42 }).addFromUri(mnemonic).toJson('pw')), { mode: 0o600 });
r = await run(['grant', '--auto-renew', '--key-file', kf, '--yes']);
assert.equal(r.code, 1); assert.match(r.err, /encrypted: pass --password-file/);
// the key does not own the API key: refused
grantView = view;
const other = path.join(tmp, 'other'); fs.writeFileSync(other, mnemonicGenerate(12) + '\n', { mode: 0o600 });
r = await run(['grant', '--auto-renew', '--seed-file', other, '--yes']);
assert.equal(r.code, 1); assert.match(r.err, /grant parameters are for|belongs to/);
// changing caps on renewal needs all three flags
r = await run(['grant', '--auto-renew', '--seed-file', seed, '--yes', '--spending-cap', '50']);
assert.equal(r.code, 1); assert.match(r.err, /give all three/);
// a renewal call other than revoke + create: refused before any chain access
paramsExtra = { renewal_call: { pallet: 'utility', method: 'batchAll', calls: [{ pallet: 'balances', method: 'transferAll', args: [DELEGATE, false] }] } };
r = await run(['grant', '--auto-renew', '--seed-file', seed, '--yes']);
assert.equal(r.code, 1); assert.match(r.err, /renewal other than revokeSession \+ createSession/);
paramsExtra = {};
// renewal needed: it goes to the chain (the stub's RPC is unreachable, so it stops there with an error, signing nothing)
grantView = { data: [{ ...view.data[0], expires_at: new Date(Date.now() + 3600_000).toISOString() }] };
r = await run(['grant', '--auto-renew', '--seed-file', seed, '--yes']);
assert.equal(r.code, 1); assert.match(r.err, /chain devnet via ws:\/\/127\.0\.0\.1:9/);
// --status --json: stable fields and what --auto-renew would do
r = await run(['grant', '--status', '--json']);
assert.equal(r.code, 0, r.err);
const st = JSON.parse(r.out);
for (const k of ['address', 'state', 'active', 'remaining', 'spending_cap' === 'x' ? '' : 'spendingCap', 'dayRoom', 'expiresInSec', 'needs_renewal', 'auto_renew_action', 'reason']) assert.ok(k === '' || k in st, `status --json has ${k}`);
assert.equal(st.needs_renewal, true); assert.equal(st.auto_renew_action, 'renew');

stub.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`auto-renew tests passed (${cases.length} decision branches, ${syncs} router syncs, CLI paths without a chain)`);
