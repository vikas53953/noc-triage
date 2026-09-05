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
  const b2b = sent.length;
  P.answered({ actor: 'jarvis', actorName: 'Jarvis', requestId: 'req-2', clientMessageId: 'm-abc', reason: 'done' });
  ok('answered is a one-shot receipt too, with the same ids and a reason', sent.length === b2b + 1
    && sent[b2b].data.state === 'answered' && sent[b2b].data.requestId === 'req-2' && sent[b2b].data.clientMessageId === 'm-abc' && sent[b2b].data.reason === 'done');
  P.answered({ actor: 'jarvis', requestId: 'req-3', clientMessageId: 'm-x', reason: 'error' });
  ok('…an error outcome is carried honestly', sent[sent.length - 1].data.reason === 'error' && P.size() === 0);
  P.answered({ actor: 'jarvis', requestId: 'req-4', clientMessageId: 'm-y', reason: 'whatever' });
  ok('…an unknown reason degrades to done, never to an invented word', sent[sent.length - 1].data.reason === 'done');

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

  // the belt measures from the last re-state, so live long work is never cut off
  {
    const sentB = [];
    let tb = 5_000_000;
    const PB = presence.create({ broadcast: (type, data) => sentB.push(data), now: () => tb });
    PB.start({ actor: 'netops', actorName: 'NetOps', state: 'checking', id: 'netops' });
    tb += presence.MAX_AGE_MS - 1000;
    PB.start({ actor: 'netops', state: 'checking', id: 'netops' });   // progress re-stated
    tb += 5000;
    ok('a flight re-stated within the window is NOT expired (age counts from the last re-state)', PB.expire() === 0 && PB.size() === 1);
    tb += presence.MAX_AGE_MS + 1;
    ok('…and a flight silent for the whole window is', PB.expire() === 1 && PB.size() === 0 && sentB[sentB.length - 1].reason === 'expired');
    ok('the belt runs on its own timer (not only on snapshot) and can be stopped', typeof PB.stop === 'function' && presence.SWEEP_MS > 0 && presence.SWEEP_MS < presence.MAX_AGE_MS);
    PB.stop();
  }

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
      /pickedUp\(agent\);\s*\n\s*settle\(simulateAgentAction\(agent, command\), agent\)/.test(server) && /pickedUp\(targetId\);\s*\n\s*settle\(simulateAgentAction\(targetId, mentionMessage\), targetId\)/.test(server));
    ok('ANSWERED is sent from the one seam that owns the request end (handler promise settled), never inferred',
      /const settle = \(result, actorId\) => \{\s*\n\s*if \(!result \|\| typeof result\.then !== 'function'\) return;\s*\n\s*result\.then\(\(\) => answered\(actorId, 'done'\), \(\) => answered\(actorId, 'error'\)\);/.test(server)
      && /livePresence\.answered\(/.test(server));
    ok('the unknown-@mention refusal is itself the answer', /Unknown @mention refused[\s\S]{0,120}answered\(agent, 'done'\)/.test(server));
    // review round 2: the seam FAILS CLOSED, and every handler path returns a promise that resolves after its last reply
    ok('settle() fails closed: a non-thenable result emits NO answered receipt', /if \(!result \|\| typeof result\.then !== 'function'\) return;/.test(server));
    ok('ping and help resolve AFTER their delayed reply', (server.match(/return new Promise\(\(resolve\) => setTimeout\(\(\) => \{/g) || []).length === 2
      && /moveTaskOnBoard\(taskTitle, 'inProgress', 'done'\);\s*\n\s*resolve\(true\);/.test(server) && /'Help displayed'\);\s*\n\s*resolve\(true\);/.test(server));
    ok('maybeForget (sync reply) and resumeClarification (the read\'s promise) both hand a thenable back',
      /if \(live\.maybeForget\(agentId, command\)\) return Promise\.resolve\(true\);/.test(server) && /const resumed = live\.resumeClarification\(agentId, command\);\s*\n\s*if \(resumed\) return resumed;/.test(server));
    ok('write refusals (sync) are wrapped so the refusal counts as the reply', (server.match(/Promise\.resolve\(live\.refuseWrite\(/g) || []).length === 2);
    const la = fs.readFileSync(path.join(__dirname, 'live-agents.js'), 'utf8');
    ok('resumeClarification returns the read\'s promise for a pick / "all", and a resolved promise after a sync line',
      /return configKeeper\(p\.agentId, p\.request, \{ allDevices: true \}\)/.test(la) && /return configKeeper\(p\.agentId, p\.request, \{ device: c\.hostname \}\)/.test(la)
      && (la.match(/return Promise\.resolve\(true\);   \/\/ the line above IS the reply/g) || []).length === 3);
    ok('…including the "never mind" cancel branch (review round 3)', /Operator cancelled — ran nothing'\);\s*\n\s*return Promise\.resolve\(true\);/.test(la));
    ok('no say-only branch of resumeClarification returns a bare true any more', !/say\(p\.agentId,[\s\S]{0,400}?\n\s*return true;/.test(la.slice(la.indexOf('function resumeClarification'), la.indexOf('function pickCandidate'))));
    ok('live.handle wraps its synchronous honest replies (not connected / cannot answer)', (la.match(/Promise\.resolve\((notConnected|cannotAnswer)\(/g) || []).length === 3);
    // functional: every runAgentAction-style return is a thenable or false
    const live = require('./live-agents');
    ok('maybeForget still returns false for a non-forget message (route continues)', live.maybeForget('netops', 'show version on sw1') === false);
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
