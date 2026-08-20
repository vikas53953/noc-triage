// claude.js — the ONE place this app talks to the Anthropic API.
//
// Phase E (Jarvis). This is a GENUINE integration: Jarvis's reasoning is a real
// Claude call. There is no rule-router hiding behind it — if this module cannot
// run (no key), the caller shows an honest "needs your API key" state and Jarvis
// declines to reason. It never fabricates a plan or an answer.
//
// CW-10: the internals are now the OFFICIAL @anthropic-ai/sdk. The hand-rolled
// https client and the hand-rolled transient-retry are gone — the SDK owns the
// wire, the retries (429/5xx/connection blips) and the streaming. The EXPORTED
// SURFACE IS UNCHANGED (hasKey / model / reason), so every call site in
// jarvis.js, conduct.js and the investigation loop is untouched and their
// behaviour on the same inputs is identical. What is new is additive:
//   • prompt caching   — the stable system prompt is sent as a cached block;
//   • token accounting — every response.usage lands in sources/spend-store.js;
//   • web research     — server-side web_search/web_fetch on REASONING calls
//                        only, degraded honestly if the account rejects them;
//   • compaction       — the compact-2026-01-12 beta on long-conversation
//                        paths, with a silent fall back to normal behaviour;
//   • streaming        — an optional onDelta callback for Jarvis's final
//                        user-facing compose (the buffered result is unchanged).
//
// Model failures are surfaced generically and honestly by the caller (jarvis.js):
// an API/network/timeout error, a safety-classifier refusal, or a missing key each
// map to a spoken "I couldn't reason / declined" state — no fabricated plan or
// answer, and no assumptions baked in about any one model's availability rules.
//
// KEY HANDLING (hard rule): ANTHROPIC_API_KEY is read from process.env (loaded by
// sources/env.js from the gitignored .env.local). The key is handed to the SDK
// client and nowhere else. It is never written to a log, an error message, an
// artifact, or the DOM. Errors record status codes and the API's own error text,
// never request headers.

const AnthropicModule = require('@anthropic-ai/sdk');
const Anthropic = AnthropicModule.default || AnthropicModule;
const spend = require('./spend-store');

// Model: Jarvis's job here is routing + summarising — deciding who to delegate to
// and composing an answer from the gathered findings. That does not need the very
// top tier, so the default is Claude Opus 5 (strong reasoning at a fraction of
// Fable's cost). Override with JARVIS_MODEL to pick another tier without a code
// change (e.g. claude-sonnet-5 for cheaper still). Model id verified against the
// `claude-api` skill's model catalogue.
const MODEL = process.env.JARVIS_MODEL || 'claude-opus-5';
const TIMEOUT_MS = Number(process.env.CLAUDE_TIMEOUT_MS || 60000);
// The SDK retries 408/409/429/5xx and connection errors itself with backoff, so
// the hand-rolled retry loop is gone. Two retries = the same three attempts the
// hand-rolled loop made, without the code.
const MAX_RETRIES = Number(process.env.CLAUDE_MAX_RETRIES || 2);

// Presence check ONLY — never returns or logs the value.
function hasKey() {
  const k = process.env.ANTHROPIC_API_KEY;
  return typeof k === 'string' && k.trim().length > 0;
}

function model() { return MODEL; }

// ── The SDK client ──────────────────────────────────────────────────────────
// Built lazily so a key set after require() still works, and rebuilt whenever
// the key changes. `_setFetch` is the TEST SEAM: a mock transport is injected as
// the SDK's own fetch, so the tests exercise the real request the SDK builds
// (headers, cache_control placement, tools, betas) rather than a stub of it.
let client = null;
let clientKey = null;
let fetchOverride = null;

function getClient() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || !key.trim()) {
    const err = new Error('no_api_key');   // caller maps this to the honest UI state
    throw err;
  }
  if (!client || clientKey !== key) {
    const opts = { apiKey: key, timeout: TIMEOUT_MS, maxRetries: MAX_RETRIES };
    if (fetchOverride) opts.fetch = fetchOverride;
    client = new Anthropic(opts);
    clientKey = key;
  }
  return client;
}

