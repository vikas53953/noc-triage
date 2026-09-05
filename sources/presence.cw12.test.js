// presence.cw12.test.js — CW-12 Live Presence (backend half).
//
// Plain words: the console may say "Jarvis is typing…" or "Router-Expert is
// checking…" ONLY while that work is really in flight, and the line must clear
// the moment the work ends — however it ends. A pulsing indicator on a dead
// request is a fabrication, the same class as an invented number. This suite
// pins that law at three seams:
//   1. the tracker (sources/presence.js): a start is a flight, an end clears it,
//      an end without a start sends NOTHING, a leaked flight expires honestly,
//      the reconnect snapshot carries only what is live;
//   2. the model-call seam (claude.reason): start → [stream] → end fire in that
//      order for a call that succeeds, and start → end(error/aborted) for one
//      that fails — from a `finally`, so an end can never be missed;
//   3. the server wiring (server.js text): the three real signals are wired and
//      nothing invents presence from intent.
//
// Deterministic and offline: the SDK's fetch is a mock, the clock is injected.

const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.ANTHROPIC_API_KEY = 'test-key-never-real';
process.env.JARVIS_MODEL = 'claude-opus-5';

const spend = require('./spend-store');
spend._setDir(fs.mkdtempSync(path.join(os.tmpdir(), 'cw12-spend-')));

