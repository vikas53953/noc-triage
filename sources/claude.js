// claude.js — the ONE place this app talks to the Anthropic API.
//
// Phase E (Jarvis). This is a GENUINE integration: Jarvis's reasoning is a real
// Claude call. There is no rule-router hiding behind it — if this module cannot
// run (no key), the caller shows an honest "needs your API key" state and Jarvis
// declines to reason. It never fabricates a plan or an answer.
//
// WHY raw HTTPS and not the @anthropic-ai/sdk: the SDK is not installed in this
// repo's node_modules and this phase must not run `npm install`. The `claude-api`
// skill permits raw HTTP when no official SDK is available for the project. The
// wire shape below is the documented Messages API (POST /v1/messages).
//
// KEY HANDLING (hard rule): ANTHROPIC_API_KEY is read from process.env (loaded by
// sources/env.js from the gitignored .env.local). The key is placed ONLY in the
// x-api-key request header. It is never written to a log, an error message, an
// artifact, or the DOM. Errors record status codes and the API's own error text,
// never request headers.

const https = require('https');

// Model: Jarvis is the L4 / Principal Engineer — the squad's orchestrator. Per
// Vikas's standing "orchestrate up" law the orchestrator runs on the most capable
// model (Claude Fable 5). Override with JARVIS_MODEL if you want a cheaper tier.
// Model id verified against the `claude-api` skill's model catalogue.
const MODEL = process.env.JARVIS_MODEL || 'claude-fable-5';
const API_VERSION = '2023-06-01';
const HOST = 'api.anthropic.com';
const PATH = '/v1/messages';
const TIMEOUT_MS = Number(process.env.CLAUDE_TIMEOUT_MS || 60000);

// Presence check ONLY — never returns or logs the value.
function hasKey() {
  const k = process.env.ANTHROPIC_API_KEY;
  return typeof k === 'string' && k.trim().length > 0;
}

function model() { return MODEL; }

// Low-level POST. Resolves with the parsed JSON body on 2xx; rejects with an
// Error whose message is safe to show/log (status + API error text, no secrets).
function post(body) {
  return new Promise((resolve, reject) => {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key || !key.trim()) {
      return reject(new Error('no_api_key')); // caller maps this to the honest UI state
    }
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    const req = https.request({
      host: HOST, path: PATH, method: 'POST', timeout: TIMEOUT_MS,
      headers: {
        // The key lives here and nowhere else. Do not log this object.
        'x-api-key': key,
        'anthropic-version': API_VERSION,
        'content-type': 'application/json',
        'content-length': payload.length,
      },
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(data); } catch (e) { /* handled below */ }
        if (res.statusCode >= 200 && res.statusCode < 300 && parsed) {
          return resolve(parsed);
        }
        // Surface the API's own error text — never the request headers/key.
        const apiMsg = parsed && parsed.error && parsed.error.message
          ? parsed.error.message
          : `HTTP ${res.statusCode}`;
        reject(new Error(`Anthropic API error (${res.statusCode}): ${apiMsg}`));
      });
    });
    req.on('timeout', () => { req.destroy(new Error(`Anthropic API timed out after ${TIMEOUT_MS}ms`)); });
    req.on('error', (err) => {
      // err.message here is a network message (ENOTFOUND, ECONNRESET…) — no secret.
      reject(new Error(`Could not reach Anthropic: ${err.message}`));
    });
    req.write(payload);
    req.end();
  });
}

// Concatenate the text blocks of a Messages response.
function textOf(resp) {
  if (!resp || !Array.isArray(resp.content)) return '';
  return resp.content.filter((b) => b && b.type === 'text').map((b) => b.text).join('').trim();
}

// One reasoning call. Returns { text, stopReason, model, refused }.
//
// Notes on params (checked against the `claude-api` skill for claude-fable-5):
//  - `thinking` is OMITTED entirely — thinking is always on for Fable 5 and an
//    explicit config returns a 400.
//  - No temperature/top_p (removed on this model tier — would 400).
//  - `output_config.effort` tunes depth; `output_config.format` (json_schema)
//    is used by the planner to guarantee a parseable plan.
//  - Streaming is unnecessary here: both calls are small (a plan, a short
//    synthesis) and well under any HTTP timeout at these max_tokens.
async function reason({ system, messages, maxTokens = 1200, effort = 'high', format = null }) {
  const outputConfig = { effort };
  if (format) outputConfig.format = format;
  const body = {
    model: MODEL,
    max_tokens: maxTokens,
    system,
    messages,
    output_config: outputConfig,
  };
  const resp = await post(body);
  // Safety classifiers can decline (HTTP 200, stop_reason "refusal"). Honesty
  // rule at the LLM layer: report the decline, never fabricate around it.
  if (resp.stop_reason === 'refusal') {
    return { text: '', stopReason: 'refusal', model: resp.model || MODEL, refused: true };
  }
  return { text: textOf(resp), stopReason: resp.stop_reason || 'end_turn', model: resp.model || MODEL, refused: false };
}

module.exports = { hasKey, model, reason };
