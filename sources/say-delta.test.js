// say-delta.test.js — CW-10 item 3 (BE half): Jarvis's composed answer streams,
// and NOTHING ELSE does.
//
// Deterministic and offline: claude.reason is scripted, so the "model" writes
// its answer in known chunks and the whole envelope contract can be asserted
// without a key or a token.
//
// What is pinned:
//   - deltas arrive in order under ONE messageId, ending with done:true;
//   - the buffered chat_message that follows carries the SAME messageId and is
//     the authoritative record (the deltas are additive, never persisted);
//   - the message is byte-identical to what a pre-CW-10 build would have said
//     (behaviour parity — streaming adds a channel, it does not change output);
//   - AGENT EVIDENCE NEVER STREAMS: a finding is emitted whole, never as deltas;
//   - a host that wires no sayDelta (every existing test and any old surface)
//     is completely unaffected.

const claude = require('./claude');
const jarvis = require('./jarvis');
const { planAndAnswer } = jarvis._test;

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`); }
}

const said = [];      // every buffered chat_message (agentId, text, envelope)
const deltas = [];    // every say-delta payload

function initJarvis(withDelta) {
  said.length = 0; deltas.length = 0;
  const ctx = {
    say: (agentId, text, env) => said.push({ agentId, text: String(text), env: env || null }),
    status: () => {},
    log: () => {},
    nameOf: (id) => id,
    conversationId: () => 'conv-delta',
    // ONE agent, ONE real read, so the answer path runs end to end.
    gather: () => Promise.resolve({
      name: 'NetOps', stance: 'evidence', text: 'Campus reads clean.',
      cli: [{ host: 'sw1', command: 'show version', output: 'IOS-XE 17.12', transport: 'cmdrunner' }],
    }),
    roster: () => [{ id: 'netops', name: 'NetOps', connected: true, sees: ['campus'], sources: ['catalyst-center'], note: '' }],
    abilities: () => [],
  };
  if (withDelta) ctx.sayDelta = (agentId, payload) => deltas.push({ agentId, ...payload });
  jarvis.init(ctx);
}

// The scripted model: a plan (one delegation), then the synthesis, whose text is
// delivered chunk by chunk through onDelta exactly as the SDK stream does.
const ANSWER = 'Campus is clean. One device answered, and nothing points at a fault yet.';
const CHUNKS = ['Campus is clean. ', 'One device answered, ', 'and nothing points at a fault yet.'];
const realReason = claude.reason;
function script() {
  let n = 0;
  claude.reason = async (args) => {
    n += 1;
    if (n === 1) {
      return { refused: false, stopReason: 'end_turn', text: JSON.stringify({
        selfAnswer: null,
        delegations: [{ agentId: 'netops', question: 'check campus health', why: 'owns campus', device: null }],
        standDown: [], note: '',
      }) };
    }
    // The synthesis call — stream it if the caller asked for deltas.
    if (typeof args.onDelta === 'function') for (const c of CHUNKS) args.onDelta(c);
    return { refused: false, stopReason: 'end_turn', text: ANSWER };
  };
}

(async () => {
  console.log('\nWITH a delta-capable host — the composed answer streams:');
  initJarvis(true);
  script();
  await planAndAnswer('what is going on in the campus?');

  const finalMsg = said.filter((s) => s.env && s.env.kind === 'say').pop();
  ok('the buffered say message is still there and is the whole answer',
    Boolean(finalMsg) && finalMsg.text === ANSWER, finalMsg && finalMsg.text);
  ok('deltas were emitted', deltas.length > 0, `deltas=${deltas.length}`);
  ok('every delta is kind "say-delta"', deltas.every((d) => d.kind === 'say-delta'), JSON.stringify(deltas[0]));
  ok('every delta is from jarvis', deltas.every((d) => d.agentId === 'jarvis'));

  const ids = new Set(deltas.map((d) => d.messageId));
  ok('all the deltas share ONE messageId', ids.size === 1, [...ids].join(','));
  ok('the buffered message carries the SAME messageId (so a client can replace it)',
    finalMsg.env.messageId && finalMsg.env.messageId === deltas[0].messageId,
    `${finalMsg.env.messageId} vs ${deltas[0].messageId}`);

  const joined = deltas.filter((d) => !d.done).map((d) => d.delta).join('');
  ok('the deltas concatenate to the answer, in order', joined === ANSWER, JSON.stringify(joined));
  ok('exactly one delta closes the stream with done:true',
    deltas.filter((d) => d.done === true).length === 1);
  ok('the closing delta is the LAST one', deltas[deltas.length - 1].done === true);
  ok('no delta before the last one claims done', deltas.slice(0, -1).every((d) => d.done === false));

  console.log('\nAGENT EVIDENCE NEVER STREAMS:');
  const findingMsgs = said.filter((s) => s.env && s.env.kind === 'finding');
  ok('the agent finding was emitted as a whole message', findingMsgs.length >= 1);
  ok('no finding text was ever streamed as a delta',
    !deltas.some((d) => /show version|IOS-XE|17\.12/.test(String(d.delta))), JSON.stringify(deltas.map((d) => d.delta)));
  ok('only jarvis ever emitted a delta — no agent did',
    deltas.every((d) => d.agentId === 'jarvis'));

  console.log('\nBEHAVIOUR PARITY — a host with no sayDelta sees exactly what it always saw:');
  const withDeltasSaid = said.map((s) => ({ agentId: s.agentId, text: s.text, env: s.env }));
  initJarvis(false);
  script();
  await planAndAnswer('what is going on in the campus?');
  const withoutSaid = said.map((s) => ({ agentId: s.agentId, text: s.text, env: s.env }));
  ok('no deltas are emitted when the host wires none (and nothing throws)', deltas.length === 0);
  ok('the same number of chat messages is spoken either way',
    withoutSaid.length === withDeltasSaid.length, `${withoutSaid.length} vs ${withDeltasSaid.length}`);
  const strip = (list) => JSON.stringify(list.map((m) => ({
    agentId: m.agentId, text: m.text,
    env: m.env ? { ...m.env, messageId: undefined } : null,
  })));
  ok('every message is byte-identical apart from the additive messageId',
    strip(withoutSaid) === strip(withDeltasSaid));
  const finalNo = withoutSaid.filter((s) => s.env && s.env.kind === 'say').pop();
  ok('the answer text itself is unchanged', finalNo.text === ANSWER, finalNo.text);

  claude.reason = realReason;
  console.log(`\nCW-10 say-delta envelope: ${pass} passed, ${fail} failed.`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error('test crashed:', err); process.exit(1); });
