// claude.sdk.test.js — CW-10 item 1: the wrapper now runs on the OFFICIAL
// @anthropic-ai/sdk, and this proves it WITHOUT spending a token.
//
// A mock transport is injected as the SDK's own `fetch`, so every assertion is
// made against the REAL request the SDK builds — headers, body, betas, tools,
// SSE — not against a stub of our own. What is pinned here:
//   - the exported surface is unchanged (hasKey / model / reason) and reason()
//     still returns { text, stopReason, model, refused };
//   - the body is model-correct: NEVER temperature/top_p/top_k, NEVER
//     budget_tokens, adaptive thinking, json_schema via output_config.format;
//   - the model policy is unchanged (default + JARVIS_MODEL override + per-call
//     override);
//   - typed SDK errors map to the SAME honest strings the hand-rolled client
//     produced, so the operator-facing text does not change;
//   - the hand-rolled retry is GONE and the SDK's own retry does the work;
//   - a safety refusal (HTTP 200, stop_reason refusal) is reported, never
//     fabricated around;
//   - web research attaches the tools on a reasoning call, and an account that
//     REJECTS them turns the capability off honestly instead of crashing;
//   - compaction uses the beta path and falls back SILENTLY on a beta error;
//   - streaming yields deltas and a buffered result identical to the deltas.

const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.ANTHROPIC_API_KEY = 'test-key-never-real';
process.env.JARVIS_MODEL = 'claude-opus-5';

const spend = require('./spend-store');
spend._setDir(fs.mkdtempSync(path.join(os.tmpdir(), 'cw10-spend-')));

