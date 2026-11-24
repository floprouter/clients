// HTTP client for the floprouter API (global fetch, Node 18+), with server-sent-event parsing.
//
// Error bodies: the current API answers {error: {code: <HTTP status>, message, metadata: {reason, ...}}}; earlier
// servers answered {error: {code: "<reason>", message, type}}. ApiError.code is always the string reason
// (metadata.reason, or the old string code), ApiError.status the HTTP status, ApiError.metadata the rest.

export const DEFAULT_BASE_URL = 'https://api.floprouter.com';

export class ApiError extends Error {
  constructor(status, code, message, body, metadata = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.reason = code;
    this.body = body;
    this.metadata = metadata;
  }
}

/** Normalises an error object from either error format into {reason, message, metadata}. */
export function readError(err, status) {
  const e = err && typeof err === 'object' ? err : {};
  const metadata = e.metadata && typeof e.metadata === 'object' ? e.metadata : {};
  const reason = typeof metadata.reason === 'string' ? metadata.reason
    : typeof e.code === 'string' ? e.code
      : `http_${typeof e.code === 'number' ? e.code : status}`;
  // Old-format errors put details (session_id, available, required...) next to the code.
  const extra = {};
  for (const [k, v] of Object.entries(e)) if (!['code', 'message', 'type', 'metadata'].includes(k)) extra[k] = v;
  return { reason, message: e.message ?? `HTTP ${status}`, metadata: { ...extra, ...metadata } };
}

const HEADERS = Symbol.for('floprouter.headers');
/** Response headers of a parsed JSON body returned by the client (null when unknown). */
export const headersOf = (data) => (data && typeof data === 'object' ? data[HEADERS] ?? null : null);

export function makeClient({ baseUrl, apiKey, timeoutMs = 600_000, userAgent = 'floprouter-cli', title } = {}) {
  const base = (baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');

  async function raw(method, path, { query, body, auth = true, signal } = {}) {
    const url = new URL(base + path);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined && v !== null && v !== '' && v !== false) url.searchParams.set(k, String(v));
    }
    const headers = { accept: 'application/json, text/event-stream', 'user-agent': userAgent };
    if (title) headers['x-title'] = title;
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (auth && apiKey) headers.authorization = `Bearer ${apiKey}`;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(new Error(`request timed out after ${timeoutMs} ms`)), timeoutMs);
    if (signal) { if (signal.aborted) ctl.abort(signal.reason); else signal.addEventListener('abort', () => ctl.abort(signal.reason), { once: true }); }
    let res;
    try {
      res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: ctl.signal });
    } catch (e) {
      clearTimeout(timer);
      throw new ApiError(0, 'network_error', `cannot reach ${base}: ${e?.cause?.message ?? e?.message ?? e}`);
    }
    if (!res.ok) {
      clearTimeout(timer);
      const text = await res.text();
      let data; try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 500) }; }
      const er = readError(data?.error, res.status);
      const retry = res.headers.get('retry-after');
      throw new ApiError(res.status, er.reason, er.message, data, { ...er.metadata, ...(retry ? { retry_after: retry } : {}) });
    }
    return { res, done: () => clearTimeout(timer) };
  }

  // Reads (and other idempotent calls marked `retry`) are retried twice on 502/503/504 and network errors, so an hourly
  // job is not failed by a router restart. Chat and anything that spends is never retried here.
  async function request(method, path, opts = {}) {
    const retry = opts.retry ?? method === 'GET';
    for (let attempt = 0; ; attempt++) {
      try { return await requestOnce(method, path, opts); } catch (e) {
        const transient = e instanceof ApiError && (e.status === 0 || e.status === 502 || e.status === 503 || e.status === 504) && e.code !== 'stream_interrupted';
        if (!retry || !transient || attempt >= 2) throw e;
        await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
      }
    }
  }
  async function requestOnce(method, path, opts) {
    const { res, done } = await raw(method, path, opts);
    try {
      const text = await res.text();
      const data = text.trim() ? JSON.parse(text) : null;   // leading whitespace: the server's keep-alive bytes
      // After a long wait the current API has already sent 200, so a late error arrives as a 200 JSON error body
      // with the real status in error.code. (Session records carry `error` as a string or null, never an object.)
      if (data && typeof data.error === 'object' && data.error !== null && typeof data.error.message === 'string') {
        const er = readError(data.error, res.status);
        throw new ApiError(typeof data.error.code === 'number' ? data.error.code : res.status, er.reason, er.message, data, er.metadata);
      }
      if (data && typeof data === 'object') {
        Object.defineProperty(data, HEADERS, { value: res.headers, enumerable: false });
        Object.defineProperty(data, 'httpStatus', { value: res.status, enumerable: false });
      }
      return data;
    } finally { done(); }
  }

  /**
   * POST with stream: true. Calls onHeaders once, onEvent for each parsed `data:` JSON and onComment for keep-alive
   * comments. A mid-stream error chunk (either format) becomes an ApiError.
   */
  async function stream(path, body, { onEvent, onComment, onHeaders, signal } = {}) {
    const { res, done } = await raw('POST', path, { body, signal });
    onHeaders?.(res.headers);
    let lastId = res.headers.get('x-generation-id');
    try {
      const decoder = new TextDecoder();
      let buf = '';
      for await (const chunk of streamBody(res.body, () => lastId)) {
        buf += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          for (const line of block.split('\n')) {
            if (line.startsWith(':')) { onComment?.(line.slice(1).trim()); continue; }
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (data === '[DONE]') return;
            let ev; try { ev = JSON.parse(data); } catch { continue; }
            if (ev.id) lastId = ev.id;
            if (ev.error) {
              const er = readError(ev.error, 200);
              throw new ApiError(typeof ev.error.code === 'number' ? ev.error.code : 200, er.reason, er.message, ev, { session_id: lastId, ...er.metadata });
            }
            onEvent?.(ev);
          }
        }
      }
    } finally { done(); }
  }

  return {
    base,
    hasKey: Boolean(apiKey),
    get: (path, opts) => request('GET', path, opts),
    post: (path, body, opts) => request('POST', path, { ...opts, body }),
    del: (path, opts) => request('DELETE', path, opts),
    patch: (path, body, opts) => request('PATCH', path, { ...opts, body }),
    stream,
  };
}

