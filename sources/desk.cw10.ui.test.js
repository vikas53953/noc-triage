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
{
  const s = CW9B.createStream();
  s.accept(delta('m1', 'partial'));
  ok('the final message is matched to its preview by id', s.finalFor({ messageId: 'm1', text: 'whole' }) === 'm1');
  ok('a final for an answer we never previewed matches nothing', s.finalFor({ messageId: 'zz' }) === null);
  ok('an id-less final with exactly one preview open still clears it',
    s.finalFor({ text: 'whole' }) === 'm1');
  s.accept(delta('m2', 'another'));
  ok('with two previews open an id-less final is NOT guessed at', s.finalFor({ text: 'whole' }) === null);
  ok('a delta is never treated as a final', s.finalFor(delta('m1', 'x')) === null);
  ok('dropping a settled preview removes it', s.drop('m1') === true && s.size() === 1 && s.get('m1') === null);
  ok('dropping twice is harmless', s.drop('m1') === false);
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
ok('no summary at all is an honest empty state', /No spend data yet/.test(CW9B.spendHtml(null)));
ok('an empty summary never shows a zero as if it were measured',
  /No spend data yet/.test(CW9B.spendHtml({ today: {}, week: {}, byPurpose: {}, byModel: {} })));
ok('the empty state says nothing is being estimated',
  /Nothing is being estimated/.test(CW9B.spendNoteHtml('')));
ok('a 404 reason is shown, escaped', CW9B.spendNoteHtml(XSS).indexOf('<img') === -1 &&
  CW9B.spendNoteHtml(XSS).indexOf('&lt;img') !== -1);
ok('a garbage summary degrades honestly instead of throwing',
  /No spend data yet/.test(CW9B.spendHtml('not a summary')));
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
ok('the desk routes say-delta to the stream', /onSayDelta\(m\.data\)/.test(desk));
ok('the classic console routes say-delta to the stream', /onSayDeltaClassic\(m\.data\)/.test(idx));
ok('a delta inside a chat_message is routed too, on both pages',
  /CW9B\.isDelta\(m\.data\)/.test(desk) && /CW9B\.isDelta\(m\.data\)/.test(idx));
ok('the desk clears the preview BEFORE painting the recorded message',
  desk.indexOf('saySettle(d);') < desk.indexOf("if(cw9Render(d)){"));
ok('the classic console clears the preview before painting too',
  /saySettleClassic\(d\)/.test(idx) &&
  idx.indexOf('saySettleClassic(d)') < idx.indexOf('var outgoing = d.type'));
ok('neither page hand-rolls its own accumulator',
  /CW9B\.createStream\(\)/.test(desk) && /CW9B\.createStream\(\)/.test(idx) &&
  !/\+= *d\.delta/.test(desk) && !/\+= *d\.delta/.test(idx));
ok('the pages only ever put MODULE output into the DOM',
  /body\.innerHTML = r\.html/.test(desk) && /body\.innerHTML = r\.html/.test(idx));
ok('a preview restored from localStorage is not shown as live',
  /cw10SweepRestoredPreviews/.test(desk) && /never recorded/.test(desk));
ok('a preview whose recorded answer never arrives is said out loud, not deleted',
  /stopped mid-answer/.test(desk) && /stopped mid-answer/.test(idx));
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
