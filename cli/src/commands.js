// floprouter CLI commands.
import readline from 'node:readline';
import { ApiError, costOf, makeClient, headersOf, isMissingRoute, modelFacts } from './api.js';
import { ALLOWED_PALLETS, FEE_PALLETS, buildBatchTx, checkGrantBatch, checkGrantParams, checkRenewalCall, decideRenewal, chainError, explainChainError, grantFacts, grantOf, hasFeeGrant, knownDelegates, parseDuration, readGrantParams, renewIfDue, validAddresses } from './renewal.js';

export { decideRenewal, grantFacts, parseDuration, readGrantParams };
import { bold, confirm, dim, err, flopAmount, green, pct, printJson, readConfig, red, short, table, writeConfig, yellow } from './io.js';

const MAX_FLOAT_DEFAULT = '1';

// ---- read-only ---------------------------------------------------------------------------------------------------

export async function models(ctx, o) {
  const r = await ctx.api.get('/v1/models', { auth: false });
  let data = r.data ?? [];
  if (o.available) data = data.filter((m) => modelFacts(m).available);
  if (o.json) return printJson({ ...r, data });
  console.log(table(data.map((m) => {
    const f = modelFacts(m);
    return {
      id: f.id, avail: f.available ? green('yes') : 'no', ready: f.ready, reach: f.reachable,
      params: f.paramsBillion ? `${f.paramsBillion}B` : null, price: f.escrowPer1k, min: f.minCharge, ctx: f.contextLength,
    };
  }), [
    { key: 'id', title: 'MODEL' }, { key: 'avail', title: 'AVAILABLE' }, { key: 'ready', title: 'READY', right: true },
    { key: 'reach', title: 'REACHABLE', right: true }, { key: 'params', title: 'SIZE', right: true }, { key: 'price', title: 'FLOP/1K TOK', right: true },
    { key: 'min', title: 'MIN/REQ', right: true }, { key: 'ctx', title: 'MAX TOKENS', right: true },
  ]));
  console.log(dim('\nREADY = miners that can serve this model now. Price = escrow per 1,000 tokens of prompt + max_tokens: the escrow'));
  console.log(dim('follows max_tokens, not the tokens produced. MAX TOKENS = the largest request this router serves for the model.'));
}

export async function miners(ctx, o) {
  const query = {
    reachable: o.reachable ? 'true' : undefined, ready: o.ready ? 'true' : undefined, model: o.model,
    min_score: o['min-score'], sort: o.sort, order: o.order, limit: o.limit ?? (o.all ? 1000 : 25), offset: o.offset,
    calibrated: o.calibrated ? 'true' : undefined, view: o.reachable ? 'full' : undefined,
  };
  const r = await ctx.api.get('/v1/miners', { auth: false, query });
  if (o.json) return printJson(r);
  const rows = (r.data ?? []).map((m) => ({
    rank: m.rank, address: m.address, score: m.score, settle: pct(m.history?.settle_rate),
    sessions: m.history ? `${m.history.settled}/${m.history.sessions_resolved}` : null, strikes: m.slashing?.strikes,
    stake: flopAmount(m.stake?.total), cal: m.calibration?.live ? 'yes' : 'no',
    models: (m.models ?? []).map((x) => x.id ?? x).join(','),
    reach: m.availability ? (m.availability === 'available' ? green('available') : m.availability.replace('_', ' '))
      : (m.router_measured?.reachable ? green('yes') : 'no'),
    ready: m.health ? (m.health === 'unknown' ? '-' : m.health) : (m.router_measured?.ready ? green('yes') : 'no'),
  }));
  console.log(table(rows, [
    { key: 'rank', title: 'RANK', right: true }, { key: 'address', title: 'MINER' }, { key: 'score', title: 'SCORE', right: true },
    { key: 'settle', title: 'SETTLE', right: true }, { key: 'sessions', title: 'SETTLED', right: true }, { key: 'strikes', title: 'STRIKES', right: true },
    { key: 'stake', title: 'STAKE', right: true }, { key: 'cal', title: 'CALIB' }, { key: 'reach', title: 'AVAILABILITY' }, { key: 'ready', title: 'HEALTH' },
    { key: 'models', title: 'MODELS' },
  ]));
  console.log(dim(`\n${rows.length} of ${r.total ?? rows.length} miners${r.finalized_block ? ` at block ${r.finalized_block}` : ''}. Score 0-100 from on-chain facts; AVAILABILITY and HEALTH measured by the router.`));
}

export async function miner(ctx, o, address, rest = []) {
  if (address === 'endpoint' || address === 'register') return minerEndpoint(ctx, o, rest[0]);
  if (address === 'status') return minerStatus(ctx, o, rest[0]);
  if (!address) throw new Error('usage: floprouter miner <address> | miner endpoint <url> --key-file <miner key> | miner status');
  if (!/^[1-9A-HJ-NP-Za-km-z]{47,48}$/.test(address)) throw new Error(`${address} is not a miner address (SS58, 47 or 48 characters)`);
  const m = await ctx.api.get(`/v1/miners/${encodeURIComponent(address)}`, { auth: false });
  if (o.json) return printJson(m);
  const h = m.history ?? {}; const rm = m.router_measured ?? {};
  const kv = (k, v) => console.log(`${dim(k.padEnd(16))}${v ?? '-'}`);
  console.log(bold(m.address));
  kv('score / rank', `${m.score ?? '-'} / ${m.rank ?? '-'}`);
  kv('status', [m.active ? 'active' : 'inactive', m.retired && 'retired', m.blacklisted && red('blacklisted')].filter(Boolean).join(', '));
  kv('settled', `${h.settled ?? 0} of ${h.sessions_resolved ?? 0} resolved (${pct(h.settle_rate) ?? '-'}), timed out ${h.timed_out ?? 0}, payers ${h.distinct_payers ?? 0}`);
  kv('volume', h.settled_volume ? `${flopAmount(h.settled_volume)} FLOP settled` : '-');
  kv('stake', m.stake ? `${flopAmount(m.stake.total)} FLOP (self ${flopAmount(m.stake.self)}, delegated ${flopAmount(m.stake.delegated)})` : '-');
  kv('calibration', m.calibration?.live ? `live, ${m.calibration.cap_gflops_per_sec} GFLOP/s, tier ${m.calibration.tier}` : 'not live');
  kv('slashing', m.slashing ? `strikes ${m.slashing.strikes}, failed acks ${m.slashing.failed_acks}, failed offer opens ${m.slashing.failed_offer_opens}` : '-');
  kv('models', (m.models ?? []).map((x) => `${x.id ?? x.name} [${(x.evidence ?? []).join(', ')}]`).join('; '));
  if (m.availability) {
    // Endpoint URLs are not public; the router reports availability and health instead.
    kv('availability', `${m.availability.replace('_', ' ')}${m.health && m.health !== 'unknown' ? `, health ${m.health}` : m.health === 'unknown' ? ', health: not enough data' : ''}`);
    if (m.last_checked_at) kv('last checked', m.last_checked_at);
    if (m.recent) kv('recent', `success ${pct(m.recent.success_rate) ?? 'not enough data'}, median first output ${m.recent.first_output_ms_median ?? '-'} ms`);
  } else {
    kv('router measured', `reachable ${rm.reachable ? 'yes' : 'no'}, ready ${rm.ready ? 'yes' : 'no'}, first output ${rm.first_output_ms ?? '-'} ms, success ${pct(rm.session_success_rate) ?? '-'}`);
    for (const e of m.endpoints ?? []) kv('endpoint', `${e.url ? `${e.url} ` : ''}${e.status}${e.ready ? ' ready' : ''} ${e.model ?? ''} (probe ${pct(e.probe_success_rate) ?? '-'}, ${e.proof_latency_ms ?? '-'} ms)`);
  }
  if (m.own_listing) printOwnListing(m.own_listing, kv);
  if (m.recent_channels?.length) kv('recent channels', `${m.recent_channels.length} (use --json for the list)`);
  if (m.links?.account) kv('explorer', m.links.account);
}

