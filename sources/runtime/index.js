// runtime/index.js — CW-14 stage A: one Jarvis ask on an ADOPTED agent runtime.
//
// HANDOFF law 9 (Vikas, 2026-09-05): "there is no point in building the loop,
// tool calling and other things — those things are already built. Use those."
// This module is the spike behind `JARVIS_RUNTIME=agents` (default stays
// `legacy`, sources/jarvis.js). The agent loop, tool calling and handoffs are
// the OpenAI Agents SDK's; the model comes from the provider seam
// (runtime/model.js, Anthropic today via the Vercel AI SDK adapter — law 10).
//
// WHAT DOES NOT MOVE — the laws sit around the runtime, never inside it:
//   1. conduct.assess runs FIRST, exactly as jarvis.ask does. A vague problem →
//      the SAME kind:'ask' envelope and STOP: zero tools, zero reads. A change
//      ask → the SAME honest refusal, out loud, before anything else.
//   2. ctx.screen (the capability screen) runs AFTER the gate, as in jarvis.ask.
//   3. Every tool is one of OUR gate-wrapped reads (runtime/squad.js); the SDK
//      never holds a device client or its own MCP client.
//   4. The wire is the CW-9 envelope + CW-10 say_delta + CW-12 presence,
//      through the SAME ctx object server.js hands jarvis.init — an old page
//      cannot tell which loop answered.
//   5. A model failure → the same honest failure line jarvis.js speaks; an
//      approval pause → rejected, said honestly, never executed.
//
// The ctx contract is jarvis.init's: { say(agentId,text,env), sayDelta(agentId,
// payload), status(agentId,state,label), log(line), gather(agentId,question,
// device,incidentId), roster(), abilities(), screen(q), nameOf(id),
// conversationId() }.

const claude = require('../claude');
const conduct = require('../conduct');
const session = require('../session-log');
const model = require('./model');
const squad = require('./squad');

let ctx = null;
function init(hostCtx) { ctx = hostCtx; }

const RULE = '──────────────────────────────────';
const PURPOSE = 'runtime';
// The SDK's own bound on the loop — a runaway model cannot spin tools forever.
const MAX_TURNS = Math.max(2, Number(process.env.JARVIS_RUNTIME_MAX_TURNS) || 8);
// How many times one ask may resume after an approval pause was rejected.
const MAX_RESUMES = 1;

// ── The pinned-envelope helpers (mirror jarvis.js speak / sayDelta) ─────────
function speak(agentId, env) { ctx.say(agentId, env.text, env); }

let deltaSeq = 0;
function newMessageId() { return `jv-${Date.now().toString(36)}-${(deltaSeq += 1).toString(36)}`; }
let callSeq = 0;
function newCallId() { return `rt-${Date.now().toString(36)}-${(++callSeq).toString(36)}`; }

function sayDelta(messageId, delta, done, flags) {
  if (!ctx || typeof ctx.sayDelta !== 'function') return;
  try {
    const payload = { kind: 'say-delta', messageId, delta: String(delta == null ? '' : delta), done: Boolean(done) };
    if (flags && flags.aborted) payload.aborted = true;
    if (flags && flags.discard) payload.discard = true;
    ctx.sayDelta('jarvis', payload);
  } catch (e) { /* a display optimisation must never break the answer */ }
}

// The SAME cap discipline as jarvis.js cappedDeltas: the preview stops at
// conduct.TEXT_MAX on a word boundary, holds back a trailing partial word, and
// releases it on flush() — so a preview never ends mid-word and never shows
// text the conduct layer would cap away.
function cappedDeltas(messageId) {
  let shownLen = 0;
  let pending = '';
  let stopped = false;
  function emit(text) { if (!text) return; shownLen += text.length; sayDelta(messageId, text, false); }
  function fits(text) {
    const room = conduct.TEXT_MAX - shownLen;
    if (room <= 0) return '';
    if (text.length <= room) return text;
    const slice = text.slice(0, room);
    const space = slice.lastIndexOf(' ');
    return space > 0 ? slice.slice(0, space + 1) : '';
  }
  function forward(chunk) {
    if (stopped) return;
    pending += String(chunk == null ? '' : chunk);
    const lastSpace = pending.search(/\s(?=\S*$)/);
    if (lastSpace < 0) return;
    const whole = pending.slice(0, lastSpace + 1);
    pending = pending.slice(lastSpace + 1);
    const out = fits(whole);
    if (out.length < whole.length) stopped = true;
    emit(out);
  }
  forward.emitted = () => shownLen > 0;
  forward.flush = () => {
    if (stopped || !pending) return;
    const out = fits(pending);
    pending = '';
    emit(out);
  };
  return forward;
}

