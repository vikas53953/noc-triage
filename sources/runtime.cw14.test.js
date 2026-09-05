// runtime.cw14.test.js — CW-14 stage A: Jarvis on an ADOPTED agent runtime
// (OpenAI Agents SDK + aisdk adapter + @ai-sdk/anthropic), behind
// JARVIS_RUNTIME=agents, pinned DETERMINISTICALLY and OFFLINE.
//
// No key, no network: the provider's transport is a scripted mock (JSON + SSE,
// the same shape the spike used), the conduct gate's model call (claude.reason)
// is scripted the way conduct.cw9.test.js / say-delta.test.js do it, and every
// delegated read is a stub. A fake ctx records every say / sayDelta / status.
//
// The bar (contract, stage A): the 4 flagship behaviours with the SAME chat
// envelope on the wire —
//   1. a vague problem      → ONE kind:'ask', ZERO tool calls, zero reads
//   2. a specific ask       → the model calls delegate_read → a `finding` with
//                              evidenceId + the cli block → a streamed answer
//   3. "reload sw2"         → the honest write refusal, zero tools, zero wire
//   4. the streamed answer  → every delta within conduct.TEXT_MAX, never
//                              mid-word, final chat_message with the same
//                              messageId, aborted:true on a mid-stream failure
// plus: presence start/stream/end through the CW-12 seam; a write-classified
// MCP tool pauses and is rejected (never executed); a model error → the honest
// line; a tool throw → an honest string, never a fabricated reading; spend
// recorded; JARVIS_RUNTIME unset → the legacy path is untouched.

const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.ANTHROPIC_API_KEY = 'test-key-not-real';
process.env.JARVIS_MODEL = 'claude-sonnet-5';     // the spend rule: tests on sonnet
process.env.JARVIS_RUNTIME_TIMEOUT_MS = '1000';   // the stall bound (its floor), short for the hang tests (§10)
process.env.OPENAI_API_KEY = 'test-openai-key-not-real';   // §10: the SDK's tracing exporter must stay silent
delete process.env.MODEL_PROVIDER;

const claude = require('./claude');
const conduct = require('./conduct');
const jarvis = require('./jarvis');
const mcp = require('./mcp-connector');
const spend = require('./spend-store');
const model = require('./runtime/model');
const runtime = require('./runtime');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`); }
}
const section = (t) => console.log(`\n${t}`);

// ── The mock Anthropic transport (JSON + SSE) — copied from the spike ───────
const calls = [];      // one entry per provider request
let script = [];       // per request: {tool:{name,input}} | {text} | {chunks:[..]} | {status} | {chunks, failAfter}

function msg(content, stop) {
  return { id: `msg_${calls.length}`, type: 'message', role: 'assistant', model: 'claude-sonnet-5', content, stop_reason: stop,
    usage: { input_tokens: 42, output_tokens: 7, cache_read_input_tokens: 5, cache_creation_input_tokens: 0 } };
}
function sseFrames(m, chunks) {
  const ev = [['message_start', { type: 'message_start', message: { ...m, content: [], stop_reason: null } }]];
  m.content.forEach((c, i) => {
    if (c.type === 'text') {
      ev.push(['content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } }]);
      for (const piece of (chunks || [c.text])) ev.push(['content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: piece } }]);
    } else {
      ev.push(['content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: c.id, name: c.name, input: {} } }]);
      ev.push(['content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(c.input) } }]);
    }
    ev.push(['content_block_stop', { type: 'content_block_stop', index: i }]);
  });
  ev.push(['message_delta', { type: 'message_delta', delta: { stop_reason: m.stop_reason }, usage: { output_tokens: 7 } }]);
  ev.push(['message_stop', { type: 'message_stop' }]);
  return ev.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`);
}
const SSE_HEADERS = { status: 200, headers: { 'content-type': 'text/event-stream' } };
function sse(m, chunks) { return new Response(sseFrames(m, chunks).join(''), SSE_HEADERS); }
// A stream that dies mid-answer: the first `failAfter` frames arrive, then the
// socket errors — the honest "aborted" path.
function sseBroken(m, chunks, failAfter) {
  const frames = sseFrames(m, chunks);
  const enc = new TextEncoder();
  const body = new ReadableStream({
    start(controller) { frames.slice(0, failAfter).forEach((f) => controller.enqueue(enc.encode(f))); },
    // pull() runs once the enqueued frames have been drained — THEN the socket dies.
    pull(controller) { controller.error(new Error('socket hang up mid-stream')); },
  });
  return new Response(body, SSE_HEADERS);
}
function contentTypes(content) { return [].concat(content).map((c) => (typeof c === 'string' ? 'string' : c.type)); }
function toolResultText(content) {
  return [].concat(content).filter((c) => c && c.type === 'tool_result')
    .map((c) => [].concat(c.content || []).map((x) => (typeof x === 'string' ? x : x.text || '')).join('')).join('\n');
}
let hangFetch = false;   // §10: a transport that never answers (honours the abort signal)
let stallAfter = 0;      // §10: a stream that sends N frames, then never closes
const mockFetch = async (url, init) => {
  const body = JSON.parse(init.body);
  const last = body.messages[body.messages.length - 1];
  if (hangFetch) return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
  calls.push({ model: body.model, stream: !!body.stream, tools: (body.tools || []).map((t) => t.name),
    maxTokens: body.max_tokens, cacheControl: body.cache_control || null,
    lastRole: last.role, lastTypes: contentTypes(last.content), toolResult: toolResultText(last.content),
    system: JSON.stringify(body.system || ''), messages: body.messages });
  const step = script.shift() || { text: '(script exhausted)' };
  if (step.status) return new Response(JSON.stringify({ type: 'error', error: { type: 'api_error', message: step.message || 'Overloaded' } }), { status: step.status, headers: { 'content-type': 'application/json' } });
  const m = step.tool
    ? msg([...(step.text ? [{ type: 'text', text: step.text }] : []), { type: 'tool_use', id: `tu_${calls.length}`, name: step.tool.name, input: step.tool.input }], 'tool_use')
    : msg([{ type: 'text', text: step.chunks ? step.chunks.join('') : step.text }], 'end_turn');
  if (!body.stream) return new Response(JSON.stringify(m), { status: 200, headers: { 'content-type': 'application/json' } });
  if (step.failAfter) return sseBroken(m, step.chunks, step.failAfter);
  if (stallAfter) {
    const frames = sseFrames(m, step.chunks);
    const enc = new TextEncoder();
    return new Response(new ReadableStream({
      start(c) { frames.slice(0, stallAfter).forEach((f) => c.enqueue(enc.encode(f))); },
      pull() { return new Promise(() => {}); },   // never another byte, never closes
    }), SSE_HEADERS);
  }
  return sse(m, step.chunks);
};
model._test.setFetch(mockFetch);