export async function session(ctx, o, id) {
  if (!id) {
    const r = await ctx.api.get('/v1/sessions', { query: { limit: o.limit } });
    if (o.json) return printJson(r);
    return console.log(table((r.data ?? []).map((s) => ({ id: s.session_id ?? s.id, status: s.status, model: s.model, miner: short(s.miner), escrow: s.escrow, created: s.created_at })), [
      { key: 'id', title: 'SESSION' }, { key: 'status', title: 'STATUS' }, { key: 'model', title: 'MODEL' }, { key: 'miner', title: 'MINER' },
      { key: 'escrow', title: 'ESCROW', right: true }, { key: 'created', title: 'CREATED' },
    ]));
  }
  const s = await ctx.api.get(`/v1/sessions/${encodeURIComponent(id)}`);
  if (o.json) return printJson(s);
  const kv = (k, v) => console.log(`${dim(k.padEnd(16))}${v ?? '-'}`);
  kv('session', s.session_id); kv('status', s.status); kv('model', s.model); kv('miner', s.miner); kv('channel', s.channel_id);
  kv('payer', s.payer ? `${s.payer.address} (${s.payer.kind})` : null);
  kv('escrow', s.escrow ? `${s.escrow} ${s.currency ?? 'FLOP'}` : null); kv('miner paid', s.miner_paid);
  kv('router fee', s.router_fee ? `${s.router_fee.amount} (${s.router_fee.status ?? (s.router_fee.charged ? 'charged' : 'not charged')})` : null);
  if (s.payer?.fallback_from) kv('payer note', `ran in ${s.payer.mode} mode instead of ${s.payer.fallback_from}`);
  kv('on chain', s.on_chain ? `opened ${s.on_chain.open_block ?? '-'}, outcome ${s.on_chain.outcome ?? 'pending'}${s.on_chain.outcome_block ? ` at ${s.on_chain.outcome_block}` : ''}` : null);
  kv('attempts', (s.attempts ?? []).map((a) => `${a.n}:${short(a.miner)} ${a.status}${a.error ? ` (${a.error})` : ''}`).join('; '));
  if (s.error) kv('error', red(typeof s.error === 'string' ? s.error : JSON.stringify(s.error)));
  if (s.links?.channel) kv('explorer', s.links.channel);
}

export async function health(ctx, o) {
  const h = await ctx.api.get('/health', { auth: false });
  if (o.json) return printJson(h);
  console.log(`${bold(ctx.api.base)}  ${h.status === 'ok' ? green('ok') : yellow(h.status)}  ${h.network}  block ${h.finalized_block}`);
  console.log(`miners ${h.registry?.miners}, models ${h.registry?.models}, endpoints verified ${h.endpoints?.verified} (ready ${h.endpoints?.verified_ready})`);
  // payer: {kind, address} in the earlier format, {router_wallet, modes, ...} in the current one.
  if (h.payer) {
    const wallet = h.payer.router_wallet ?? h.payer.address;
    const modes = Array.isArray(h.payer.modes) ? h.payer.modes.join(', ') : h.payer.kind;
    console.log(`payer modes ${modes ?? '-'}${wallet ? `, router wallet ${wallet}` : ''}${h.payer.demo ? ', demo on' : ''}`);
  } else console.log('payer none: this router serves the directory only');
  const f = h.finality;
  if (f && typeof f.lag_blocks === 'number') console.log(`finality ${f.finalized_block} of ${f.best_block} (${f.lag_blocks} blocks behind${f.waiting ? ', waiting' : ''})`);
}

// ---- chat --------------------------------------------------------------------------------------------------------

async function pickModel(ctx) {
  const r = await ctx.api.get('/v1/models', { auth: false });
  const m = (r.data ?? []).map(modelFacts).filter((x) => x.available).sort((a, b) => (b.ready ?? 0) - (a.ready ?? 0))[0];
  if (!m) throw new Error('no model has a ready miner right now; see `floprouter models`');
  err(dim(`model: ${m.id} (auto: most ready miners)`));
  return m.id;
}

function chatBody(o, model, messages, stream) {
  const miners = [o.miner].flat().filter(Boolean).flatMap((x) => String(x).split(',')).map((x) => x.trim()).filter(Boolean);
  const fallbacks = [o['fallback-model']].flat().filter(Boolean).flatMap((x) => String(x).split(',')).map((x) => x.trim()).filter(Boolean);
  return {
    model, messages, stream,
    ...(fallbacks.length ? { models: fallbacks } : {}),
    ...(o['max-tokens'] ? { max_tokens: Number(o['max-tokens']) } : {}),
    ...(miners.length ? { provider: o.fallbacks ? { order: miners } : { only: miners } } : o.sort ? { provider: { sort: o.sort } } : {}),
    // Never ask the server to hold the response open until settlement: behind Cloudflare a response that is
    // silent for about 100 s is cut. `--wait` polls the session instead (see waitForSettlement).
    flop: { wait_for_settlement: false, ...(o.payer ? { payer: o.payer } : {}), ...(o['fallback-payer'] ? { fallback_payer: o['fallback-payer'] } : {}) },
  };
}

function tokensOf(u) {
  if (!u) return null;
  const t = u.total_tokens ?? (typeof u.prompt_tokens === 'number' && typeof u.completion_tokens === 'number' ? u.prompt_tokens + u.completion_tokens : null);
  return t === null ? null : `${t} tokens`;
}

/** One status line on stderr: session, model (when a fallback answered), miner, cost, payer, tokens; ignored parameters. */
function footer({ flop, usage, model, requested, headers }) {
  const ignored = (headers?.get?.('x-floprouter-ignored-parameters') ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  const ign = ignored.length ? ignored : flop?.ignored_parameters ?? [];
  if (ign.length) err(yellow(`ignored by this model: ${ign.join(', ')}`));
  if (!flop) return;
  const cost = costOf({ usage });
  const parts = [`session ${flop.session_id ?? headers?.get?.('x-generation-id') ?? '-'}`,
    model && requested && String(model).toLowerCase() !== String(requested).toLowerCase() && `model ${model} (fallback)`,
    `miner ${short(flop.miner)}`, cost !== null ? `cost ${cost} FLOP${usage?.cost_details?.final === false ? ' (until settled)' : ''}` : flop.escrow && `escrow ${flop.escrow} FLOP`,
    flop.payer?.mode ? `payer ${flop.payer.mode}${flop.payer.fallback_from ? ` (from ${flop.payer.fallback_from})` : ''}` : flop.payer?.kind && `payer ${flop.payer.kind}`,
    `status ${flop.status}`, tokensOf(usage)].filter(Boolean);
  err(dim(`[${parts.join(' · ')}]`));
}

const FINAL = new Set(['settled', 'refunded', 'failed', 'fraud', 'voided']);

/** Polls GET /v1/sessions/{id} until the on-chain outcome is final (or the time limit). */
export async function waitForSettlement(api, id, { everyMs = 10_000, maxMs = 420_000, onTick } = {}) {
  const t0 = Date.now();
  for (;;) {
    const s = await api.get(`/v1/sessions/${encodeURIComponent(id)}`);
    if (FINAL.has(s.status) || Date.now() - t0 > maxMs) return s;
    onTick?.(s);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

async function settle(ctx, o, flop) {
  if (!o.wait || !flop?.session_id) return;
  err(dim('waiting for the on-chain settlement (usually 2-5 minutes)...'));
  const s = await waitForSettlement(ctx.api, flop.session_id);
  err(dim(`[session ${s.session_id} · status ${s.status}${s.miner_paid ? ` · miner paid ${s.miner_paid} FLOP` : ''}${s.on_chain?.outcome_tx ? ` · tx ${s.on_chain.outcome_tx}` : ''}]`));
}

/** The router answers 202 `chat.completion.pending` when no verified reply arrived before its response deadline. */
async function awaitReply(ctx, pending) {
  err(dim(`no reply within the router's response deadline; polling ${pending.poll ?? `/v1/sessions/${pending.id}`}`));
  for (let i = 0; i < 60; i++) {
    await new Promise((res) => setTimeout(res, 5_000));
    const s = await ctx.api.get(`/v1/sessions/${encodeURIComponent(pending.id)}`);
    // The reply is a string in the earlier format and {role, content, finish_reason} in the current one.
    const text = typeof s.reply === 'string' ? s.reply : typeof s.reply?.content === 'string' ? s.reply.content : null;
    if (text !== null) {
      return { id: s.session_id, object: 'chat.completion', model: s.model, choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: s.reply?.finish_reason ?? s.usage?.finish_reason ?? null }], usage: s.usage, flop: s };
    }
    if (FINAL.has(s.status)) throw new Error(`session ${s.session_id} ended ${s.status} without a reply${s.error ? `: ${typeof s.error === 'string' ? s.error : JSON.stringify(s.error)}` : ''}`);
  }
  throw new Error(`no reply yet for session ${pending.id}; check later with: floprouter session ${pending.id}`);
}

async function oneTurn(ctx, o, model, messages) {
  if (o.stream) {
    let content = ''; let flop = null; let usage = null; let full = []; let headers = null; let used = null;
    let spin = process.stderr.isTTY ? setInterval(() => process.stderr.write(dim('.')), 2000) : null;
    const stopSpin = () => { if (spin) { clearInterval(spin); spin = null; } };
    try {
      await ctx.api.stream('/v1/chat/completions', chatBody(o, model, messages, true), {
        onHeaders: (h) => { headers = h; },
        onEvent: (ev) => {
          full.push(ev);
          if (ev.model) used = ev.model;
          const d = ev.choices?.[0]?.delta?.content;
          if (d) { if (spin) { stopSpin(); process.stderr.write('\n'); } content += d; if (!o.json) process.stdout.write(d); }
          if (ev.flop) flop = ev.flop;
          if (ev.usage) usage = ev.usage;
        },
      });
    } finally { stopSpin(); }
    if (o.json) printJson({ chunks: full }); else { process.stdout.write('\n'); footer({ flop, usage, model: used, requested: model, headers }); }
    await settle(ctx, o, flop);
    return content;
  }
  let r = await ctx.api.post('/v1/chat/completions', chatBody(o, model, messages, false));
  if (r?.object === 'chat.completion.pending' && r.id) r = await awaitReply(ctx, r);
  const content = r.choices?.[0]?.message?.content ?? '';
  if (o.json) printJson(r); else { process.stdout.write(content + '\n'); footer({ flop: r.flop, usage: r.usage, model: r.model, requested: model, headers: headersOf(r) }); }
  await settle(ctx, o, r.flop);
  return content;
}

export async function chat(ctx, o, words) {
  let model = o.model || (await pickModel(ctx));
  const base = o.system ? [{ role: 'system', content: o.system }] : [];
  let prompt = words.join(' ').trim();
  if (!prompt && !process.stdin.isTTY) prompt = (await readStdin()).trim();
  if (prompt) { await oneTurn(ctx, o, model, [...base, { role: 'user', content: prompt }]); return; }

  // Interactive: the whole conversation is resent each turn (each turn is one paid session on chain).
  err(dim('Interactive chat. Each message is one paid session. Commands: /model <id>, /miner <address|auto>, /reset, /exit'));
  let history = [...base];
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  const q = () => new Promise((res) => rl.question(bold('you> '), res));
  for (;;) {
    const line = (await q()).trim();
    if (!line) continue;
    if (line === '/exit' || line === '/quit') break;
    if (line === '/reset') { history = [...base]; err(dim('conversation cleared')); continue; }
    if (line.startsWith('/model')) { model = line.split(/\s+/)[1] || model; err(dim(`model: ${model}`)); continue; }
    if (line.startsWith('/miner')) { const a = line.split(/\s+/)[1]; o.miner = !a || a === 'auto' ? undefined : a; err(dim(`miner: ${o.miner ?? 'auto'}`)); continue; }
    if (line.startsWith('/')) { err(dim('commands: /model <id>, /miner <address|auto>, /reset, /exit')); continue; }
    history.push({ role: 'user', content: line });
    try {
      process.stdout.write(bold('assistant> '));
      const reply = await oneTurn(ctx, { ...o, json: false }, model, history);
      history.push({ role: 'assistant', content: reply });
    } catch (e) { history.pop(); process.stdout.write('\n'); err(red(describe(e))); err(dim('(not added to the conversation; send it again, or /model to try another model)')); }
  }
  rl.close();
}

function readStdin() {
  return new Promise((resolve) => { let s = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (d) => { s += d; }); process.stdin.on('end', () => resolve(s)); });
}

