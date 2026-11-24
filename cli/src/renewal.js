// Keeping a session-key grant alive: what the grant needs (pure decision logic) and the one renewal flow shared by
// `floprouter grant --auto-renew` and the MCP server's opt-in `renew_grant`. The source of truth is
// clients/cli/src/renewal.js; clients/mcp/src/renewal.js is a byte-for-byte copy (`npm run sync-shared` in mcp/,
// checked by both test suites), so the CLI and the MCP server decide and sign the same way.
//
// Safety rules every renewal follows:
// - the chain requires the owner's signature for every grant; the router cannot renew, the wallet's own key does;
// - renew only when due (missing, revoked or expired when creating is allowed; expiring within the window; total or
//   daily room nearly used up), and confirm that on chain before signing, so a job run every hour never renews twice;
// - sign only flopSessionKeys.createSession with allowed pallets ["ComputeChannel"], or exactly
//   utility.batchAll[revokeSession(delegate), createSession(delegate, ...)] when a grant is active;
// - the router's grant parameters and renewal description are checked, never signed as they are;
// - in same-caps mode the new grant has exactly the current grant's caps: never larger caps, never other pallets.
//
// Observed on devnet (2026-11-24): the chain keeps `spent` and `epochSpent` for an owner and delegate across
// revokeSession + createSession. So a renewal with the same caps restores the time left but not the room left; the
// day's room comes back on its own at the next epoch. Hence: no renewal for today's room (it would repeat every run
// without effect), and for the total room `keepHeadroom` sets the new cap to spent + the previous cap (the CLI), or
// the renewal is refused and the owner is asked (same-caps mode, the MCP server).

export const ALLOWED_PALLETS = ['ComputeChannel'];

/** "2d", "12h", "90m", "3600s" or a number of seconds. */
export function parseDuration(s) {
  const m = /^(\d+(?:\.\d+)?)\s*([smhd]?)$/.exec(String(s ?? '').trim());
  if (!m) throw new Error(`not a duration: ${s} (use for example 2d, 12h, 90m)`);
  return Number(m[1]) * { '': 1, s: 1, m: 60, h: 3600, d: 86400 }[m[2]];
}

const pick = (...xs) => xs.find((x) => x !== undefined && x !== null && x !== '');
const num = (x) => (x === null || x === undefined || x === '' ? null : Number(x));

/** The grant to this router's delegate in a /v1/grants view (prefers one waiting for finality, then the active one). */
export function grantOf(g, delegate) {
  let list = Array.isArray(g?.data) ? g.data : Array.isArray(g) ? g : g ? [g] : [];
  if (delegate) list = list.filter((x) => !x.delegate || x.delegate === delegate);
  return list.find((x) => x.state === 'waiting_for_finality') ?? list.find((x) => x.active) ?? list[0] ?? null;
}

/** The grant from GET /v1/grants or POST /v1/grants/sync, as plain numbers. */
export function grantFacts(g, delegate, nowMs = Date.now()) {
  const x = grantOf(g, delegate);
  if (!x) return { state: 'none' };
  const expiresMs = x.expires_at ? Date.parse(x.expires_at) : null;
  return {
    state: x.state ?? (x.active ? 'active' : 'none'), active: x.active === true, delegate: x.delegate ?? delegate ?? null,
    spendingCap: num(x.spending_cap), spent: num(x.spent), remaining: num(x.remaining), perTxLimit: num(x.per_tx_limit),
    dailyCap: num(x.daily_cap), dayRoom: num(x.epoch_room), expiresAt: x.expires_at ?? null,
    expiresInSec: expiresMs !== null ? Math.round((expiresMs - nowMs) / 1000) : null,
    sessionsLeft: x.sessions_left_estimate ?? null, pending: x.pending ?? null,
  };
}

function fmtSec(sec) {
  const a = Math.abs(sec);
  const t = a >= 86400 ? `${(a / 86400).toFixed(1)} days` : a >= 3600 ? `${(a / 3600).toFixed(1)} hours` : `${Math.round(a / 60)} minutes`;
  return sec < 0 ? `-${t}` : t;
}