function _setFetch(fn) { fetchOverride = fn || null; client = null; clientKey = null; }
function _resetClient() { client = null; clientKey = null; }

// ── Typed SDK errors → the wrapper's existing honest-failure semantics ───────
// The message SHAPES are deliberately identical to the hand-rolled client's, so
// the operator-facing strings jarvis.js composes from err.message do not change:
//   • `no_api_key`                                → "needs your API key"
//   • `Anthropic API error (<status>): <message>` → an honest API failure
//   • `Could not reach Anthropic: <message>`      → network/DNS/socket
//   • `Anthropic API timed out after <n>ms`       → timeout
// A secret can never reach these strings: only the status code and the API's own
// error text are used, never the request or its headers.
function mapError(err) {
  if (!err) return new Error('Anthropic call failed');
  if (err.message === 'no_api_key') return err;

  const A = AnthropicModule;
  if (A.APIConnectionTimeoutError && err instanceof A.APIConnectionTimeoutError) {
    return new Error(`Anthropic API timed out after ${TIMEOUT_MS}ms`);
  }
  if (A.APIConnectionError && err instanceof A.APIConnectionError) {
    const cause = (err.cause && err.cause.message) || err.message || 'connection failed';
    return new Error(`Could not reach Anthropic: ${cause}`);
  }
  if (A.APIError && err instanceof A.APIError && err.status) {
    const apiMsg = (err.error && err.error.error && err.error.error.message)
      || err.message
      || `HTTP ${err.status}`;
    return new Error(`Anthropic API error (${err.status}): ${apiMsg}`);
  }
  if (err.name === 'AbortError' || /aborted|timed out/i.test(err.message || '')) {
    return new Error(`Anthropic API timed out after ${TIMEOUT_MS}ms`);
  }
  return new Error(`Could not reach Anthropic: ${err.message || String(err)}`);
}

// ── Prompt caching ──────────────────────────────────────────────────────────
// Caching is a PREFIX MATCH: one changed byte anywhere before the breakpoint
// invalidates everything after it. The app's system prompts are module-level
// constants (no timestamps, no ids, no per-request interpolation) and every
// volatile thing — the clock, the roster text, the operator's words, the
// findings — already travels in the USER message, i.e. AFTER the breakpoint.
// So all this has to do is mark the stable system block as cacheable.
//
// The block is built deterministically from the system STRING alone: same
// system prompt in, byte-identical block out, every call. That property is what
// sources/claude.cache.test.js asserts on two calls of one conversation.
const CACHE_CONTROL = { type: 'ephemeral' };

function systemBlocks(system, extra) {
  const text = String(system == null ? '' : system) + (extra || '');
  if (!text) return undefined;
  return [{ type: 'text', text, cache_control: CACHE_CONTROL }];
}

// ── Server-side web research (contract item 5) ──────────────────────────────
// Only ever attached to REASONING calls (never to a probe), and only when the
// caller asks for it. What comes back is a WEB source and is labelled as one:
// this note is a fixed string, so it does not disturb the cached prefix.
const WEB_NOTE = `

WEB RESEARCH. You have web_search and web_fetch. Use them ONLY to check vendor
documentation, release notes or known-bug advisories that would change your
reading of the evidence. Anything you learn that way is a WEB source, not a
reading from this network: say so in plain words and name where it came from
("per cisco.com/…"). NEVER present a web result as something a device reported,
and never let it stand in for evidence you do not have.`;

const WEB_TOOLS = [
  { type: 'web_search_20260209', name: 'web_search', max_uses: 3 },
  { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 3 },
];

// Honest capability state. Starts "unknown" (we have never tried); becomes false
// the FIRST time the account rejects the tool types, and stays false for the
// process — we never crash and never silently retry a rejected capability.
let webResearchAvailable = null;
let webResearchWhy = 'not attempted yet on this account';