// ---- account: login, keys, balance --------------------------------------------------------------------------------

export async function login(ctx, o) {
  const { loadSigner, signChallenge } = await import('./wallet.js');
  const pair = await loadSigner(signerOpts(o));
  err(`wallet ${bold(pair.address)}`);
  const ch = await ctx.api.post('/v1/auth/challenge', { address: pair.address }, { auth: false });
  if (!ch?.challenge) throw new Error('router returned no challenge');
  // Show what is being signed: the router's challenge must say it creates an API key and moves no funds.
  if (!/API key/i.test(ch.challenge)) throw new Error('unexpected challenge text from the router; refusing to sign');
  err(dim(ch.challenge.split('\n').map((l) => `  | ${l}`).join('\n')));
  const signature = await signChallenge(pair, ch.challenge, { wrap: Boolean(o['wrap-bytes']) });
  const r = await ctx.api.post('/v1/auth/keys', {
    address: pair.address, challenge: ch.challenge, signature,
    ...(o.name ? { name: o.name } : {}), ...(o.payer ? { payer: o.payer } : {}),
  }, { auth: false });
  if (!r?.key) throw new Error('router returned no key');
  const who = r.address ?? pair.address;
  if (o['no-save']) {
    pair.lock?.();
    err(yellow('Not saved (--no-save). This is the only time the key is shown:'));
    process.stdout.write(r.key + '\n');
    return;
  }
  const file = writeConfig({ api_key: r.key, key_id: r.id ?? null, address: who, base_url: ctx.api.base });
  err(green(`API key ${r.id ?? ''} created for ${who} (payer mode: ${r.payer_mode ?? 'default'}), saved to ${file} (mode 600).`));
  err('The CLI and floprouter-mcp read it from there.');
  if (o['show-key']) process.stdout.write(`export FLOPROUTER_API_KEY=${r.key}\n`);
  else err(dim('To use it in another tool: floprouter key --show   (treat it like a password)'));
  if ((r.payer_mode ?? 'grant') !== 'grant') {
    pair.lock?.();
    return err(dim('Next: floprouter deposit <amount>   (credit mode: the router pays sessions from your prepaid balance)'));
  }
  // Grant mode: finish the sign-up with the one grant signature, using the wallet that is already unlocked.
  // Nothing more is asked than `grant` asks today (its summary and one confirmation; --yes skips it).
  if (o['no-grant']) { pair.lock?.(); return err(dim('Next: floprouter grant   (one signature; your wallet then pays each session on chain)')); }
  if (!o.yes && !process.stdin.isTTY) { pair.lock?.(); return err(dim('No terminal to confirm on. Next: floprouter grant --yes   (one signature; your wallet then pays each session on chain)')); }
  const ctx2 = { api: ctx.withKey ? ctx.withKey(r.key) : makeClient({ baseUrl: ctx.api.base, apiKey: r.key, userAgent: 'floprouter-cli', title: 'floprouter CLI' }) };
  try {
    if (await alreadyGranted(ctx2, o)) { err(green('Your grant is already active: nothing more to sign.')); return; }
    err(dim('\nOne more step: the grant, so the router can pay for sessions from your wallet.'));
    await grant(ctx2, { ...o, revoke: false, status: false, 'auto-renew': false }, { pair, say: (m) => err(m) });
  } catch (e) {
    err(yellow(`The API key is saved, but the grant was not completed: ${describe(e)}`));
    err('Run `floprouter grant` to try again.');
    process.exitCode = 1;
  } finally { pair.lock?.(); }
}

/** True when this wallet needs nothing signed: an active compute grant that is not due, and (in fee mode) an active fee grant. */
async function alreadyGranted(ctx, o) {
  let g; try { g = await ctx.api.post('/v1/grants/sync', {}); } catch { return false; }
  const f = grantFacts(g);
  if (f.state !== 'active' || decideRenewal(f).action !== 'skip') return false;
  if (o['no-fee-grant'] || g?.fees?.mode === 'prepaid') return true;
  return grantOf(g, undefined, 'fee')?.state === 'active';
}

export async function keys(ctx, o, args) {
  const [sub, id, mode] = args;
  if (sub === 'revoke') {
    if (!id) throw new Error('usage: floprouter keys revoke <id>');
    await ctx.api.del(`/v1/auth/keys/${encodeURIComponent(id)}`);
    return err(green(`revoked ${id}`));
  }
  if (sub === 'payer') {
    if (!id || !mode) throw new Error('usage: floprouter keys payer <id> grant|credit');
    const r = await ctx.api.patch(`/v1/auth/keys/${encodeURIComponent(id)}`, { payer: mode });
    return err(green(`${r.id} payer mode is now ${r.payer_mode}`));
  }
  const r = await ctx.api.get('/v1/auth/keys');
  if (o.json) return printJson(r);
  console.log(table((r.data ?? []).map((k) => ({
    id: k.id, name: k.name, prefix: k.prefix ? `${k.prefix}…` : null, payer: k.payer_mode,
    state: k.revoked ? 'revoked' : 'active', created: k.created_at, used: k.last_used_at,
  })), [
    { key: 'id', title: 'ID' }, { key: 'name', title: 'NAME' }, { key: 'prefix', title: 'KEY' }, { key: 'payer', title: 'PAYER' },
    { key: 'state', title: 'STATE' }, { key: 'created', title: 'CREATED' }, { key: 'used', title: 'LAST USED' },
  ]));
}