// ── The honest states (same words jarvis.js speaks) ─────────────────────────
function refuseNoKey(question) {
  ctx.say('jarvis',
    `🔑 I can't reason about this yet — I have no Anthropic API key.\n${RULE}\n` +
    `You asked: "${String(question || '').slice(0, 140)}"\n\n` +
    `Being the Principal Engineer here means actually REASONING about who to pull in and ` +
    `why — that runs on a real Claude call, and there is no key on this machine yet. ` +
    `I will NOT fake a plan or an answer, and I will NOT fall back to a keyword router ` +
    `and pass it off as thinking.\n\n` +
    `Add ANTHROPIC_API_KEY to .env.local and I will reason for real. Meanwhile you can ` +
    `still @mention any engineer directly for a live read, or open a triage — those work now.`);
  ctx.status('jarvis', 'idle', 'No API key — declined to reason');
  ctx.log(`[Jarvis] No API key — declined to reason (no fabrication): "${String(question || '').slice(0, 60)}"`);
}

// The API/runtime call failed. The SAME line jarvis.js reasoningError speaks —
// honest, nothing invented — carrying the messageId when a preview was open so
// the FE settles that bubble (the relayFindings seam, PR #75).
// The plain sentence for a failure. The AI SDK wraps the real cause ("socket
// hang up") under a generic "Failed to process successful response", so the
// cause chain is walked to its root — MESSAGES ONLY, never the error object,
// which carries the request body and the URL (same posture as claude.js
// mapError: status code + the provider's own words, nothing from the request).
function readableError(err) {
  if (!err) return 'an unexpected error';
  if (err.message === 'no_api_key') return 'no Anthropic API key is set';
  const messages = [];
  let e = err;
  for (let i = 0; e && i < 5; i++) {
    if (e.message && String(e.message).trim()) messages.push(String(e.message).trim());
    e = e.cause;
  }
  const root = messages[messages.length - 1] || String(err);
  const status = Number(err.statusCode || err.status);
  return Number.isFinite(status) && status > 0 ? `provider error (${status}): ${root}` : root;
}

function reasoningError(q, err, messageId) {
  const msg = readableError(err);
  ctx.say('jarvis',
    `⚠️ I couldn't complete my reasoning — ${msg}.\n${RULE}\n` +
    `I have not invented a plan or an answer. Nothing was sent to any device on the strength of a guess.`,
    messageId ? { messageId } : undefined);
  ctx.status('jarvis', 'idle', 'Reasoning unavailable');
  ctx.log(`[Jarvis] Reasoning error — ${msg}`);
}

// The ask message: mirrors jarvis.js askNarrowing byte for byte — ONE short
// line plus up to 3 real narrowing questions. Nothing engaged, nothing read.
// (Stage C deletes the jarvis.js original; until then the two must not drift.)
function askNarrowing(q, gate) {
  const questions = (gate.questions || []).slice(0, conduct.MAX_QUESTIONS);
  const fit = (lead) => {
    let text = lead;
    let n = 0;
    for (let i = 0; i < questions.length; i++) {
      const next = `${text}\n${i + 1}. ${questions[i]}`;
      if (next.length > conduct.TEXT_MAX) break;
      text = next; n++;
    }
    return { text, n };
  };
  const short = 'Nothing has run yet — first:';
  const withLead = fit(gate.message);
  const body = (withLead.n === questions.length ? withLead : fit(short)).text;
  speak('jarvis', conduct.envelope.ask(body, questions));
  session.recordReasoning({
    command: 'UNDERSTAND',
    raw: `Problem as stated: "${q}"\nNot specific enough to act on. Asked:\n` +
      questions.map((x, i) => `${i + 1}. ${x}`).join('\n'),
    interpretation: 'Ran the shared conduct gate BEFORE any engagement: the problem was underspecified, so Jarvis asked the operator to narrow it and engaged nobody — zero reads, zero device calls.',
  });
  ctx.status('jarvis', 'idle', 'Asked you to narrow it — engaged nobody');
  ctx.log(`[Jarvis] Conduct gate: asked ${questions.length} narrowing question(s), engaged nobody, read nothing — "${q.slice(0, 60)}"`);
}