function webResearch() {
  return { available: webResearchAvailable === true, why: webResearchWhy };
}
function _setWebResearch(v, why) { webResearchAvailable = v; webResearchWhy = why || webResearchWhy; }

// Does this error say "this account/model cannot use those tool types"? Only a
// 400/404-class rejection counts — a rate limit or an outage says nothing about
// the capability and must not switch it off.
function isToolRejection(err) {
  if (!err || !err.status) return false;
  if (err.status !== 400 && err.status !== 404 && err.status !== 403) return false;
  const m = String(err.message || '');
  return /tool|web_search|web_fetch|beta|not\s+supported|unsupported|unknown/i.test(m);
}

// ── Compaction (contract item 6) ────────────────────────────────────────────
// Long conversations get the compact-2026-01-12 beta; on any beta error we fall
// back SILENTLY to the current behaviour and never try the beta again for this
// process. The full response.content is always returned to the caller so that a
// caller replaying a conversation preserves the compaction blocks verbatim.
const COMPACT_BETA = 'compact-2026-01-12';
const COMPACT_EDIT = { type: 'compact_20260112' };
let compactionAvailable = true;
function _setCompaction(v) { compactionAvailable = v !== false; }
function compaction() { return { available: compactionAvailable }; }

// Concatenate the text blocks of a Messages response.
function textOf(resp) {
  if (!resp || !Array.isArray(resp.content)) return '';
  return resp.content.filter((b) => b && b.type === 'text').map((b) => b.text).join('').trim();
}

// The web sources a response actually used — url + title only, pulled from the
// server-tool result blocks. This is what lets the caller say "per cisco.com/…"
// honestly; it never becomes device evidence and never enters finding.cli.
function webSourcesOf(resp) {
  const out = [];
  if (!resp || !Array.isArray(resp.content)) return out;
  for (const block of resp.content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type !== 'web_search_tool_result' && block.type !== 'web_fetch_tool_result') continue;
    const inner = Array.isArray(block.content) ? block.content : [block.content];
    for (const r of inner) {
      if (!r || typeof r !== 'object') continue;
      const url = r.url || (r.document && r.document.source && r.document.source.url) || null;
      if (!url) continue;
      out.push({ url: String(url), title: r.title ? String(r.title) : null });
    }
  }
  return out;
}

// Build the request body ONCE, from the same inputs, every time — the property
// the cache byte-stability test relies on.
function buildBody({ system, messages, maxTokens, effort, format, model: modelOverride, web, tools }) {
  const outputConfig = { effort };
  if (format) outputConfig.format = format;
  const body = {
    // Per-call model override lets a caller run ONE call on a different tier (used
    // by the synthesis-refusal retry) without changing the app-wide default MODEL.
    model: modelOverride || MODEL,
    max_tokens: maxTokens,
    system: systemBlocks(system, web ? WEB_NOTE : ''),
    messages,
    // `thinking: {type:'adaptive'}` is set EXPLICITLY. Adaptive is valid on every
    // current tier (Opus 5, Sonnet 5, Fable 5). Being explicit keeps reasoning ON
    // even if JARVIS_MODEL is pointed at a model where omitting `thinking` would
    // mean no thinking (e.g. Opus 4.8). We never send {type:'disabled'}, so the
    // Opus 5 "disabled-only-at-≤high-effort" 400 cannot arise.
    thinking: { type: 'adaptive' },
    // NEVER temperature/top_p/top_k and never budget_tokens — all removed on the
    // current tiers (Opus 5 / Sonnet 5 / Fable 5) and each would 400.
    output_config: outputConfig,
  };
  if (tools && tools.length) body.tools = tools;
  return body;
}

function recordSpend(resp, { purpose, conversationId, incidentId, model: modelOverride }) {
  try {
    spend.record({
      purpose: purpose || 'unknown',
      model: (resp && resp.model) || modelOverride || MODEL,
      conversationId: conversationId || null,
      incidentId: incidentId || null,
      usage: (resp && resp.usage) || {},
    });
  } catch (e) { /* accounting must never break a real call */ }
}

