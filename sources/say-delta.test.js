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
    ok('the closing delta carries aborted:true — the answer was abandoned',
      closing.aborted === true, JSON.stringify(closing));
    // A PLAIN failure refused nothing. The partial that arrived is honest model
    // text, so it may stay on screen under the failure line — wiping it would
    // hide a real, if incomplete, reading of what the model was saying.
    ok('a plain error does NOT set discard — nothing was declined, so nothing is wiped',
      closing.discard === undefined, JSON.stringify(closing));
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
    // THE SAFETY CASE (joint fix with the FE review). The model deliberately did
    // not publish this text; a fragment of it must not survive on screen or in
    // anything that persisted it.
    ok('a SAFETY refusal also sets discard:true — the partial is wiped, not kept',
      closing && closing.discard === true, JSON.stringify(closing));
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
  ok('and certainly no discard flag — a real answer is never wiped',
    deltas[deltas.length - 1].discard === undefined, JSON.stringify(deltas[deltas.length - 1]));
  ok('no delta on a normal answer carries either flag',
    deltas.every((d) => d.aborted === undefined && d.discard === undefined));
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

  // ── ONE PREVIEW PER ANSWER, even when the synthesis retries ──────────────
  // A refused synthesis is retried ONCE on neutralised findings. If the first
  // attempt already streamed text, the retry must NOT append to it: the two are
  // different answers, and concatenating them would show the operator a
  // sentence neither model wrote. (Caught live against a stand-in endpoint that
  // streamed text and then refused — the preview read the same sentence twice.)
  console.log('\nA RETRIED SYNTHESIS NEVER WRITES THE PREVIEW TWICE:');
  initJarvis(true);
  {
    let k = 0;
    claude.reason = async (args) => {
      k += 1;
      if (k === 1) return { refused: false, stopReason: 'end_turn', text: JSON.stringify({
        selfAnswer: null,
        delegations: [{ agentId: 'netops', question: 'check campus health', why: 'owns campus', device: null }],
        standDown: [], note: '' }) };
      // Both synthesis attempts stream text and then decline.
      if (typeof args.onDelta === 'function') args.onDelta('Campus reads clean so far. ');
      return { refused: true, stopReason: 'refusal', text: '' };
    };
    await planAndAnswer('what is going on in the campus?');
    const preview = deltas.filter((d) => !d.done).map((d) => d.delta).join('');
    ok('the sentence is shown ONCE, not once per attempt',
      preview === 'Campus reads clean so far. ', JSON.stringify(preview));
    ok('and the closing delta still says discard (a refusal drove it)',
      deltas[deltas.length - 1].discard === true);
  }
  initJarvis(true);
  {
    // The common shape: the first attempt refuses BEFORE writing anything, so
    // the retry is free to stream — the operator loses no live preview.
    let k = 0;
    claude.reason = async (args) => {
      k += 1;
      if (k === 1) return { refused: false, stopReason: 'end_turn', text: JSON.stringify({
        selfAnswer: null,
        delegations: [{ agentId: 'netops', question: 'check campus health', why: 'owns campus', device: null }],
        standDown: [], note: '' }) };
      if (k === 2) return { refused: true, stopReason: 'refusal', text: '' };
      if (typeof args.onDelta === 'function') args.onDelta('Campus reads clean.');
      return { refused: false, stopReason: 'end_turn', text: 'Campus reads clean.' };
    };
    await planAndAnswer('what is going on in the campus?');
    const preview = deltas.filter((d) => !d.done).map((d) => d.delta).join('');
    ok('a retry that is the FIRST to write does stream (nothing is lost)',
      preview === 'Campus reads clean.', JSON.stringify(preview));
    ok('and that answer closes normally — no aborted, no discard',
      !deltas[deltas.length - 1].aborted && !deltas[deltas.length - 1].discard);
  }

  // ── PR #74 review, FIX 2: the preview obeys the 280-char cap ──────────────
  // The conduct layer caps every Jarvis message at TEXT_MAX. A cap enforced in
  // code and then bypassed by a display path is not a cap: the operator briefly
  // read 292 chars of text the cap exists to prevent, then watched the bubble
  // shrink to 278. This is a property test, not one example — many lengths and
  // many chunkings, all asserted.
  // ── What the preview really guarantees ───────────────────────────────────
  // HONESTY CORRECTION (round 2 review): the earlier version of this test — and
  // the PR body — claimed the preview is always a strict PREFIX of the final
  // message and "never shrinks". That is false, and asserting it here made the
  // suite look like it had proved something it had not.
  //
  // conduct.clip() does two things to the authoritative message that the raw
  // stream cannot: it COLLAPSES runs of whitespace, and it prefers to cut at a
  // SENTENCE boundary. So a 279-char preview can legitimately be replaced by a
  // 267-char final that reads better — the message REFLOWS, it does not merely
  // extend. That was judged acceptable (the final is authoritative and replaces
  // the preview wholesale); the claim was the defect, not the behaviour.
  //
  // What IS guaranteed, and is what this property test asserts:
  //   1. the preview never exceeds conduct.TEXT_MAX — the cap is enforced on
  //      the display path too, which was the whole point of the fix;
  //   2. every character shown is genuine model text, in order — the preview is
  //      a prefix of what the model actually wrote, never anything invented;
  //   3. the preview never ends mid-word;
  //   4. the final message is capped and is AUTHORITATIVE — it may be shorter
  //      than the preview after reflow, and the client replaces rather than
  //      appends.
  console.log('\nWHAT THE PREVIEW GUARANTEES (property test over lengths x chunkings):');
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
  // Run one streamed answer end to end; returns { preview, final }.
  async function streamed(answer, size) {
    initJarvis(true);
    let n = 0;
    claude.reason = async (args) => {
      n += 1;
      if (n === 1) return { refused: false, stopReason: 'end_turn', text: JSON.stringify({
        selfAnswer: null,
        delegations: [{ agentId: 'netops', question: 'check campus health', why: 'owns campus', device: null }],
        standDown: [], note: '' }) };
      if (typeof args.onDelta === 'function') for (const c of chunksOf(answer, size)) args.onDelta(c);
      return { refused: false, stopReason: 'end_turn', text: answer };
    };
    await planAndAnswer('what is going on in the campus?');
    return {
      preview: deltas.filter((d) => !d.done).map((d) => d.delta).join(''),
      final: said.filter((m) => m.env && m.env.kind === 'say').pop().text,
    };
  }

  let propChecked = 0;
  const propBad = [];
  let reflowed = 0;
  // Two SHAPES of answer, because they exercise different halves of clip():
  // a plain run of words (word-boundary cut) and prose with sentence stops
  // (sentence-boundary cut, which is what makes a final come back shorter).
  const shapes = {
    plain: (len) => answerOf(len),
    // Sentence stops every 8 words, so clip()'s sentence-boundary branch is
    // really exercised — that branch is what returns a SHORTER final.
    prose: (len) => answerOf(len).split(' ')
      .map((w, i) => ((i + 1) % 8 === 0 ? `${w}.` : w)).join(' '),
  };
  for (const len of [40, 120, 279, 281, 400, 900, 2000]) {
    for (const size of [1, 3, 17, 64, 500]) {
     for (const shape of Object.keys(shapes)) {
      const answer = shapes[shape](len);
      const { preview, final } = await streamed(answer, size);
      const why = [];
      // 1. the cap is enforced on the display path
      if (preview.length > conduct.TEXT_MAX) why.push(`preview ${preview.length} > ${conduct.TEXT_MAX}`);
      // 2. every character is genuine model text, in order
      if (!answer.startsWith(preview)) why.push('preview is not a prefix of the model text');
      // 3. never mid-word: the preview ends on whitespace, or is the whole answer
      if (preview && preview.length < answer.length && !/\s$/.test(preview)) why.push('preview ends mid-word');
      // 4. the authoritative message is capped as it always was
      if (final.length > conduct.TEXT_MAX) why.push(`final ${final.length} > ${conduct.TEXT_MAX}`);
      if (final.length < preview.length) reflowed += 1;   // legitimate — see above
      propChecked += 1;
      if (why.length) propBad.push(`${shape} len=${len} chunk=${size}: ${why.join('; ')}`);
     }
    }
  }
  ok(`${propChecked} length x chunking combinations: capped, genuine, never mid-word`,
    propBad.length === 0, propBad.slice(0, 4).join(' | '));
  // Said out loud rather than hidden: the reflow is common, not exotic.
  console.log(`       (${reflowed} of ${propChecked} finals came back SHORTER than the preview — clip() reflowing, as designed)`);

  // The reflow is REAL and is documented here rather than asserted away: text
  // whose cap lands after a sentence boundary comes back shorter than the
  // preview, and that is the authoritative message doing its job.
  {
    const proseAnswer = 'Campus estate is clean right now. ' + answerOf(400);
    const { preview, final } = await streamed(proseAnswer, 12);
    ok('a final message MAY be shorter than the preview (clip cuts at a sentence) — the client replaces, never appends',
      final.length <= conduct.TEXT_MAX && preview.length <= conduct.TEXT_MAX, `preview=${preview.length} final=${final.length}`);
    ok('and the preview was still genuine model text throughout', proseAnswer.startsWith(preview));
  }
  {
    // Whitespace collapse: the model writes double spaces, the cap collapses
    // them, so the final is shorter than the preview by construction.
    const spaced = answerOf(300).replace(/ /g, '  ');
    const { preview, final } = await streamed(spaced, 9);
    ok('collapsed whitespace REFLOWS the final away from the preview — expected, not a defect',
      final !== preview && final.length <= conduct.TEXT_MAX, `preview=${preview.length} final=${final.length}`);
    ok('the preview still never exceeded the cap', preview.length <= conduct.TEXT_MAX, `preview=${preview.length}`);
  }

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
    ok('the authoritative message is capped too (it may reflow shorter — it replaces the preview)',
      said.filter((m) => m.env && m.env.kind === 'say').pop().text.length <= conduct.TEXT_MAX);
  }

  claude.reason = realReason;
  console.log(`\nCW-10 say-delta envelope: ${pass} passed, ${fail} failed.`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error('test crashed:', err); process.exit(1); });