// ── The conduct gate's model call, scripted (the REAL conductPlanner runs) ──
const realReason = claude.reason;
let understand = null;
claude.reason = async ({ system }) => {
  if (/ITERATIVE investigation/.test(String(system)) && understand) {
    return { refused: false, stopReason: 'end_turn', text: JSON.stringify(understand) };
  }
  throw new Error(`unexpected model call outside the runtime: ${String(system).slice(0, 50)}`);
};
conduct.setPlanner(jarvis.conductPlanner);

const VAGUE = { problemReport: true, replyIntent: 'answers', changeAsk: null, specific: false,
  understood: 'Something is wrong with an EPG, but which one is not stated.', hypotheses: [],
  questions: ['Which EPG (and which tenant) is affected?', 'What exactly is failing — no endpoints learned, or contract drops?', 'When did it start?'],
  relevantFronts: ['fabric'] };
const NOT_A_PROBLEM = { problemReport: false, replyIntent: 'answers', changeAsk: null, specific: true,
  understood: 'A direct health question about sw1.', hypotheses: [], questions: [], relevantFronts: [] };
const RELOAD = { problemReport: false, replyIntent: 'answers', changeAsk: 'reload sw2', specific: true,
  understood: 'The operator asked to reload sw2.', hypotheses: [], questions: [], relevantFronts: [] };

// ── The fake host ctx (records every say / sayDelta / status) ───────────────
const ROSTER = [
  { id: 'netops', name: 'NetOps', connected: true, sees: ['campus switches via Catalyst Center'], sources: ['catalyst-center'], note: '' },
  { id: 'router-expert', name: 'Router-Expert', connected: true, sees: ['ACI fabric', 'SD-WAN overlay'], sources: ['aci', 'sdwan'], note: '' },
  { id: 'sentinel', name: 'Sentinel', connected: false, sees: [], sources: [], note: 'not connected — CVE feed' },
];
const said = [], deltas = [], statuses = [], gathers = [], logs = [];
let gatherImpl = null;
let screenImpl = null;
function resetHarness() {
  said.length = 0; deltas.length = 0; statuses.length = 0; gathers.length = 0; logs.length = 0; calls.length = 0;
  script = []; gatherImpl = null; screenImpl = null; understand = null; hangFetch = false; stallAfter = 0;
  conduct._threads.clear();
  runtime.init({
    say: (agent, text, env) => said.push({ agent, text: String(text), env: env || null }),
    sayDelta: (agent, payload) => deltas.push({ agent, ...payload }),
    status: (agent, state, label) => statuses.push({ agent, state, label }),
    log: (line) => logs.push(line),
    nameOf: (id) => (ROSTER.find((a) => a.id === id) || {}).name || id,
    roster: () => ROSTER.slice().concat(mcp.rosterEntries()),
    abilities: () => [{ label: 'Live reads', available: true, plain: 'read the estate' }],
    screen: (q) => (screenImpl ? screenImpl(q) : false),
    conversationId: () => 'conv-cw14',
    gather: (agentId, question, device, incidentId) => {
      gathers.push({ agentId, question, device, incidentId });
      // live-agents.gatherWithEvidence flips the engineer active → idle itself.
      statuses.push({ agent: agentId, state: 'active', label: `Jarvis delegation: ${String(question || '').slice(0, 60)}` });
      const idle = () => statuses.push({ agent: agentId, state: 'idle', label: 'Delegation turn ended' });
      if (gatherImpl) return Promise.resolve().then(() => gatherImpl(agentId, question, device, incidentId)).finally(idle);
      idle();
      return Promise.resolve({ agentId, name: 'NetOps', connected: true, stance: 'evidence',
        text: 'sw1 is healthy: IOS-XE 17.12.01, uptime 41 days, no open issues.',
        cli: [{ host: 'sw1', command: 'show version', output: 'Cisco IOS XE Software, Version 17.12.01\nsw1 uptime is 41 days', transport: 'cmdrunner', source: 'catalyst-center' }] });
    },
  });
}
const kinds = () => said.map((m) => m.env && m.env.kind).filter(Boolean);
const withKind = (k) => said.filter((m) => m.env && m.env.kind === k);
const trim = (o) => JSON.stringify(o).slice(0, 220);

// Spend into a temp dir — never the workspace.
const spendDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw14-spend-'));
spend._setDir(spendDir);