export async function balance(ctx, o) {
  const b = await ctx.api.get('/v1/balance');
  let g = null;
  try { g = await ctx.api.get('/v1/grants'); } catch (e) { if (!(e instanceof ApiError && (e.status === 404 || e.status === 503))) throw e; }
  if (o.json) return printJson({ balance: b, grants: g });
  const kv = (k, v) => console.log(`${dim(k.padEnd(16))}${v ?? '-'}`);
  kv('wallet', b.address);
  kv('balance', `${b.balance} ${b.currency ?? 'FLOP'}${b.held && Number(b.held) > 0 ? ` (held ${b.held}, available ${b.available})` : ''}`);
  kv('deposit to', b.deposit_address ?? 'deposits not enabled on this router');
  kv('router fee', b.fee_percent !== undefined ? `${b.fee_percent}% of escrow, only for sessions that settle paid` : null);
  kv('grant', describeGrant(g));
  const fees = b.fees ?? g?.fees ?? null;
  if (fees || grantOf(g, undefined, 'fee')) {
    kv('fees', describeFees(fees));
    const lc = fees?.last_collection;
    if (lc) kv('last collection', `${lc.amount} FLOP${lc.block !== undefined ? ` at block ${lc.block}` : ''}, ${txLink(lc.tx, b.explorer_url ?? g?.explorer_url ?? fees?.explorer_url)}`);
    kv('fee grant', describeGrant(g, 'fee', fees));
    if (fees && Number(fees.owed) > 0 && grantOf(g, undefined, 'fee')?.state !== 'active') console.log(dim('                Fees are owed and no fee grant is active: run `floprouter grant` (one signature) or `floprouter deposit <amount>`.'));
  }
  const wd = b.withdrawals;
  if (wd && !Array.isArray(wd)) kv('withdrawals', wd.enabled ? `enabled, at least ${wd.min} FLOP: floprouter withdraw <amount|all>` : 'not enabled on this router');
  for (const w of (Array.isArray(wd) ? wd : wd?.recent ?? []).slice(0, 3)) kv('withdrawal', `${w.status} ${w.sent ?? w.requested} FLOP ${w.tx ?? ''} ${w.created_at ?? ''}`);
  const recent = (b.recent ?? []).slice(0, o.all ? 50 : 8);
  if (recent.length) {
    console.log(bold('\nrecent'));
    console.log(table(recent.map((t) => ({ at: t.at, kind: t.kind, amount: t.amount, ref: t.session_id ?? t.tx ?? t.channel_id, note: t.note })), [
      { key: 'at', title: 'AT' }, { key: 'kind', title: 'KIND' }, { key: 'amount', title: 'AMOUNT', right: true }, { key: 'ref', title: 'REF' }, { key: 'note', title: 'NOTE' },
    ]));
  }
}

function describeGrant(g, kind = 'compute', fees = null) {
  const x = grantOf(g, undefined, kind);
  if (kind === 'fee' && !x) return fees?.mode === 'prepaid' ? 'not used: the fee is taken from your prepaid balance' : 'none (run `floprouter grant` for deposit-free fees)';
  if (x?.state === 'waiting_for_finality') {
    const pnd = x.pending ?? {};
    return yellow(`waiting for finality: in block ${pnd.best_block ?? '?'}, final up to ${pnd.finalized_block ?? '?'}; reads as ${pnd.at_best ?? 'the new state'} once final`);
  }
  if (x?.state === 'revoked') return `revoked (run \`floprouter grant\` to grant again)`;
  if (!x || x.state === 'assigned' || (!x.active && x.state !== 'expired')) return `none (run \`floprouter grant\`)`;
  if (x.state === 'expired' || !x.active) return yellow(`${x.state}: sign a new one with \`floprouter grant\``);
  return [green(x.state ?? 'active'), x.remaining && `${x.remaining} of ${x.spending_cap} FLOP left`,
    kind !== 'fee' && x.epoch_room && `${x.epoch_room} left today`, kind !== 'fee' && x.sessions_left_estimate !== null && x.sessions_left_estimate !== undefined && `about ${x.sessions_left_estimate} sessions`,
    x.expires_at && `expires ${x.expires_at.slice(0, 16).replace('T', ' ')} UTC`].filter(Boolean).join(', ');
}

function describeFees(f) {
  if (!f) return null;
  const how = f.mode === 'grant_accrual' ? 'deposit-free: collected from your wallet through the fee grant' : 'taken from your prepaid balance';
  return `${how}; accrued ${f.accrued}, collected ${f.collected}, owed ${f.owed} FLOP`;
}

/** A transaction as a link when the explorer's URL is known, else its hash. */
function txLink(tx, explorerUrl) {
  if (!tx) return '-';
  return explorerUrl ? `${String(explorerUrl).replace(/\/+$/, '')}/transactions/${tx}` : `tx ${tx}`;
}

// ---- signing commands: grant, deposit ---------------------------------------------------------------------------

function signerOpts(o) { return { keyFile: o['key-file'], seedFile: o['seed-file'], passwordFile: o['password-file'], type: o.type }; }

async function chainContext(ctx, o, hint) {
  const h = await ctx.api.get('/health', { auth: false });
  const rpc = o.rpc || hint?.rpc || (Array.isArray(h.rpc) ? h.rpc[0] : h.rpc);
  if (!rpc) throw new Error('no chain RPC known: pass --rpc wss://...');
  if (hint?.genesis && h.genesis_hash && hint.genesis !== h.genesis_hash) throw new Error('router reports two different genesis hashes; refusing to sign');
  const { connect } = await import('./wallet.js');
  err(dim(`chain ${h.network ?? ''} via ${rpc}`));
  return { api: await connect(rpc, h.genesis_hash ?? hint?.genesis), network: h.network };
}

const pick = (...xs) => xs.find((x) => x !== undefined && x !== null && x !== '');

