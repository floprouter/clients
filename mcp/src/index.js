#!/usr/bin/env node
// floprouter MCP server. Gives an AI agent the floprouter API as tools: models, miners, paid chat
// completions on FLOP Network, session status, balance and grant state.
//
//   stdio (default):        npx -y floprouter-mcp
//   streamable HTTP:        npx -y floprouter-mcp --http [--port 8792] [--host 127.0.0.1]
//
// Configuration (environment):
//   FLOPROUTER_API_KEY      router API key (fr_...). Needed for chat, balance, grants and your sessions.
//   FLOPROUTER_BASE_URL     default https://api.floprouter.com
//   FLOPROUTER_TIMEOUT_MS   per-request timeout, default 300000
//
// This server never handles wallet keys. Creating a key, signing a grant and depositing are done with the
// floprouter CLI on your own machine.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { ApiError, DEFAULT_BASE_URL, costOf, isMissingRoute, makeClient, modelFacts } from './api.js';
import { decideRenewal, explainChainError, grantFacts, grantWarning, parseDuration, renewIfDue } from './renewal.js';

const VERSION = '0.2.0';
const env = process.env;
// Fallback: the file written by `floprouter login` (the CLI), so one login serves both.
function cliConfig() {
  const file = env.FLOPROUTER_CONFIG || path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'floprouter', 'config.json');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}
const saved = cliConfig();
const BASE_URL = env.FLOPROUTER_BASE_URL || saved.base_url || DEFAULT_BASE_URL;
const API_KEY = env.FLOPROUTER_API_KEY || saved.api_key;
const SETTLE_WAIT_MS = Number(env.FLOPROUTER_SETTLE_WAIT_MS || 300_000);
// MCP clients commonly time a tool call out at 60 s; chat answers within this budget, with an id if still running.
const TOOL_BUDGET_MS = Number(env.FLOPROUTER_TOOL_BUDGET_MS || 50_000);
// A client that asks for progress (a progressToken) gets a notification every 10 s and a longer budget: clients that
// reset their timeout on progress can then wait for a slow reply instead of getting `pending`.
const PROGRESS_BUDGET_MS = Number(env.FLOPROUTER_PROGRESS_BUDGET_MS || 240_000);
const FINAL = new Set(['settled', 'refunded', 'failed', 'fraud', 'voided']);
// Opt-in signing. By default this server never touches a wallet key. Only when the configuration names a key file
// (or seed file) AND sets FLOPROUTER_ALLOW_GRANT_RENEWAL=1 does it offer `renew_grant`, which signs one transaction
// with that wallet: the same revoke-plus-create renewal as `floprouter grant --auto-renew`, with the same caps.
const SIGNING = {
  keyFile: env.FLOPROUTER_KEY_FILE || undefined, seedFile: env.FLOPROUTER_KEY_FILE ? undefined : env.FLOPROUTER_SEED_FILE || undefined,
  passwordFile: env.FLOPROUTER_PASSWORD_FILE || undefined,
};
const SIGNING_ENABLED = env.FLOPROUTER_ALLOW_GRANT_RENEWAL === '1' && Boolean(SIGNING.keyFile || SIGNING.seedFile);
const AUTO_RENEW = SIGNING_ENABLED && env.FLOPROUTER_AUTO_RENEW === '1';
const RENEW_BEFORE = parseDuration(env.FLOPROUTER_RENEW_BEFORE || '2d');
const SIGN_LOG = env.FLOPROUTER_SIGN_LOG || path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'floprouter', 'mcp-signatures.log');
const TIMEOUT_MS = Number(env.FLOPROUTER_TIMEOUT_MS || 300_000);

