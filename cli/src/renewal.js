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
// - when the router also offers the deposit-free fee grant (params carry fee_call and calls), sign only
//   utility.batchAll[revokeSession(known delegate)*, createSession(compute delegate, ["ComputeChannel"])?,
//   createSession(fee delegate, ["Balances"])] with the caps the router states (checkGrantBatch), after building the
//   same batch locally and comparing its encoding with the router's call_data;
// - the router's grant parameters and renewal description are checked, never signed as they are;
// - in same-caps mode the new grant has exactly the current grant's caps: never larger caps, never other pallets.
//
// Observed on devnet (2026-11-24): the chain keeps `spent` and `epochSpent` for an owner and delegate across
// revokeSession + createSession. So a renewal with the same caps restores the time left but not the room left; the
// day's room comes back on its own at the next epoch. Hence: no renewal for today's room (it would repeat every run
// without effect), and for the total room `keepHeadroom` sets the new cap to spent + the previous cap (the CLI), or
// the renewal is refused and the owner is asked (same-caps mode, the MCP server).

export const ALLOWED_PALLETS = ['ComputeChannel'];
export const FEE_PALLETS = ['Balances'];

/** "2d", "12h", "90m", "3600s" or a number of seconds. */
export function parseDuration(s) {
  const m = /^(\d+(?:\.\d+)?)\s*([smhd]?)$/.exec(String(s ?? '').trim());
  if (!m) throw new Error(`not a duration: ${s} (use for example 2d, 12h, 90m)`);
  return Number(m[1]) * { '': 1, s: 1, m: 60, h: 3600, d: 86400 }[m[2]];
}

const pick = (...xs) => xs.find((x) => x !== undefined && x !== null && x !== '');
const num = (x) => (x === null || x === undefined || x === '' ? null : Number(x));

/**
 * The grant to this router's delegate in a /v1/grants view (prefers one waiting for finality, then the active one).
 * Without a delegate it is the compute grant (entries without `kind` are compute grants); kind 'fee' selects the fee grant.
 */
export function grantOf(g, delegate, kind = 'compute') {
  let list = Array.isArray(g?.data) ? g.data : Array.isArray(g) ? g : g ? [g] : [];
  if (delegate) list = list.filter((x) => !x.delegate || x.delegate === delegate);
  else list = list.filter((x) => (kind === 'fee' ? x.kind === 'fee' : x.kind !== 'fee'));
  return list.find((x) => x.state === 'waiting_for_finality') ?? list.find((x) => x.active) ?? list[0] ?? null;
}

/** Every delegate of this wallet that the router lists (compute and fee grants), for the revoke check of a batch. */
export function knownDelegates(g) {
  const list = Array.isArray(g?.data) ? g.data : Array.isArray(g) ? g : [];
  return list.map((x) => x.delegate).filter(Boolean);
}

/** True when the wallet has a fee grant that is, or was, in use (active, expired or in a block not final yet), not a revoked one. */
export function hasFeeGrant(g) {
  const list = Array.isArray(g?.data) ? g.data : Array.isArray(g) ? g : [];
  return list.some((x) => x.kind === 'fee' && ['active', 'expired', 'waiting_for_finality'].includes(x.state));
}