export async function grant(ctx, o, preset = {}) {
  if (o.status) return grantStatus(ctx, o);
  if (o['auto-renew']) return autoRenew(ctx, o);
  const say = preset.say ?? ((m) => console.log(m));
  const { loadSigner, toRaw, fromRaw, signAndWait, isValidAddress } = await import('./wallet.js');
  const pair = preset.pair ?? await loadSigner(signerOpts(o));
  const p = preset.params ?? readGrantParams(await ctx.api.get('/v1/grants/params', { query: ctx.api.hasKey ? {} : { address: pair.address } }));
  checkGrantParams(p, pair.address, await isValidAddress(p.delegate ?? ''));
  // Deposit-free fees: one signature for the compute grant and the fee grant. --no-fee-grant keeps the compute-only
  // grant (the fee is then taken from a prepaid deposit). The router's batch is checked before any chain access.
  const plan = p.feeCall && !o['no-fee-grant'] && !o.revoke ? await feePlan(ctx, o, preset, p, isValidAddress) : null;
  const { api } = preset.chain ?? await chainContext(ctx, o, p);
  try {
    const blocksPerHour = Number(api.consts.flopSessionKeys?.blocksPerHour?.toString() ?? 3600);
    const chainMax = Number(api.consts.flopSessionKeys?.maxSessionDuration?.toString() ?? 864000);
    const maxDur = Math.min(chainMax, Number(p.maxDurationBlocks ?? chainMax));

    if (o.revoke) return await revokeAll(ctx, o, { api, pair, p, signAndWait });

    if (plan) return await grantWithFee(ctx, o, { api, pair, p, plan, preset, say, blocksPerHour, signAndWait, fromRaw });

    const want = {
      spendingCap: String(pick(o['spending-cap'], preset.caps?.spendingCap, p.spendingCap, '5')),
      perTxLimit: String(pick(o['per-tx'], preset.caps?.perTxLimit, p.perTxLimit, '0.5')),
      dailyCap: String(pick(o['daily-cap'], preset.caps?.dailyCap, p.dailyCap, '2')),
      durationBlocks: o.days ? Math.round(Number(o.days) * 24 * blocksPerHour) : Number(pick(p.durationBlocks, maxDur)),
      feeFloat: String(pick(o['fee-float'], p.feeFloat, '0')),
    };
    if (!(want.durationBlocks > 0) || want.durationBlocks > maxDur) throw new Error(`duration ${want.durationBlocks} blocks is outside 1..${maxDur}`);
    const existing = await api.query.flopSessionKeys.sessions(pair.address, p.delegate);
    const active = existing.isSome && existing.unwrap().active?.isTrue === true;
    // A fee-mode router (with --no-fee-grant) states the compute caps in `amounts` only when it puts a compute grant in
    // its batch; for an active compute grant it states that grant's own caps there, and `call` carries its defaults.
    const computeInBatch = !p.calls || p.calls.some((c) => c?.method === 'createSession' && c.args?.[0] === p.delegate);
    const ownCaps = o['spending-cap'] || o['per-tx'] || o['daily-cap'] || preset.caps;
    if (p.feeCall && active && !computeInBatch && !ownCaps && !o.days) {
      err('You already have an active compute grant, and --no-fee-grant leaves it as it is: nothing to sign.');
      err(dim('To change its caps run `floprouter grant --no-fee-grant --spending-cap <FLOP> --per-tx <FLOP> --daily-cap <FLOP>`; to add deposit-free fees run `floprouter grant`.'));
      return null;
    }
    const callCaps = p.feeCall && !ownCaps && p.argRaw && !computeInBatch;
    const raw = callCaps
      ? { cap: BigInt(p.argRaw.cap), tx: BigInt(p.argRaw.tx), day: BigInt(p.argRaw.day), float: await toRaw(api, want.feeFloat) }
      : { cap: await toRaw(api, want.spendingCap), tx: await toRaw(api, want.perTxLimit), day: await toRaw(api, want.dailyCap), float: await toRaw(api, want.feeFloat) };
    if (callCaps) { want.spendingCap = fromRaw(api, raw.cap); want.perTxLimit = fromRaw(api, raw.tx); want.dailyCap = fromRaw(api, raw.day); }
    if (raw.cap <= 0n || raw.tx <= 0n || raw.day <= 0n) throw new Error('caps must be positive');
    if (raw.tx > raw.cap || raw.day > raw.cap) throw new Error('per-transaction and daily caps cannot exceed the spending cap');
    // The router's own call must say the same as its amounts (unless the caps were chosen here on purpose).
    if (p.argRaw && !ownCaps && p.spendingCap && !callCaps
      && (String(p.argRaw.cap) !== raw.cap.toString() || String(p.argRaw.tx) !== raw.tx.toString() || String(p.argRaw.day) !== raw.day.toString())) {
      throw new Error('the router\'s call arguments do not match its stated amounts; refusing to sign');
    }
    const maxFloat = await toRaw(api, String(o['max-float'] ?? MAX_FLOAT_DEFAULT));
    if (raw.float > maxFloat) throw new Error(`fee float ${want.feeFloat} FLOP is above --max-float ${o['max-float'] ?? MAX_FLOAT_DEFAULT}`);

    const create = api.tx.flopSessionKeys.createSession(p.delegate, raw.cap, raw.tx, raw.day, want.durationBlocks, ALLOWED_PALLETS);
    // The chain refuses a second createSession while a grant to the same delegate is active
    // (SessionAlreadyExists), so a renewal is revokeSession + createSession in one batchAll: one signature, and
    // if either part fails nothing changes. Built here, from the chain's own state; the router's renewal_call, when it
    // sends one, must describe exactly that batch.
    if (active && p.renewalCall && !p.feeCall) checkRenewalCall(p.renewalCall, p.delegate);
    if (active && p.renewal === false && p.renewalCall === null && 'renewal' in (p.raw ?? {})) {
      err(dim('the router does not see the active grant yet (it reads its finalized block); renewing from the chain state'));
    }
    const calls = [...(active ? [api.tx.flopSessionKeys.revokeSession(p.delegate)] : []), create,
      ...(raw.float > 0n ? [api.tx.balances.transferKeepAlive(p.delegate, raw.float)] : [])];
    const tx = calls.length === 1 ? calls[0] : api.tx.utility.batchAll(calls);

    const hours = want.durationBlocks / blocksPerHour;
    const span = hours < 48 ? `${hours.toFixed(1)} hours` : `${(hours / 24).toFixed(1)} days`;
    const acct = await api.query.system.account(pair.address);
    say(bold(`\nSession-key grant${active ? ' renewal' : ''}`));
    say(`  your wallet (payer)   ${pair.address}  balance ${fromRaw(api, acct.data.free.toString())} FLOP`);
    say(`  router delegate       ${p.delegate}`);
    say(`  allowed               ${ALLOWED_PALLETS.join(', ')} only (compute channels; no transfers)`);
    say(`  spending cap          ${want.spendingCap} FLOP in total`);
    say(`  per session           ${want.perTxLimit} FLOP at most`);
    say(`  per day               ${want.dailyCap} FLOP at most`);
    say(`  duration              ${want.durationBlocks} blocks (about ${span})`);
    if (raw.float > 0n) say(`  fee float             ${want.feeFloat} FLOP sent to the delegate for its transaction fees`);
    if (active) say(`  renews                your active grant: revoke and new grant in one transaction (one signature)`);
    if (preset.reason) say(`  why                   ${preset.reason}`);
    say(dim('  Within these caps the router opens compute channels that your wallet pays for. Revoke any time:'));
    say(dim('  floprouter grant --revoke'));
    if (p.feeCall) say(dim('  No fee grant here (--no-fee-grant): the router fee is taken from your prepaid balance, so deposit first: floprouter deposit <amount>'));
    say('');
    if (!(await confirm('Sign and submit?', o))) { err('cancelled'); return null; }
    const r = await signAndWait(api, tx, pair, (st) => err(dim(`  ${st}`)));
    pair.lock?.();
    err(green(`grant ${active ? 'renewed' : 'created'}, finalized in block ${r.block} (tx ${r.tx})`));
    // A renewal replaces an active grant, so "active" alone could still be the old one: wait for the new cap.
    await syncGrant(ctx, { delegate: p.delegate, expect: 'active', cap: want.spendingCap, maxMs: preset.syncMaxMs });
    return { tx: r.tx, block: r.block, renewed: active, caps: want };
  } finally { if (!preset.chain) await api.disconnect(); }
}

/** Every grant of this wallet to the router that is active on chain: compute and fee delegates (the router's list, plus those named in the params). */
async function activeDelegates(ctx, { api, pair, p }) {
  let listed = [];
  if (ctx.api.hasKey) { try { listed = knownDelegates(await ctx.api.post('/v1/grants/sync', {})); } catch { /* the params still name the current ones */ } }
  const out = [];
  for (const d of new Set([...listed, p.delegate, p.feeDelegate].filter(Boolean))) {
    const rec = await api.query.flopSessionKeys.sessions(pair.address, d);
    if (rec.isSome && rec.unwrap().active?.isTrue === true) out.push(d);
  }
  return out;
}

/** --revoke: one transaction that revokes every active grant of this wallet to the router (compute and fee). */
async function revokeAll(ctx, o, { api, pair, p, signAndWait }) {
  const targets = await activeDelegates(ctx, { api, pair, p });
  if (!targets.length) { err('no grant to the router on chain'); return null; }
  err(`Revoke ${targets.length > 1 ? 'these grants' : 'this grant'} from ${pair.address}:`);
  for (const d of targets) err(`  ${d}${d === p.feeDelegate ? '  (fee grant)' : d === p.delegate ? '  (compute grant)' : ''}`);
  if (!(await confirm('Sign and submit?', o))) return err('cancelled');
  const revokes = targets.map((d) => api.tx.flopSessionKeys.revokeSession(d));
  const r = await signAndWait(api, revokes.length === 1 ? revokes[0] : api.tx.utility.batchAll(revokes), pair, (st) => err(dim(`  ${st}`)));
  err(green(`revoked in block ${r.block} (tx ${r.tx})`));
  await syncGrant(ctx, { delegate: p.delegate, expect: 'gone' });
  return null;
}

/** The router's one-signature batch, checked against this wallet's known grants (pure checks; no chain access). */
async function feePlan(ctx, o, preset, p, isValidAddress) {
  const chosen = ['spending-cap', 'per-tx', 'daily-cap', 'days', 'fee-float'].filter((k) => o[k] !== undefined);
  if (chosen.length || preset.caps) {
    throw new Error(`--${chosen[0] ?? 'spending-cap'} cannot change the router's one-signature grant (the router sets its caps). `
      + 'To choose your own caps use `floprouter grant --no-fee-grant ...` (compute-only grant; the fee is then paid from a deposit).');
  }
  let known = [];
  if (ctx.api.hasKey) {
    try { known = knownDelegates(await ctx.api.post('/v1/grants/sync', {})); } catch (e) { err(dim(`could not list your current grants (${describe(e)}); continuing with the router's own delegates`)); }
  }
  return checkGrantBatch(p, known, { valid: await validAddresses(p, isValidAddress) });
}

