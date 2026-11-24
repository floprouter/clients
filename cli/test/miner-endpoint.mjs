// `floprouter miner endpoint <url>` and `miner status` against a stub router that checks the signature like the
// service does (sr25519 over the exact challenge text, raw or <Bytes>-wrapped). Headless: no terminal, --yes.
//   node test/miner-endpoint.mjs
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mnemonicGenerate, cryptoWaitReady, signatureVerify } from '@polkadot/util-crypto';
import { Keyring } from '@polkadot/keyring';
import { describeSubmission } from '../src/commands.js';

await cryptoWaitReady();
const bin = fileURLToPath(new URL('../bin/floprouter.js', import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'floprouter-miner-'));
const mnemonic = mnemonicGenerate(12);
const pair = new Keyring({ type: 'sr25519', ss58Format: 42 }).addFromUri(mnemonic);
const kf = path.join(tmp, 'miner.json'); const pw = path.join(tmp, 'pw');
fs.writeFileSync(kf, JSON.stringify(pair.toJson('pw-1')), { mode: 0o600 }); fs.writeFileSync(pw, 'pw-1\n', { mode: 0o600 });

const issued = new Map();
let evilChallenge = false;
const outcome = { 'ok.example.com': [200, { status: 'verified', accepted: true, ready: true, model: 'qwen/qwen3-8b', message: 'Accepted.', ownership: 'signature' }],
  'pending.example.com': [202, { status: 'unbound', accepted: false, message: 'Recorded, not yet routable: the session key is not tied to this miner on chain yet.' }],
  'down.example.com': [422, { error: { code: 422, message: 'the URL did not answer', metadata: { reason: 'endpoint_unreachable' } } }],
  'wrong.example.com': [422, { error: { code: 422, message: 'the proof names another miner', metadata: { reason: 'not_verified' } } }],
  'busy.example.com': [429, { error: { code: 429, message: 'at most 5 pending endpoints', metadata: { reason: 'too_many_pending' } } }] };