/**
 * What a grant needs: 'grant' (none usable: create one), 'renew' (active or expired: revoke and create in one
 * transaction), 'wait' (a grant transaction is not final yet) or 'skip'. Renews within `renewBeforeSec` of expiry, or
 * when the total left is below `minRemaining` (default: the per-session limit). A low room for today is reported in
 * `note` but never renews: the chain keeps the day's spend across a renewal, and the room returns at the next epoch.
 */
export function decideRenewal(f, { renewBeforeSec = 172_800, minRemaining = null, minDaily = null } = {}) {
  if (f.state === 'waiting_for_finality') return { action: 'wait', reason: 'a grant transaction is in a block that is not final yet; nothing to do until it is' };
  if (f.state === 'none' || f.state === 'assigned') return { action: 'grant', reason: 'no grant to this router' };
  if (f.state === 'revoked') return { action: 'grant', reason: 'the grant was revoked' };
  if (f.state === 'expired' || (f.expiresInSec !== null && f.expiresInSec <= 0)) return { action: 'renew', reason: 'the grant has expired' };
  if (!f.active) return { action: 'grant', reason: `the grant is ${f.state}` };
  const perTx = f.perTxLimit ?? 0;
  const minTotal = minRemaining ?? perTx;
  const minDay = minDaily ?? perTx;
  if (f.expiresInSec !== null && f.expiresInSec < renewBeforeSec) {
    return { action: 'renew', reason: `the grant expires in ${fmtSec(f.expiresInSec)}, within the ${fmtSec(renewBeforeSec)} window` };
  }
  if (f.remaining !== null && f.remaining < minTotal) return { action: 'renew', capRoom: true, reason: `${f.remaining} FLOP left of the spending cap, below ${minTotal}` };
  const note = minDay > 0 && f.dayRoom !== null && f.dayRoom < minDay ? `only ${f.dayRoom} FLOP left today; it comes back at the next daily epoch (a renewal would not restore it)` : undefined;
  return { action: 'skip', reason: `active, ${f.remaining ?? '?'} of ${f.spendingCap ?? '?'} FLOP left, ${f.dayRoom ?? '?'} left today, expires in ${f.expiresInSec !== null ? fmtSec(f.expiresInSec) : '?'}`, ...(note ? { note } : {}) };
}

/** A short warning for a user-facing answer when the grant needs attention soon (under 2 days, or nearly used up). */
export function grantWarning(f, opts = {}) {
  if (!f || f.state === 'none') return null;
  const d = decideRenewal(f, { renewBeforeSec: 172_800, ...opts });
  if (d.action === 'wait') return null;
  if (d.action === 'skip') return d.note ? `${d.note}.` : null;
  return `${d.reason}. Renew it soon (\`floprouter grant\`, or \`floprouter grant --auto-renew\` from a job); without a usable grant, grant-mode requests fail.`;
}

/** Normalises GET /v1/grants/params. The router suggests; the extrinsic is built locally from checked values. */
export function readGrantParams(p) {
  const call = p.call ?? null;
  const args = Array.isArray(call?.args) ? call.args : null;
  const a = p.amounts ?? p.suggested ?? {};
  const l = p.limits ?? {};
  return {
    owner: p.owner ?? null,
    delegate: pick(p.delegate, args?.[0]),
    rpc: pick(p.rpc, Array.isArray(p.rpc_urls) ? p.rpc_urls[0] : undefined),
    genesis: pick(p.genesis_hash, p.genesis),
    callPallet: call ? String(call.pallet ?? '') : null,
    callMethod: call ? String(call.method ?? '') : null,
    argDelegate: args?.[0] ?? null,
    argRaw: args ? { cap: args[1], tx: args[2], day: args[3], duration: args[4] } : null,
    allowedPallets: pick(args?.[5], l.allowed_pallets),
    spendingCap: pick(a.spending_cap), perTxLimit: pick(a.per_tx_limit), dailyCap: pick(a.daily_cap),
    durationBlocks: pick(a.duration_blocks, args?.[4]), feeFloat: pick(a.fee_float, p.fee_float),
    maxDurationBlocks: pick(l.max_session_duration_blocks, l.max_duration_blocks),
    blockTimeMs: pick(l.block_time_ms),
    renewal: p.renewal === true, renewalCall: p.renewal_call ?? null, raw: p,
  };
}