/** The one-signature sign-up: the checked batch of compute grant + fee grant, shown and signed. */
async function grantWithFee(ctx, o, { api, pair, p, plan, preset, say, blocksPerHour, signAndWait, fromRaw }) {
  const tx = buildBatchTx(api, plan, p.callData);
  let pctFee = null;
  if (ctx.api.hasKey) { try { pctFee = (await ctx.api.get('/v1/balance'))?.fee_percent ?? null; } catch { /* optional */ } }
  const fl = (v) => fromRaw(api, v);
  const c = plan.compute; const f = plan.fee;
  const span = (blocks) => { const h = blocks / blocksPerHour; return h < 48 ? `${h.toFixed(1)} hours` : `${(h / 24).toFixed(1)} days`; };
  const acct = await api.query.system.account(pair.address);
  say(bold(plan.shape === 'add_fee' ? '\nDeposit-free fees: add the fee grant (your compute grant stays as it is)' : `\nSession-key grants${plan.shape === 'renewal' ? ' (renewal)' : ''}: one transaction, one signature`));
  say(`  your wallet (payer)   ${pair.address}  balance ${fl(acct.data.free.toString())} FLOP`);
  for (const d of plan.revokes) say(`  replaces              your current grant to ${d} (${d === p.feeDelegate ? 'fee' : d === p.delegate ? 'compute' : 'earlier fee delegate'})`);
  if (c) {
    say(`  compute grant         to the router delegate ${c.delegate}`);
    say(`    allowed             ${ALLOWED_PALLETS.join(', ')} only (compute channels; no transfers)`);
    say(`    spending cap        ${fl(c.cap)} FLOP in total, ${fl(c.tx)} per session, ${fl(c.day)} per day`);
    say(`    duration            ${c.duration} blocks (about ${span(c.duration)})`);
  }
  say(`  fee grant             to the fee delegate ${f.delegate}`);
  say(`    allowed             ${FEE_PALLETS.join(', ')} only`);
  say(`    fee cap             ${fl(f.cap)} FLOP in total, ${fl(f.tx)} per payment, ${fl(f.day)} per day`);
  if (!c) say(`    duration            ${f.duration} blocks (about ${span(f.duration)})`);
  say(`    the router collects its fee${pctFee !== null ? ` (${pctFee}% of the escrow)` : ''} from your wallet with it, paid to ${plan.feeAddress}`);
  if (preset.reason) say(`  why                   ${preset.reason}`);
  say(dim('  The chain limits what the router can do with each grant to the pallet and caps above; the router sends the fee'));
  say(dim('  only to the address shown. No deposit is needed. Revoke both any time: floprouter grant --revoke'));
  say(dim('  To pay the fee from a deposit instead: floprouter grant --no-fee-grant, then floprouter deposit <amount>.'));
  say('');
  if (!(await confirm('Sign and submit?', o))) { err('cancelled'); return null; }
  let r;
  try { r = await signAndWait(api, tx, pair, (st) => err(dim(`  ${st}`))); } catch (e) { throw chainError(e, p.maxRotations); }
  pair.lock?.();
  err(green(`${plan.shape === 'add_fee' ? 'fee grant created' : plan.shape === 'renewal' ? 'grants renewed' : 'grants created'}, finalized in block ${r.block} (tx ${r.tx})`));
  await syncGrant(ctx, { delegate: p.delegate, feeDelegate: f.delegate, expect: 'active', cap: c ? fl(c.cap) : undefined, maxMs: preset.syncMaxMs });
  return { tx: r.tx, block: r.block, renewed: plan.shape === 'renewal', shape: plan.shape, caps: c ? { spendingCap: fl(c.cap), perTxLimit: fl(c.tx), dailyCap: fl(c.day) } : null, fee_caps: { spendingCap: fl(f.cap), perTxLimit: fl(f.tx), dailyCap: fl(f.day) } };
}

/**
 * --auto-renew: safe to run every hour from cron, a systemd timer, CI or an agent loop. The shared flow in renewal.js
 * reads the grant from the router, does nothing (exit 0) while it is healthy, otherwise confirms the state on chain and
 * signs one transaction with the wallet's own key: a new grant, or revokeSession + createSession in one batchAll with
 * the current caps (or the caps given as flags). Never prompts for a key.
 */
export async function autoRenew(ctx, o) {
  const keyGiven = o['key-file'] || o['seed-file'] || process.env.FLOPROUTER_KEY_FILE || process.env.FLOPROUTER_SEED_FILE;
  if (!keyGiven) throw new Error('--auto-renew needs --key-file or --seed-file (or FLOPROUTER_KEY_FILE / FLOPROUTER_SEED_FILE); it never prompts for a key');
  if (!o.yes && !process.stdin.isTTY) throw new Error('--auto-renew without a terminal needs --yes');
  if (!ctx.api.hasKey) throw new Error('--auto-renew reads the grant from the router: run `floprouter login` or set FLOPROUTER_API_KEY');
  const caps = o['spending-cap'] || o['per-tx'] || o['daily-cap']
    ? { spendingCap: String(o['spending-cap'] ?? ''), perTxLimit: String(o['per-tx'] ?? ''), dailyCap: String(o['daily-cap'] ?? '') } : null;
  if (caps && (!caps.spendingCap || !caps.perTxLimit || !caps.dailyCap)) throw new Error('to change the caps on renewal give all three: --spending-cap, --per-tx and --daily-cap');
  const wallet = await import('./wallet.js');
  const r = await renewIfDue({
    client: ctx.api, wallet, key: signerOpts(o), rpc: o.rpc, days: o.days, caps, sameCaps: !caps, keepHeadroom: true, allowCreate: true, dryRun: Boolean(o['dry-run']), feeGrant: !o['no-fee-grant'],
    opts: { renewBeforeSec: parseDuration(o['renew-before'] ?? '2d'), minRemaining: o['min-remaining'] !== undefined ? Number(o['min-remaining']) : null,
      minDaily: o['min-daily'] !== undefined ? Number(o['min-daily']) : null },
    log: (m) => err(dim(m)),
  });
  if (r.action === 'skip' || r.action === 'wait') err(`${r.action === 'skip' ? 'grant ok' : 'grant pending'}: ${r.reason}. Nothing to do.`);
  if (r.note) err(yellow(r.note));
  else if (r.dry_run) err(yellow(`would ${r.action} (${r.reason}); --dry-run, nothing signed`));
  else if (r.tx) err(green(`${r.action === 'renew' ? 'renewed' : r.action === 'add_fee' ? 'fee grant added' : 'granted'} (${r.reason}): tx ${r.tx}, block ${r.block}`));
  if (o.json) printJson(r);
  if (r.action === 'refused') throw new Error(r.reason);
}

async function grantStatus(ctx, o) {
  const g = ctx.api.hasKey ? await ctx.api.post('/v1/grants/sync', {}) : null;
  if (!g) throw new Error('needs an API key: run `floprouter login`');
  const x = grantOf(g);
  const f = grantFacts(g, x?.delegate);
  const fx = grantOf(g, undefined, 'fee');
  const d = decideRenewal(f, { renewBeforeSec: parseDuration(o['renew-before'] ?? '2d'),
    minRemaining: o['min-remaining'] !== undefined ? Number(o['min-remaining']) : null, minDaily: o['min-daily'] !== undefined ? Number(o['min-daily']) : null });
  // Stable shape for scripts: the facts in plain numbers, and what --auto-renew would do now.
  if (o.json) return printJson({ address: g.address ?? null, ...f, needs_renewal: d.action === 'grant' || d.action === 'renew', auto_renew_action: d.action, reason: d.reason,
    fee_grant: fx ? grantFacts(g, fx.delegate, Date.now(), 'fee') : null, fees: g.fees ?? null });
  console.log(describeGrant(g));
  if (fx || g.fees) console.log(`fee grant: ${describeGrant(g, 'fee', g.fees)}`);
  if (g.fees) console.log(dim(`fees: ${describeFees(g.fees)}`));
  if (d.action !== 'skip') console.log(dim(`auto-renew would ${d.action}: ${d.reason}`));
}