/** The grant from GET /v1/grants or POST /v1/grants/sync, as plain numbers. */
export function grantFacts(g, delegate, nowMs = Date.now(), kind = 'compute') {
  const x = grantOf(g, delegate, kind);
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
    blockTimeMs: pick(l.block_time_ms), maxRotations: pick(l.max_rotations_per_hour),
    renewal: p.renewal === true, renewalCall: p.renewal_call ?? null,
    // Deposit-free fee mode (absent on a router that takes its fee from the prepaid balance).
    feeCall: p.fee_call ?? null, feeDelegate: pick(p.fee_delegate), feeAddress: pick(p.fee_address),
    calls: Array.isArray(p.calls) ? p.calls : null, callData: pick(p.call_data), explorerUrl: pick(p.explorer_url),
    amountsDuration: pick(a.duration_blocks), raw: p,
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

// ---- the one-signature batch: compute grant + fee grant ------------------------------------------------------------

const SESSION_PALLET = 'flopSessionKeys';
const sameList = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const norm = (args) => (Array.isArray(args) ? args.map((x) => (Array.isArray(x) ? x : String(x))) : null);

/** Decimal FLOP string to raw units (pure; the chain has 18 decimals). */
export function decimalToRaw(flop, decimals = 18) {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(String(flop ?? '').trim());
  if (!m || (m[2]?.length ?? 0) > decimals) return null;
  return BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt((m[2] ?? '').padEnd(decimals, '0') || '0');
}

function readCreate(c, what) {
  const a = c?.args;
  if (!Array.isArray(a) || a.length !== 6) throw new Error(`the router's ${what} is not a createSession with six arguments; refusing to sign`);
  let cap; let tx; let day;
  try { cap = BigInt(a[1]); tx = BigInt(a[2]); day = BigInt(a[3]); } catch { throw new Error(`the router's ${what} has a cap that is not a whole number; refusing to sign`); }
  const duration = Number(a[4]);
  if (cap <= 0n || tx <= 0n || day <= 0n) throw new Error(`the router's ${what} has a cap that is not positive; refusing to sign`);
  if (tx > cap || day > cap) throw new Error(`the router's ${what} has a per-transaction or daily cap above its spending cap; refusing to sign`);
  if (!Number.isInteger(duration) || duration <= 0) throw new Error(`the router's ${what} has no valid duration; refusing to sign`);
  return { delegate: String(a[0]), cap: cap.toString(), tx: tx.toString(), day: day.toString(), duration, pallets: a[5] };
}

/**
 * The checks on a fee-mode GET /v1/grants/params (the one signature: compute grant + fee grant). `p` is readGrantParams'
 * output, `known` the delegates the router lists for this wallet (see knownDelegates). Accepts exactly
 * utility.batchAll of  revokeSession(known delegate)*,  [createSession(compute delegate, ["ComputeChannel"])],
 * createSession(fee delegate, ["Balances"])  where the caps are the ones the router states (`call`, `amounts`,
 * `fee_call`), and refuses anything else. A batch of only the fee grant (an existing compute grant stays) is accepted.
 * `valid` (optional Set from validAddresses) rejects addresses that are not valid SS58.
 * Returns the checked plan { revokes, compute | null, fee, shape } with raw caps as decimal strings.
 */
export function checkGrantBatch(p, known = [], { valid = null, decimals = 18 } = {}) {
  const refuse = (why) => { throw new Error(`${why}; refusing to sign`); };
  if (!p.feeCall) refuse('the router describes no fee grant');
  if (!p.delegate || !p.feeDelegate) refuse('the router named no compute delegate or no fee delegate');
  if (p.delegate === p.feeDelegate) refuse('the router named the same delegate for compute and fees');
  if (!p.feeAddress) refuse('the router named no fee address');
  if (!Array.isArray(p.calls) || p.calls.length === 0) refuse('the router sent no batch of calls');
  if (valid) for (const [what, a] of [['compute delegate', p.delegate], ['fee delegate', p.feeDelegate], ['fee address', p.feeAddress]]) if (!valid.has(a)) refuse(`the ${what} ${a} is not a valid address`);
  const revokeOk = new Set([...known, p.delegate, p.feeDelegate]);
  const calls = p.calls;
  const revokes = []; let i = 0;
  for (; i < calls.length && calls[i]?.method === 'revokeSession'; i++) {
    const c = calls[i]; const t = c.args?.[0];
    if (c.pallet !== SESSION_PALLET || c.args?.length !== 1 || typeof t !== 'string') refuse('the router sent a malformed revokeSession');
    if (!revokeOk.has(t)) refuse(`the batch revokes ${t}, which is neither the router's delegates nor a grant this wallet is known to have made (run \`floprouter grant --status\` to refresh, then try again)`);
    if (valid && !valid.has(t)) refuse(`the revoke target ${t} is not a valid address`);
    if (revokes.includes(t)) refuse(`the batch revokes ${t} twice`);
    revokes.push(t);
  }
  let compute = null; let fee = null;
  for (; i < calls.length; i++) {
    const c = calls[i];
    if (c?.pallet !== SESSION_PALLET || (c.method !== 'createSession' && c.method !== 'revokeSession')) refuse(`the batch contains ${c?.pallet}.${c?.method}; only flopSessionKeys.createSession and revokeSession are signed`);
    if (c.method === 'revokeSession') refuse('the batch has a revokeSession after a createSession');
    const target = c.args?.[0];
    if (target === p.delegate) {
      if (compute || fee) refuse('the batch has more than one compute grant, or it is out of order');
      if (!sameList(c.args?.[5], ALLOWED_PALLETS)) refuse(`the compute grant allows ${JSON.stringify(c.args?.[5])}; only ${JSON.stringify(ALLOWED_PALLETS)} is granted to the compute delegate`);
      compute = readCreate(c, 'compute grant');
    } else if (target === p.feeDelegate) {
      if (fee) refuse('the batch has more than one fee (Balances) grant');
      if (!sameList(c.args?.[5], FEE_PALLETS)) refuse(`the fee grant allows ${JSON.stringify(c.args?.[5])}; only ${JSON.stringify(FEE_PALLETS)} is granted to the fee delegate`);
      fee = readCreate(c, 'fee grant');
    } else refuse(`the batch creates a grant for ${target}, which is neither the compute delegate nor the fee delegate`);
  }
  if (!fee) refuse('the batch has no fee grant');
  if (calls[calls.length - 1]?.args?.[0] !== p.feeDelegate) refuse('the fee grant must be the last call of the batch');
  if (revokes.includes(p.delegate) && !compute) refuse('the batch revokes the compute grant without creating a new one');
  if (!sameList(norm(p.feeCall.args), norm(calls[calls.length - 1].args)) || p.feeCall.method !== 'createSession' || p.feeCall.pallet !== SESSION_PALLET) {
    refuse('the batch\'s fee grant differs from the router\'s fee_call');
  }
  if (compute) {
    const inBatch = calls.find((c) => c.method === 'createSession' && c.args?.[0] === p.delegate);
    if (!p.argRaw || p.callPallet !== SESSION_PALLET || p.callMethod !== 'createSession' || !sameList(norm(p.raw?.call?.args), norm(inBatch.args))) {
      refuse('the batch\'s compute grant differs from the router\'s call');
    }
    for (const [k, name] of [['spendingCap', 'cap'], ['perTxLimit', 'tx'], ['dailyCap', 'day']]) {
      if (p[k] === undefined || p[k] === null) continue;
      const want = decimalToRaw(p[k], decimals);
      if (want === null || want.toString() !== compute[name]) refuse(`the compute grant's caps do not match the router's stated amounts (${k} ${p[k]})`);
    }
  }
  const durations = [compute?.duration, fee.duration].filter((d) => d !== undefined);
  const want = p.amountsDuration !== undefined && p.amountsDuration !== null ? Number(p.amountsDuration) : null;
  const max = p.maxDurationBlocks !== undefined && p.maxDurationBlocks !== null ? Number(p.maxDurationBlocks) : null;
  for (const d of durations) {
    if (want !== null && d !== want) refuse(`a grant lasts ${d} blocks, but the router states ${want}`);
    if (max !== null && d > max) refuse(`a grant lasts ${d} blocks, above the maximum ${max}`);
  }
  return { revokes, compute, fee, shape: compute ? (revokes.length ? 'renewal' : 'new') : 'add_fee', delegate: p.delegate, feeDelegate: p.feeDelegate, feeAddress: p.feeAddress };
}

/** The set of valid addresses among those a fee-mode params response names (`isValid` is the wallet's async check). */
export async function validAddresses(p, isValid) {
  const all = new Set([p.delegate, p.feeDelegate, p.feeAddress, ...(p.calls ?? []).filter((c) => c?.method === 'revokeSession').map((c) => c.args?.[0])].filter((a) => typeof a === 'string'));
  const ok = new Set();
  for (const a of all) if (await isValid(a)) ok.add(a);
  return ok;
}

/**
 * Builds the batch locally from the checked plan (never from the router's call_data) and, when the router sent call_data,
 * requires its encoding to equal the local one: so what is signed is exactly what the router described and the checks cover.
 */
export function buildBatchTx(api, plan, callData) {
  const sk = api.tx.flopSessionKeys;
  const create = (c, pallets) => sk.createSession(c.delegate, BigInt(c.cap), BigInt(c.tx), BigInt(c.day), c.duration, pallets);
  const calls = [...plan.revokes.map((d) => sk.revokeSession(d)), ...(plan.compute ? [create(plan.compute, ALLOWED_PALLETS)] : []), create(plan.fee, FEE_PALLETS)];
  const tx = api.tx.utility.batchAll(calls);
  if (callData && String(tx.method.toHex()).toLowerCase() !== String(callData).toLowerCase()) {
    throw new Error('the router\'s call_data does not match the batch its parameters describe; refusing to sign');
  }
  return tx;
}

/** A plain-words line for a chain error the user can act on, or null. */
export function explainChainError(e, perHour = 3) {
  if (/SessionRotationLimited/.test(String(e?.message ?? e))) {
    return `The chain allows at most ${perHour} new grants per hour for one wallet, and this wallet has used them (a first sign-up creates 2). Nothing was changed. Try again in about an hour.`;
  }
  return null;
}

/** The error to throw after a failed signature: the plain-words one when the chain error is known, else the original. */
export function chainError(e, perHour) {
  const m = explainChainError(e, perHour);
  return m ? new Error(m) : e;
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
 *   feeGrant    use the router's one-signature batch (compute + fee grant) when it offers one (default). A wallet that has
 *               no fee grant gets it only when allowCreate is true: an unattended renewal that may not create grants
 *               (the MCP server) renews a compute-only wallet compute-only, as before. false: always compute-only.
 *
 * Fee mode signs the router's batch, so its compute caps are the router's: they must equal the wallet's current caps
 * (same-caps), and `caps` flags and the headroom rule do not apply (use `floprouter grant --no-fee-grant` for those).
 */
export async function renewIfDue({ client, wallet, key, rpc, opts = {}, allowCreate = true, sameCaps = true, keepHeadroom = false, caps = null, days = null, dryRun = false, feeGrant = true, log = () => {}, onSigned = () => {} }) {
  const pair = await wallet.loadSigner({ ...key, noPrompt: true });
  const g = await client.post('/v1/grants/sync', {}, { retry: true });
  if (g?.address && g.address !== pair.address) throw new Error(`this API key belongs to ${g.address} but the key loaded is ${pair.address}`);
  const p = readGrantParams(await client.get('/v1/grants/params'));
  checkGrantParams(p, pair.address, await wallet.isValidAddress(p.delegate ?? ''));
  if (p.renewalCall && !p.feeCall) checkRenewalCall(p.renewalCall, p.delegate);
  const before = grantFacts(g, p.delegate);
  const d = decideRenewal(before, opts);
  // The router's batch also carries the fee grant (a Balances authority). A wallet that has one is renewed with it, and a
  // wallet with no usable compute grant is set up with both (the sign-up). A wallet with only a compute grant (fees from a
  // deposit) stays compute-only here: adding the fee grant is for its owner to sign with `floprouter grant`.
  const batchMode = Boolean(p.feeCall) && feeGrant && (hasFeeGrant(g) || d.action === 'grant');
  const base = { address: pair.address, delegate: p.delegate };
  if (d.action === 'skip' || d.action === 'wait') return { ...base, action: d.action, reason: d.reason, ...(d.note ? { note: d.note } : {}), grant: before };
  if (d.action === 'grant' && !allowCreate) return { ...base, action: 'refused', reason: `${d.reason}: creating a grant needs the owner (floprouter grant); only existing grants are renewed here`, grant: before };
  if (sameCaps && caps) throw new Error('caps cannot be changed in a same-caps renewal');
  if (batchMode && caps) throw new Error('the router\'s fee-grant batch sets the caps; to choose your own caps use --no-fee-grant (compute-only grant, fees paid from a deposit)');
  let plan = null;
  if (batchMode) {
    // Pure checks of the router's batch, before any chain access.
    plan = checkGrantBatch(p, knownDelegates(g), { valid: await validAddresses(p, wallet.isValidAddress) });
    if (!plan.compute) return { ...base, action: 'refused', reason: 'the router offers only a fee grant (Balances) now: adding one is for the owner to sign (floprouter grant); it is not done unattended', grant: before };
  }

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
    if (plan) return await signBatch({ client, wallet, pair, api, p, plan, cg, d2, sameCaps, dryRun, log, onSigned, base, g, allowCreate });
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

/** Fee mode: sign the router's checked batch (compute + fee grant, or only the fee grant) with the wallet's own key. */
async function signBatch({ client, wallet, pair, api, p, plan, cg, d2, sameCaps, dryRun, log, onSigned, base, g, allowCreate }) {
  if (plan.compute) {
    if (d2.capRoom) {
      return { ...base, action: 'refused', grant: cg.facts, reason: `${d2.reason}: the chain keeps the amount spent across a renewal, so the router's batch (its own caps) would not restore it; restoring room needs a larger cap, which only the owner sets (floprouter grant --no-fee-grant --spending-cap ...)` };
    }
    if (cg.raw) {
      if (JSON.stringify(cg.raw.pallets) !== JSON.stringify(ALLOWED_PALLETS)) throw new Error(`the current grant covers ${JSON.stringify(cg.raw.pallets)}; only ${JSON.stringify(ALLOWED_PALLETS)} is renewed`);
      const c = plan.compute;
      if (sameCaps && (BigInt(c.cap) !== cg.raw.cap || BigInt(c.tx) !== cg.raw.tx || BigInt(c.day) !== cg.raw.day)) {
        return { ...base, action: 'refused', grant: cg.facts, reason: 'the router\'s renewal would change the compute caps of the current grant (a renewal here keeps the same caps, never larger); renew with `floprouter grant` to review and sign the new ones' };
      }
    }
  }
  // Same-caps renewals never raise the fee grant either: the new fee caps may not exceed those of the fee grant being
  // replaced. A first sign-up (nothing to replace) is only done where creating grants is allowed (the CLI).
  if (sameCaps) {
    const feeSet = new Set([p.feeDelegate, ...(Array.isArray(g?.data) ? g.data : []).filter((x) => x.kind === 'fee').map((x) => x.delegate)]);
    const old = plan.revokes.filter((d) => feeSet.has(d));
    if (!old.length && !allowCreate) return { ...base, action: 'refused', grant: cg.facts, reason: 'the batch replaces no fee grant of this wallet, so its fee caps cannot be compared with a current one; the owner signs a new fee grant with `floprouter grant`' };
    for (const d of old) {
      const rec = await api.query.flopSessionKeys.sessions(pair.address, d);
      if (rec.isNone) return { ...base, action: 'refused', grant: cg.facts, reason: `the fee grant to ${d} cannot be read on chain, so the new fee caps cannot be compared with it; the owner signs with \`floprouter grant\`` };
      const o = rec.unwrap(); const f = plan.fee;
      if (BigInt(f.cap) > BigInt(o.spendingCap.toString()) || BigInt(f.tx) > BigInt(o.perTxLimit.toString()) || BigInt(f.day) > BigInt(o.dailyCap.toString())) {
        return { ...base, action: 'refused', grant: cg.facts, reason: 'the router\'s new fee grant has higher caps than the fee grant it replaces (a renewal here never raises a cap); renew with `floprouter grant` to review and sign the new ones' };
      }
    }
  }
  const tx = buildBatchTx(api, plan, p.callData);
  const fl = (v) => (wallet.fromRaw ? wallet.fromRaw(api, v) : (Number(v) / 1e18).toString());
  const shown = {
    ...(plan.compute ? { spending_cap: fl(plan.compute.cap), per_tx_limit: fl(plan.compute.tx), daily_cap: fl(plan.compute.day), duration_blocks: plan.compute.duration } : {}),
    fee_grant: { delegate: plan.fee.delegate, fee_address: plan.feeAddress, spending_cap: fl(plan.fee.cap), per_tx_limit: fl(plan.fee.tx), daily_cap: fl(plan.fee.day), duration_blocks: plan.fee.duration },
    ...(plan.revokes.length ? { revokes: plan.revokes } : {}),
  };
  const action = plan.revokes.includes(p.delegate) ? 'renew' : 'grant';
  const what = `utility.batchAll[${[...plan.revokes.map(() => 'revokeSession'), ...(plan.compute ? ['createSession(ComputeChannel)'] : []), 'createSession(Balances)'].join(', ')}]`;
  log(`${action === 'renew' ? 'renewing' : 'granting'} (${d2.reason}): ${what}, fee grant to ${plan.fee.delegate} up to ${shown.fee_grant.spending_cap} FLOP in total, fees paid to ${plan.feeAddress}${plan.compute ? `, compute caps ${shown.spending_cap} total / ${shown.per_tx_limit} per session / ${shown.daily_cap} per day` : ''}`);
  if (dryRun) return { ...base, action, dry_run: true, reason: d2.reason, call: what, caps: shown, grant: cg.facts };
  let r;
  try { r = await wallet.signAndWait(api, tx, pair, (st) => log(`  ${st}`)); } catch (e) { throw chainError(e, p.maxRotations); }
  pair.lock?.();
  onSigned({ action, tx: r.tx, block: r.block, owner: pair.address, delegate: p.delegate, fee_delegate: plan.fee.delegate, call: what, caps: shown, reason: d2.reason });
  log(`${action === 'renew' ? 'renewed' : 'granted'}: finalized in block ${r.block} (tx ${r.tx})`);
  let after = null;
  for (let i = 0; i < 24; i++) {
    try {
      const g2 = await client.post('/v1/grants/sync', {}, { retry: true });
      after = grantFacts(g2, p.delegate);
      const feeNow = grantOf(g2, plan.fee.delegate);
      const computeOk = (after.state === 'active' && after.spent === 0 && (after.expiresInSec ?? 0) > (cg.facts.expiresInSec ?? 0));
      if (computeOk && feeNow?.state === 'active') break;
    } catch { /* keep trying */ }
    await new Promise((res) => setTimeout(res, 5000));
  }
  return { ...base, action, reason: d2.reason, tx: r.tx, block: r.block, call: what, caps: shown, grant_before: cg.facts, grant: after };
}