/** Checks on the router's grant parameters that hold for every grant signed here. */
export function checkGrantParams(p, ownerAddress, delegateValid) {
  if (!p.delegate || !delegateValid) throw new Error(`router named no valid delegate address (${p.delegate})`);
  if (p.owner && p.owner !== ownerAddress) throw new Error(`these grant parameters are for ${p.owner}, but the key you loaded is ${ownerAddress}`);
  if (p.callPallet && (p.callPallet !== 'flopSessionKeys' || p.callMethod !== 'createSession')) {
    throw new Error(`router asks for ${p.callPallet}.${p.callMethod}; only flopSessionKeys.createSession is signed`);
  }
  if (p.argDelegate && p.argDelegate !== p.delegate) throw new Error('router named two different delegates; refusing to sign');
  if (p.allowedPallets && JSON.stringify(p.allowedPallets) !== JSON.stringify(ALLOWED_PALLETS)) {
    throw new Error(`router suggests allowed pallets ${JSON.stringify(p.allowedPallets)}; only ${JSON.stringify(ALLOWED_PALLETS)} is granted`);
  }
}

/** The router's renewal description, if any, must be exactly revokeSession(delegate) + createSession(delegate, ...). */
export function checkRenewalCall(rc, delegate) {
  const calls = rc?.calls ?? [];
  const ok = rc?.pallet === 'utility' && rc?.method === 'batchAll' && calls.length === 2
    && calls[0]?.pallet === 'flopSessionKeys' && calls[0]?.method === 'revokeSession' && calls[0]?.args?.[0] === delegate
    && calls[1]?.pallet === 'flopSessionKeys' && calls[1]?.method === 'createSession' && calls[1]?.args?.[0] === delegate
    && JSON.stringify(calls[1]?.args?.[5]) === JSON.stringify(ALLOWED_PALLETS);
  if (!ok) throw new Error('the router describes a renewal other than revokeSession + createSession for its delegate; refusing to sign');
}

/** The grant as the chain records it (raw caps included), to confirm a decision and to copy the caps exactly. */
export async function chainGrant(api, owner, delegate) {
  const rec = await api.query.flopSessionKeys.sessions(owner, delegate);
  if (rec.isNone) return { facts: { state: 'none' }, raw: null };
  const s = rec.unwrap();
  const head = (await api.rpc.chain.getHeader()).number.toNumber();
  const blockMs = Number(api.consts.babe?.expectedBlockTime?.toString() ?? api.consts.aura?.slotDuration?.toString() ?? 1000) || 1000;
  const epochLen = Number(api.consts.flopSessionKeys?.sessionEpochLength?.toString() ?? 86400);
  const dec = 10 ** (api.registry.chainDecimals[0] ?? 18);
  const f = (v) => Number(BigInt(v.toString())) / dec;
  const epochOver = head >= s.epochStart.toNumber() + epochLen;
  const active = s.active.isTrue; const expiresIn = s.expiresAt.toNumber() - head;
  const pallets = s.allowedPallets.map((b) => Buffer.from(b.toU8a(true)).toString('utf8'));
  return {
    facts: {
      state: !active ? 'revoked' : expiresIn <= 0 ? 'expired' : 'active', active,
      spendingCap: f(s.spendingCap), spent: f(s.spent), remaining: f(s.spendingCap) - f(s.spent), perTxLimit: f(s.perTxLimit),
      dailyCap: f(s.dailyCap), dayRoom: f(s.dailyCap) - (epochOver ? 0 : f(s.epochSpent)), expiresInSec: Math.round((expiresIn * blockMs) / 1000),
    },
    raw: { cap: BigInt(s.spendingCap.toString()), tx: BigInt(s.perTxLimit.toString()), day: BigInt(s.dailyCap.toString()), spent: BigInt(s.spent.toString()), pallets, active },
  };
}

/**
 * Builds the renewal or new grant. `caps` are raw units ({cap, tx, day}). With `current` (the chain's raw record) and
 * `sameCaps`, the caps must equal the current grant's exactly and the current grant must cover only ComputeChannel.
 */