/** Iterates a response body; a dropped connection becomes an ApiError naming the session, which may still finish. */
async function* streamBody(body, sessionId) {
  try { for await (const chunk of body) yield chunk; } catch (e) {
    const id = sessionId();
    throw new ApiError(0, 'stream_interrupted', `the connection closed before the reply finished (${e?.message ?? e})${id ? `; the session may still complete: floprouter session ${id}` : ''}`);
  }
}

/** True when the router does not have this route at all (an older router, or a feature not deployed there). */
export const isMissingRoute = (e) => e instanceof ApiError && e.status === 404 && e.code === 'not_found';

/** Reads a model object in either format: the current one (FLOP facts under `flop`) or the earlier flat one. */
export function modelFacts(m) {
  const f = m?.flop ?? {};
  const pick = (...xs) => xs.find((x) => x !== undefined && x !== null);
  return {
    id: m.id, name: m.name,
    available: Boolean(pick(f.available, m.available, false)),
    ready: pick(f.providers_ready, f.miners_ready, m.miners_ready, null),
    reachable: pick(f.providers_reachable, f.miners_reachable, m.miners_reachable, null),
    paramsBillion: pick(f.params_billion, m.params_billion, null),
    escrowPer1k: pick(f.escrow_per_1000_tokens, m.pricing?.escrow_per_1000_tokens, null),
    routerFeePercent: pick(f.router_fee_percent, m.pricing?.router_fee_percent, null),
    minCharge: pick(f.min_charge_per_request, null),
    contextLength: pick(m.context_length, null),
    maxCompletionTokens: pick(m.top_provider?.max_completion_tokens, null),
    supportedParameters: m.supported_parameters ?? null,
    pricePerToken: m.pricing && typeof m.pricing.prompt === 'string' ? { prompt: m.pricing.prompt, completion: m.pricing.completion } : null,
  };
}

/** The FLOP cost of a response or session in either format (usage.cost in the current one), as a string or null. */
export function costOf(resp) {
  const c = resp?.usage?.cost ?? resp?.total_cost ?? null;
  return c === null || c === undefined ? null : String(c);
}