// ── The front door: SAME order as jarvis.ask, no other ─────────────────────
async function ask(question, opts) {
  if (!ctx) throw new Error('runtime not initialised — call init(ctx) first');
  if (!model.hasKey()) return refuseNoKey(question);

  const q = String(question || '').trim();
  const conversationId = (opts && opts.conversationId) || 'default';
  const operatorTz = (opts && opts.operatorTz) || null;

  // (a) THE CONDUCT GATE, FIRST.
  let gate;
  try {
    gate = await conduct.assess({ conversationId, text: q, operatorTz });
  } catch (err) {
    gate = { decision: 'unavailable', reason: 'failed', changeAsk: conduct.writeAsk(q),
      why: (err && err.message) || 'the gate failed' };
  }

  // A CHANGE ASK IS NEVER MET WITH SILENCE — refused out loud, first.
  if (gate && gate.changeAsk) {
    speak('jarvis', conduct.envelope.say(conduct.writeRefusalText(gate.changeAsk)));
    session.audit({
      what: `change asked in chat: ${String((gate.changeAsk.clause || q)).slice(0, 200)}`,
      result: 'refused out loud on the read-only path — zero device calls, nothing applied',
    });
    ctx.log(`[Jarvis] Change ask refused out loud (${gate.changeAsk.source}) — nothing ran — "${q.slice(0, 60)}"`);
  }

  // Underspecified problem report → ASK and STOP. Zero tools, zero reads.
  if (gate.decision === 'ask') return askNarrowing(q, gate);
  // The understanding step FAILED — fail safe: say so, engage nobody.
  if (gate.decision === 'unavailable' && gate.reason === 'failed') {
    speak('jarvis', conduct.envelope.say(
      `I could not reason about that — ${gate.why}. I have engaged nobody and read nothing. Say it again and I will try once more.`));
    ctx.status('jarvis', 'idle', 'Could not understand it — engaged nobody');
    ctx.log(`[Jarvis] Conduct gate failed safe (${gate.why}) — zero engagement — "${q.slice(0, 60)}"`);
    return;
  }
  // (b) The capability screen, AFTER the gate. It may only refuse or offer.
  if (typeof ctx.screen === 'function' && ctx.screen(q)) return;

  // (c)+(d) The runtime. A specific problem report ('proceed') and a plain
  // question / command ('not-a-problem' / no planner) both run here in stage A;
  // stage B puts the investigation rounds behind it.
  return runOnRuntime(q, gate, { conversationId, operatorTz });
}

// What the model is handed. The gate's understanding rides along (it already
// paid for it); a refused change is named so the model does not chase it.
function inputFor(q, gate, operatorTz) {
  const lines = [`Current time (UTC): ${new Date().toISOString()}${operatorTz ? `  Operator timezone: ${operatorTz}` : ''}`];
  lines.push(`Operator: "${q}"`);
  if (gate && gate.decision === 'proceed' && gate.understood) lines.push(`Understood as: ${gate.understood}`);
  if (gate && gate.changeAsk) {
    lines.push(`NOTE: the change the operator asked for ("${gate.changeAsk.clause || gate.changeAsk.keyword}") has ALREADY been refused out loud — ` +
      `do not attempt it, do not read anything in service of it, and do not offer to do it. Answer only what remains, if anything.`);
  }
  return lines.join('\n');
}

function safeJson(s) { try { return JSON.parse(s); } catch (e) { return null; } }