// One API call, with the compaction beta when asked for and available.
async function send(body, { compact, onDelta }) {
  const c = getClient();
  const wantCompact = Boolean(compact) && compactionAvailable;

  if (wantCompact) {
    try {
      const betaBody = { ...body, betas: [COMPACT_BETA], context_management: { edits: [COMPACT_EDIT] } };
      return await (onDelta
        ? c.beta.messages.stream(betaBody).on('text', onDelta).finalMessage()
        : c.beta.messages.create(betaBody));
    } catch (err) {
      // Any beta error → silent fall back to current behaviour, for this call
      // and every later one. The operator never sees a compaction failure,
      // because compaction is an optimisation, not a promise.
      compactionAvailable = false;
    }
  }

  if (onDelta) {
    return c.messages.stream(body).on('text', onDelta).finalMessage();
  }
  return c.messages.create(body);
}

/**
 * One reasoning call. Returns { text, stopReason, model, refused } — the
 * unchanged contract every existing call site relies on — plus additive fields
 * { usage, content, webSources } that CW-10 callers may use and older ones ignore.
 *
 * Options (all optional except system/messages):
 *   maxTokens, effort, format, model   — as before, unchanged.
 *   purpose, conversationId, incidentId — labels for the spend record. NEVER
 *                                         prompt text; ids the app already holds.
 *   web       — attach server-side web_search/web_fetch (REASONING calls only).
 *   compact   — allow the compaction beta on this (long-conversation) call.
 *   onDelta   — stream: called with each text chunk as it arrives. The buffered
 *               result is identical to the non-streamed one.
 */
async function reason({
  system, messages, maxTokens = 3000, effort = 'high', format = null,
  model: modelOverride = null,
  purpose = null, conversationId = null, incidentId = null,
  web = false, compact = false, onDelta = null,
}) {
  const meta = { purpose, conversationId, incidentId, model: modelOverride };
  // Web research is attempted unless the account has already refused it.
  const useWeb = Boolean(web) && webResearchAvailable !== false;
  let resp;
  try {
    resp = await send(
      buildBody({ system, messages, maxTokens, effort, format, model: modelOverride, web: useWeb, tools: useWeb ? WEB_TOOLS : null }),
      { compact, onDelta },
    );
    if (useWeb) { webResearchAvailable = true; webResearchWhy = 'server-side web search + fetch accepted by this account'; }
  } catch (err) {
    // The account rejected the web tool types: switch the capability OFF
    // honestly, ONCE, and run the same call again without them. Never crash,
    // never pretend the research happened.
    if (useWeb && isToolRejection(err)) {
      webResearchAvailable = false;
      webResearchWhy = 'the Anthropic account rejected the server-side web tools';
      try {
        resp = await send(
          buildBody({ system, messages, maxTokens, effort, format, model: modelOverride, web: false, tools: null }),
          { compact, onDelta },
        );
      } catch (err2) {
        throw mapError(err2);
      }
    } else {
      throw mapError(err);
    }
  }

  recordSpend(resp, meta);

  const usedModel = resp.model || modelOverride || MODEL;
  // Safety classifiers can decline (HTTP 200, stop_reason "refusal"). Honesty
  // rule at the LLM layer: report the decline, never fabricate around it.
  if (resp.stop_reason === 'refusal') {
    return { text: '', stopReason: 'refusal', model: usedModel, refused: true, usage: resp.usage || null, content: resp.content || [], webSources: [] };
  }
  return {
    text: textOf(resp),
    stopReason: resp.stop_reason || 'end_turn',
    model: usedModel,
    refused: false,
    usage: resp.usage || null,
    content: resp.content || [],
    webSources: webSourcesOf(resp),
  };
}

module.exports = {
  hasKey, model, reason,
  // CW-10 additive surface (capability honesty + tests). Nothing here changes
  // how an existing caller behaves.
  webResearch, compaction,
  _test: { _setFetch, _resetClient, _setWebResearch, _setCompaction, buildBody, mapError, webSourcesOf, WEB_TOOLS, WEB_NOTE },
};