const claude = require('./claude');
const capabilities = require('./capabilities');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`); }
}

// ── The mock transport ──────────────────────────────────────────────────────
const seen = [];                 // every request the SDK actually made
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
function okBody(extra) {
  return {
    id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-5',
    content: [{ type: 'text', text: 'answer text' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 90 },
    ...(extra || {}),
  };
}
// Headers may arrive as a Headers instance or a plain object — normalise so an
// assertion on a beta header is made against what really went on the wire.
function headersOf(init) {
  const h = (init && init.headers) || {};
  if (typeof h.forEach === 'function' && typeof h.get === 'function') {
    const out = {};
    h.forEach((v, k) => { out[String(k).toLowerCase()] = v; });
    return out;
  }
  const out = {};
  for (const k of Object.keys(h)) out[String(k).toLowerCase()] = h[k];
  return out;
}

// `handler(request)` decides what comes back; every call is recorded first.
let handler = () => jsonResponse(okBody());
async function mockFetch(url, init) {
  const req = {
    url: String(url),
    headers: headersOf(init),
    body: init && init.body ? JSON.parse(init.body) : null,
  };
  seen.push(req);
  return handler(req);
}
claude._test._setFetch(mockFetch);

function lastBody() { return seen.length ? seen[seen.length - 1].body : null; }
function reset() { seen.length = 0; handler = () => jsonResponse(okBody()); }

const BASE = { system: 'STABLE SYSTEM PROMPT', messages: [{ role: 'user', content: 'volatile question' }] };

(async () => {
  // ── 1. surface + body shape ───────────────────────────────────────────────
  console.log('\nSURFACE + REQUEST BODY (the model-policy rules that would 400):');
  ok('hasKey / model / reason are all still exported', typeof claude.hasKey === 'function' && typeof claude.model === 'function' && typeof claude.reason === 'function');
  ok('model policy: the default tier is unchanged', claude.model() === 'claude-opus-5', claude.model());

  reset();
  const r1 = await claude.reason({ ...BASE, maxTokens: 1234, effort: 'high', purpose: 'plan' });
  const b1 = lastBody();
  ok('reason() returns the unchanged shape', r1.text === 'answer text' && r1.stopReason === 'end_turn' && r1.refused === false, JSON.stringify(r1));
  ok('the SDK posted to /v1/messages', /\/v1\/messages$/.test(seen[0].url), seen[0].url);
  ok('NEVER temperature / top_p / top_k (400 on opus-5)', !('temperature' in b1) && !('top_p' in b1) && !('top_k' in b1));
  ok('NEVER budget_tokens', JSON.stringify(b1.thinking) === '{"type":"adaptive"}', JSON.stringify(b1.thinking));
  ok('max_tokens + effort are passed through', b1.max_tokens === 1234 && b1.output_config.effort === 'high');
  ok('the model is the app default', b1.model === 'claude-opus-5');
  ok('one call = one request (no hand-rolled retry on a success)', seen.length === 1, `requests=${seen.length}`);

  reset();
  const schema = { type: 'json_schema', schema: { type: 'object', additionalProperties: false, required: ['a'], properties: { a: { type: 'string' } } } };
  await claude.reason({ ...BASE, format: schema });
  ok('json_schema output rides output_config.format (not output_format)',
    JSON.stringify(lastBody().output_config.format) === JSON.stringify(schema) && !('output_format' in lastBody()));

  reset();
  await claude.reason({ ...BASE, model: 'claude-sonnet-5' });
  ok('a per-call model override still works (the refusal retry path)', lastBody().model === 'claude-sonnet-5');

  // ── 2. prompt caching ─────────────────────────────────────────────────────
  console.log('\nPROMPT CACHING (the stable system block, first and marked):');
  reset();
  await claude.reason(BASE);
  const sys = lastBody().system;
  ok('system is a block array, not a bare string', Array.isArray(sys) && sys.length === 1);
  ok('the stable system block carries cache_control ephemeral',
    sys[0].cache_control && sys[0].cache_control.type === 'ephemeral', JSON.stringify(sys[0].cache_control));
  ok('the volatile content is AFTER it, in the user message',
    lastBody().messages[0].content === 'volatile question' && !/volatile/.test(sys[0].text));

  // ── 3. honest failures: typed SDK errors → the SAME strings as before ─────
  console.log('\nTYPED SDK ERRORS → the wrapper\'s existing honest-failure semantics:');
  reset();
  handler = () => jsonResponse({ type: 'error', error: { type: 'invalid_request_error', message: 'bad thing' } }, 400);
  let err = null;
  try { await claude.reason(BASE); } catch (e) { err = e; }
  ok('a 400 is an "Anthropic API error (400): …" (fail fast, one attempt)',
    err && /^Anthropic API error \(400\): /.test(err.message) && seen.length === 1, err && err.message);

  reset();
  handler = () => jsonResponse({ type: 'error', error: { type: 'authentication_error', message: 'nope' } }, 401);
  err = null;
  try { await claude.reason(BASE); } catch (e) { err = e; }
  ok('a 401 is an honest API error, never a fabricated answer', err && /Anthropic API error \(401\)/.test(err.message), err && err.message);

  reset();
  handler = () => { throw new TypeError('fetch failed'); };
  err = null;
  try { await claude.reason(BASE); } catch (e) { err = e; }
  ok('a network failure is "Could not reach Anthropic: …"', err && /^Could not reach Anthropic: /.test(err.message), err && err.message);

  const savedKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  err = null;
  try { await claude.reason(BASE); } catch (e) { err = e; }
  ok('no key still rejects with exactly "no_api_key"', err && err.message === 'no_api_key', err && err.message);
  ok('hasKey() is false with no key', claude.hasKey() === false);
  process.env.ANTHROPIC_API_KEY = savedKey;
  claude._test._setFetch(mockFetch);   // rebuild the client for the restored key

  // ── 4. the SDK owns the retry now ────────────────────────────────────────
  console.log('\nRETRY (the hand-rolled loop is gone — the SDK does it):');
  reset();
  let attempts = 0;
  handler = () => {
    attempts += 1;
    if (attempts < 3) return jsonResponse({ type: 'error', error: { message: 'overloaded' } }, 529);
    return jsonResponse(okBody());
  };
  const retried = await claude.reason(BASE);
  ok('a transient 529 is retried by the SDK and the call still succeeds',
    retried.text === 'answer text' && attempts === 3, `attempts=${attempts}`);

  // ── 5. a safety refusal is reported, never fabricated around ─────────────
  console.log('\nSAFETY REFUSAL (HTTP 200, stop_reason refusal):');
  reset();
  handler = () => jsonResponse(okBody({ content: [], stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber' } }));
  const refused = await claude.reason(BASE);
  ok('refused:true with empty text — unchanged from the hand-rolled client',
    refused.refused === true && refused.stopReason === 'refusal' && refused.text === '', JSON.stringify(refused));

  // ── 6. web research (item 5) ─────────────────────────────────────────────
  console.log('\nWEB RESEARCH — reasoning calls only, honest when refused:');
  reset();
  claude._test._setWebResearch(null, 'not attempted yet');
  handler = () => jsonResponse(okBody({
    content: [
      { type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://cisco.com/bug/CSCxx', title: 'Known bug' }] },
      { type: 'text', text: 'Per cisco.com there is a known bug.' },
    ],
  }));
  const web = await claude.reason({ ...BASE, web: true });
  const wb = lastBody();
  ok('web_search_20260209 + web_fetch_20260209 are attached, max_uses 3',
    wb.tools && wb.tools.length === 2 && wb.tools[0].type === 'web_search_20260209' && wb.tools[1].type === 'web_fetch_20260209'
    && wb.tools[0].max_uses === 3 && wb.tools[1].max_uses === 3, JSON.stringify(wb.tools));
  ok('the web instruction is a FIXED string on the system block (cache-safe)',
    wb.system[0].text.endsWith(claude._test.WEB_NOTE));
  ok('the web sources come back labelled, separately from the text',
    web.webSources.length === 1 && web.webSources[0].url === 'https://cisco.com/bug/CSCxx', JSON.stringify(web.webSources));
  ok('capability web-research flips to available once the account accepts it',
    claude.webResearch().available === true && capabilities.get('web-research').available === true);

  reset();
  claude._test._setWebResearch(null, 'not attempted yet');
  let calls = 0;
  handler = () => {
    calls += 1;
    if (calls === 1) return jsonResponse({ type: 'error', error: { type: 'invalid_request_error', message: 'tool type web_search_20260209 is not supported' } }, 400);
    return jsonResponse(okBody());
  };
  const degraded = await claude.reason({ ...BASE, web: true });
  ok('an account that REJECTS the tools does not crash — the answer still comes back',
    degraded.text === 'answer text' && calls === 2, `calls=${calls}`);
  ok('the retry ran WITHOUT the tools', !lastBody().tools);
  ok('capability web-research is honestly OFF afterwards, with a reason',
    claude.webResearch().available === false && capabilities.get('web-research').available === false
    && typeof capabilities.get('web-research').reason === 'string');
  reset();
  await claude.reason({ ...BASE, web: true });
  ok('a rejected capability is never re-attempted (one honest decision, not a loop)',
    !lastBody().tools && seen.length === 1, `requests=${seen.length}`);
  claude._test._setWebResearch(null, 'reset for later tests');

  // ── 7. compaction (item 6) ───────────────────────────────────────────────
  console.log('\nCOMPACTION — the beta on long paths, silent fallback on a beta error:');
  reset();
  claude._test._setCompaction(true);
  handler = () => jsonResponse(okBody({ content: [{ type: 'text', text: 'answer text' }] }));
  const compacted = await claude.reason({ ...BASE, compact: true });
  const cb = lastBody();
  const betaHeader = String((seen[seen.length - 1].headers['anthropic-beta'] || seen[seen.length - 1].headers['Anthropic-Beta'] || ''));
  ok('the beta endpoint sends anthropic-beta: compact-2026-01-12',
    betaHeader.includes('compact-2026-01-12'), betaHeader || '(no beta header)');
  ok('context_management edits [{type:compact_20260112}] is sent',
    JSON.stringify(cb.context_management) === JSON.stringify({ edits: [{ type: 'compact_20260112' }] }), JSON.stringify(cb.context_management));
  ok('the FULL response.content comes back so compaction blocks can be preserved',
    Array.isArray(compacted.content) && compacted.content.length === 1);

  reset();
  claude._test._setCompaction(true);
  let n = 0;
  handler = () => {
    n += 1;
    if (n === 1) return jsonResponse({ type: 'error', error: { message: 'beta compact-2026-01-12 is not enabled' } }, 400);
    return jsonResponse(okBody());
  };
  const fellBack = await claude.reason({ ...BASE, compact: true });
  ok('a beta error falls back SILENTLY — the operator still gets the answer',
    fellBack.text === 'answer text' && fellBack.refused === false && n === 2, `calls=${n}`);
  const fbHeader = String(seen[seen.length - 1].headers['anthropic-beta'] || '');
  ok('the fallback request carries no compaction beta and no context_management',
    !fbHeader.includes('compact-2026-01-12') && !lastBody().context_management, fbHeader);
  ok('compaction is not retried once the account refused it', claude.compaction().available === false);
  reset();
  await claude.reason({ ...BASE, compact: true });
  ok('a later compact call goes straight down the normal path',
    !String(seen[0].headers['anthropic-beta'] || '').includes('compact-2026-01-12') && seen.length === 1);
  claude._test._setCompaction(true);

  // ── 8. streaming (item 3, BE half) ───────────────────────────────────────
  console.log('\nSTREAMING — deltas then a buffered result that matches them:');
  reset();
  const chunks = ['The ', 'campus ', 'estate ', 'is healthy.'];
  handler = () => {
    const events = [
      ['message_start', { type: 'message_start', message: { id: 'msg_s', type: 'message', role: 'assistant', model: 'claude-opus-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } }],
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
      ...chunks.map((t) => ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } }]),
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 12 } }],
      ['message_stop', { type: 'message_stop' }],
    ];
    const sse = events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('');
    return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const deltas = [];
  const streamed = await claude.reason({ ...BASE, onDelta: (d) => deltas.push(d) });
  ok('every chunk arrived as a delta, in order', deltas.join('') === chunks.join(''), JSON.stringify(deltas));
  ok('more than one delta was emitted (it really streamed)', deltas.length === chunks.length, `deltas=${deltas.length}`);
  ok('the buffered result is byte-identical to the streamed text',
    streamed.text === chunks.join('').trim(), JSON.stringify(streamed.text));
  ok('the streamed request is a stream request', lastBody().stream === true);

  // ── 9. token accounting is fed from the API's own usage ──────────────────
  console.log('\nTOKEN ACCOUNTING (the spend record is written from response.usage):');
  reset();
  handler = () => jsonResponse(okBody({ usage: { input_tokens: 777, output_tokens: 88, cache_read_input_tokens: 555, cache_creation_input_tokens: 0 } }));
  await claude.reason({ ...BASE, purpose: 'synthesize', conversationId: 'conv-9' });
  const recs = spend.all();
  const rec = recs[recs.length - 1];
  ok('the record carries the real usage numbers',
    rec.input_tokens === 777 && rec.output_tokens === 88 && rec.cache_read_input_tokens === 555, JSON.stringify(rec));
  ok('the record carries purpose / model / conversationId',
    rec.purpose === 'synthesize' && rec.model === 'claude-opus-5' && rec.conversationId === 'conv-9', JSON.stringify(rec));
  ok('NO prompt text is anywhere in the record',
    !JSON.stringify(rec).includes('STABLE SYSTEM PROMPT') && !JSON.stringify(rec).includes('volatile question'), JSON.stringify(rec));

  console.log(`\nCW-10 claude-over-SDK: ${pass} passed, ${fail} failed.`);
  if (fail) process.exit(1);
})().catch((err) => { console.error('test crashed:', err); process.exit(1); });
