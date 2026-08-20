// desk.cw10.ui.test.js — CW-10 FRONTEND: streamed answers + the Spend panel.
//
// Plain words: this suite guards the three things this wave added to the screen.
//   1. STREAMING. Jarvis's answer now arrives twice — in pieces while it is
//      being written, then once more as the message the server recorded. The
//      pieces are a PREVIEW. The recorded message must always win, exactly
//      once, with no second bubble left behind, however badly the network
//      mangled the pieces (lost, duplicated, reordered, never finished).
//      The pieces are also raw model text going to the DOM, so they are
//      escaped like every other sink.
//   2. THE SPEND PANEL. It reads the server's usage record. When there is no
//      record — the endpoint is not built yet, or is unreachable, or answers in
//      a shape we cannot read — it must SAY SO. A fabricated or estimated
//      number here would be a lie about money.
//   3. LOW 7b. A non-string member of an envelope array used to print the
//      literal words "[object Object]" on a P1 bridge. It must render as
//      something a human can read.
//
// DETERMINISTIC: no browser, no network. public/cw9-bridge.js is the SHIPPED
// module both pages load, required here directly — the code under test is the
// code that runs.

const fs = require('fs');
const path = require('path');

const CW9B = require('../public/cw9-bridge.js');

let passed = 0, failed = 0;
function ok(name, cond) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}`); }
}
const pub = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
const desk = pub('desk.html');
const idx = pub('index.html');
const sharedJs = pub('cw9-bridge.js');
const sharedCss = pub('cw9-bridge.css');

const XSS = '<img src=x onerror=alert(1)>';
const delta = (id, d, extra) => Object.assign({ kind: 'say-delta', messageId: id, delta: d }, extra || {});

console.log('\nCW-10 UI — streamed answers, the spend panel, and readable list members:\n');

// ── 1. what counts as a delta ───────────────────────────────────────────────
ok('a say-delta with an id is a delta', CW9B.isDelta(delta('m1', 'hi')) === true);
ok('a say-delta with NO id is not usable', CW9B.isDelta({ kind: 'say-delta', delta: 'hi' }) === false);
ok('an ordinary message is not a delta', CW9B.isDelta({ text: 'hello' }) === false);
ok('a CW-9 envelope is not a delta', CW9B.isDelta({ kind: 'verdict', verdict: {} }) === false);
ok('null / a string are not deltas', CW9B.isDelta(null) === false && CW9B.isDelta('x') === false);
ok('a delta is NOT a CW-9 envelope (old cards are untouched)',
  CW9B.isEnvelope({ kind: 'say-delta', messageId: 'm1' }) === false);
ok('a numeric messageId still identifies the answer', CW9B.streamId({ messageId: 7 }) === '7');
ok('an absurd messageId is refused rather than kept as a key',
  CW9B.streamId({ messageId: 'x'.repeat(500) }) === '');

// ── 2. pieces accumulate, in the order they were written ────────────────────
{
  const s = CW9B.createStream();
  const a = s.accept(delta('m1', 'Looking '));
  const b = s.accept(delta('m1', 'at sw1'));
  const c = s.accept(delta('m1', ' now.', { done: true }));
  ok('the first piece tells the page to open a bubble', a.first === true);
  ok('later pieces update the same bubble', b.first === false && c.first === false);
  ok('the pieces accumulate in order', s.get('m1').text === 'Looking at sw1 now.');
  ok('done is carried through', c.done === true && a.done === false);
  ok('two answers stream side by side without mixing',
    (s.accept(delta('m2', 'other')), s.get('m1').text === 'Looking at sw1 now.' && s.get('m2').text === 'other'));
  ok('the stream knows how many answers are open', s.size() === 2);
}

// ── 3. the network misbehaving must not corrupt the answer ──────────────────
{
  const s = CW9B.createStream();
  s.accept(delta('m1', 'one ', { seq: 0 }));
  s.accept(delta('m1', 'two ', { seq: 1 }));
  s.accept(delta('m1', 'two ', { seq: 1 }));            // duplicate replay
  ok('a duplicated piece is not appended twice', s.get('m1').text === 'one two ');
  const late = s.accept(delta('m1', 'stale', { seq: 0 }));
  ok('a piece that arrives late and out of order is ignored', late.stale === true && s.get('m1').text === 'one two ');
  s.accept(delta('m1', 'four', { seq: 4 }));            // seq 2,3 never arrived
  ok('a hole in the pieces is noticed', s.get('m1').gaps === true);
  ok('a hole is said out loud, not hidden', /did not reach the screen/.test(s.accept(delta('m1', '', { seq: 5 })).html));
  ok('the preview still shows what did arrive', s.get('m1').text === 'one two four');
}
{
  const s = CW9B.createStream();
  s.accept(delta('m1', 'a'));
  s.accept(delta('m1', 'b'));
  ok('with no seq at all the pieces are simply appended', s.get('m1').text === 'ab');
}
{
  // a stream that never stops must never be able to freeze the tab
  const s = CW9B.createStream();
  const big = 'x'.repeat(5000);
  for (let i = 0; i < 20; i++) s.accept(delta('m1', big));
  ok('a runaway stream is capped', s.get('m1').text.length === CW9B.MAX_STREAM_CHARS);
  ok('the cap is admitted on screen', s.get('m1').capped === true &&
    /longer than the live preview holds/.test(CW9B.streamPreviewHtml(s.get('m1'))));
}
{
  const s = CW9B.createStream();
  const r = s.accept(delta('m1', { unexpected: 'object' }));
  ok('a wrong-typed piece never prints [object Object]', s.get('m1').text.indexOf('[object Object]') === -1 && r !== null);
  s.accept(delta('m1', null));
  ok('a null piece is simply nothing', s.get('m1').text.indexOf('null') === -1);
}

// ── 4. the recorded message always wins, exactly once ───────────────────────
// ONE rule decides a settle: the messageId matches. Two live reviews found the
// same class of bug from guessing without one — first a finding card claiming a
// preview (a second bubble), then, once the recorded answer was painted into
// the preview's place, an unrelated message claiming a finished preview and
// DELETING Jarvis's answer. There is no id-less path left.
{
  const s = CW9B.createStream();
  s.accept(delta('m1', 'partial'));
  const hit = s.settleFor({ messageId: 'm1', text: 'whole' });
  ok('the recorded message is matched to its preview by id', hit && hit.id === 'm1' && hit.empty === false);
  ok('it reports how much text the operator had already seen', hit.shown === 'partial'.length);
  ok('a record for an answer we never previewed matches nothing', s.settleFor({ messageId: 'zz', text: 'x' }) === null);
}
{
  const s = CW9B.createStream();
  s.accept(delta('m1', 'partial'));
  ok('a still-streaming preview is never claimed by an id-less message',
    s.settleFor({ text: 'whole' }) === null);
  s.accept(delta('m1', ' more', { done: true }));
  ok('a FINISHED preview is not claimed by an id-less message either',
    s.settleFor({ text: 'whole' }) === null);
  ok('a finding card can never claim a preview',
    s.settleFor({ kind: 'finding', finding: { line: 'CRC climbing' } }) === null &&
    s.settleFor({ kind: 'finding', messageId: 'm1', text: 'CRC' }) === null);
  ok('a roster or verdict card cannot either',
    s.settleFor({ kind: 'roster', roster: {} }) === null && s.settleFor({ kind: 'verdict', text: 'x' }) === null);
  ok('a delta is never treated as a record', s.settleFor(delta('m1', 'x')) === null);
  ok('the preview is still intact after all of that', s.get('m1').text === 'partial more' && s.size() === 1);
  ok('dropping a preview removes it', s.drop('m1') === true && s.size() === 0 && s.get('m1') === null);
  ok('dropping twice is harmless', s.drop('m1') === false);
}
// BLOCKER (review round 2): a recorded copy with EMPTY text used to destroy the
// preview and leave nothing behind — the answer the operator had just read
// vanished. An empty record is reported, never obeyed.
{
  const s = CW9B.createStream();
  s.accept(delta('m1', 'Looking at sw1 — the uplink flapped at 10:17.', { done: true }));
  const m = s.settleFor({ messageId: 'm1', text: '' });
  ok('an empty recorded copy does NOT replace the answer', m && m.empty === true);
  ok('the text the operator read is handed back intact',
    m.html.indexOf('Looking at sw1 — the uplink flapped at 10:17.') !== -1);
  ok('the empty record is reported honestly', /came back empty/.test(m.html));
  ok('the caret is gone — nothing is still being written', !/cw9-caret/.test(m.html));
  ok('it no longer waits for a record that already came', !/Waiting for the recorded/.test(m.html));
  ok('the answer stops being live, so it is never swept as an orphan',
    s.size() === 0 && s.isLive('m1') === false);
  ok('whitespace-only counts as empty', (() => {
    const s2 = CW9B.createStream();
    s2.accept(delta('x', 'text', { done: true }));
    return s2.settleFor({ messageId: 'x', text: '   \n ' }).empty === true;
  })());
  ok('a second empty record changes nothing', s.settleFor({ messageId: 'm1', text: '' }) === null);
  const late = s.settleFor({ messageId: 'm1', text: 'the real answer' });
  ok('a LATE real record can still replace what the empty one left', late && late.empty === false);
}
// The backend flags an interrupted stream with done+aborted (BE PR #74).
{
  const s = CW9B.createStream();
  s.accept(delta('m1', 'Half an answer before the'));
  const r = s.accept(delta('m1', ' stream died', { done: true, aborted: true }));
  ok('an aborted stream settles immediately', r.aborted === true && r.settled === 'aborted');
  ok('the partial text is kept, in full', r.html.indexOf('Half an answer before the stream died') !== -1);
  ok('it is labelled as partial, not as an answer', /Answer interrupted/.test(r.html) && /partial text/.test(r.html));
  ok('it never waits for a record that is not coming',
    !/Waiting for the recorded/.test(r.html) && !/cw9-caret/.test(r.html));
  ok('an aborted answer is not live, so the sweeper leaves it alone',
    s.size() === 0 && s.isLive('m1') === false && s.stale(1, 99999999).length === 0);
  ok('the partial text is still readable afterwards', s.get('m1').text.indexOf('stream died') !== -1);
  const late = s.settleFor({ messageId: 'm1', text: 'what the server kept' });
  ok('a record arriving after an abort still replaces the partial', late && late.empty === false);
  ok('done WITHOUT aborted still waits for the record normally', (() => {
    const s2 = CW9B.createStream();
    const r2 = s2.accept(delta('n1', 'all of it', { done: true }));
    return r2.aborted === false && r2.settled === null && s2.isLive('n1') === true;
  })());
}
// A SAFETY-DECLINED abort (done + aborted + discard): the guardrail refused the
// draft, so the text is not "what reached the screen" — it is content that was
// thrown out. It must not survive on screen OR in the saved thread.
{
  const s = CW9B.createStream();
  s.accept(delta('m1', 'REFUSED-CONTENT-ONE the safety check will throw out'));
  const r = s.accept(delta('m1', ' REFUSED-CONTENT-TWO', { done: true, aborted: true, discard: true }));
  ok('a discarded draft is flagged as a discard, not a plain abort',
    r.discard === true && r.settled === 'discarded' && r.aborted === true);
  ok('NOTHING of the draft text is rendered',
    r.html.indexOf('REFUSED-CONTENT-ONE') === -1 && r.html.indexOf('REFUSED-CONTENT-TWO') === -1);
  ok('the operator is told plainly what happened',
    /withdrawn by the safety check/.test(r.html) && /recorded message below is what stands/.test(r.html));
  ok('no caret, no waiting line, no leftover caveats',
    !/cw9-caret/.test(r.html) && !/Waiting for the recorded/.test(r.html) && !/did not reach the screen/.test(r.html));
  ok('the text is dropped from the STATE too, not just from the markup',
    s.get('m1').text === '');
  ok('re-rendering the settled answer can never bring the text back',
    CW9B.streamSettledHtml(s.get('m1'), 'discarded').indexOf('REFUSED-CONTENT') === -1 &&
    CW9B.streamSettledHtml({ text: 'REFUSED-CONTENT-THREE' }, 'discarded').indexOf('REFUSED-CONTENT-THREE') === -1);
  ok('a discarded answer is not live and is never swept as an orphan',
    s.size() === 0 && s.isLive('m1') === false && s.stale(1, 99999999).length === 0);
  const late = s.settleFor({ messageId: 'm1', text: 'What the server actually recorded.' });
  ok('the follow-up record with the same id settles normally',
    late && late.empty === false && late.shown === 0);
  ok('a discarded draft that was capped or holed carries none of that over', (() => {
    const s2 = CW9B.createStream();
    s2.accept(delta('d1', 'x'.repeat(30000)));
    const r2 = s2.accept(delta('d1', 'tail', { seq: 9, done: true, aborted: true, discard: true }));
    return !/longer than the live preview/.test(r2.html) && s2.get('d1').text === '';
  })());
}
// aborted WITHOUT discard is unchanged — the partial is the operator's evidence.
{
  const s = CW9B.createStream();
  const r = s.accept(delta('m1', 'Half an answer', { done: true, aborted: true }));
  ok('a plain abort still KEEPS the partial text', r.html.indexOf('Half an answer') !== -1);
  ok('a plain abort is not a discard', r.discard === false && r.settled === 'aborted');
  ok('and it still says it was interrupted, not withdrawn',
    /Answer interrupted/.test(r.html) && !/withdrawn by the safety check/.test(r.html));
  ok('discard:true without an abort changes nothing', (() => {
    const s2 = CW9B.createStream();
    const r2 = s2.accept(delta('q1', 'still streaming', { discard: true }));
    return r2.settled === null && s2.get('q1').text === 'still streaming';
  })());
}
{
  // the answer that never finished: not deleted, not left pretending to be live
  const s = CW9B.createStream();
  s.accept(delta('m1', 'half an answer'), 1000);
  ok('a preview is not stale while it is moving', s.stale(45000, 5000).length === 0);
  ok('a preview with no final is eventually flagged', s.stale(45000, 60000)[0] === 'm1');
}

// ── 5. the pieces are raw model text — escaped like every other sink ────────
{
  const s = CW9B.createStream();
  s.accept(delta('m1', '<script>alert("stream")</script>'));
  s.accept(delta('m1', '\n' + XSS));
  const html = CW9B.streamPreviewHtml(s.get('m1'));
  ok('a script tag in the stream cannot open a tag', !/<script/i.test(html));
  ok('an event handler in the stream cannot survive', html.indexOf('<img') === -1);
  ok('the streamed text still shows, escaped', html.indexOf('&lt;script&gt;') !== -1);
  ok('newlines in the stream become line breaks, not markup', html.indexOf('<br>') !== -1);
  const tags = (html.match(/<[^>]+>/g) || []).map((t) => t.slice(1, -1));
  const bad = tags.find((t) => {
    const name = t.split(/[\s>]/)[0].toLowerCase();
    return ['span', '/span', 'br'].indexOf(name) === -1 || /\son\w+\s*=/i.test(t);
  });
  ok('the preview emits only its own tags', bad === undefined);
  ok('the caret blinks while the answer is still being written', /cw9-caret/.test(html));
  s.accept(delta('m1', '', { done: true }));
  ok('the caret stops the moment the last piece lands', !/cw9-caret/.test(CW9B.streamPreviewHtml(s.get('m1'))));
  ok('a finished preview says it is still waiting for the record',
    /Waiting for the recorded answer/.test(CW9B.streamPreviewHtml(s.get('m1'))));
}
{
  const s = CW9B.createStream();
  const r = s.accept(delta('m1', ''));
  ok('an empty first piece says Jarvis is answering, not an empty bubble',
    /Jarvis is answering/.test(r.html));
}

// ── 6. LOW 7b — a list member that is not a string ──────────────────────────
ok('an object member never renders as [object Object]',
  CW9B.itemText({ step: 'reseat the SFP' }).indexOf('[object Object]') === -1);
ok('an object member renders as something readable',
  CW9B.itemText({ step: 'reseat the SFP' }) === '{"step":"reseat the SFP"}');
ok('a number member keeps its value', CW9B.itemText(3) === '3' && CW9B.itemText(0) === '0');
ok('a null member is nothing at all', CW9B.itemText(null) === '' && CW9B.itemText(undefined) === '');
ok('an enormous member is trimmed, not dumped',
  CW9B.itemText({ a: 'y'.repeat(5000) }).length < 500 &&
  /trimmed for display/.test(CW9B.itemText({ a: 'y'.repeat(5000) })));
{
  const cyc = { a: 1 }; cyc.self = cyc;
  ok('a circular member cannot throw the card away', /cannot show/.test(CW9B.itemText(cyc)));
}
{
  const ask = CW9B.askHtml({ questions: [{ q: 'which device?' }, 'and since when?', 42, null] });
  ok('object questions render readably in the ask card',
    ask.indexOf('[object Object]') === -1 && ask.indexOf('which device?') !== -1);
  ok('the plain questions beside them are untouched', ask.indexOf('and since when?') !== -1);
  ok('an empty member is dropped rather than printed as a blank line',
    (ask.match(/<li>/g) || []).length === 3);
  const chg = CW9B.changeHtml({ change: { id: 'C1', steps: [{ cmd: 'shut' }, 'then no shut'] } });
  ok('object change steps render readably', chg.indexOf('[object Object]') === -1 && chg.indexOf('&quot;cmd&quot;') !== -1);
  ok('a hostile object member is still escaped',
    CW9B.changeHtml({ change: { steps: [{ x: XSS }] } }).indexOf('<img') === -1);
}

// ── 7. the spend panel — honest before it is pretty ─────────────────────────
// BLOCKER (review round 2): "nothing has been spent yet" is a claim about the
// server's record. It may only be made when a summary was actually UNDERSTOOD
// and its counters really are zero. A body this panel cannot read is a
// different claim, and the branch that said so was dead code — normalizeSpend
// never threw, so an unreadable shape quietly claimed zero spend.
ok('an empty summary never shows a zero as if it were measured',
  /No spend data yet/.test(CW9B.spendHtml({ today: {}, week: {}, byPurpose: {}, byModel: {} })));
ok('a summary that IS understood and really is zero says nothing was spent',
  /nothing has been spent yet/.test(CW9B.spendHtml({ today: {}, week: {} })));
ok('the empty state says nothing is being estimated',
  /Nothing is being estimated/.test(CW9B.spendNoteHtml('')));
ok('a 404 reason is shown, escaped', CW9B.spendNoteHtml(XSS).indexOf('<img') === -1 &&
  CW9B.spendNoteHtml(XSS).indexOf('&lt;img') !== -1);
ok('a body that is not a summary at all is UNREADABLE, not zero spend',
  /can't be read/.test(CW9B.spendHtml('not a summary')) &&
  !/nothing has been spent/.test(CW9B.spendHtml('not a summary')));
ok('null, a number and an array are unreadable too',
  /can't be read/.test(CW9B.spendHtml(null)) && /can't be read/.test(CW9B.spendHtml(7)) &&
  /can't be read/.test(CW9B.spendHtml([{ today: 1 }])));
ok('an object naming none of the fields this panel reads is unreadable',
  /can't be read/.test(CW9B.spendHtml({ spend: 12, currency: 'usd' })));
ok('the unreadable state refuses to guess in either direction',
  /may or may not be spend recorded/.test(CW9B.spendUnreadableHtml('')));
ok('unreadable is flagged on the normalised shape, not just in the markup',
  CW9B.normalizeSpend('nonsense').unreadable === true &&
  CW9B.normalizeSpend({ today: {} }).unreadable === false &&
  CW9B.normalizeSpend({ today: {} }).empty === true);
ok('a summary that throws while being read is unreadable, never zero', (() => {
  const hostile = { get today() { throw new Error('boom'); } };
  const html = CW9B.spendHtml(hostile);
  return /can't be read/.test(html) && !/nothing has been spent/.test(html);
})());
{
  const fx = require('../test/cw10-say-delta-fixture.js').CW10_SPEND_FIXTURE;
  const html = CW9B.spendHtml(fx);
  ok('the fixture summary renders both totals', /Today/.test(html) && /This week/.test(html));
  ok('the totals are the real sum of the recorded counters',
    html.indexOf('315k') !== -1);   // 184320+21440+96110+12800 = 314670
  ok('the per-purpose bars are drawn', /What it went on/.test(html) && /understand/.test(html));
  ok('the per-model split is drawn', /Which model/.test(html) && /claude-opus-5/.test(html));
  ok('the biggest purpose is listed first',
    html.indexOf('investigate') < html.indexOf('understand'));
  ok('no bar can overflow its track',
    (html.match(/width:(\d+)%/g) || []).every((w) => Number(w.match(/\d+/)[0]) <= 100));
  ok('no price is ever printed — the record does not hold one',
    !/[$£€]/.test(html) && /No price is shown/.test(html));
  ok('the model split states what share it is', /% of all tokens/.test(html));
}
{
  // a half-populated record: what is measured is shown, what is not says so
  const html = CW9B.spendHtml({ today: { input_tokens: 100, output_tokens: 10 } });
  ok('a week with no record says so rather than showing 0', /nothing recorded/.test(html));
  ok('the day that IS recorded still shows', html.indexOf('110') !== -1 || /110/.test(html));
}
{
  const html = CW9B.spendHtml({ byPurpose: [{ purpose: XSS, input_tokens: 5 }], byModel: { [XSS]: { input_tokens: 5 } } });
  ok('a hostile purpose or model name cannot open a tag', html.indexOf('<img') === -1);
  ok('the hostile name still shows as text', html.indexOf('&lt;img') !== -1);
  const tags = (html.match(/<[^>]+>/g) || []).map((t) => t.slice(1, -1));
  const bad = tags.find((t) => {
    const name = t.split(/[\s>]/)[0].toLowerCase();
    return ['div', '/div', 'span', '/span', 'b', '/b'].indexOf(name) === -1 || /\son\w+\s*=/i.test(t);
  });
  ok('the spend panel emits only its own tags', bad === undefined);
}
ok('a list shape and a map shape both read the same',
  CW9B.normalizeSpend({ byPurpose: [{ purpose: 'plan', input_tokens: 5 }] }).purposes[0].name === 'plan' &&
  CW9B.normalizeSpend({ byPurpose: { plan: { input_tokens: 5 } } }).purposes[0].name === 'plan');
ok('camelCase and snake_case counters both read the same',
  CW9B.normalizeSpend({ today: { inputTokens: 10 } }).today.input === 10 &&
  CW9B.normalizeSpend({ today: { input_tokens: 10 } }).today.input === 10);
ok('a negative or nonsense counter is treated as no measurement, never as data',
  CW9B.normalizeSpend({ today: { input_tokens: -5 } }).today.input === 0 &&
  CW9B.normalizeSpend({ today: { input_tokens: 'lots' } }).today.input === 0);
ok('totals nested under a totals object are found too',
  CW9B.normalizeSpend({ totals: { today: { input_tokens: 9 } } }).today.input === 9);

// ── 8. both pages, one implementation ──────────────────────────────────────
// The wire shape pinned with the backend (PR #74): pieces ride their OWN WS
// message type 'say_delta'; they do NOT arrive inside a chat_message.
ok('the desk listens for the pinned say_delta message type',
  /m\.type === 'say_delta'[\s\S]{0,120}onSayDelta\(m\.data\)/.test(desk));
ok('the classic console listens for it too',
  /m\.type === 'say_delta'[\s\S]{0,140}onSayDeltaClassic\(m\.data\)/.test(idx));
ok('a delta smuggled inside a chat_message is still not painted as a message',
  /CW9B\.isDelta\(m\.data\)/.test(desk) && /CW9B\.isDelta\(m\.data\)/.test(idx));
ok('the desk clears the preview BEFORE painting the recorded message',
  desk.indexOf('var slot = saySettle(d);') < desk.indexOf('onChatPaint(d)'));
ok('the classic console clears the preview before painting too',
  /var sayslot = \(d && d\.type !== 'outgoing'\) \? saySettleClassic\(d\)/.test(idx) &&
  idx.indexOf('saySettleClassic(d)') < idx.indexOf('var outgoing = d.type'));
// A shrinking bubble must not read as text quietly lost: the server caps what
// it records at 280 characters, so the recorded answer is routinely SHORTER
// than the preview the operator was just reading.
ok('a recorded answer shorter than the preview is explained, on both pages',
  /shorter than the live preview/.test(desk) && /shorter than the live preview/.test(idx));
ok('the length actually shown is what the note is measured against',
  /slot\.shown - finalLen > 40/.test(desk) && /sayslot\.shown - String\(d\.text \|\| ''\)\.length > 40/.test(idx));
// The preview holds its PLACE in the thread: findings and roster cards keep
// arriving while an answer streams, and an answer that jumped to the bottom is
// an answer the operator has to go looking for.
ok('the recorded answer is painted into the slot the preview held',
  /createComment\('say-slot'\)/.test(desk) && /createComment\('say-slot'\)/.test(idx) &&
  /insertBefore\(moved\[i\], slot\.mark\)/.test(desk) &&
  /sayslot\.mark\.parentNode\.insertBefore\(el, sayslot\.mark\)/.test(idx));
ok('the slot marker is always cleaned up, even when nothing is painted',
  /finally\{ sayTakeSlot\(/.test(desk) && /sayDropSlot\(sayslot\);\s*\n\s*return;/.test(idx));
ok('neither page hand-rolls its own accumulator',
  /CW9B\.createStream\(\)/.test(desk) && /CW9B\.createStream\(\)/.test(idx) &&
  !/\+= *d\.delta/.test(desk) && !/\+= *d\.delta/.test(idx));
ok('the pages only ever put MODULE output into the DOM',
  /body\.innerHTML = r\.html/.test(desk) && /body\.innerHTML = r\.html/.test(idx));
ok('a preview restored from localStorage is not shown as live',
  /cw10SweepRestoredPreviews/.test(desk) && /never recorded/.test(desk));
ok('a preview whose recorded answer never arrives is said out loud, not deleted',
  /CW9B\.streamSettledHtml\(st, 'orphan'\)/.test(desk) && /CW9B\.streamSettledHtml\(st, 'orphan'\)/.test(idx));
ok('the wording for a settled preview lives in the module, not in two pages',
  /stopped mid-answer/.test(sharedJs) && !/stopped mid-answer/.test(desk) && !/stopped mid-answer/.test(idx));
ok('a settled preview keeps its text on both pages (innerHTML from the module, never emptied)',
  /body\.innerHTML = html;/.test(desk) && /body\.innerHTML = html;/.test(idx));
ok('old messages with no deltas render exactly as before (nothing was removed)',
  /jvMsg\(d\.agentName \|\| d\.agent \|\| 'Jarvis', d\.text \|\| '', d\.timestamp\);/.test(desk));

// ── 9. the spend panel is wired to the real endpoint, honestly ─────────────
ok('the desk has a collapsible Spend panel', /<details class="spendpanel"/.test(desk));
ok('it reads the real endpoint', /api\('\/api\/spend\/summary'\)/.test(desk));
ok('a 404 is an honest "not recorded yet", not an error and not a zero',
  /r\.status === 404/.test(desk) && /does not record model usage yet/.test(desk));
ok('an unreachable server is admitted too', /could not be read/.test(desk));
ok('the panel draws through the shared module, not its own markup',
  /CW9B\.spendHtml\(d\)/.test(desk) && /CW9B\.spendNoteHtml\(/.test(desk));
ok('a closed panel does not poll the server', /if\(!p\.open\) return;/.test(desk));
// BLOCKER (review round 2): an open Spend panel grew the queue footer until the
// incident queue and the "Open a new triage" button were pushed out of a column
// that clips its overflow (620px and 760px shells). The panel's contents scroll
// inside the panel, and the footer can never take more than half the column.
ok('the panel contents scroll inside the panel',
  /\.sp-body\{[^}]*max-height:clamp\([^}]*overflow-y:auto/.test(sharedCss.replace(/\s+/g, '')));
ok('the queue footer can never take the whole column',
  /\.qfoot\{[^}]*max-height:50%[^}]*overflow-y:auto/.test(desk.replace(/\s+/g, '')));
ok('the reason is written down where the next person will see it',
  /pushed out of a column/.test(sharedCss) && /never push the work queue/.test(desk));

// BLOCKER (review round 2): an empty recorded copy must not delete the answer.
ok('both pages relabel the preview instead of deleting it on an empty record',
  /if\(m\.empty\)\{/.test(desk) && /if\(m\.empty\)\{/.test(idx));
ok('both pages then paint NOTHING in its place (no empty bubble)',
  /if\(slot && slot\.empty\) return;/.test(desk) && /if\(sayslot && sayslot\.empty\) return;/.test(idx));
ok('the bridge path refuses an empty record the same way', /if\(tslot && tslot\.empty\) break;/.test(desk));
ok('the settled node stops being a live preview but is still replaceable later',
  /data-say-settled/.test(desk) && /data-say-settled/.test(idx));

// An interrupted stream (BE PR #74: done + aborted).
ok('both pages settle an aborted stream at once', /if\(r\.settled\)\{/.test(desk) && /if\(r\.settled\)\{/.test(idx));
ok('the abort wording lives in the module', /Answer interrupted/.test(sharedJs) &&
  !/Answer interrupted/.test(desk) && !/Answer interrupted/.test(idx));
// The persistence half of the discard: the desk SAVES its thread, so removing a
// withdrawn draft from the screen is not enough — the saved copy must be
// rewritten at once, not in 300ms, or a reload brings it back.
ok('the desk flushes its saved thread immediately on a discard',
  /if\(r\.discard\) persistNow\(\); else persistWork\(\);/.test(desk));
ok('persistNow writes on the spot, not on the debounce',
  /function persistNow\(\)\{\s*clearTimeout\(persistT\);/.test(desk));
ok('the ordinary path is still debounced', /persistT = setTimeout\(persistNow, 300\);/.test(desk));
ok('the reason is written down where the next person will see it',
  /reload must never bring back what the safety check refused/.test(desk));
ok('the classic console has no local copy of the thread to clear',
  !/localStorage\.setItem\([^)]*chat/i.test(idx));
ok('the panel styles live with the shared module', /\.spendpanel\{/.test(sharedCss) && /\.sp-fill\{/.test(sharedCss));
ok('the streamed-answer styles do too', /\.cw9-caret\{/.test(sharedCss));
ok('the caret respects reduced motion', /prefers-reduced-motion[\s\S]*cw9-caret/.test(sharedCss));

// ── 10. the module stays runnable in node and in a browser ────────────────
ok('the shared module is still DOM-free', !/\bdocument\.|window\.(?!CW9B)/.test(sharedJs));
ok('the dev fixture is not loaded by the app',
  !/cw10-say-delta-fixture/.test(desk.replace(/\/\*[\s\S]*?\*\//g, '')) &&
  fs.existsSync(path.join(__dirname, '..', 'test', 'cw10-say-delta-fixture.js')));
ok('the dev hooks are marked as dev-only, on both pages',
  /DEV\/TEST ONLY[\s\S]{0,400}__cw10DevDelta/.test(desk) && /DEV\/TEST ONLY[\s\S]{0,400}__cw10DevDelta/.test(idx));
// Each hook must appear exactly ONCE on the page — as the line that defines it.
// A second mention would mean the product itself is calling a test door.
ok('nothing in the product calls a dev hook',
  ['__cw10DevDelta', '__cw10DevSay', '__cw10DevSpend'].every((h) => (desk.split(h).length - 1) === 1) &&
  ['__cw10DevDelta', '__cw10DevSay'].every((h) => (idx.split(h).length - 1) === 1));

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