async function runOnRuntime(q, gate, { conversationId, operatorTz }) {
  ctx.status('jarvis', 'active', 'Reasoning on the agent runtime…');

  const engaged = new Set();         // engineer ids flipped active during the run
  const callAgent = new Map();       // tool callId → engineer id
  let messageId = null;              // the preview in flight (null = none open)
  let deltas = null;
  let buffered = '';                 // text of the response in flight
  let modelCallId = null;            // the presence span in flight
  let streamedOnce = false;
  let lastResult = null;

  const activity = (ev) => claude.activity({ ...ev, purpose: PURPOSE, conversationId });
  const idleEngaged = () => { for (const id of engaged) ctx.status(id, 'idle', 'Reported back to Jarvis'); engaged.clear(); };

  // A delegated read's envelopes go on the wire as `finding` messages — one per
  // terminal block — the moment the read returns, exactly as jarvis.js does.
  const onFinding = (agentId, name, finding, evidenceId, envelopes) => {
    for (const env of envelopes) speak(agentId, env);
    session.recordReasoning({
      command: `DELEGATE → ${agentId}`,
      raw: `Runtime tool delegate_read → ${name}: ${String(finding && finding.stance || '')}\n${String(finding && finding.text || '').slice(0, 400)}`,
      interpretation: `Routed on the agent runtime to ${name}; the read went through the same gate + guardrail + session log; tagged ${evidenceId}.`,
    });
  };

  // Close the preview in flight as a SETTLED say (a chat_message with the same
  // messageId is what settles it on the FE) — used when a response turned out
  // to be narration before a tool call, not the answer.
  const settleNarration = () => {
    if (!messageId) return;
    const text = buffered.trim();
    if (text) {
      deltas.flush();
      sayDelta(messageId, '', true);
      speak('jarvis', { ...conduct.envelope.say(text), messageId });
    }
    messageId = null; deltas = null; buffered = '';
  };

  const onEvent = (ev, squadInfo) => {
    if (ev.type === 'raw_model_stream_event') {
      const d = ev.data || {};
      if (d.type === 'response_started') {
        modelCallId = newCallId(); streamedOnce = false;
        activity({ phase: 'start', callId: modelCallId, streaming: true });
        messageId = newMessageId(); deltas = cappedDeltas(messageId); buffered = '';
      } else if (d.type === 'output_text_delta') {
        if (!modelCallId) { modelCallId = newCallId(); activity({ phase: 'start', callId: modelCallId, streaming: true }); }
        if (!streamedOnce) { streamedOnce = true; activity({ phase: 'stream', callId: modelCallId }); }
        if (!messageId) { messageId = newMessageId(); deltas = cappedDeltas(messageId); buffered = ''; }
        buffered += String(d.delta || '');
        deltas(d.delta);
      } else if (d.type === 'response_done') {
        if (modelCallId) activity({ phase: 'end', callId: modelCallId, reason: 'done' });
        modelCallId = null;
        const output = (d.response && Array.isArray(d.response.output)) ? d.response.output : [];
        const calls = output.some((o) => o && (o.type === 'function_call' || o.type === 'hosted_tool_call'));
        if (calls) settleNarration();
      }
    } else if (ev.type === 'run_item_stream_event') {
      const raw = (ev.item && ev.item.rawItem) || {};
      if (ev.name === 'tool_called') {
        const args = typeof raw.arguments === 'string' ? safeJson(raw.arguments) : (raw.arguments || null);
        if (raw.name === 'delegate_read' && args && args.agentId) {
          const name = (ctx.nameOf && ctx.nameOf(args.agentId)) || args.agentId;
          engaged.add(args.agentId);
          if (raw.callId) callAgent.set(raw.callId, args.agentId);
          ctx.status(args.agentId, 'active', `Jarvis delegation: ${String(args.question || '').slice(0, 60)}`);
          speak('jarvis', conduct.envelope.say(`@${name} — ${String(args.question || '')}`));
          ctx.log(`[Jarvis] Runtime → delegate_read ${args.agentId} — "${String(args.question || '').slice(0, 60)}"`);
        } else {
          ctx.log(`[Jarvis] Runtime → tool ${raw.name || '?'} (${(squadInfo && squadInfo.agentOfTool(raw.name)) || 'not an engineer'})`);
        }
      } else if (ev.name === 'tool_output') {
        const id = raw.callId && callAgent.get(raw.callId);
        if (id) { ctx.status(id, 'idle', 'Reported back to Jarvis'); engaged.delete(id); callAgent.delete(raw.callId); }
      } else if (ev.name === 'handoff_occurred') {
        const target = ev.item && ev.item.targetAgent && ev.item.targetAgent.name;
        const id = target && squadInfo ? squadInfo.idOfAgent(target) : null;
        if (id) { engaged.add(id); ctx.status(id, 'active', 'Took the handoff from Jarvis'); }
        ctx.log(`[Jarvis] Runtime handoff → ${target || '?'}`);
      } else if (ev.name === 'tool_approval_requested') {
        ctx.log(`[Jarvis] Runtime: tool ${raw.name || '?'} asked for approval — held`);
      }
    } else if (ev.type === 'agent_updated_stream_event') {
      ctx.log(`[Jarvis] Runtime: ${ev.agent && ev.agent.name} is answering`);
    }
  };

  let squadInfo = null;
  try {
    const m = await model.build();
    squadInfo = await squad.build(ctx, { model: m, hooks: { onFinding } });
    const { run } = await import('@openai/agents');

    let input = inputFor(q, gate, operatorTz);
    for (let attempt = 0; attempt <= MAX_RESUMES; attempt++) {
      const stream = await run(squadInfo.jarvis, input, { stream: true, maxTurns: MAX_TURNS });
      for await (const ev of stream) onEvent(ev, squadInfo);
      await stream.completed;
      lastResult = stream;
      model.recordUsage(stream.rawResponses, { purpose: PURPOSE, conversationId });

      const pauses = stream.interruptions || [];
      if (!pauses.length) break;
      // (3) An approval pause: a write-classified tool asked to run. Stage A
      // never applies — reject every one, say so honestly, and let the model
      // finish its answer knowing the tool did not run.
      settleNarration();
      for (const item of pauses) {
        const name = (item.rawItem && item.rawItem.name) || 'that tool';
        const id = squadInfo.agentOfTool(name) || name;
        stream.state.reject(item);
        speak('jarvis', conduct.envelope.say(
          `"${id}" is classified as a write, so I did not run it — nothing was sent. Writes go through the change engine, approve-first.`));
        session.audit({
          what: `runtime tool held for approval: ${String(id).slice(0, 200)}`,
          result: 'rejected on the read-only path — never executed, zero external calls',
        });
        ctx.log(`[Jarvis] Runtime: approval pause on ${id} — rejected, not run`);
      }
      if (attempt === MAX_RESUMES) {
        speak('jarvis', conduct.envelope.say(
          'I stopped there: the only step left was a write, which this path does not do. Ask for a read, or open a change.'));
        ctx.status('jarvis', 'idle', 'Stopped at a write — nothing applied');
        idleEngaged();
        return;
      }
      input = stream.state;
    }
  } catch (err) {
    if (modelCallId) { activity({ phase: 'end', callId: modelCallId, reason: 'error' }); modelCallId = null; }
    if (messageId) { sayDelta(messageId, '', true, { aborted: true }); }
    idleEngaged();
    if (lastResult) model.recordUsage(lastResult.rawResponses, { purpose: PURPOSE, conversationId });
    reasoningError(q, err, messageId);
    return;
  }

  // (d) The final answer, in the pinned envelope, settling the preview.
  const answer = String((lastResult && lastResult.finalOutput) || buffered || '').trim();
  if (!answer) {
    if (messageId) sayDelta(messageId, '', true, { aborted: true });
    ctx.say('jarvis',
      `🎖️ The readings from each engineer are above, all real — the runtime finished without a written summary, so I am not inventing one.`,
      messageId ? { messageId } : undefined);
    ctx.status('jarvis', 'idle', 'Relayed to live findings (no summary)');
    idleEngaged();
    return;
  }
  if (!messageId) { messageId = newMessageId(); deltas = cappedDeltas(messageId); }
  deltas.flush();
  sayDelta(messageId, '', true);
  speak('jarvis', { ...conduct.envelope.say(answer), messageId });
  session.recordReasoning({
    command: 'SYNTHESIS',
    raw: answer,
    interpretation: 'Composed on the agent runtime strictly from the tool findings above — no number, device, or status invented.',
  });
  idleEngaged();
  ctx.status('jarvis', 'idle', 'Answered from live findings');
  ctx.log(`[Jarvis] Runtime answered — "${q.slice(0, 50)}"`);
}

module.exports = {
  init, ask,
  _test: { cappedDeltas, askNarrowing, inputFor, readableError, MAX_TURNS, MAX_RESUMES, PURPOSE },
};