export function buildGrantTx(api, { delegate, caps, durationBlocks, current, sameCaps }) {
  if (sameCaps) {
    if (!current) throw new Error('same-caps renewal needs a current grant to copy; refusing to create a new one');
    if (JSON.stringify(current.pallets) !== JSON.stringify(ALLOWED_PALLETS)) throw new Error(`the current grant covers ${JSON.stringify(current.pallets)}; only ${JSON.stringify(ALLOWED_PALLETS)} is renewed`);
    if (caps.cap !== current.cap || caps.tx !== current.tx || caps.day !== current.day) {
      throw new Error('the requested caps differ from the current grant; a renewal here keeps the same caps (never larger)');
    }
  }
  if (caps.cap <= 0n || caps.tx <= 0n || caps.day <= 0n) throw new Error('caps must be positive');
  if (caps.tx > caps.cap || caps.day > caps.cap) throw new Error('per-transaction and daily caps cannot exceed the spending cap');
  const create = api.tx.flopSessionKeys.createSession(delegate, caps.cap, caps.tx, caps.day, durationBlocks, ALLOWED_PALLETS);
  const renew = current?.active === true;
  return { tx: renew ? api.tx.utility.batchAll([api.tx.flopSessionKeys.revokeSession(delegate), create]) : create, renew };
}

/**
 * The shared flow: read the grant from the router, decide, confirm on chain, then sign exactly one transaction with
 * the wallet's own key. Returns {action, reason, ...}; action 'skip' and 'wait' mean nothing was signed.
 *
 *   client      floprouter API client (get/post) with the wallet's API key
 *   wallet      { loadSigner, connect, signAndWait, toRaw, isValidAddress }
 *   key         { keyFile, seedFile, passwordFile, type }: files only, never a key or seed value
 *   allowCreate create a grant when none is usable (CLI); false: only renew an existing active or expired grant (MCP)
 *   sameCaps    the new grant keeps the current caps exactly (MCP always; CLI unless caps are given)
 *   caps        optional FLOP strings {spendingCap, perTxLimit, dailyCap} (CLI flags); refused in same-caps mode
 *   onSigned    called with {action, tx, block, owner, delegate, caps} after each signature (for the audit log)
 */