const stub = http.createServer(async (req, res) => {
  let raw = ''; for await (const c of req) raw += c;
  const body = raw ? JSON.parse(raw) : {};
  const send = (s, b) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
  const m = /^\/v1\/miners\/([1-9A-HJ-NP-Za-km-z]{47,48})(\/endpoint(\/challenge)?)?$/.exec(new URL(req.url, 'http://x').pathname);
  if (!m) return send(404, { error: { code: 404, message: 'no route', metadata: { reason: 'not_found' } } });
  const addr = m[1];
  if (m[3]) {
    const text = evilChallenge ? `floprouter API key request; Address: ${addr}` : `floprouter endpoint registration; Miner: ${addr}; URL: ${body.url}; Network: devnet; Nonce: ${crypto.randomBytes(8).toString('hex')}; Signing this lets this URL be listed as your miner's session endpoint on floprouter. It does not move funds.`;
    issued.set(text, { addr, url: body.url });
    return send(200, { object: 'endpoint_challenge', miner: addr, url: body.url, challenge: text });
  }
  if (m[2] && req.method === 'POST') {
    const c = issued.get(body.challenge);
    if (!c || c.addr !== addr || c.url !== body.url) return send(401, { error: { code: 401, message: 'unknown challenge', metadata: { reason: 'invalid_challenge' } } });
    if (!signatureVerify(body.challenge, body.signature, addr).isValid) return send(401, { error: { code: 401, message: 'bad signature', metadata: { reason: 'invalid_signature' } } });
    issued.delete(body.challenge);
    const [s, b] = outcome[new URL(body.url).host] ?? [200, { status: 'verified', accepted: true }];
    return send(s, { miner: addr, url: body.url, ...b });
  }
  const own = (req.headers.authorization ?? '') === 'Bearer fr_miner';
  return send(200, { address: addr, availability: 'busy', health: 'unknown', last_checked_at: '2026-11-24T10:00:00Z', recent: { success_rate: null, first_output_ms_median: null },
    ...(own ? { own_listing: { endpoints: [{ url: 'https://ok.example.com', status: 'verified', ready: true, model: 'qwen/qwen3-8b', last_checked_at: '2026-11-24T10:00:00Z' }] } } : {}) });
});
await new Promise((r) => stub.listen(0, '127.0.0.1', r));
const run = (args, env = {}) => new Promise((resolve) => {
  const c = spawn(process.execPath, [bin, ...args], { env: { ...process.env, FLOPROUTER_BASE_URL: `http://127.0.0.1:${stub.address().port}`, FLOPROUTER_API_KEY: '', FLOPROUTER_CONFIG: path.join(tmp, 'none.json'), NO_COLOR: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; let err = ''; c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { err += d; });
  c.on('close', (code) => resolve({ code, out, err }));
});
const key = ['--key-file', kf, '--password-file', pw];

let r = await run(['miner', 'endpoint', 'https://ok.example.com', ...key, '--yes']);
assert.equal(r.code, 0, r.err); assert.match(r.err, /verified: the endpoint is listed and routable \(serves qwen\/qwen3-8b\)/); assert.match(r.err, /\| floprouter endpoint registration/);
r = await run(['miner', 'endpoint', 'https://pending.example.com', ...key, '--yes']);
assert.equal(r.code, 0); assert.match(r.err, /recorded, not routable yet/);
r = await run(['miner', 'endpoint', 'https://down.example.com', ...key, '--yes']);
assert.equal(r.code, 2); assert.match(r.err, /unreachable: the router could not reach the endpoint/);
r = await run(['miner', 'endpoint', 'https://wrong.example.com', ...key, '--yes', '--json']);
assert.equal(r.code, 2); assert.equal(JSON.parse(r.out).word, 'not verified');
r = await run(['miner', 'endpoint', 'https://busy.example.com', ...key, '--yes']);
assert.equal(r.code, 3); assert.match(r.err, /rate limited \(too many endpoints recorded but not routable\)/);
// headless without --yes, a URL with a path, a key argument, no key file: refused before anything is signed
r = await run(['miner', 'endpoint', 'https://ok.example.com', ...key]); assert.equal(r.code, 1); assert.match(r.err, /pass --yes/);
r = await run(['miner', 'endpoint', 'https://ok.example.com/path', ...key, '--yes']); assert.equal(r.code, 1); assert.match(r.err, /no path/);
r = await run(['miner', 'endpoint', 'http://ok.example.com', ...key, '--yes']); assert.equal(r.code, 1); assert.match(r.err, /https/);
r = await run(['miner', 'endpoint', 'https://ok.example.com', '--seed=abc', '--yes']); assert.equal(r.code, 1); assert.match(r.err, /never read from the command line/);
r = await run(['miner', 'endpoint', 'https://ok.example.com', '--yes']); assert.equal(r.code, 1); assert.match(r.err, /no --key-file or --seed-file/);
// a challenge that is not an endpoint registration (for example a login challenge): refused, nothing signed
evilChallenge = true;
r = await run(['miner', 'endpoint', 'https://ok.example.com', ...key, '--yes']); assert.equal(r.code, 1); assert.match(r.err, /unexpected challenge; refusing to sign/);
evilChallenge = false;
// status: public view, then with an API key of the miner address (own listing)
r = await run(['miner', 'status', pair.address]);
assert.equal(r.code, 0, r.err); assert.match(r.out, /availability\s+busy/); assert.match(r.out, /not enough data yet/); assert.match(r.out, /needs an API key of the miner address/);
r = await run(['miner', 'status', ...key], { FLOPROUTER_API_KEY: 'fr_miner' });
assert.equal(r.code, 0, r.err); assert.match(r.out, /your endpoint\s+https:\/\/ok\.example\.com verified, ready, qwen\/qwen3-8b/);
r = await run(['miner', 'status', pair.address, '--json'], { FLOPROUTER_API_KEY: 'fr_miner' });
assert.equal(JSON.parse(r.out).own_listing.endpoints.length, 1);
// plain words for every answer
assert.equal(describeSubmission(401, { error: { metadata: { reason: 'challenge_expired' }, message: 'expired' } }).word, 'refused');
stub.close(); fs.rmSync(tmp, { recursive: true, force: true });
console.log('miner endpoint tests passed (verified, not verified yet, unreachable, not verified, rate limited, refusals, status)');