(async () => {
  // ════════════════════════════════════════════════════════════════════════
  section('1. A VAGUE PROBLEM → one kind:ask, ZERO tool calls, zero reads (the 2026-08-19 law, on the runtime):');
  {
    resetHarness();
    understand = VAGUE;
    await runtime.ask('hey jarvis facing issue in epg', { conversationId: 'c1', operatorTz: 'Asia/Kolkata' });
    const asks = withKind('ask');
    ok('exactly ONE kind:ask envelope', asks.length === 1 && said.length === 1, trim(said));
    ok('…carrying the 3 real narrowing questions, text within the cap', asks[0] && asks[0].env.questions.length === 3 && asks[0].text.length <= conduct.TEXT_MAX, trim(asks[0]));
    ok('…the SAME envelope shape jarvis.js emits ({kind:"ask", text, questions})', asks[0] && Object.keys(asks[0].env).sort().join() === 'kind,questions,text');
    ok('ZERO provider requests (the runtime never started)', calls.length === 0, String(calls.length));
    ok('ZERO delegated reads, zero deltas', gathers.length === 0 && deltas.length === 0);
    ok('the thread is parked awaiting-info, like the legacy path', !!conduct.pending('c1'));
    console.log('     wire:', trim(asks[0]));
  }

  // ════════════════════════════════════════════════════════════════════════
  section('2. A SPECIFIC ASK → the model calls delegate_read → finding with evidenceId + cli block → streamed answer:');
  {
    resetHarness();
    understand = NOT_A_PROBLEM;
    const ANSWER = 'sw1 is healthy — IOS-XE 17.12.01, up 41 days, no open issues on the one read that ran.';
    script = [
      { tool: { name: 'delegate_read', input: { agentId: 'netops', question: 'Is sw1 healthy? Read its version, uptime and open issues.', device: 'sw1', incidentId: null } } },
      { chunks: ['sw1 is healthy — ', 'IOS-XE 17.12.01, up 41 da', 'ys, no open issues on the one read that ran.'] },
    ];
    await runtime.ask('is sw1 healthy?', { conversationId: 'c2', operatorTz: null });

    ok('the provider was asked twice (tool turn + answer), streaming, with delegate_read + the handoffs advertised',
      calls.length === 2 && calls[0].stream && calls[0].tools.includes('delegate_read') && calls[0].tools.some((t) => /^transfer_to_Router_Expert$/.test(t)), trim(calls.map((c) => c.tools)));
    ok('the model ran on the test tier (spend rule)', calls.every((c) => c.model === 'claude-sonnet-5'));
    ok('the SDK ran OUR gate-wrapped read exactly once, with the structured device', gathers.length === 1 && gathers[0].agentId === 'netops' && gathers[0].device === 'sw1', trim(gathers));
    const findings = withKind('finding');
    ok('ONE finding envelope on the wire, from the engineer, with the cli block (host / command / output / honest transport)',
      findings.length === 1 && findings[0].agent === 'netops' && findings[0].env.finding.cli && findings[0].env.finding.cli.host === 'sw1'
        && findings[0].env.finding.cli.transport === 'cmdrunner' && /17\.12\.01/.test(findings[0].env.finding.cli.output), trim(findings));
    const evId = findings[0] && findings[0].env.evidenceId;
    ok('…tagged with a stable evidenceId (ev-…)', typeof evId === 'string' && /^ev-/.test(evId), String(evId));
    ok('…finding.line within the 200-char cap; raw output never in text', findings[0] && findings[0].text.length <= conduct.LINE_MAX && !/uptime is 41 days/.test(findings[0].text));
    ok('the tool_result sent BACK to the model carries the same evidenceId and the evidence block',
      calls[1].lastTypes.includes('tool_result') && calls[1].toolResult.includes(`evidence[${evId}]`) && /sw1> show version/.test(calls[1].toolResult), trim(calls[1].toolResult));
    ok('the "@NetOps — question" delegation line was said, as the legacy loop says it', said.some((m) => m.env && m.env.kind === 'say' && /^@NetOps — Is sw1 healthy/.test(m.text)));
    const finals = withKind('say').filter((m) => m.env.messageId);
    const finalMsg = finals[finals.length - 1];
    ok('the final answer is a kind:say chat_message with a messageId, capped', !!finalMsg && finalMsg.text === conduct.capText(ANSWER), trim(finalMsg));
    ok('…and the deltas stream under THAT messageId, ending done:true (not aborted)',
      deltas.length > 0 && deltas.every((d) => d.messageId === finalMsg.env.messageId) && deltas[deltas.length - 1].done === true && !deltas[deltas.length - 1].aborted, trim(deltas));
    ok('…the streamed preview reassembles to the answer', deltas.map((d) => d.delta).join('') === ANSWER, deltas.map((d) => d.delta).join(''));
    ok('presence: NetOps flipped active → idle around the read ONCE (live-agents owns the flip; the runtime does not add a second — review #81)',
      statuses.filter((s) => s.agent === 'netops' && s.state === 'active').length === 1 && statuses.filter((s) => s.agent === 'netops' && s.state === 'idle').length === 1, trim(statuses));
    ok('the "@NetOps — question" line is on the wire once, spoken by Jarvis (same line jarvis.js speaks)', withKind('say').filter((m) => m.agent === 'jarvis' && /^@NetOps — Is sw1 healthy/.test(m.text)).length === 1, trim(withKind('say')));
    ok('request shape: the legacy output bound (max_tokens 3000, never the adapter\'s 128k) and prompt caching (top-level cache_control) on every call',
      calls.every((c) => c.maxTokens === 3000 && c.cacheControl && c.cacheControl.type === 'ephemeral'), trim(calls.map((c) => [c.maxTokens, c.cacheControl])));
    ok('Jarvis ends idle, answered', statuses[statuses.length - 1].agent === 'jarvis' && statuses[statuses.length - 1].state === 'idle');
    ok('no envelope kind outside the pinned set', kinds().every((k) => ['say', 'ask', 'roster', 'finding', 'verdict', 'change'].includes(k)), trim(kinds()));
    console.log('     wire finding:', trim({ ...findings[0], env: { ...findings[0].env, finding: { ...findings[0].env.finding, cli: { ...findings[0].env.finding.cli, output: '…' } } } }));
    console.log('     wire answer :', trim(finalMsg));
  }

  // ════════════════════════════════════════════════════════════════════════
  section('3. "reload sw2" → the honest write refusal, ZERO tool calls, ZERO wire:');
  {
    resetHarness();
    understand = RELOAD;
    script = [{ text: 'I have not reloaded sw2 — this path is read-only. Nothing else was asked.' }];
    await runtime.ask('reload sw2', { conversationId: 'c3' });
    const refusal = said.find((m) => m.env && m.env.kind === 'say' && /this path is read-only, so I have not done it/.test(m.text));
    ok('the refusal is said OUT LOUD, first, in the SAME words conduct.writeRefusalText gives the legacy path',
      !!refusal && said.indexOf(refusal) === 0 && refusal.text === conduct.writeRefusalText({ clause: 'reload sw2', source: 'reasoning' }), trim(said));
    ok('ZERO tool calls (no tool_use reached any tool), ZERO delegated reads (zero wire)', gathers.length === 0 && !calls.some((c) => c.lastTypes.includes('tool_result')));
    ok('no write tool exists for the model to call at all (delegate_read is the only non-handoff tool)',
      calls.length === 0 || calls[0].tools.filter((t) => !/^transfer_to_/.test(t)).join() === 'delegate_read', trim(calls[0] && calls[0].tools));
    ok('the model was told the change was already refused, so it does not chase it', calls.length === 0 || /ALREADY been refused/.test(JSON.stringify(calls[0].messages)));
    console.log('     wire:', trim(refusal));
  }

  // ════════════════════════════════════════════════════════════════════════
  section('4. THE STREAMED ANSWER — cap discipline (never past TEXT_MAX, never mid-word) + aborted on a mid-stream failure:');
  {
    resetHarness();
    understand = NOT_A_PROBLEM;
    const long = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ') + ' — the campus is quiet and nothing points at a fault.';
    // Chunks cut MID-WORD on purpose, like a real token stream.
    const chunks = long.match(/.{1,7}/g);
    script = [{ chunks }];
    await runtime.ask('quick campus status?', { conversationId: 'c4' });
    const shown = deltas.filter((d) => !d.done).map((d) => d.delta).join('');
    ok('the preview never exceeds conduct.TEXT_MAX', shown.length <= conduct.TEXT_MAX, String(shown.length));
    ok('no delta ends mid-word (every delta ends on whitespace or is the final flush)', deltas.filter((d) => !d.done).every((d, i, arr) => /\s$/.test(d.delta) || i === arr.length - 1), trim(deltas.slice(-3)));
    ok('the preview is a prefix of the answer, cut on a word boundary', long.startsWith(shown) && (shown.length === long.length || /\s$/.test(shown) || long[shown.length] === ' '));
    ok('one messageId across all deltas, closed with done:true', new Set(deltas.map((d) => d.messageId)).size === 1 && deltas[deltas.length - 1].done === true);
    const final = withKind('say').find((m) => m.env.messageId);
    ok('the authoritative chat_message carries the SAME messageId and the conduct-capped text', !!final && final.env.messageId === deltas[0].messageId && final.text === conduct.capText(long) && final.text.length <= conduct.TEXT_MAX, trim(final));

    // A failure MID-STREAM → aborted:true, and the honest line settles the bubble.
    resetHarness();
    understand = NOT_A_PROBLEM;
    script = [{ chunks: ['The campus ', 'looks fine so far ', 'but I never got to finish.'], failAfter: 4 }];
    await runtime.ask('campus status?', { conversationId: 'c4b' });
    const last = deltas[deltas.length - 1];
    ok('a mid-stream failure closes the preview with done:true + aborted:true', !!last && last.done === true && last.aborted === true, trim(deltas));
    ok('…never discard:true (nothing was refused — a plain failure)', deltas.every((d) => !d.discard));
    const honest = said.find((m) => /I couldn't complete my reasoning/.test(m.text));
    ok('…and the honest failure line (jarvis.js wording) is said, carrying the same messageId to settle the bubble',
      !!honest && honest.env && honest.env.messageId === last.messageId && /not invented a plan or an answer/.test(honest.text), trim(said));
    ok('…naming the REAL cause (the SDK\'s generic wrapper is unwrapped), never the request body or URL',
      !!honest && /socket hang up mid-stream/.test(honest.text) && !/Failed to process successful response/.test(honest.text) && !/mock\.local|requestBodyValues|messages/.test(honest.text), honest && honest.text);
    ok('…Jarvis ends idle, reasoning unavailable', statuses[statuses.length - 1].state === 'idle' && /unavailable/i.test(statuses[statuses.length - 1].label));
  }

  // ════════════════════════════════════════════════════════════════════════
  section('5. PRESENCE — model-call start/stream/end fire through the SAME claude.js seam server.js installed:');
  {
    resetHarness();
    understand = NOT_A_PROBLEM;
    const events = [];
    claude.setActivityListener((ev) => events.push(ev));
    script = [
      { tool: { name: 'delegate_read', input: { agentId: 'netops', question: 'read sw1', device: 'sw1', incidentId: null } } },
      { chunks: ['sw1 ', 'is fine.'] },
    ];
    await runtime.ask('is sw1 fine?', { conversationId: 'c5' });
    const phases = events.map((e) => e.phase);
    ok('start → end for the tool turn, start → stream → end for the answer (one span per model call)',
      phases.join() === 'start,end,start,stream,end', phases.join());
    ok('each span pairs on its own callId; purpose + conversationId ride along, never prompt text',
      events[0].callId === events[1].callId && events[2].callId === events[3].callId && events[3].callId === events[4].callId
        && events.every((e) => e.purpose === 'runtime' && e.conversationId === 'c5') && !events.some((e) => /sw1/.test(JSON.stringify(e))), trim(events));
    ok('the answer span ends with reason:done', events[4].reason === 'done');

    // A failing call clears the line: end with reason:error.
    events.length = 0;
    resetHarness();
    understand = NOT_A_PROBLEM;
    script = [{ chunks: ['half an ', 'answer'], failAfter: 3 }];
    await runtime.ask('anything?', { conversationId: 'c5b' });
    ok('a failed call ends its span with reason:error (thinking/typing clears on error)', events.some((e) => e.phase === 'end' && e.reason === 'error') && events.filter((e) => e.phase === 'start').length === events.filter((e) => e.phase === 'end').length, trim(events));
    claude.setActivityListener(null);
    ok('claude.activity ignores a malformed event (no callId) instead of throwing', (() => { try { claude.activity({ phase: 'start' }); claude.activity(null); return true; } catch (e) { return false; } })());
  }

  // ════════════════════════════════════════════════════════════════════════
  section('6. MCP — a write-classified tool PAUSES the run and is REJECTED (never executed); a read-only one runs through OUR connector:');
  {
    const realRoster = mcp.rosterEntries;
    const realGather = mcp.gather;
    const mcpCalls = [];
    mcp.rosterEntries = () => [
      { id: 'mcp:catc:catc_find', name: 'MCP · catc · catc_find', connected: true, sees: ['external MCP tool (read) — find a Catalyst Center operation'], note: 'read-only', readOnly: true },
      { id: 'mcp:catc:catc_apply', name: 'MCP · catc · catc_apply', connected: true, sees: ['external MCP tool (write) — apply a template'], note: 'looks like a write', readOnly: false },
    ];
    mcp.gather = async (id, question, opts) => {
      mcpCalls.push({ id, question, opts });
      return { agentId: id, name: 'MCP · catc · catc_find', connected: true, stance: 'evidence', text: 'Called external MCP tool catc:catc_find — real result:\nLOCAL catalogue: 2 health operations' };
    };
    try {
      resetHarness();
      understand = NOT_A_PROBLEM;
      script = [
        { tool: { name: 'mcp__catc__catc_apply', input: { question: 'apply the template', args_json: '{"template":"x"}' } } },
        { text: 'That was a write, so it was not run. Nothing was applied.' },
      ];
      await runtime.ask('push the template through catc', { conversationId: 'c6' });
      ok('both MCP roster entries are advertised as tools (namespaced, through our connector)', calls[0] && calls[0].tools.includes('mcp__catc__catc_find') && calls[0].tools.includes('mcp__catc__catc_apply'), trim(calls[0] && calls[0].tools));
      ok('the write tool NEVER executed — mcp.gather was not called for it (zero external calls)', mcpCalls.length === 0, trim(mcpCalls));
      ok('the pause was rejected and said honestly on the wire', said.some((m) => m.env && m.env.kind === 'say' && /classified as a write, so I did not run it/.test(m.text)), trim(said));
      ok('the run resumed once so the model could finish honestly (2 provider calls)', calls.length === 2 && withKind('say').some((m) => /was not run/.test(m.text)), String(calls.length));
      ok('the rejection reached the model as the tool outcome, not a fabricated success', !/applied/i.test(calls[1].toolResult) || /reject|not approved|denied/i.test(calls[1].toolResult), trim(calls[1].toolResult));
      ok('spend: the resume records each model response ONCE — 2 calls, 2 records (rawResponses is cumulative across a resume; review #81)',
        spend.all().filter((r) => r.purpose === 'runtime' && r.conversationId === 'c6').length === 2, String(spend.all().filter((r) => r.conversationId === 'c6').length));

      // A read-only MCP tool runs — through mcp.gather with approved:false.
      resetHarness();
      understand = NOT_A_PROBLEM;
      script = [
        { tool: { name: 'mcp__catc__catc_find', input: { question: 'health ops', args_json: '{"query":"health","limit":2}' } } },
        { text: 'Two health operations exist in the local catalogue.' },
      ];
      await runtime.ask('what health reads exist?', { conversationId: 'c6b' });
      ok('a read-only MCP tool ran through mcp.gather with the parsed args and approved:false (connector posture kept)',
        mcpCalls.length === 1 && mcpCalls[0].id === 'mcp:catc:catc_find' && mcpCalls[0].opts.args.query === 'health' && mcpCalls[0].opts.approved === false && mcpCalls[0].opts.who === 'jarvis', trim(mcpCalls));
      ok('…its result is a finding envelope with an evidenceId, and the model saw the real result', withKind('finding').length === 1 && /^ev-/.test(withKind('finding')[0].env.evidenceId) && /LOCAL catalogue/.test(calls[1].toolResult));
    } finally {
      mcp.rosterEntries = realRoster; mcp.gather = realGather;
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  section('7. MODEL ERROR → the honest line; a TOOL THROW → an honest string, never a fabricated reading:');
  {
    resetHarness();
    understand = NOT_A_PROBLEM;
    script = [{ status: 500, message: 'Overloaded' }];
    await runtime.ask('is the wan ok?', { conversationId: 'c7' });
    ok('an HTTP failure from the provider → the honest "couldn\'t complete my reasoning" line, no answer invented',
      said.length === 1 && /I couldn't complete my reasoning/.test(said[0].text) && /not invented/.test(said[0].text), trim(said));
    ok('…with the status code and the provider\'s own words (claude.js mapError posture)', /provider error \(500\): .*Overloaded/.test(said[0].text), said[0].text.split('\n')[0]);
    ok('…zero reads, zero deltas, Jarvis idle', gathers.length === 0 && deltas.length === 0 && statuses[statuses.length - 1].state === 'idle');

    resetHarness();
    understand = NOT_A_PROBLEM;
    gatherImpl = async () => { throw new Error('APIC socket reset'); };
    script = [
      { tool: { name: 'delegate_read', input: { agentId: 'router-expert', question: 'fabric health', device: null, incidentId: null } } },
      { text: 'Router-Expert could not read the fabric — the APIC socket reset. No reading, nothing invented.' },
    ];
    await runtime.ask('fabric health?', { conversationId: 'c7b' });
    ok('a throwing read becomes an honest "could not complete" tool result for the model (never a fabricated reading)',
      /could not complete — APIC socket reset/.test(calls[1].toolResult) && /NOT a reading/.test(calls[1].toolResult), trim(calls[1].toolResult));
    ok('…and an honest finding envelope (no cli, stance unreachable in the line) on the wire', withKind('finding').length === 1 && withKind('finding')[0].env.finding.cli === null && /could not complete/.test(withKind('finding')[0].text), trim(withKind('finding')));
    const wrapped = await require('./runtime/squad')._test.honest('t', async () => { throw new Error('boom'); })();
    ok('the honest() wrapper turns a throw into an evidence[none] string naming the failure + "nothing was invented"', /evidence\[none\]/.test(wrapped) && /boom/.test(wrapped) && /nothing was invented/.test(wrapped), wrapped);
    const empty = await require('./runtime/squad')._test.honest('t', async () => '')();
    ok('…and an empty result is said to be empty, not silently dropped', /returned nothing/.test(empty), empty);

    // Nothing at all without a key — the same honest no-key state, zero model calls.
    resetHarness();
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    await runtime.ask('anything', { conversationId: 'c7c' });
    process.env.ANTHROPIC_API_KEY = saved;
    ok('no key → the honest no-key refusal, zero provider calls', said.length === 1 && /no Anthropic API key/.test(said[0].text) && calls.length === 0, trim(said));
  }

  // ════════════════════════════════════════════════════════════════════════
  section('8. SPEND recorded in the same store / shape claude.js writes:');
  {
    const recs = spend.all().filter((r) => r.purpose === 'runtime');
    ok('runtime model calls landed in the spend store under purpose "runtime"', recs.length >= 4, String(recs.length));
    ok('…with the model id and the token counts the transport reported (input 42 / output 7 / cache-read 5)',
      recs.every((r) => r.model === 'claude-sonnet-5') && recs.some((r) => r.input_tokens === 42 && r.output_tokens === 7) && recs.some((r) => r.cache_read_input_tokens === 5), trim(recs[0]));
    ok('…tagged with the conversation, never prompt text', recs.some((r) => r.conversationId === 'c2') && !JSON.stringify(recs).includes('sw1 is healthy'));
    const u = model._test.usageOf({ usage: { inputTokens: 15, outputTokens: 3, inputTokensDetails: [{ cached_tokens: 4, cache_write_tokens: 1 }] } });
    ok('the SDK usage → spend-store shape mapping (SDK inputTokens is the TOTAL; input_tokens is the uncached part, like Anthropic\'s)',
      u.input_tokens === 10 && u.output_tokens === 3 && u.cache_read_input_tokens === 4 && u.cache_creation_input_tokens === 1, trim(u));
  }

  // ════════════════════════════════════════════════════════════════════════
  section('9. THE PROVIDER SEAM (law 10) + THE FLAG (default legacy, legacy untouched):');
  {
    ok('model.describe() names the provider + model, presence only (never the key value)',
      (() => { const d = model.describe(); return d.provider === 'anthropic' && d.model === 'claude-sonnet-5' && d.keyPresent === true && !JSON.stringify(d).includes('test-key-not-real'); })());
    process.env.MODEL_PROVIDER = 'openai';
    let threw = null;
    try { await model.build(); } catch (e) { threw = e; }
    ok('an unwired MODEL_PROVIDER is refused honestly (one case to add in model.js, nothing above it)', !!threw && /not wired up/.test(threw.message) && model.hasKey() === false, threw && threw.message);
    delete process.env.MODEL_PROVIDER;

    const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    const server = read('server.js');
    const pkg = JSON.parse(read('package.json'));
    const envExample = read('.env.example');
    ok('server.js: JARVIS_RUNTIME defaults to legacy and only "agents" selects the runtime',
      /\(process\.env\.JARVIS_RUNTIME \|\| 'legacy'\) === 'agents'/.test(server) && /return runtime\.ask\(command, \{ conversationId/.test(server));
    ok('server.js: the legacy jarvis.ask call is still the default path in simulateJarvisAction',
      /function simulateJarvisAction[\s\S]*?return jarvis\.ask\(command, \{ conversationId: req\.conversationId \|\| 'default', operatorTz: req\.operatorTz \|\| null \}\);/.test(server));
    ok('server.js: the runtime is init-ed with the IDENTICAL ctx object jarvis.init gets', /const jarvisCtx = \{/.test(server) && /jarvis\.init\(jarvisCtx\);\s*\n[\s\S]{0,400}runtime\.init\(jarvisCtx\);/.test(server));
    ok('no product file uses the SDK\'s own MCP client (every MCP call keeps the connector posture)',
      !/MCPServerStdio|MCPServerStreamableHttp/.test(read('sources/runtime/index.js') + read('sources/runtime/squad.js') + read('sources/runtime/model.js') + server));
    ok('package.json pins the runtime deps + this suite is in the test chain',
      pkg.dependencies['@openai/agents'] === '0.17.0' && pkg.dependencies['@openai/agents-extensions'] === '0.17.0' && /@ai-sdk\/anthropic/.test(JSON.stringify(pkg.dependencies)) && /runtime\.cw14\.test\.js/.test(pkg.scripts.test));
    ok('.env.example documents JARVIS_RUNTIME (default legacy) and MODEL_PROVIDER', /JARVIS_RUNTIME=legacy/.test(envExample) && /MODEL_PROVIDER=anthropic/.test(envExample));
    ok('jarvis.js is not required by the runtime modules (the legacy loop is not a dependency of its replacement)',
      !/require\(['"]\.\.\/jarvis['"]\)/.test(read('sources/runtime/index.js') + read('sources/runtime/squad.js')));
  }

  // ════════════════════════════════════════════════════════════════════════
  section('10. REVIEW ROUND 1 (PR #81) — hang, trace leak, bad tool input, handoff attribution, own-id reads:');
  {
    const squadMod = require('./runtime/squad');
    const sdk = await import('@openai/agents');

    // (a) A transport that never answers → aborted at the stall bound, said honestly, presence closed.
    resetHarness();
    understand = NOT_A_PROBLEM;
    hangFetch = true;
    const events = [];
    claude.setActivityListener((ev) => events.push(ev));
    const t0 = Date.now();
    await runtime.ask('is sw1 up?', { conversationId: 'c10a' });
    const took = Date.now() - t0;
    claude.setActivityListener(null);
    ok('a model call that sends NO bytes is aborted at JARVIS_RUNTIME_TIMEOUT_MS (1000ms here), not left hanging', took >= 900 && took < 4000, `${took}ms`);
    ok('…and the honest failure line names the stall — nothing invented', said.length === 1 && /I couldn't complete my reasoning — .*stalled — no bytes for 1000ms/.test(said[0].text), trim(said));
    ok('…no presence span left open (a call that never started streaming opened none), Jarvis idle — no "thinking" left on screen',
      events.filter((e) => e.phase === 'start').length === events.filter((e) => e.phase === 'end').length && statuses[statuses.length - 1].agent === 'jarvis' && statuses[statuses.length - 1].state === 'idle', trim({ events, last: statuses[statuses.length - 1] }));

    // (b) A stream that starts and then stalls mid-answer → aborted:true delta + the honest line settling that bubble.
    resetHarness();
    understand = NOT_A_PROBLEM;
    stallAfter = 3;   // message_start, content_block_start, one delta — then silence
    script = [{ chunks: ['sw1 looks ', 'fine so far.'] }];
    const ev2 = [];
    claude.setActivityListener((ev) => ev2.push(ev));
    await runtime.ask('sw1 quick check', { conversationId: 'c10b' });
    claude.setActivityListener(null);
    const lastDelta = deltas[deltas.length - 1];
    ok('…the open "typing" span is closed with reason:error and Jarvis is idle', ev2.some((e) => e.phase === 'stream') && ev2.some((e) => e.phase === 'end' && e.reason === 'error') && statuses[statuses.length - 1].state === 'idle', trim(ev2));
    ok('a stream that goes silent mid-answer is aborted at the stall bound (aborted:true on the preview)', !!lastDelta && lastDelta.done === true && lastDelta.aborted === true, trim(deltas));
    ok('…and the honest line carries the SAME messageId, so the half-written bubble settles', said.length === 1 && /stalled/.test(said[0].text) && said[0].env && said[0].env.messageId === lastDelta.messageId, trim(said));

    // (c) The SDK's tracing exporter never fires: OPENAI_API_KEY is set for this whole suite, and nothing has left for openai.com.
    const provider = sdk.getGlobalTraceProvider();
    const seen = [];
    provider.registerProcessor({ onTraceStart: async (t) => seen.push(t), onTraceEnd: async () => {}, onSpanStart: async () => {}, onSpanEnd: async () => {}, shutdown: async () => {}, forceFlush: async () => {} });
    const realFetch = globalThis.fetch;
    const outbound = [];
    globalThis.fetch = async (url, init) => { outbound.push(String(url)); return realFetch(url, init); };
    resetHarness();
    understand = NOT_A_PROBLEM;
    script = [{ text: 'sw1 is not something I have a reading for yet.' }];
    await runtime.ask('anything about sw1?', { conversationId: 'c10c' });
    await provider.forceFlush().catch(() => {});
    globalThis.fetch = realFetch;
    ok('tracing is OFF: with OPENAI_API_KEY in the environment, no trace was created and nothing was sent to openai.com (law 5; review #81)',
      seen.length === 0 && !outbound.some((u) => /openai\.com/.test(u)), `${seen.length} traces, outbound=${JSON.stringify(outbound)}`);
    ok('…the runtime disables it before the first run, in code, unconditionally', /setTracingDisabled\(true\)/.test(fs.readFileSync(path.join(__dirname, 'runtime', 'index.js'), 'utf8')));

    // (d) Arguments that fail the tool's schema: nothing runs, nothing is said, the model gets OUR wording.
    resetHarness();
    understand = NOT_A_PROBLEM;
    script = [
      { tool: { name: 'delegate_read', input: { agentId: 'netops', question: 'q', device: null, incidentId: 42 } } },   // incidentId must be string|null
      { text: 'The read could not be made because the arguments were wrong. I have no reading.' },
    ];
    await runtime.ask('sw1 incident?', { conversationId: 'c10d' });
    ok('a schema-invalid tool call runs NOTHING: zero reads, no "@NetOps —" line, no NetOps status flip', gathers.length === 0 && !said.some((m) => /^@NetOps/.test(m.text)) && !statuses.some((s) => s.agent === 'netops'), trim({ gathers, said: said.map((m) => m.text), statuses }));
    ok('…and the model reads OUR words (did not run / did not match / nothing invented), not the SDK\'s "An error occurred…" boilerplate',
      /evidence\[none\] delegate_read: the tool did not run — the arguments did not match/.test(calls[1].toolResult) && /nothing was invented/.test(calls[1].toolResult) && !/An error occurred while running the tool/.test(calls[1].toolResult), trim(calls[1].toolResult));

    // (e) Every engineer gets a read tool bound to ITSELF; only Jarvis can pick an engineer by id.
    const built = await squadMod.build({ roster: () => ROSTER.slice(), nameOf: (id) => id, abilities: () => [], gather: async () => null }, { model: await model.build() });
    ok('Jarvis holds delegate_read (any engineer) + a handoff to every engineer', built.jarvis.tools.some((t) => t.name === 'delegate_read') && built.jarvis.handoffs.length === ROSTER.length);
    ok('each engineer holds exactly ONE read tool, bound to its own id (read_as_<id>), never delegate_read',
      built.engineers.every((e) => e.tools.length === 1 && e.tools[0].name === `read_as_${squadMod._test.toolSafe(built.idOfAgent(e.name))}`), trim(built.engineers.map((e) => e.tools.map((t) => t.name))));
    ok('modelSettingsFor(anthropic) = max 3000 + top-level cache_control; another provider gets the bound only',
      squadMod._test.modelSettingsFor('anthropic').maxTokens === 3000 && squadMod._test.modelSettingsFor('anthropic').providerData.providerOptions.anthropic.cacheControl.type === 'ephemeral' && !squadMod._test.modelSettingsFor('openai').providerData);

    // (f) A handoff: Router-Expert takes it, reads AS ITSELF, and its answer is posted as Router-Expert — not as Jarvis.
    resetHarness();
    understand = NOT_A_PROBLEM;
    gatherImpl = async (agentId) => ({ agentId, name: 'Router-Expert', connected: true, stance: 'evidence', text: 'ACI fabric healthy: 0 faults critical.',
      cli: [{ host: 'apic1', command: 'show faults', output: '0 critical', transport: 'api', source: 'aci' }] });
    script = [
      { tool: { name: 'transfer_to_Router_Expert', input: {} } },
      { tool: { name: 'read_as_router_expert', input: { question: 'fabric faults', device: null, incidentId: null } } },
      { chunks: ['Fabric is clean: ', '0 critical faults on apic1.'] },
    ];
    await runtime.ask('any fabric faults?', { conversationId: 'c10f' });
    ok('after the handoff the model saw ONLY the engineer\'s own read tool (no delegate_read, no handoffs)', calls.length === 3 && calls[1].tools.join() === 'read_as_router_expert', trim(calls.map((c) => c.tools)));
    ok('the read ran as router-expert (own id, never another engineer)', gathers.length === 1 && gathers[0].agentId === 'router-expert', trim(gathers));
    ok('the "@Router-Expert — fabric faults" line is spoken by router-expert itself', withKind('say').some((m) => m.agent === 'router-expert' && /^@Router-Expert — fabric faults/.test(m.text)), trim(withKind('say')));
    const finalRE = withKind('say').filter((m) => m.env.messageId).pop();
    ok('the answer is posted AS Router-Expert (chat_message agent + every delta), settling one preview', !!finalRE && finalRE.agent === 'router-expert' && finalRE.text === 'Fabric is clean: 0 critical faults on apic1.' && deltas.length > 0 && deltas.every((d) => d.agent === 'router-expert' && d.messageId === finalRE.env.messageId), trim({ finalRE, deltas }));
    ok('Router-Expert flipped active ("Took the handoff") → idle, Jarvis ends idle', statuses.some((s) => s.agent === 'router-expert' && s.state === 'active' && /handoff/.test(s.label)) && statuses.some((s) => s.agent === 'router-expert' && s.state === 'idle') && statuses[statuses.length - 1].agent === 'jarvis' && statuses[statuses.length - 1].state === 'idle', trim(statuses));

    // (h) Round 2: a tool the current agent does not hold is answered to the model in our words; the run goes on.
    resetHarness();
    understand = NOT_A_PROBLEM;
    script = [
      { tool: { name: 'reboot_device', input: { device: 'sw1' } } },
      { text: 'There is no such tool here, so nothing ran. Ask for a read.' },
    ];
    await runtime.ask('reboot sw1 via the tool', { conversationId: 'c10h' });
    ok('an unknown tool name does NOT abort the run: the model gets our "no such tool — nothing ran" result and answers', calls.length === 2 && /evidence\[none\] reboot_device: no such tool here — nothing ran/.test(calls[1].toolResult) && withKind('say').some((m) => /nothing ran/.test(m.text)), trim({ n: calls.length, r: calls[1] && calls[1].toolResult, said: said.map((m) => m.text) }));
    ok('…and no SDK "not found in agent" line reached the wire, zero reads', !said.some((m) => /not found in agent/.test(m.text)) && gathers.length === 0, trim(said));

    // (i) Round 2: a provider error body that echoes a key never reaches the wire.
    resetHarness();
    understand = NOT_A_PROBLEM;
    script = [{ status: 401, message: 'invalid x-api-key: sk-ant-fake-not-real-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 (authorization: Bearer sk-ant-fake-not-real-ABCDEFGHIJ)' }];
    await runtime.ask('is sw1 up', { conversationId: 'c10i' });
    ok('a 401 whose body echoes the key → the honest line carries «redacted», never the key', said.length === 1 && /provider error \(401\)/.test(said[0].text) && /«redacted»/.test(said[0].text) && !/sk-ant-fake/.test(said[0].text) && !/sk-ant-fake/.test(logs.join('\n')), trim(said));
    ok('readableError trims the SDK\'s trailing full stop (no "..")', runtime._test.readableError(new Error('Tool x not found in agent Jarvis.')) === 'Tool x not found in agent Jarvis');

    // (g) The key never sits in the model cache signature.
    const modelSrc = fs.readFileSync(path.join(__dirname, 'runtime', 'model.js'), 'utf8');
    ok('model.js keys its cache on a digest of the key, never the key itself', /keyTag/.test(modelSrc) && !/\|\$\{key\}`/.test(modelSrc));
  }

  claude.reason = realReason;
  conduct.setPlanner(null);
  spend._setDir(null);
  try { fs.rmSync(spendDir, { recursive: true, force: true }); } catch (e) { /* tmp */ }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