export async function renewIfDue({ client, wallet, key, rpc, opts = {}, allowCreate = true, sameCaps = true, keepHeadroom = false, caps = null, days = null, dryRun = false, log = () => {}, onSigned = () => {} }) {
  const pair = await wallet.loadSigner({ ...key, noPrompt: true });
  const g = await client.post('/v1/grants/sync', {}, { retry: true });
  if (g?.address && g.address !== pair.address) throw new Error(`this API key belongs to ${g.address} but the key loaded is ${pair.address}`);
  const p = readGrantParams(await client.get('/v1/grants/params'));
  checkGrantParams(p, pair.address, await wallet.isValidAddress(p.delegate ?? ''));
  if (p.renewalCall) checkRenewalCall(p.renewalCall, p.delegate);
  const before = grantFacts(g, p.delegate);
  const d = decideRenewal(before, opts);
  const base = { address: pair.address, delegate: p.delegate };
  if (d.action === 'skip' || d.action === 'wait') return { ...base, action: d.action, reason: d.reason, ...(d.note ? { note: d.note } : {}), grant: before };
  if (d.action === 'grant' && !allowCreate) return { ...base, action: 'refused', reason: `${d.reason}: creating a grant needs the owner (floprouter grant); only existing grants are renewed here`, grant: before };
  if (sameCaps && caps) throw new Error('caps cannot be changed in a same-caps renewal');

  const h = await client.get('/health', { auth: false });
  const url = rpc || p.rpc || (Array.isArray(h.rpc) ? h.rpc[0] : h.rpc);
  if (!url) throw new Error('no chain RPC known: the router names none; pass --rpc');
  if (p.genesis && h.genesis_hash && p.genesis !== h.genesis_hash) throw new Error('router reports two different genesis hashes; refusing to sign');
  log(`chain ${h.network ?? ''} via ${url}`);
  const api = await wallet.connect(url, h.genesis_hash ?? p.genesis);
  try {
    // The router reads its finalized block; the chain may already hold a fresh grant (for example from the previous
    // run). Confirm on chain, so an hourly job never renews twice for the same reason.
    const cg = await chainGrant(api, pair.address, p.delegate);
    const d2 = decideRenewal(cg.facts, opts);
    if (d2.action === 'skip') return { ...base, action: 'skip', reason: `chain: ${d2.reason}`, router_reason: d.reason, grant: cg.facts };
    if (d2.action === 'grant' && !allowCreate) return { ...base, action: 'refused', reason: `${d2.reason} (on chain): creating a grant needs the owner`, grant: cg.facts };
    // Room, not time: the chain keeps `spent` across a renewal, so only a larger cap restores room.
    let headroomCap = null;
    if (d2.capRoom && !caps) {
      if (!keepHeadroom) return { ...base, action: 'refused', reason: `${d2.reason}: the chain keeps the amount spent across a renewal, so the same caps would not restore it; restoring room needs a larger cap, which only the owner sets (floprouter grant --spending-cap ...)`, grant: cg.facts };
      headroomCap = cg.raw.cap + cg.raw.spent;
    }
    const blocksPerHour = Number(api.consts.flopSessionKeys?.blocksPerHour?.toString() ?? 3600);
    const chainMax = Number(api.consts.flopSessionKeys?.maxSessionDuration?.toString() ?? 864000);
    const maxDur = Math.min(chainMax, Number(p.maxDurationBlocks ?? chainMax));
    const durationBlocks = days ? Math.round(Number(days) * 24 * blocksPerHour) : Number(pick(p.durationBlocks, maxDur));
    if (!(durationBlocks > 0) || durationBlocks > maxDur) throw new Error(`duration ${durationBlocks} blocks is outside 1..${maxDur}`);
    let raw;
    if (caps) raw = { cap: await wallet.toRaw(api, caps.spendingCap), tx: await wallet.toRaw(api, caps.perTxLimit), day: await wallet.toRaw(api, caps.dailyCap) };
    else if (cg.raw) raw = { cap: headroomCap ?? cg.raw.cap, tx: cg.raw.tx, day: cg.raw.day };
    else raw = { cap: await wallet.toRaw(api, String(p.spendingCap ?? '5')), tx: await wallet.toRaw(api, String(p.perTxLimit ?? '0.5')), day: await wallet.toRaw(api, String(p.dailyCap ?? '2')) };
    const { tx, renew } = buildGrantTx(api, { delegate: p.delegate, caps: raw, durationBlocks, current: cg.raw, sameCaps: sameCaps && !!cg.raw && headroomCap === null });
    if (headroomCap !== null) log(`keeping the headroom: new spending cap = ${Number(cg.raw.cap) / 1e18} (previous cap) + ${Number(cg.raw.spent) / 1e18} (spent, which the chain carries over)`);
    const dec = 10n ** BigInt(api.registry.chainDecimals[0] ?? 18);
    const fl = (v) => (Number(v) / Number(dec)).toString();
    const shown = { spending_cap: fl(raw.cap), per_tx_limit: fl(raw.tx), daily_cap: fl(raw.day), duration_blocks: durationBlocks };
    const what = renew ? 'utility.batchAll[revokeSession, createSession]' : 'flopSessionKeys.createSession';
    log(`${renew ? 'renewing' : 'granting'} (${d2.reason}): ${what} to ${p.delegate}, caps ${shown.spending_cap} total / ${shown.per_tx_limit} per session / ${shown.daily_cap} per day, ${durationBlocks} blocks`);
    if (dryRun) return { ...base, action: renew ? 'renew' : 'grant', dry_run: true, reason: d2.reason, call: what, caps: shown, grant: cg.facts };
    const r = await wallet.signAndWait(api, tx, pair, (st) => log(`  ${st}`));
    pair.lock?.();
    onSigned({ action: renew ? 'renew' : 'grant', tx: r.tx, block: r.block, owner: pair.address, delegate: p.delegate, call: what, caps: shown, reason: d2.reason });
    log(`${renew ? 'renewed' : 'granted'}: finalized in block ${r.block} (tx ${r.tx})`);
    // The router reads grants at its finalized block: wait until it sees the new one (bounded).
    let after = null;
    for (let i = 0; i < 24; i++) {
      try {
        after = grantFacts(await client.post('/v1/grants/sync', {}, { retry: true }), p.delegate);
        if (after.state === 'active' && after.spent === 0 && (after.expiresInSec ?? 0) > (cg.facts.expiresInSec ?? 0)) break;
      } catch { /* keep trying */ }
      await new Promise((res) => setTimeout(res, 5000));
    }
    return { ...base, action: renew ? 'renew' : 'grant', reason: d2.reason, tx: r.tx, block: r.block, call: what, caps: shown, grant_before: cg.facts, grant: after };
  } finally { await api.disconnect(); }
}