/**
 * Re-syncs until the router reads the new state. The router reads grants at its finalized block, which can trail the
 * block our transaction was final in (and devnet finality sometimes lags by minutes), so one immediate sync can still
 * show the old state.
 */
async function syncGrant(ctx, { delegate, feeDelegate, expect, cap, maxMs = 180_000, everyMs = 5_000 } = {}) {
  if (!ctx.api.hasKey) return err(dim('No API key yet: run `floprouter login`, then `floprouter balance` shows the grant.'));
  const t0 = Date.now(); let said = false; let g = null;
  for (;;) {
    try { g = await ctx.api.post('/v1/grants/sync', {}); } catch (e) { err(yellow(`the router could not read the grant yet: ${describe(e)}`)); return; }
    const x = grantOf(g, delegate);
    const state = x?.state ?? 'none';
    const feeOk = !feeDelegate || grantOf(g, feeDelegate)?.state === 'active';
    const done = expect === 'active' ? state === 'active' && x.active !== false && feeOk && (cap === undefined || Number(x.spending_cap) === Number(cap))
      : state !== 'waiting_for_finality' && !(x?.active === true && state === 'active') && !(g?.data ?? []).some((y) => y.state === 'waiting_for_finality' || (y.active === true && y.state === 'active'));
    if (done) { err(`router sees: ${describeGrant(g)}`); if (feeDelegate) err(`              fee grant: ${describeGrant(g, 'fee', g?.fees)}`); return; }
    if (Date.now() - t0 > maxMs) {
      return err(yellow(`router still sees: ${describeGrant(g)}. It reads grants at its finalized block, which is behind; check again with \`floprouter grant --status\`.`));
    }
    if (!said) { err(dim('waiting for the router to read it at its finalized block...')); said = true; }
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

export async function deposit(ctx, o, args) {
  const amount = args[0];
  if (!amount) throw new Error('usage: floprouter deposit <amount in FLOP>');
  const b = await ctx.api.get('/v1/balance');
  if (!b.deposit_address) throw new Error('this router does not accept deposits');
  const { loadSigner, toRaw, fromRaw, signAndWait, isValidAddress } = await import('./wallet.js');
  if (!(await isValidAddress(b.deposit_address))) throw new Error(`deposit address ${b.deposit_address} is not valid`);
  const pair = await loadSigner(signerOpts(o));
  if (b.address && b.address !== pair.address) {
    throw new Error(`this API key belongs to ${b.address} but the key you loaded is ${pair.address}; a deposit is credited to the sending wallet`);
  }
  const { api } = await chainContext(ctx, o);
  try {
    const value = await toRaw(api, amount);
    if (value <= 0n) throw new Error('amount must be positive');
    const acct = await api.query.system.account(pair.address);
    console.log(bold('\nDeposit'));
    console.log(`  from     ${pair.address}  balance ${fromRaw(api, acct.data.free.toString())} FLOP`);
    console.log(`  to       ${b.deposit_address} (router deposit address)`);
    console.log(`  amount   ${amount} FLOP`);
    console.log(dim('  Credited to your router balance once the block is finalized.\n'));
    if (!(await confirm('Sign and submit?', o))) return err('cancelled');
    const r = await signAndWait(api, api.tx.balances.transferKeepAlive(b.deposit_address, value), pair, (s) => err(dim(`  ${s}`)));
    pair.lock?.();
    err(green(`transfer finalized in block ${r.block} (tx ${r.tx}). Check with: floprouter balance`));
  } finally { await api.disconnect(); }
}

// ---- miner operators: list an endpoint, see the own listing ------------------------------------------------------

function printOwnListing(ol, kv) {
  const list = Array.isArray(ol) ? ol : Array.isArray(ol?.endpoints) ? ol.endpoints : Array.isArray(ol?.data) ? ol.data : [];
  if (!list.length) return kv('your listing', 'no endpoint listed (floprouter miner endpoint <url> --key-file <miner key>)');
  for (const e of list) kv('your endpoint', `${e.url} ${e.status ?? ''}${e.ready ? ', ready' : ''}${e.model ? `, ${e.model}` : ''}${e.verified_at ? `, verified ${e.verified_at}` : ''}${e.last_checked_at ? `, checked ${e.last_checked_at}` : ''}`);
}

/** Plain words for the answer to an endpoint submission. */
export function describeSubmission(status, body) {
  const reason = body?.error?.metadata?.reason ?? (typeof body?.error?.code === 'string' ? body.error.code : null) ?? body?.status;
  const msg = body?.message ?? body?.error?.message ?? '';
  if (status === 200) return { ok: true, word: 'verified', text: `verified: the endpoint is listed and routable${body?.model ? ` (serves ${body.model})` : ''}. ${msg}`.trim() };
  if (status === 202) return { ok: true, word: 'not verified yet', text: `recorded, not routable yet: ${msg}` };
  if (status === 422 && /unreachable/.test(reason ?? '')) return { ok: false, word: 'unreachable', text: `unreachable: the router could not reach the endpoint. ${msg}`.trim() };
  if (status === 422) return { ok: false, word: 'not verified', text: `not verified: ${msg}` };
  if (status === 429) return { ok: false, word: 'rate limited', text: `rate limited${reason === 'too_many_pending' ? ' (too many endpoints recorded but not routable)' : ''}: ${msg}` };
  if (status === 401) return { ok: false, word: 'refused', text: `refused (${reason}): ${msg}` };
  return { ok: false, word: 'failed', text: `HTTP ${status} ${reason ?? ''}: ${msg}`.trim() };
}

/**
 * `floprouter miner endpoint <url>`: proves control of the miner account by signing the router's endpoint challenge
 * with the miner key (raw bytes, like `login`), then submits the URL. Works headless with --key-file and --yes.
 */
export async function minerEndpoint(ctx, o, url) {
  if (!url) throw new Error('usage: floprouter miner endpoint <https://host[:port]> --key-file <miner key> [--yes]');
  let u; try { u = new URL(url); } catch { throw new Error(`${url} is not a URL`); }
  if (u.protocol !== 'https:' || (u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) throw new Error('the endpoint must be https://host[:port] with no path');
  const clean = `https://${u.host.toLowerCase()}`;
  const headless = !process.stdin.isTTY;
  if (headless && !o.yes) throw new Error('without a terminal pass --yes (after checking the URL)');
  const { loadSigner, signChallenge } = await import('./wallet.js');
  const pair = await loadSigner({ ...signerOpts(o), noPrompt: headless });
  const addr = pair.address;
  const ch = await ctx.api.post(`/v1/miners/${addr}/endpoint/challenge`, { url: clean }, { auth: false });
  const text = ch?.challenge;
  // Sign only a challenge that is what it says: this miner, this URL, no funds moved.
  if (typeof text !== 'string' || !text.includes(addr) || !text.includes(clean) || !/endpoint/i.test(text) || !/does not move funds/i.test(text) || /API key/i.test(text)) {
    throw new Error('the router returned an unexpected challenge; refusing to sign');
  }
  err(`miner ${bold(addr)} lists ${bold(clean)}`);
  err(dim(text.split(/;\s*/).map((l) => `  | ${l}`).join('\n')));
  if (!(await confirm('Sign with the miner key and submit?', o))) return err('cancelled');
  const signature = await signChallenge(pair, text, { wrap: Boolean(o['wrap-bytes']) });
  pair.lock?.();
  let status = 200; let body;
  try { body = await ctx.api.post(`/v1/miners/${addr}/endpoint`, { url: clean, challenge: text, signature }, { auth: false }); status = body?.httpStatus ?? 200; }
  catch (e) { if (!(e instanceof ApiError)) throw e; status = e.status; body = e.body; }
  const d = describeSubmission(status, body);
  if (o.json) printJson({ status, word: d.word, ...body });
  (d.ok ? (m) => err(green(m)) : (m) => err(red(m)))(d.text);
  if (!d.ok) process.exitCode = status === 429 ? 3 : 2;
}

/** `floprouter miner status [address]`: the miner's public entry, and its own listing when the API key is the miner's. */
export async function minerStatus(ctx, o, address) {
  let addr = address;
  if (!addr && (o['key-file'] || o['seed-file'])) { const { loadSigner } = await import('./wallet.js'); addr = (await loadSigner({ ...signerOpts(o), noPrompt: true })).address; }
  if (!addr) addr = readConfig().address;
  if (!addr) throw new Error('usage: floprouter miner status [<address>] (or --key-file, or the address saved by login)');
  const m = await ctx.api.get(`/v1/miners/${encodeURIComponent(addr)}`, { auth: ctx.api.hasKey });
  if (o.json) return printJson({ address: m.address, availability: m.availability ?? null, health: m.health ?? null, last_checked_at: m.last_checked_at ?? null, recent: m.recent ?? null, own_listing: m.own_listing ?? null });
  const kv = (k, v) => console.log(`${dim(k.padEnd(16))}${v ?? '-'}`);
  console.log(bold(m.address));
  kv('availability', m.availability ? m.availability.replace('_', ' ') : '-');
  kv('health', m.health === 'unknown' ? 'not enough data yet' : m.health);
  kv('last checked', m.last_checked_at);
  if (m.recent) kv('recent', `success ${pct(m.recent.success_rate) ?? 'not enough data'}, median first output ${m.recent.first_output_ms_median ?? '-'} ms`);
  if (m.own_listing) printOwnListing(m.own_listing, kv);
  else kv('your listing', ctx.api.hasKey ? 'not shown: this API key is not the miner address (floprouter login --key-file <miner key>)' : 'not shown: needs an API key of the miner address (floprouter login --key-file <miner key>)');
}

// ---- generation, key, withdraw -----------------------------------------------------------------------------------

/** GET /v1/generation?id= (tokens, cost in FLOP, latency, reply); on a router without it, the session record. */
export async function generation(ctx, o, id) {
  if (!id) throw new Error('usage: floprouter generation <gen-id>');
  let g;
  try { g = (await ctx.api.get('/v1/generation', { query: { id } }))?.data; } catch (e) {
    if (!isMissingRoute(e)) throw e;
    err(dim('this router has no /v1/generation; showing the session record'));
    return session(ctx, o, id);
  }
  if (o.json) return printJson(g);
  const kv = (k, v) => console.log(`${dim(k.padEnd(16))}${v ?? '-'}`);
  kv('generation', g.id); kv('model', g.model); kv('miner', g.flop?.miner ?? g.provider_name); kv('created', g.created_at);
  kv('tokens', `${g.tokens_prompt ?? '-'} prompt + ${g.tokens_completion ?? '-'} completion`);
  kv('cost', g.total_cost !== undefined ? `${g.total_cost} ${g.flop?.currency ?? 'FLOP'}${g.flop?.cost_final === false ? ' (final when the session settles)' : ''}` : null);
  kv('escrow', g.upstream_inference_cost); kv('finish', `${g.finish_reason ?? '-'}${g.native_finish_reason && g.native_finish_reason !== g.finish_reason ? ` (${g.native_finish_reason})` : ''}`);
  kv('latency', g.latency !== undefined && g.latency !== null ? `${g.latency} ms (generation ${g.generation_time ?? '-'} ms)` : null);
  kv('status', g.flop?.status); kv('channel', g.flop?.channel_id);
  if (g.flop?.error) kv('error', red(typeof g.flop.error === 'string' ? g.flop.error : JSON.stringify(g.flop.error))); kv('streamed', g.streamed === undefined ? null : String(g.streamed));
  if (g.reply?.content !== undefined) { console.log(bold('\nreply')); console.log(g.reply.content); }
}

/** GET /v1/key: the calling key's usage in FLOP, rate limits, wallet and payer mode. */
export async function keyInfo(ctx, o) {
  let k;
  try { k = (await ctx.api.get('/v1/key'))?.data; } catch (e) {
    if (isMissingRoute(e)) throw new Error('this router does not offer GET /v1/key; use `floprouter keys`');
    throw e;
  }
  if (o.json) return printJson(k);
  const kv = (key, v) => console.log(`${dim(key.padEnd(16))}${v ?? '-'}`);
  kv('key', `${k.flop?.key_id ?? '-'} ${k.label ? `(${k.label})` : ''}`); kv('wallet', k.flop?.address ?? k.creator_user_id);
  kv('payer mode', k.flop?.payer_mode);
  kv('usage', `${k.usage ?? 0} FLOP (today ${k.usage_daily ?? 0}, this week ${k.usage_weekly ?? 0}, this month ${k.usage_monthly ?? 0})`);
  kv('limit', k.limit === null || k.limit === undefined ? 'none on the key: the balance and the grant bound spending' : k.limit);
  if (k.rate_limit) kv('rate limit', typeof k.rate_limit === 'object' ? Object.entries(k.rate_limit).map(([a, b]) => `${a} ${b}`).join(', ') : k.rate_limit);
}

/** POST /v1/balance/withdraw: prepaid FLOP back to the wallet that owns the key. */
export async function withdraw(ctx, o, args) {
  const amount = args[0];
  if (!amount || !(amount === 'all' || /^\d+(\.\d+)?$/.test(amount))) throw new Error('usage: floprouter withdraw <amount in FLOP | all>');
  const b = await ctx.api.get('/v1/balance');
  console.log(bold('\nWithdraw'));
  if (b.withdrawals && b.withdrawals.enabled === false) throw new Error('withdrawals are not enabled on this router');
  console.log(`  from     your router balance (available ${b.available ?? b.balance} FLOP)`);
  console.log(`  to       ${b.address} (the wallet that owns this key; the only destination allowed)`);
  console.log(`  amount   ${amount === 'all' ? 'all of the available balance' : `${amount} FLOP`}`);
  console.log(dim('  The chain fee is taken out of the amount sent.\n'));
  if (!(await confirm('Withdraw?', o))) return err('cancelled');
  let w;
  try { w = await ctx.api.post('/v1/balance/withdraw', { amount }); } catch (e) {
    if (isMissingRoute(e)) throw new Error('this router does not offer withdrawals yet');
    // The amount is held before the transfer: a lost answer does not mean a lost or a double withdrawal.
    if (!(e instanceof ApiError) || e.status === 0 || e.status >= 500) {
      throw new Error(`${describe(e)}\nThe withdrawal may still complete: check \`floprouter balance\` (withdrawals) before trying again.`);
    }
    throw e;
  }
  // Current API: 202 with status "submitted" and a poll URL (finality can take minutes); earlier: the final transfer.
  if (w.poll && !['sent', 'failed'].includes(w.status)) {
    err(dim(`submitted (tx ${w.tx ?? '-'}); waiting for it to be final...`));
    const t0 = Date.now();
    while (!['sent', 'failed'].includes(w.status) && Date.now() - t0 < 300_000) {
      await new Promise((r) => setTimeout(r, 5_000));
      try { w = { ...w, ...(await ctx.api.get(w.poll.replace(/^\/api\/v1\//, '/v1/'))) }; } catch { /* keep polling */ }
    }
  }
  if (o.json) return printJson(w);
  if (w.status === 'failed') throw new Error(`the withdrawal failed and nothing was sent: ${w.error ?? 'unknown reason'}`);
  if (w.status !== 'sent') {
    err(yellow(`${w.status}: ${w.requested} FLOP, tx ${w.tx ?? '-'}. Not final yet; the amount stays held until it is. Check with \`floprouter balance\`.`));
    return;
  }
  err(green(`sent ${w.sent} FLOP to ${w.to}${w.chain_fee ? ` (chain fee ${w.chain_fee})` : ''}${w.tx ? `, tx ${w.tx}` : ''}`));
  if (w.balance_after !== undefined) err(`balance now ${w.balance_after} FLOP`);
}

export function describe(e) {
  const chainMsg = explainChainError(e);
  if (chainMsg) return chainMsg;
  if (e instanceof ApiError) {
    if (e.status === 402 && e.code === 'fees_owed') {
      const m = e.metadata ?? {};
      return `Fees owed: ${m.amount ?? '?'} FLOP${m.max_owed ? ` (the limit is ${m.max_owed})` : ''}. Sign again with \`floprouter grant\` to renew the fee grant (one signature), or pay them with \`floprouter deposit <amount>\`.`;
    }
    if (e.status === 401) return `${e.message}\nRun \`floprouter login\` or set FLOPROUTER_API_KEY.`;
    if (e.status === 402 && /^grant_/.test(e.code)) return `${e.message}\nSign a new grant with \`floprouter grant\`, or retry with \`--fallback-payer credit\`.`;
    if (e.status === 503 && e.metadata?.retry_after) return `${e.code}: ${e.message} (retry after ${e.metadata.retry_after} s)`;
    if (e.status === 402) return `${e.message}\nSee \`floprouter balance\`; top up with \`floprouter deposit <amount>\` or sign a grant with \`floprouter grant\`.`;
    if (isMissingRoute(e)) return `${e.message} (this router does not offer that endpoint)`;
    return `${e.code}: ${e.message}`;
  }
  return e?.message ?? String(e);
}