const presence = require('./presence');
const claude = require('./claude');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`); }
}

console.log('\nCW-12 backend — presence is a mirror of real work, never a guess:\n');

// ── 1. the tracker ──────────────────────────────────────────────────────────
{
  let t = 1_000_000;
  const sent = [];
  const P = presence.create({ broadcast: (type, data) => sent.push({ type, data }), now: () => t });

  ok('nothing is in flight at boot', P.size() === 0 && P.snapshot().length === 0);

  const id = P.start({ actor: 'jarvis', actorName: 'Jarvis', state: 'thinking', id: 'call-1', requestId: 'req-1' });
  ok('a start is broadcast as a presence envelope', sent.length === 1 && sent[0].type === 'presence');
  ok('…with actor, state, id, requestId and a since', (() => {
    const d = sent[0].data;
    return d.actor === 'jarvis' && d.actorName === 'Jarvis' && d.state === 'thinking' && d.id === 'call-1'
      && d.requestId === 'req-1' && typeof d.since === 'string' && typeof d.at === 'string';
  })());
  ok('the start returns the id', id === 'call-1');
  ok('the flight is now live', P.size() === 1 && P.snapshot()[0].id === 'call-1');

  t += 500;
  P.start({ actor: 'jarvis', state: 'typing', id: 'call-1' });
  ok('re-stating the same flight (thinking → typing) updates in place, no second flight', P.size() === 1 && sent[1].data.state === 'typing');
  ok('…and keeps the ORIGINAL since (the work did not restart)', sent[1].data.since === sent[0].data.since);
  ok('…and keeps the actorName it was started with', sent[1].data.actorName === 'Jarvis');

  const ended = P.end({ actor: 'jarvis', id: 'call-1', reason: 'done' });
  ok('an end clears the flight and says so', ended === true && P.size() === 0 && sent[2].data.state === 'done' && sent[2].data.reason === 'done');
  ok('the done envelope still names the flight it closes', sent[2].data.id === 'call-1' && sent[2].data.actor === 'jarvis');

  const before = sent.length;
  const ghost = P.end({ actor: 'jarvis', id: 'never-started' });
  ok('an end without a start sends NOTHING (no invented "done")', ghost === false && sent.length === before);

  ok('a bad state is refused (no flight, no envelope)', P.start({ actor: 'x', state: 'pulsing' }) === null && P.size() === 0 && sent.length === before);
  ok('"done" is not a start state either', P.start({ actor: 'x', state: 'done' }) === null && sent.length === before);
  ok('a start without an actor is refused', P.start({ state: 'typing' }) === null && sent.length === before);

  const b2 = sent.length;
  P.pickedUp({ actor: 'jarvis', actorName: 'Jarvis', requestId: 'req-2', clientMessageId: 'm-abc' });
  ok('picked-up is a one-shot receipt carrying requestId + clientMessageId', sent.length === b2 + 1
    && sent[b2].data.state === 'picked-up' && sent[b2].data.requestId === 'req-2' && sent[b2].data.clientMessageId === 'm-abc');
  ok('…and it is NOT a flight (nothing to end)', P.size() === 0);

  // two agents at once, keyed independently
  P.start({ actor: 'router-expert', actorName: 'Router-Expert', state: 'checking', id: 'router-expert' });
  P.start({ actor: 'netops', actorName: 'NetOps', state: 'checking', id: 'netops' });
  ok('two agents checking at once are two flights', P.size() === 2);
  P.end({ actor: 'netops', id: 'netops' });
  ok('ending one leaves the other live', P.size() === 1 && P.snapshot()[0].actor === 'router-expert');

  // a leaked flight expires honestly
  const b3 = sent.length;
  t += presence.MAX_AGE_MS + 1;
  const snap = P.snapshot();
  ok('a flight older than MAX_AGE is NOT in the reconnect snapshot', snap.length === 0);
  ok('…and its clients are told, with reason "expired"', sent.length === b3 + 1 && sent[b3].data.state === 'done' && sent[b3].data.reason === 'expired');

  // ids are bounded — an actor/id from the wire cannot be unbounded
  const big = 'x'.repeat(5000);
  P.start({ actor: big, state: 'checking', id: big });
  const last = sent[sent.length - 1].data;
  ok('actor and id are bounded', last.actor.length <= 96 && last.id.length <= 96);
  P.end({ actor: big, id: big });
  ok('…and the bounded key still ends cleanly', P.size() === 0);

  // a broadcast that throws never breaks the tracker
  const P2 = presence.create({ broadcast: () => { throw new Error('socket died'); } });
  let threw = false;
  try { P2.start({ actor: 'jarvis', state: 'thinking', id: 'c' }); } catch (e) { threw = true; }
  ok('the tracker never lets its own fan-out throw into a real call path', threw === false && P2.size() === 1);
}

// ── 2. the model-call seam ──────────────────────────────────────────────────
{
  const events = [];
  claude.setActivityListener((ev) => events.push(ev));

  function sse(chunks) {
    const evs = [
      ['message_start', { type: 'message_start', message: { id: 'msg_s', type: 'message', role: 'assistant', model: 'claude-opus-5', content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } }],
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
      ...chunks.map((c) => ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: c } }]),
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }],
      ['message_stop', { type: 'message_stop' }],
    ];
    return new Response(evs.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join(''),
      { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const okBody = () => ({
    id: 'msg_t', type: 'message', role: 'assistant', model: 'claude-opus-5',
    content: [{ type: 'text', text: 'answer' }], stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
  });

  let handler = () => json(okBody());
  claude._test._setFetch(async () => handler());

  (async () => {
    // a plain (non-streamed) call: start, end — and NO stream event
    events.length = 0;
    await claude.reason({ system: 's', messages: [{ role: 'user', content: 'q' }], purpose: 'plan', conversationId: 'c1' });
    ok('a buffered call fires start then end', events.length === 2 && events[0].phase === 'start' && events[1].phase === 'end');
    ok('…under ONE callId', events[0].callId && events[0].callId === events[1].callId);
    ok('…with reason "done" on success', events[1].reason === 'done');
    ok('…carrying purpose + conversationId and NEVER prompt text', events[0].purpose === 'plan' && events[0].conversationId === 'c1'
      && !JSON.stringify(events).includes('"q"') && !('system' in events[0]) && !('messages' in events[0]));
    ok('…and no "stream" phase for a buffered call', !events.some((e) => e.phase === 'stream'));
    ok('a buffered call announces streaming:false', events[0].streaming === false);

    // a streamed call: start, stream (once, at the first chunk), end
    events.length = 0;
    handler = () => sse(['Camp', 'us is ', 'clean.']);
    const got = [];
    const r = await claude.reason({ system: 's', messages: [{ role: 'user', content: 'q' }], purpose: 'synthesis', onDelta: (c) => got.push(c) });
    ok('a streamed call fires start, stream, end in that order',
      events.map((e) => e.phase).join(',') === 'start,stream,end');
    ok('…"stream" fires exactly once, however many chunks', events.filter((e) => e.phase === 'stream').length === 1 && got.length === 3);
    ok('…the deltas still reach the caller unchanged', got.join('') === 'Campus is clean.' && r.text === 'Campus is clean.');
    ok('…and all three share the callId', new Set(events.map((e) => e.callId)).size === 1);

    // a failing call: start, end(error) — from finally
    events.length = 0;
    handler = () => json({ type: 'error', error: { type: 'authentication_error', message: 'bad key' } }, 401);
    let threw = null;
    try { await claude.reason({ system: 's', messages: [{ role: 'user', content: 'q' }] }); } catch (e) { threw = e; }
    ok('a failing call still fires end (the error propagates)', threw && events.length === 2 && events[1].phase === 'end');
    ok('…with reason "error"', events[1].reason === 'error');

    // no key at all: start, end — the honest "offline" path also clears
    events.length = 0;
    const saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = '';
    claude._test._resetClient && claude._test._resetClient();
    let threw2 = null;
    try { await claude.reason({ system: 's', messages: [{ role: 'user', content: 'q' }] }); } catch (e) { threw2 = e; }
    ok('with no key the seam still pairs start with end', threw2 && events.length === 2 && events[0].phase === 'start' && events[1].phase === 'end');
    process.env.ANTHROPIC_API_KEY = saved;
    claude._test._setFetch(async () => handler());

    // a listener that throws never breaks the call
    events.length = 0;
    handler = () => json(okBody());
    claude.setActivityListener(() => { throw new Error('listener bug'); });
    let r2 = null, threw3 = null;
    try { r2 = await claude.reason({ system: 's', messages: [{ role: 'user', content: 'q' }] }); } catch (e) { threw3 = e; }
    ok('a throwing listener cannot break a real call', !threw3 && r2 && r2.text === 'answer');
    claude.setActivityListener(null);

    // two overlapping calls keep distinct ids
    events.length = 0;
    claude.setActivityListener((ev) => events.push(ev));
    let release;
    const gate = new Promise((res) => { release = res; });
    handler = async () => { await gate; return json(okBody()); };
    const a = claude.reason({ system: 's', messages: [{ role: 'user', content: 'a' }] });
    const b = claude.reason({ system: 's', messages: [{ role: 'user', content: 'b' }] });
    ok('two overlapping calls start with two different callIds', events.length === 2 && events[0].callId !== events[1].callId);
    release();
    await Promise.all([a, b]);
    ok('…and both end, each under its own id', events.length === 4
      && events.slice(2).every((e) => e.phase === 'end') && new Set(events.slice(2).map((e) => e.callId)).size === 2);
    claude.setActivityListener(null);

    // ── 3. the server wiring (text-level, like the UI suites) ────────────────
    const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    ok('server creates ONE tracker on the real broadcast', /presence\.create\(\{ broadcast \}\)/.test(server));
    ok('the model-call seam is wired (claude.setActivityListener)', /claude\.setActivityListener\(/.test(server));
    ok('…thinking on start, typing on the first streamed chunk, end on end',
      /phase === 'start'[\s\S]*state: 'thinking'/.test(server) && /phase === 'stream'[\s\S]*state: 'typing'/.test(server) && /phase === 'end'[\s\S]*livePresence\.end\(/.test(server));
    ok('agent reads are wired from updateAgentStatus (active → checking, else end)',
      /status === 'active'[\s\S]{0,400}state: 'checking'/.test(server) && /livePresence\.end\(\{ actor: agentId, id: agentId/.test(server));
    ok('Jarvis is NOT tracked from agent status (its truth is the model seam)', /if \(agentId !== 'jarvis'\) \{\s*\n\s*if \(status === 'active'\)/.test(server));
    ok('approval waits are wired: pending → waiting-approval, update → end',
      /approval_new' && data\.state === 'pending'[\s\S]{0,600}state: 'waiting-approval'/.test(server) && /type === 'approval_update'[\s\S]{0,200}livePresence\.end\(/.test(server));
    ok('the receipt fires right before the handler runs (never on enqueue)',
      /pickedUp\(agent\);\s*\n\s*simulateAgentAction\(agent, command\)/.test(server) && /pickedUp\(targetId\);\s*\n\s*simulateAgentAction\(targetId, mentionMessage\)/.test(server));
    ok('the outgoing echo carries the clientMessageId the page sent', /type: 'outgoing',[\s\S]{0,200}clientMessageId: cmid/.test(server));
    ok('the client id is bounded at the boundary', /clientMessageId\.trim\(\)\.slice\(0, 96\)/.test(server));
    ok('the init snapshot carries live presence (and nothing is persisted)', /presence: livePresence\.snapshot\(\)/.test(server)
      && !/chatStore\.append[A-Za-z]*\([^)]*presence/.test(server));
    ok('/api/command passes clientMessageId through', /clientMessageId: typeof body\.clientMessageId === 'string'/.test(server));
    ok('no timer-driven or keyword-driven presence anywhere (real events only)',
      !/setInterval\([^)]*presence/i.test(server) && !/livePresence\.start\(\{[^}]*state: 'typing'[^}]*\}\)\s*;\s*\/\/\s*fake/i.test(server));

    console.log(`\n${pass} passed, ${fail} failed\n`);
    process.exit(fail ? 1 : 0);
  })().catch((e) => { console.error(e); process.exit(1); });
}