const json = (v) => JSON.stringify(v);
const ok = (v) => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : json(v) }] });
const fail = (e) => {
  // e.code is the API's reason (metadata.reason in the current error format, the string code in the earlier one).
  const meta = e instanceof ApiError ? Object.entries(e.metadata ?? {}).filter(([k]) => k !== 'reason').map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' ') : '';
  const msg = e instanceof ApiError
    ? `floprouter API error ${e.status} ${e.code}: ${e.message}${meta ? ` (${meta})` : ''}`
    : `error: ${explainChainError(e) ?? e?.message ?? e}`;
  return { isError: true, content: [{ type: 'text', text: msg }] };
};
const tool = (fn) => async (args, extra) => { try { return await fn(args ?? {}, extra); } catch (e) { return fail(e); } };

/** Calls an endpoint that a router may not have yet; a 404 for the route itself becomes a plain note. */
async function optional(call) {
  try { return await call(); } catch (e) {
    if (isMissingRoute(e)) return { unavailable: 'this router does not offer this endpoint yet' };
    if (e instanceof ApiError && e.status === 401) return { unavailable: 'needs an API key (set FLOPROUTER_API_KEY; create one with `npx floprouter login`)' };
    throw e;
  }
}

function minerRow(m) {
  const rm = m.router_measured ?? {};
  return {
    address: m.address, rank: m.rank ?? null, score: m.score ?? null,
    settle_rate: m.history?.settle_rate ?? null, settled: m.history?.settled ?? null, resolved: m.history?.sessions_resolved ?? null,
    strikes: m.slashing?.strikes ?? null, calibrated: m.calibration?.live ?? null,
    stake: m.stake?.total ?? null,
    models: (m.models ?? []).map((x) => x.id ?? x.name ?? x),
    availability: m.availability ?? null, health: m.health ?? null, last_checked_at: m.last_checked_at ?? null,
    reachable: rm.reachable ?? null, ready: rm.ready ?? null, first_output_ms: rm.first_output_ms ?? null,
  };
}

function flopSummary(f) {
  if (!f) return null;
  return {
    session_id: f.session_id, status: f.status, miner: f.miner, channel_id: f.channel_id ?? null,
    payer: f.payer?.address ?? f.payer ?? null, payer_kind: f.payer?.kind ?? null, payer_mode: f.payer?.mode ?? null,
    payer_fallback_from: f.payer?.fallback_from ?? null,
    escrow: f.escrow ?? null, miner_paid: f.miner_paid ?? null,
    router_fee: f.router_fee?.amount ?? f.router_fee ?? null, router_fee_status: f.router_fee?.status ?? null, network: f.network ?? null,
    ignored_parameters: f.ignored_parameters ?? null,
    links: f.links ?? null,
  };
}

/** Each signature is logged: one JSON line (time, action, tx, block, owner, delegate, caps), mode 600, and to stderr. */
function logSignature(e) {
  const line = JSON.stringify({ at: new Date().toISOString(), ...e });
  process.stderr.write(`floprouter-mcp: signed ${e.call} (${e.action}) tx ${e.tx}\n`);
  try { fs.mkdirSync(path.dirname(SIGN_LOG), { recursive: true, mode: 0o700 }); fs.appendFileSync(SIGN_LOG, line + '\n', { mode: 0o600 }); } catch { /* stderr has it */ }
}

