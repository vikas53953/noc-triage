// runtime/model.js — CW-14 stage A: the PROVIDER SEAM for the agent runtime.
//
// Plain words: the runtime (sources/runtime/index.js) never names a vendor. It
// asks this file for "the model", and this file builds one from config:
//
//   MODEL_PROVIDER=anthropic   (the only one wired today — decision 7 keeps
//                               Anthropic as the provider for now)
//   JARVIS_MODEL=claude-opus-5 (same variable the legacy path reads)
//   ANTHROPIC_API_KEY          (presence only — the value goes to the provider
//                               client and nowhere else, exactly like claude.js)
//
// Adding a provider (stage D: OpenAI, OpenRouter, "OpenCode"-style cheap
// models) is ONE new case in build() — the Vercel AI SDK provider package for
// it, wrapped by the same `aisdk()` adapter — and nothing above this file
// changes. That is HANDOFF law 10 in code: no new call hard-wires a vendor.
//
// TEST SEAM. `_test.setFetch(fn)` injects a mock transport as the provider's
// own fetch (createAnthropic accepts `fetch`), so the deterministic tests
// exercise the real request the adapter builds — tools, tool_result turns,
// streaming — against a scripted JSON/SSE responder, never the network.
//
// SPEND. Every model response the runtime makes carries `usage`; recordUsage()
// drops it into sources/spend-store.js in the SAME record shape claude.js
// writes (purpose, model, conversationId, incidentId, usage{input_tokens,
// output_tokens, cache_*}) so the Desk's Spend panel adds it up with no idea
// which loop ran the call. Numbers and labels only — never prompt text.
//
// The provider packages are ESM-only, so they are imported lazily (a plain
// dynamic import from this CommonJS app works on every supported Node).

const spend = require('../spend-store');

const DEFAULT_MODEL = 'claude-opus-5';
const DEFAULT_PROVIDER = 'anthropic';

let fetchOverride = null;
// One built model per (provider, model id, key, transport) — rebuilt whenever
// any of those changes, so a key set after require() still works.
let cached = null;
let cachedFor = null;

function provider() {
  return String(process.env.MODEL_PROVIDER || DEFAULT_PROVIDER).trim().toLowerCase();
}

function modelId() {
  return process.env.JARVIS_MODEL || DEFAULT_MODEL;
}

// The key for the configured provider. Presence check ONLY — never returned to
// a caller, never logged.
function keyFor(p) {
  switch (p) {
    case 'anthropic': return process.env.ANTHROPIC_API_KEY;
    default: return undefined;
  }
}

function hasKey() {
  const k = keyFor(provider());
  return typeof k === 'string' && k.trim().length > 0;
}

// The one-line description the UI / logs may show. No secrets.
function describe() {
  return { provider: provider(), model: modelId(), keyPresent: hasKey() };
}

/**
 * Build (or reuse) the runtime model for the configured provider.
 * Returns the `aisdk()`-wrapped model the OpenAI Agents SDK consumes.
 * Throws `no_api_key` (the same marker claude.js uses) when the key is absent,
 * and an honest error for a provider that is not wired up yet.
 */
// The providers this seam knows how to build. Stage D appends to this list
// and adds the matching case in build() — nothing above this file changes.
const WIRED = ['anthropic'];

async function build() {
  const p = provider();
  const id = modelId();
  if (!WIRED.includes(p)) {
    throw new Error(`MODEL_PROVIDER "${p}" is not wired up — only ${WIRED.map((w) => `"${w}"`).join(', ')} ${WIRED.length === 1 ? 'is' : 'are'} (CW-14 stage D adds the others)`);
  }
  const key = keyFor(p);
  if (!key || !String(key).trim()) {
    throw new Error('no_api_key');
  }
  const signature = `${p}|${id}|${fetchOverride ? 'mock-transport' : 'live'}|${key}`;
  if (cached && cachedFor === signature) return cached;

  const { aisdk } = await import('@openai/agents-extensions/ai-sdk');
  let languageModel;
  switch (p) {
    case 'anthropic': {
      const { createAnthropic } = await import('@ai-sdk/anthropic');
      const opts = { apiKey: key };
      if (fetchOverride) opts.fetch = fetchOverride;
      languageModel = createAnthropic(opts)(id);
      break;
    }
    // Stage D adds: case 'openai' → @ai-sdk/openai; case 'openrouter' → the
    // OpenRouter provider package. One case each, nothing else moves.
    default:
      throw new Error(`MODEL_PROVIDER "${p}" is listed as wired but has no build case`);
  }
  cached = aisdk(languageModel);
  cachedFor = signature;
  return cached;
}

// ── Spend ───────────────────────────────────────────────────────────────────
// The SDK's ModelResponse.usage is camelCase ({inputTokens, outputTokens,
// inputTokensDetails:[{cached_tokens, cache_write_tokens}]}); the spend store
// speaks the Anthropic response.usage names. Map once, here.
//
// ONE SEMANTIC DIFFERENCE, corrected here so the two loops' records add up the
// same way: the AI SDK's `inputTokens` is the TOTAL (uncached + cache-read +
// cache-write), while Anthropic's `input_tokens` — what claude.js records — is
// the UNCACHED part only, with the cache counts alongside. Recording the total
// as input_tokens would count every cached token twice in the Spend panel.
function num(v) { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.round(n) : 0; }

function usageOf(resp) {
  const u = (resp && resp.usage) || {};
  const details = Array.isArray(u.inputTokensDetails) ? u.inputTokensDetails : [];
  let cacheRead = 0, cacheWrite = 0;
  for (const d of details) {
    if (!d || typeof d !== 'object') continue;
    cacheRead += num(d.cached_tokens);
    cacheWrite += num(d.cache_write_tokens);
  }
  return {
    input_tokens: Math.max(0, num(u.inputTokens) - cacheRead - cacheWrite),
    output_tokens: num(u.outputTokens),
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheWrite,
  };
}

/**
 * Record every model response of one run into the spend store. Same record
 * shape claude.js writes (see recordSpend there). Never throws — accounting
 * must never break a real answer. Returns how many records were written.
 */
function recordUsage(rawResponses, { purpose, conversationId, incidentId } = {}) {
  let n = 0;
  const list = Array.isArray(rawResponses) ? rawResponses : [];
  for (const resp of list) {
    try {
      spend.record({
        purpose: purpose || 'runtime',
        model: modelId(),
        conversationId: conversationId || null,
        incidentId: incidentId || null,
        usage: usageOf(resp),
      });
      n += 1;
    } catch (e) { /* accounting must never break a real call */ }
  }
  return n;
}

function _setFetch(fn) { fetchOverride = typeof fn === 'function' ? fn : null; cached = null; cachedFor = null; }
function _reset() { cached = null; cachedFor = null; }

module.exports = {
  build, hasKey, provider, modelId, describe, recordUsage,
  _test: { setFetch: _setFetch, reset: _reset, usageOf },
};
