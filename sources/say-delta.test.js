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
const conduct = require('./conduct');
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

  // ── PR #74 review, FIX 1: an interrupted stream must leave NO orphan ──────
  // A stream can end two ways: the answer finished, or it was abandoned. In the
  // second case no buffered chat_message will ever carry that messageId, so a
  // client told only "done" would strand a partial, un-conducted fragment of
  // model text on screen looking like Jarvis's answer. Every abandoning exit
  // must say `aborted:true`, and must still post its honest failure message.
  console.log('\nAN INTERRUPTED STREAM LEAVES NO ORPHAN PREVIEW:');

  // (a) the wrapper throws AFTER deltas were delivered (a mid-stream blip).
  initJarvis(true);
  {
    let n = 0;
    claude.reason = async (args) => {
      n += 1;
      if (n === 1) return { refused: false, stopReason: 'end_turn', text: JSON.stringify({
        selfAnswer: null,
        delegations: [{ agentId: 'netops', question: 'check campus health', why: 'owns campus', device: null }],
        standDown: [], note: '' }) };
      if (typeof args.onDelta === 'function') { args.onDelta('Campus reads '); args.onDelta('clean so f'); }
      throw new Error('Could not reach Anthropic: socket hang up');
    };
    await planAndAnswer('what is going on in the campus?');

    const closing = deltas[deltas.length - 1];
    const previewed = deltas.filter((d) => !d.done).map((d) => d.delta).join('');
    ok('a partial preview did reach the operator (this is the real failure case)',
      previewed === 'Campus reads clean so ', JSON.stringify(previewed));
    ok('the half-written word is never shown (the forwarder holds it back)',
      !/so f$/.test(previewed), JSON.stringify(previewed));
    ok('the stream is closed', closing.done === true);
    ok('the closing delta carries aborted:true — "throw the preview away"',
      closing.aborted === true, JSON.stringify(closing));
    ok('the closing delta carries the messageId (nothing anonymous ever goes out)',
      typeof closing.messageId === 'string' && closing.messageId.length > 0);
    // THE SEAM (PR #75): the FE has NO id-less fallback — a final message
    // without the id can never settle a preview, it can only age out on a
    // timer. So the honest failure message must carry the SAME id.
    const failure = said.find((m) => /Summary skipped on this one/.test(m.text));
    ok('the honest failure message is still posted as its own chat message',
      Boolean(failure), JSON.stringify(said.map((m) => m.text)));
    ok('and it carries the SAME messageId, so the FE settles the preview at once',
      failure && failure.env && failure.env.messageId === closing.messageId,
      failure && JSON.stringify(failure.env));
  }

  // (b) the summary was DECLINED twice — same rule: nothing will carry the id.
  initJarvis(true);
  {
    let n = 0;
    claude.reason = async () => {
      n += 1;
      if (n === 1) return { refused: false, stopReason: 'end_turn', text: JSON.stringify({
        selfAnswer: null,
        delegations: [{ agentId: 'netops', question: 'check campus health', why: 'owns campus', device: null }],
        standDown: [], note: '' }) };
      return { refused: true, stopReason: 'refusal', text: '' };
    };
    await planAndAnswer('what is going on in the campus?');
    const closing = deltas[deltas.length - 1];
    ok('a declined summary also closes with aborted:true', closing && closing.done === true && closing.aborted === true,
      JSON.stringify(closing));
    const relayed = said.find((m) => /Summary skipped on this one/.test(m.text));
    ok('and its honest relay message is posted', Boolean(relayed));
    ok('carrying the SAME messageId as the deltas it settles',
      relayed && relayed.env && relayed.env.messageId === closing.messageId,
      relayed && JSON.stringify(relayed.env));
  }

  // (c) a SUCCESSFUL answer must NOT be marked aborted — the flag has to mean
  //     something, or the FE would discard every real answer.
  initJarvis(true);
  script();
  await planAndAnswer('what is going on in the campus?');
  ok('a finished answer closes with done:true and NO aborted flag',
    deltas[deltas.length - 1].done === true && !deltas[deltas.length - 1].aborted,
    JSON.stringify(deltas[deltas.length - 1]));
  ok('and the buffered message with that messageId does arrive',
    said.some((m) => m.env && m.env.messageId === deltas[0].messageId));

  // One assertion for the whole seam: EVERY path that opens a preview closes it
  // with a chat message carrying the same id — success, model error, refusal.
  console.log('\nEVERY PATH THAT OPENS A PREVIEW CLOSES IT WITH THE SAME messageId:');
  const PATHS = [
    ['finished answer', () => { script(); }],
    ['model error mid-stream', () => {
      let k = 0;
      claude.reason = async (args) => {
        k += 1;
        if (k === 1) return { refused: false, stopReason: 'end_turn', text: JSON.stringify({
          selfAnswer: null,
          delegations: [{ agentId: 'netops', question: 'check campus health', why: 'owns campus', device: null }],
          standDown: [], note: '' }) };
        if (typeof args.onDelta === 'function') args.onDelta('partial answer ');
        throw new Error('Could not reach Anthropic: socket hang up');
      };
    }],
    ['summary declined twice', () => {
      let k = 0;
      claude.reason = async () => {
        k += 1;
        if (k === 1) return { refused: false, stopReason: 'end_turn', text: JSON.stringify({
          selfAnswer: null,
          delegations: [{ agentId: 'netops', question: 'check campus health', why: 'owns campus', device: null }],
          standDown: [], note: '' }) };
        return { refused: true, stopReason: 'refusal', text: '' };
      };
    }],
  ];
  for (const [name, arrange] of PATHS) {
    initJarvis(true);
    arrange();
    await planAndAnswer('what is going on in the campus?');
    const id = deltas.length ? deltas[0].messageId : null;
    const settled = id ? said.filter((m) => m.env && m.env.messageId === id) : [];
    ok(`${name}: a chat message carries the preview's messageId`,
      Boolean(id) && settled.length === 1, `id=${id} settling messages=${settled.length}`);
    ok(`${name}: every delta carries that messageId too`,
      deltas.every((d) => d.messageId === id));
  }

  // ── PR #74 review, FIX 2: the preview obeys the 280-char cap ──────────────
  // The conduct layer caps every Jarvis message at TEXT_MAX. A cap enforced in
  // code and then bypassed by a display path is not a cap: the operator briefly
  // read 292 chars of text the cap exists to prevent, then watched the bubble
  // shrink to 278. This is a property test, not one example — many lengths and
  // many chunkings, all asserted.
  console.log('\nTHE PREVIEW OBEYS THE SAME 280-CHAR CAP AS THE MESSAGE (property test):');
  const WORDS = ['campus', 'health', 'score', 'is', 'clean', 'across', 'every', 'switch', 'and', 'nothing',
    'points', 'at', 'a', 'fault', 'yet', 'sw1', 'sw2', 'reads', 'fine', 'right', 'now'];
  function answerOf(len) {
    let out = '';
    let i = 0;
    while (out.length < len) { out += (out ? ' ' : '') + WORDS[i % WORDS.length]; i += 1; }
    return out.slice(0, len).trim() + '.';
  }
  function chunksOf(text, size) {
    const out = [];
    for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
    return out;
  }

  let propChecked = 0, propBad = [];
  for (const len of [40, 120, 279, 281, 400, 900, 2000]) {
    for (const size of [1, 3, 17, 64, 500]) {
      const ANSWER_N = answerOf(len);
      initJarvis(true);
      let n = 0;
      claude.reason = async (args) => {
        n += 1;
        if (n === 1) return { refused: false, stopReason: 'end_turn', text: JSON.stringify({
          selfAnswer: null,
          delegations: [{ agentId: 'netops', question: 'check campus health', why: 'owns campus', device: null }],
          standDown: [], note: '' }) };
        if (typeof args.onDelta === 'function') for (const c of chunksOf(ANSWER_N, size)) args.onDelta(c);
        return { refused: false, stopReason: 'end_turn', text: ANSWER_N };
      };
      await planAndAnswer('what is going on in the campus?');

      const preview = deltas.filter((d) => !d.done).map((d) => d.delta).join('');
      const finalM = said.filter((m) => m.env && m.env.kind === 'say').pop();
      const why = [];
      // 1. never longer than the cap the conduct layer enforces
      if (preview.length > conduct.TEXT_MAX) why.push(`preview ${preview.length} > ${conduct.TEXT_MAX}`);
      // 2. always a real prefix of what the model actually wrote (never invented)
      if (!ANSWER_N.startsWith(preview)) why.push('preview is not a prefix of the answer');
      // 3. the authoritative message is capped as it always was
      if (finalM.text.length > conduct.TEXT_MAX) why.push(`final ${finalM.text.length} > ${conduct.TEXT_MAX}`);
      // 4. when the whole answer fits the cap, preview and final are the SAME
      //    text — nothing to shrink, nothing to correct
      if (len <= conduct.TEXT_MAX - 1 && preview !== finalM.text) why.push(`short answer differs: ${preview.length} vs ${finalM.text.length}`);
      // 5. the preview never ends mid-word once it has been cut at the cap
      if (preview.length === conduct.TEXT_MAX && /\S$/.test(preview) && !ANSWER_N.startsWith(preview + ' ') && ANSWER_N.length > preview.length) {
        // a cut at exactly the cap is only allowed on a word boundary
        if (!/\s$/.test(ANSWER_N.slice(preview.length - 1, preview.length + 1))) why.push('preview ends mid-word');
      }
      propChecked += 1;
      if (why.length) propBad.push(`len=${len} chunk=${size}: ${why.join('; ')}`);
    }
  }
  ok(`${propChecked} length x chunking combinations all obey the cap and the prefix rule`,
    propBad.length === 0, propBad.slice(0, 4).join(' | '));

  // The observed live case from the review: 292 streamed vs 278 final.
  initJarvis(true);
  {
    const LONG = answerOf(292);
    let n = 0;
    claude.reason = async (args) => {
      n += 1;
      if (n === 1) return { refused: false, stopReason: 'end_turn', text: JSON.stringify({
        selfAnswer: null,
        delegations: [{ agentId: 'netops', question: 'check campus health', why: 'owns campus', device: null }],
        standDown: [], note: '' }) };
      if (typeof args.onDelta === 'function') for (const c of chunksOf(LONG, 8)) args.onDelta(c);
      return { refused: false, stopReason: 'end_turn', text: LONG };
    };
    await planAndAnswer('what is going on in the campus?');
    const preview = deltas.filter((d) => !d.done).map((d) => d.delta).join('');
    ok('the reviewed 292-char case: the preview never exceeds the cap',
      preview.length <= conduct.TEXT_MAX, `preview=${preview.length}`);
    ok('and the model text past the cap is simply never forwarded',
      LONG.startsWith(preview) && preview.length < LONG.length);
  }

  claude.reason = realReason;
  console.log(`\nCW-10 say-delta envelope: ${pass} passed, ${fail} failed.`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error('test crashed:', err); process.exit(1); });