export function buildServer({ apiKey } = {}) {
  const api = makeClient({ baseUrl: BASE_URL, apiKey, timeoutMs: TIMEOUT_MS, userAgent: `floprouter-mcp/${VERSION}` });

  /** The grant to the router's delegate and what it needs, from the router; null without a key or a grant route. */
  async function grantState() {
    if (!api.hasKey) return null;
    let g; try { g = await api.get('/v1/grants'); } catch { return null; }
    const f = grantFacts(g);
    const d = decideRenewal(f, { renewBeforeSec: RENEW_BEFORE });
    const fee = g?.fees || (Array.isArray(g?.data) && g.data.some((x) => x.kind === 'fee')) ? grantFacts(g, undefined, Date.now(), 'fee') : null;
    return { facts: f, decision: d, warning: grantWarning(f, { renewBeforeSec: RENEW_BEFORE }), fees: g?.fees ?? null, feeGrant: fee };
  }
  const runRenew = async (dryRun) => {
    let wallet;
    try { wallet = await import('./wallet.js'); await import('@polkadot/api'); } catch {
      throw new Error('signing needs the polkadot packages: run the server as `npx -y -p floprouter -p floprouter-mcp floprouter-mcp` (see the README, "Opt-in grant renewal")');
    }
    return renewIfDue({ client: api, wallet, key: SIGNING, opts: { renewBeforeSec: RENEW_BEFORE }, allowCreate: false, sameCaps: true, dryRun,
      log: (m) => process.stderr.write(`floprouter-mcp: ${m}\n`), onSigned: logSignature });
  };

  const server = new McpServer({ name: 'floprouter', version: VERSION }, {
    instructions: 'The floprouter API routes chat completions to GPU miners on FLOP Network and pays them in FLOP. ' +
      'Use list_models to see which models are available now (available=true means at least one ready miner). ' +
      'chat sends one paid request; it returns the reply and a session_id. Settlement on chain finishes a few minutes later: check it with session_status. ' +
      'Each chat call spends FLOP from the user (or the router, depending on the payer mode); do not loop on it without reason.',
  });

  server.registerTool('list_models', {
    title: 'List models',
    description: 'Models in the FLOP on-chain registry: how many miners can serve each right now, the escrow per 1,000 tokens of prompt + max_tokens (FLOP), the minimum charge per request and the largest request served.',
    inputSchema: { only_available: z.boolean().optional().describe('Only models with at least one ready miner') },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, tool(async ({ only_available }) => {
    const r = await api.get('/v1/models', { auth: false });
    let data = (r.data ?? []).map((m) => {
      const f = modelFacts(m);
      return {
        id: f.id, name: f.name, available: f.available, miners_ready: f.ready, miners_reachable: f.reachable, params_billion: f.paramsBillion,
        escrow_per_1000_tokens: f.escrowPer1k, min_charge_per_request: f.minCharge, router_fee_percent: f.routerFeePercent,
        max_request_tokens: f.contextLength, supported_parameters: f.supportedParameters,
      };
    });
    if (only_available) data = data.filter((m) => m.available);
    return ok({ models: data, count: data.length });
  }));

  server.registerTool('list_miners', {
    title: 'List miners',
    description: 'Registered FLOP miners with the router\'s reliability score (0-100), rank and the public on-chain facts behind it (settle rate, sessions, strikes, calibration), plus whether the router can reach them now.',
    inputSchema: {
      reachable: z.boolean().optional().describe('Only miners whose session URL the router has verified and can reach'),
      ready: z.boolean().optional().describe('Only miners that are ready to serve right now'),
      model: z.string().optional().describe('Model id, for example qwen/qwen3-8b'),
      min_score: z.number().optional(),
      sort: z.enum(['score', 'settle_rate', 'sessions', 'stake', 'latency', 'capacity']).optional(),
      limit: z.number().int().min(1).max(200).optional().describe('Default 20'),
      offset: z.number().int().min(0).optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, tool(async (a) => {
    const r = await api.get('/v1/miners', { auth: false, query: {
      reachable: a.reachable, ready: a.ready, model: a.model, min_score: a.min_score, sort: a.sort,
      limit: a.limit ?? 20, offset: a.offset, view: a.reachable ? 'full' : undefined,
    } });
    return ok({ total: r.total ?? null, finalized_block: r.finalized_block ?? null, miners: (r.data ?? []).map(minerRow), note: r.score_note ?? undefined });
  }));

  server.registerTool('get_miner', {
    title: 'Inspect a miner',
    description: 'One miner in detail: score, on-chain history, stake, calibration, slashing, models with evidence, endpoints and recent channels.',
    inputSchema: { address: z.string().min(47).max(48).describe('Miner SS58 address') },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, tool(async ({ address }) => {
    const m = await api.get(`/v1/miners/${encodeURIComponent(address)}`, { auth: false });
    // Endpoint URLs are not public: never pass one on, even from a router that still sends them.
    for (const e of m.endpoints ?? []) delete e.url;
    if (m.endpoint) delete m.endpoint.url;
    return ok(m);
  }));

  server.registerTool('chat', {
    title: 'Chat completion (paid)',
    description: 'Send one chat completion to a FLOP miner through floprouter and get the reply. Spends FLOP. ' +
      'Leave `miner` empty to let the router pick the most reliable ready miner, or pin one or more miner addresses. ' +
      'Returns the reply text plus the session id, miner, escrow and payer. Tools/function calling are not supported by the network.',
    inputSchema: {
      model: z.string().describe('Model id from list_models, for example qwen/qwen3-8b'),
      fallback_models: z.array(z.string()).optional().describe('Models to try next, in order, if no miner serves `model` (the API\'s `models` list)'),
      prompt: z.string().optional().describe('A single user message (use this or messages)'),
      messages: z.array(z.object({ role: z.enum(['system', 'developer', 'user', 'assistant']), content: z.string() })).optional()
        .describe('Full conversation in OpenAI format (use this or prompt)'),
      system: z.string().optional().describe('System prompt, used with prompt'),
      miner: z.union([z.string(), z.array(z.string())]).optional().describe('Pin to this miner address (or try these in order)'),
      allow_fallbacks: z.boolean().optional().describe('When pinned, allow other miners if the pinned ones fail. Default false when pinned'),
      max_tokens: z.number().int().min(1).max(32768).optional().describe('Default set by the router (256). The escrow, and so the cost, follows max_tokens'),
      payer: z.enum(['grant', 'credit']).optional().describe('Override the key\'s payer mode for this request'),
      fallback_payer: z.literal('credit').optional().describe('In grant mode, run in credit mode when no miner has a live signed offer'),
      wait_for_settlement: z.boolean().optional().describe('After the reply, poll until the on-chain settlement is final (2-5 minutes; only for clients without a tool timeout). Default false: return as soon as the reply is verified and check later with session_status'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, tool(async (a, extra) => {
    const messages = a.messages?.length ? a.messages
      : a.prompt ? [...(a.system ? [{ role: 'system', content: a.system }] : []), { role: 'user', content: a.prompt }] : null;
    if (!messages) throw new Error('give `prompt` or `messages`');
    let renewed = null; let renewError = null;
    if (AUTO_RENEW) {
      // A renewal that cannot be done (the router's batch is refused, the chain is slow) must not fail the chat: the grant still works until it expires.
      try {
        const gs = await grantState();
        if (gs && (gs.decision.action === 'renew')) renewed = await runRenew(false);
      } catch (e) { renewError = explainChainError(e) ?? e?.message ?? String(e); }
    }
    const pinned = a.miner ? (Array.isArray(a.miner) ? a.miner : [a.miner]) : null;
    const body = {
      model: a.model, messages, max_tokens: a.max_tokens,
      ...(a.fallback_models?.length ? { models: a.fallback_models } : {}),
      ...(pinned ? { provider: a.allow_fallbacks ? { order: pinned } : { only: pinned } } : {}),
      // The server is never asked to hold the response until settlement (a silent response is cut by proxies).
      flop: { wait_for_settlement: false, ...(a.payer ? { payer: a.payer } : {}), ...(a.fallback_payer ? { fallback_payer: a.fallback_payer } : {}) },
    };
    // Streamed internally: the generation id arrives with the response headers (or the first chunk), so when the
    // reply takes longer than the tool budget (MCP clients commonly give up after 60 s) the agent still gets an id to
    // check later. Closing the stream does not cancel the session: it completes and settles on the router.
    const progressToken = extra?._meta?.progressToken;
    const budget = progressToken !== undefined ? PROGRESS_BUDGET_MS : TOOL_BUDGET_MS;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(new Error('tool budget')), budget);
    const t0 = Date.now();
    const beat = progressToken === undefined ? null : setInterval(() => {
      const secs = Math.round((Date.now() - t0) / 1000);
      void extra.sendNotification({ method: 'notifications/progress', params: { progressToken, progress: secs, total: Math.round(budget / 1000),
        message: id ? `waiting for the miner's verified reply (${id}, ${secs} s)` : `waiting for a miner (${secs} s)` } }).catch(() => undefined);
    }, 10_000);
    let id = null; let headers = null; let content = ''; let finish = null; let usage = null; let flop = null; let model = null;
    try {
      await api.stream('/v1/chat/completions', { ...body, stream: true }, {
        signal: ctl.signal,
        onHeaders: (h) => { headers = h; id = h.get('x-generation-id') ?? id; },
        onEvent: (ev) => {
          id = ev.id ?? id; model = ev.model ?? model;
          for (const c of ev.choices ?? []) { content += c.delta?.content ?? ''; finish = c.finish_reason ?? finish; }
          if (ev.usage) usage = ev.usage;
          if (ev.flop) flop = ev.flop;
        },
      });
    } catch (e) {
      if (!ctl.signal.aborted) throw e;
      return ok({
        pending: true, generation_id: id,
        message: id ? `no verified reply within ${Math.round(budget / 1000)} s; the request continues on the router. Call generation (or session_status) with this id in a minute.`
          : `no reply within ${Math.round(budget / 1000)} s and no id yet; the request may still complete. Check your recent sessions later.`,
      });
    } finally { clearTimeout(timer); if (beat) clearInterval(beat); }
    if (a.wait_for_settlement && flop?.session_id) {
      const t0 = Date.now();
      for (;;) {
        const s2 = await api.get(`/v1/sessions/${encodeURIComponent(flop.session_id)}`);
        flop = s2;
        if (FINAL.has(s2.status) || Date.now() - t0 > SETTLE_WAIT_MS) break;
        await new Promise((res) => setTimeout(res, 10_000));
      }
    }
    const ignored = (headers?.get('x-floprouter-ignored-parameters') ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    const gs = await grantState();
    return ok({
      ...(gs?.warning ? { grant_warning: gs.warning } : {}),
      ...(renewed ? { grant_renewed: { action: renewed.action, reason: renewed.reason, tx: renewed.tx ?? null } } : {}),
      ...(renewError ? { grant_renewal_error: renewError } : {}),
      reply: content, finish_reason: finish, model,
      generation_id: id ?? flop?.session_id ?? null,
      cost_flop: costOf({ usage }), cost_final: usage?.cost_details?.final ?? null,
      ignored_parameters: ignored.length ? ignored : flop?.ignored_parameters ?? [],
      usage: usage ? { prompt_tokens: usage.prompt_tokens, completion_tokens: usage.completion_tokens, total_tokens: usage.total_tokens } : null,
      flop: flopSummary(flop),
    });
  }));

  server.registerTool('session_status', {
    title: 'Session status',
    description: 'Settlement state of a chat session: status (settling, settled, refunded, failed...), channel id, miner, escrow, amount paid to the miner, attempts and explorer links.',
    inputSchema: { session_id: z.string().min(6).max(64) },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, tool(async ({ session_id }) => ok(await api.get(`/v1/sessions/${encodeURIComponent(session_id)}`))));

  server.registerTool('generation', {
    title: 'Generation stats',
    description: 'One request by its id (gen-...): tokens, cost in FLOP (final once settled), finish reason, latency, the verified reply, and the session. Needs the key of the wallet that made it.',
    inputSchema: { id: z.string().min(6).max(128).describe('The generation id returned by chat (same as the session id)') },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, tool(async ({ id }) => {
    try {
      const g = (await api.get('/v1/generation', { query: { id } }))?.data ?? null;
      return ok(g);
    } catch (e) {
      if (!isMissingRoute(e)) throw e;
      return ok({ note: 'this router has no /v1/generation; this is the session record', session: await api.get(`/v1/sessions/${encodeURIComponent(id)}`) });
    }
  }));

  server.registerTool('account', {
    title: 'Balance, key and grant',
    description: 'The calling wallet\'s prepaid FLOP balance (available, held, deposit address, fee, recent ledger entries, withdrawals), this API key\'s usage in FLOP and rate limits, the state of its on-chain session-key grants (compute and fee grant by `kind`), and the router fees (`fees`: mode, accrued, collected, owed, last collection). In the default deposit-free mode the router collects its fee from the wallet through the fee grant, so no prepaid balance is needed. Needs an API key.',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, tool(async () => {
    if (!api.hasKey) return ok({ unavailable: 'no API key configured: set FLOPROUTER_API_KEY (create one with `npx floprouter login`)' });
    const [balance, key, grant] = await Promise.all([
      optional(() => api.get('/v1/balance')), optional(async () => (await api.get('/v1/key'))?.data ?? null), optional(() => api.get('/v1/grants')),
    ]);
    if (balance?.recent) balance.recent = balance.recent.slice(0, 10);
    const gs = await grantState();
    return ok({ ...(gs?.warning ? { grant_warning: gs.warning } : {}), balance, key, grant });
  }));

  server.registerTool('grant_status', {
    title: 'Grant status',
    description: 'The session-key grant that lets the router open channels paid by the user\'s wallet: state, expiry, days left, spending cap and today\'s room left, and whether renewal is due (under 2 days left or nearly used up). Also the router fees (`fees`: accrued, collected, owed) and the fee grant that pays them. Tell the user when renewal is due: only their wallet can sign a new grant (`floprouter grant`, one signature for both grants).',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, tool(async () => {
    if (!api.hasKey) return ok({ unavailable: 'no API key configured' });
    const gs = await grantState();
    if (!gs) return ok({ unavailable: 'this router does not report grants' });
    const f = gs.facts;
    return ok({
      state: f.state, expires_at: f.expiresAt ?? null, days_left: f.expiresInSec !== null && f.expiresInSec !== undefined ? Math.round((f.expiresInSec / 86400) * 10) / 10 : null,
      cap_left: f.remaining ?? null, spending_cap: f.spendingCap ?? null, today_left: f.dayRoom ?? null, per_session_limit: f.perTxLimit ?? null,
      renewal_due: gs.decision.action === 'renew' || gs.decision.action === 'grant', reason: gs.decision.reason, warning: gs.warning,
      // The deposit-free router fee: its totals (mode, accrued, collected, owed, last collection) and the fee grant that pays it.
      fees: gs.fees, fee_grant: gs.feeGrant ? { state: gs.feeGrant.state, expires_at: gs.feeGrant.expiresAt ?? null, cap_left: gs.feeGrant.remaining ?? null, spending_cap: gs.feeGrant.spendingCap ?? null } : null,
      renewal_by_this_server: SIGNING_ENABLED ? (AUTO_RENEW ? 'enabled, automatic before chat' : 'enabled (renew_grant)') : 'off: the user renews with `floprouter grant` or `floprouter grant --auto-renew`',
    });
  }));

  if (SIGNING_ENABLED) {
    server.registerTool('renew_grant', {
      title: 'Renew the grant (signs a transaction)',
      description: 'SIGNS A TRANSACTION WITH THE WALLET CONFIGURED FOR THIS SERVER. Renews the session-key grant only when it is due (expiring within the window, expired, or nearly used up). One utility.batchAll with the router\'s own caps, checked before signing: revokeSession of the wallet\'s known grants, createSession to the router\'s delegate with exactly the current caps and only ComputeChannel and, when the wallet already has a fee grant, createSession of the fee grant (only Balances, with the caps the router states). Does nothing when no renewal is due; never creates a grant from nothing, never adds a first fee grant and never raises caps, the fee grant\'s included (it refuses if the router\'s compute caps differ from the current ones, or its fee caps are above those of the fee grant it replaces). Every signature is logged. Use dry_run to see what it would sign.',
      inputSchema: { dry_run: z.boolean().optional().describe('Check and describe the renewal without signing') },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    }, tool(async ({ dry_run }) => ok(await runRenew(Boolean(dry_run)))));
  }

  server.registerTool('withdraw', {
    title: 'Withdraw prepaid balance',
    description: 'Send prepaid FLOP from the router balance back to the wallet that owns this API key (the only destination the API allows). The chain fee is taken out of the amount. Only use when the user asks for it.',
    inputSchema: { amount: z.string().regex(/^(all|\d+(\.\d+)?)$/).describe('Decimal FLOP, or "all" for the whole available balance') },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, tool(async ({ amount }) => {
    if (!api.hasKey) return ok({ unavailable: 'no API key configured' });
    try {
      let w = await api.post('/v1/balance/withdraw', { amount });
      // Current API: 202 "submitted" with a poll URL; poll briefly (within the tool budget), then return the state.
      const t0 = Date.now();
      while (w?.poll && !['sent', 'failed'].includes(w.status) && Date.now() - t0 < TOOL_BUDGET_MS - 10_000) {
        await new Promise((res) => setTimeout(res, 5_000));
        try { w = { ...w, ...(await api.get(w.poll.replace(/^\/api\/v1\//, '/v1/'))) }; } catch { break; }
      }
      if (w?.poll && !['sent', 'failed'].includes(w.status)) w.note = 'not final yet; the amount stays held until it is. The account tool shows it under withdrawals.';
      return ok(w);
    } catch (e) {
      if (isMissingRoute(e)) return ok({ unavailable: 'this router does not offer withdrawals yet' });
      throw e;
    }
  }));

  server.registerTool('router_status', {
    title: 'Router status',
    description: 'Network, sync state, number of miners and verified endpoints, and which wallet pays for sessions.',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, tool(async () => {
    const h = await api.get('/health', { auth: false });
    return ok({
      status: h.status, network: h.network, finalized_block: h.finalized_block,
      miners: h.registry?.miners ?? null, models: h.registry?.models ?? null,
      endpoints_verified: h.endpoints?.verified ?? null, endpoints_ready: h.endpoints?.verified_ready ?? null,
      payer: h.payer ?? null, base_url: api.base,
    });
  }));

  return server;
}

function argValue(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stdout.write(`floprouter-mcp ${VERSION}\n\n  floprouter-mcp                 stdio transport (for Claude Code, Claude Desktop, Cursor, Codex)\n  floprouter-mcp --http          streamable HTTP on http://127.0.0.1:8792/mcp\n      --port <n> --host <addr>\n\nEnvironment: FLOPROUTER_API_KEY (else the key saved by "floprouter login"),\n             FLOPROUTER_BASE_URL (default ${DEFAULT_BASE_URL}), FLOPROUTER_TIMEOUT_MS, FLOPROUTER_SETTLE_WAIT_MS\n`);
    return;
  }
  if (process.argv.includes('--version')) { process.stdout.write(VERSION + '\n'); return; }

  if (!process.argv.includes('--http')) {
    const server = buildServer({ apiKey: API_KEY });
    await server.connect(new StdioServerTransport());
    process.stderr.write(`floprouter-mcp ${VERSION} on stdio, router ${BASE_URL}${API_KEY ? '' : ' (no API key: read-only tools only)'}\n`);
    return;
  }

  // Streamable HTTP, stateless: one server and transport per request. A request may carry its own router key in
  // `Authorization: Bearer fr_...`; otherwise FLOPROUTER_API_KEY is used.
  const port = Number(argValue('--port', env.PORT || 8792));
  const host = argValue('--host', '127.0.0.1');
  const httpServer = http.createServer(async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (path === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(json({ ok: true, version: VERSION })); }
    if (path !== '/mcp') { res.writeHead(404, { 'content-type': 'application/json' }); return res.end(json({ error: 'use /mcp' })); }
    if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }); return res.end(); }
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '');
    const server = buildServer({ apiKey: m ? m[1] : API_KEY });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { void transport.close(); void server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (e) {
      if (!res.headersSent) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(json({ jsonrpc: '2.0', error: { code: -32603, message: String(e?.message ?? e) }, id: null })); }
    }
  });
  httpServer.listen(port, host, () => process.stderr.write(`floprouter-mcp ${VERSION} on http://${host}:${port}/mcp, router ${BASE_URL}\n`));
}

main().catch((e) => { process.stderr.write(`floprouter-mcp: ${e?.stack ?? e}\n`); process.exit(1); });
