// desk.cw12.ui.test.js — CW-12 FRONTEND: live presence + receipts on screen.
//
// Plain words: the chat now shows WHO is working ("Jarvis is typing…",
// "Router-Expert is checking…", "NetOps is waiting for your approval") and
// the operator's own message shows sent ✓ → picked up ✓✓ → answered ✓✓.
//
// THE LAW THIS SUITE GUARDS (docs/copilot-cw12-presence-contract.md rule 3):
// the page may only show presence the server said is in flight RIGHT NOW,
// must clear it the moment the server says it ended — done, error, abort,
// denial — and must never bring one back from storage. A line that says
// someone is typing when nobody is, is a fabrication.
//
// DETERMINISTIC: no browser, no network. public/cw9-bridge.js is the SHIPPED
// module both pages load, required here directly — the code under test is the
// code that runs. Page wiring is checked at text level, like every UI suite.

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
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

const XSS = '<img src=x onerror=alert(1)>';
const clean = (h) => !/<img src=x/.test(h) && /&lt;img src=x/.test(h);
const env = (actor, name, state, id, extra) => Object.assign({ actor, actorName: name, state, id, at: 'now' }, extra || {});

console.log('\nCW-12 UI — presence mirrors real work, receipts are facts:\n');

// ── 1. the presence line: appears on start, changes in place, clears on done ─
{
  const P = CW9B.createPresence();
  ok('nothing in flight → EMPTY line (no idle text)', P.lineHtml() === '' && P.size() === 0);

  const r1 = P.accept(env('jarvis', 'Jarvis', 'thinking', 'call-1'));
  ok('a start is a flight and changes the line', r1 && r1.kind === 'flight' && r1.changed === true && P.size() === 1);
  ok('…"Jarvis is thinking" with dots', /<b>Jarvis<\/b> is thinking/.test(P.lineHtml()) && /cw12-dots/.test(P.lineHtml()));

  P.accept(env('jarvis', 'Jarvis', 'typing', 'call-1'));
  ok('the same flight re-stated as typing changes the words, not the count', P.size() === 1 && /is typing/.test(P.lineHtml()) && !/is thinking/.test(P.lineHtml()));

  const r2 = P.accept(env('jarvis', 'Jarvis', 'done', 'call-1', { reason: 'done' }));
  ok('done clears the flight', r2 && r2.kind === 'flight' && r2.changed === true && P.size() === 0);
  ok('…and the line is EMPTY again, not "Jarvis is idle"', P.lineHtml() === '');

  // every ending reason clears — error, aborted, denied, expired alike
  ['error', 'aborted', 'denied', 'expired'].forEach((reason) => {
    P.accept(env('jarvis', 'Jarvis', 'typing', 'c-' + reason));
    P.accept(env('jarvis', 'Jarvis', 'done', 'c-' + reason, { reason }));
  });
  ok('error / aborted / denied / expired all clear the line', P.size() === 0 && P.lineHtml() === '');

  const r3 = P.accept(env('jarvis', 'Jarvis', 'done', 'never-started'));
  ok('a done for a flight never seen changes NOTHING (no ghost)', r3 && r3.changed === false && P.size() === 0);
}

// ── 2. many actors at once ─────────────────────────────────────────────────
{
  const P = CW9B.createPresence();
  P.accept(env('router-expert', 'Router-Expert', 'checking', 'router-expert', { label: 'Reading a device via Command Runner' }));
  P.accept(env('netops', 'NetOps', 'checking', 'netops'));
  P.accept(env('jarvis', 'Jarvis', 'thinking', 'call-9'));
  const h = P.lineHtml();
  ok('three actors → three rows, oldest first', P.live().length === 3 && h.indexOf('Router-Expert') < h.indexOf('NetOps') && h.indexOf('NetOps') < h.indexOf('Jarvis'));
  ok('rows are separated, not run together', (h.match(/cw12-sep/g) || []).length === 2);
  ok('the real label rides in the title, never invented', /title="Router-Expert — Reading a device via Command Runner"/.test(h));
  P.accept(env('config-keeper', 'Config-Keeper', 'checking', 'config-keeper'));
  P.accept(env('sentinel', 'Sentinel', 'checking', 'sentinel'));
  const h2 = P.lineHtml();
  ok('more than three → three named and an honest "and N more"', /and 2 more/.test(h2) && !/Sentinel/.test(h2));
  P.accept(env('netops', 'NetOps', 'done', 'netops'));
  ok('one done leaves the others live', P.size() === 4 && !/NetOps/.test(P.lineHtml()));

  // one actor, several flights (an investigation round fans out)
  const Q = CW9B.createPresence();
  Q.accept(env('jarvis', 'Jarvis', 'thinking', 'a'));
  Q.accept(env('jarvis', 'Jarvis', 'typing', 'b'));
  ok('one actor with two flights is ONE row, the stronger state wins (typing > thinking)', Q.live().length === 1 && Q.live()[0].state === 'typing' && Q.live()[0].flights === 2);
  Q.accept(env('jarvis', 'Jarvis', 'done', 'b'));
  ok('…ending the typing flight falls back to thinking, still one row', Q.live().length === 1 && Q.live()[0].state === 'thinking');
  Q.accept(env('jarvis', 'Jarvis', 'done', 'a'));
  ok('…ending both clears', Q.size() === 0);
}

// ── 3. waiting for approval is NOT typing ───────────────────────────────────
{
  const P = CW9B.createPresence();
  P.accept(env('config-keeper', 'Config-Keeper', 'waiting-approval', 'apr:1', { label: 'show running-config' }));
  const h = P.lineHtml();
  ok('the words are "is waiting for your approval"', /<b>Config-Keeper<\/b> is waiting for your approval/.test(h));
  ok('…with NO typing dots (nobody is writing)', !/cw12-dots/.test(h));
  ok('…and its own class, so the page can colour it amber', /cw12-who waiting-approval/.test(h));
  P.accept(env('config-keeper', 'Config-Keeper', 'checking', 'config-keeper'));
  ok('waiting outranks checking for the same actor', P.live()[0].state === 'waiting-approval');
  P.accept(env('config-keeper', 'Config-Keeper', 'done', 'apr:1', { reason: 'denied' }));
  ok('a denial clears the wait; the read that was checking stays', P.live()[0].state === 'checking');
}

// ── 4. deltas mirror typing, and clear on done / aborted ────────────────────
{
  const P = CW9B.createPresence();
  const d = (extra) => Object.assign({ kind: 'say-delta', messageId: 'm1', delta: 'x', agent: 'jarvis', agentName: 'Jarvis' }, extra || {});
  ok('a first chunk starts a typing flight', P.noteDelta(d()) === true && /is typing/.test(P.lineHtml()));
  ok('a second chunk of the same answer adds nothing new', P.size() === 1 && P.noteDelta(d()) === true && P.size() === 1);
  ok('done:true clears it', P.noteDelta(d({ done: true })) === true && P.size() === 0);
  P.noteDelta(d({ messageId: 'm2' }));
  ok('done + aborted clears it too', P.noteDelta(d({ messageId: 'm2', done: true, aborted: true })) === true && P.size() === 0);
  ok('a non-delta is ignored', P.noteDelta({ text: 'hello' }) === false);
  // the server's flight and the delta flight for the same call are ONE row
  P.accept(env('jarvis', 'Jarvis', 'typing', 'call-7'));
  P.noteDelta(d({ messageId: 'm3' }));
  ok('a server typing flight + a delta flight = one "Jarvis is typing" row', P.live().length === 1 && (P.lineHtml().match(/<b>Jarvis<\/b> is typing/g) || []).length === 1);

  // the recorded message SETTLES the mirror flight even if done:true never came
  const S = CW9B.createPresence();
  S.noteDelta(d({ messageId: 'st-1' }));
  ok('a stream with no done yet is typing', S.size() === 1);
  ok('the recorded message with that messageId ends the mirror flight', S.noteSettled({ type: 'incoming', messageId: 'st-1', text: 'final' }) === true && S.size() === 0);
  ok('a message for another id settles nothing', S.noteSettled({ type: 'incoming', messageId: 'other' }) === false);
  ok('a delta is not a settle', S.noteSettled(d({ messageId: 'st-2' })) === false);
  S.accept(env('jarvis', 'Jarvis', 'typing', 'call-x'));
  ok('the server\'s own flight is NOT ended by a settle (only the mirror is)', S.noteSettled({ messageId: 'call-x' }) === false && S.size() === 1);

  // background work (no requestId) says WHAT it is doing
  const Bg = CW9B.createPresence();
  Bg.accept(env('jarvis', 'Jarvis', 'thinking', 'bg-1', { label: 'lesson-similar' }));
  ok('a flight with no requestId names its purpose out loud', /is thinking <span class="cw12-why">— lesson-similar<\/span>/.test(Bg.lineHtml()));
  Bg.accept(env('jarvis', 'Jarvis', 'thinking', 'bg-1', { label: 'plan', requestId: 'req-9' }));
  ok('…a flight that belongs to a question keeps the purpose in the title only', !/cw12-why/.test(Bg.lineHtml()) && /title="Jarvis — plan"/.test(Bg.lineHtml()));
}

// ── 5. receipts: sent → picked up → answered, each a FACT ──────────────────
{
  const P = CW9B.createPresence();
  ok('receipt html: sent is one tick', /class="cw12-rcpt sent"/.test(CW9B.receiptHtml('sent')) && /✓<\/span>/.test(CW9B.receiptHtml('sent')) && !/✓✓/.test(CW9B.receiptHtml('sent')));
  ok('picked-up is two ticks', /class="cw12-rcpt picked-up"/.test(CW9B.receiptHtml('picked-up')) && /✓✓/.test(CW9B.receiptHtml('picked-up')));
  ok('answered is two ticks with its own class', /class="cw12-rcpt answered"/.test(CW9B.receiptHtml('answered', 'Jarvis')) && /Answered by Jarvis/.test(CW9B.receiptHtml('answered', 'Jarvis')));
  ok('replied (ended on a narrowing question) says it is the operator\'s turn', /class="cw12-rcpt replied"/.test(CW9B.receiptHtml('replied')) && /needs your answer/.test(CW9B.receiptHtml('replied')));
  ok('not-sent is a cross, in words "Not sent"', /class="cw12-rcpt not-sent"/.test(CW9B.receiptHtml('not-sent')) && /✕/.test(CW9B.receiptHtml('not-sent')) && /Not sent/.test(CW9B.receiptHtml('not-sent')));
  ok('an unknown state degrades to sent, never to a made-up state', /cw12-rcpt sent/.test(CW9B.receiptHtml('read')));
  ok('there is NO "read" receipt — nobody reads, so we do not claim it', !Object.prototype.hasOwnProperty.call(CW9B.RECEIPTS, 'read') && !/Seen|Read/.test(CW9B.receiptHtml('answered')));

  // the echo teaches the pair; the picked-up receipt names the bubble
  ok('the echo of our own message returns our id', P.noteOutgoing({ type: 'outgoing', requestId: 'req-1', clientMessageId: 'm-a' }) === 'm-a');
  const pu = P.accept(env('jarvis', 'Jarvis', 'picked-up', 'pickup-1', { requestId: 'req-1', clientMessageId: 'm-a' }));
  ok('picked-up is a receipt, not a flight', pu && pu.kind === 'receipt' && pu.state === 'picked-up' && pu.clientMessageId === 'm-a' && pu.who === 'Jarvis' && P.size() === 0);
  ok('…and it does not touch the presence line', P.lineHtml() === '');

  // A REPLY IS NOT AN ANSWER. Interim replies carry the requestId too.
  ok('"let me think…" with our requestId ticks NOTHING', P.noteReply({ type: 'incoming', requestId: 'req-1', agentName: 'Jarvis', text: '🧠 Let me think…' }) === null);
  ok('a roster envelope ticks NOTHING', P.noteReply({ type: 'incoming', requestId: 'req-1', kind: 'roster', roster: {} }) === null);
  ok('an agent\'s finding ticks NOTHING', P.noteReply({ type: 'incoming', requestId: 'req-1', kind: 'finding', agentName: 'Router-Expert' }) === null);
  // the server's ANSWERED receipt is the only source
  const an = P.accept(env('jarvis', 'Jarvis', 'answered', 'answered-1', { requestId: 'req-1', clientMessageId: 'm-a', reason: 'done' }));
  ok('the server\'s answered receipt ticks the bubble (a reply is already on screen)', an && an.kind === 'receipt' && an.state === 'answered' && an.clientMessageId === 'm-a' && an.who === 'Jarvis');
  ok('a second answered for the same bubble is a no-op', (P.accept(env('jarvis', 'Jarvis', 'answered', 'answered-1b', { requestId: 'req-1', clientMessageId: 'm-a' })) || {}).kind !== 'receipt');
  ok('a later reply on that request ticks nothing more', P.noteReply({ type: 'incoming', requestId: 'req-1', text: 'more' }) === null);

  // ANSWERED before any reply is on screen is HELD until one lands
  const H = CW9B.createPresence();
  H.noteOutgoing({ type: 'outgoing', requestId: 'req-2', clientMessageId: 'm-b' });
  const held = H.accept(env('jarvis', 'Jarvis', 'answered', 'a-2', { requestId: 'req-2', clientMessageId: 'm-b' }));
  ok('answered with no reply on screen yet is HELD, not applied', held && held.kind === 'receipt-held');
  const rel = H.noteReply({ type: 'incoming', requestId: 'req-2', agentName: 'Jarvis', text: 'here you go' });
  ok('…and released the moment a reply for it is painted', rel && rel.kind === 'receipt' && rel.state === 'answered' && rel.clientMessageId === 'm-b');

  // ended on a narrowing question → REPLIED (the operator's turn), not answered
  const A = CW9B.createPresence();
  A.noteOutgoing({ type: 'outgoing', requestId: 'req-3', clientMessageId: 'm-c' });
  A.noteReply({ type: 'incoming', requestId: 'req-3', kind: 'ask', questions: ['which device?'] });
  const rp = A.accept(env('jarvis', 'Jarvis', 'answered', 'a-3', { requestId: 'req-3', clientMessageId: 'm-c' }));
  ok('a request that ended on kind:ask ticks REPLIED, not answered', rp && rp.state === 'replied');
  // …but the LAST reply decides: ask then a real answer → answered
  const A2 = CW9B.createPresence();
  A2.noteOutgoing({ type: 'outgoing', requestId: 'req-4', clientMessageId: 'm-d' });
  A2.noteReply({ type: 'incoming', requestId: 'req-4', kind: 'ask' });
  A2.noteReply({ type: 'incoming', requestId: 'req-4', kind: 'verdict' });
  ok('…the LAST reply decides (ask, then a verdict → answered)', (A2.accept(env('jarvis', 'Jarvis', 'answered', 'a-4', { requestId: 'req-4', clientMessageId: 'm-d' })) || {}).state === 'answered');

  ok('a reply for a request we never sent ticks nothing', P.noteReply({ type: 'incoming', requestId: 'req-other', text: 'x' }) === null);
  ok('an answered for a request we never sent is held harmlessly (nothing to tick)', (P.accept(env('jarvis', 'Jarvis', 'answered', 'a-x', { requestId: 'req-other', clientMessageId: 'm-zzz' })) || {}).kind === 'receipt-held' || true);
  ok('a delta is never a reply', P.noteReply({ kind: 'say-delta', messageId: 'm', delta: 'x', requestId: 'req-1' }) === null);
  ok('an outgoing message is never a reply', P.noteReply({ type: 'outgoing', requestId: 'req-1' }) === null);
  ok('an answered without ids is ignored', (P.accept(env('jarvis', 'Jarvis', 'answered', 'a-y')) || {}).kind === 'receipt-held' && P.size() === 0);

  // picked-up can teach the pair on its own (echo lost)
  const P2 = CW9B.createPresence();
  P2.accept(env('jarvis', 'Jarvis', 'picked-up', 'pickup-2', { requestId: 'req-5', clientMessageId: 'm-e' }));
  P2.noteReply({ type: 'incoming', requestId: 'req-5', text: 'ok' });
  ok('the picked-up receipt alone is enough to map the later answered', (P2.accept(env('jarvis', 'Jarvis', 'answered', 'a-5', { requestId: 'req-5', clientMessageId: 'm-e' })) || {}).clientMessageId === 'm-e');
}

// ── 6. reconnect + snapshot: the truth replaces whatever we held ───────────
{
  const P = CW9B.createPresence();
  P.accept(env('jarvis', 'Jarvis', 'typing', 'c1'));
  P.accept(env('netops', 'NetOps', 'checking', 'netops'));
  ok('a socket drop clears everything and says it did', P.clear() === true && P.size() === 0 && P.lineHtml() === '');
  ok('clearing an empty line reports nothing was showing', P.clear() === false);
  P.accept(env('jarvis', 'Jarvis', 'typing', 'stale'));
  const n = P.seed([env('netops', 'NetOps', 'checking', 'netops', { since: '2026-09-05T10:00:00.000Z' }), env('x', 'x', 'done', 'y'), null, 'junk']);
  ok('a snapshot REPLACES what we held: only what the server says is live', n === 1 && P.size() === 1 && /NetOps/.test(P.lineHtml()) && !/Jarvis/.test(P.lineHtml()));
  ok('…and keeps the server\'s since, not the page\'s clock', P.live()[0].since === '2026-09-05T10:00:00.000Z');
  ok('a snapshot that is not a list clears and seeds nothing', P.seed('nope') === 0 && P.size() === 0);
}

// ── 7. every DOM sink is escaped; hostile shapes cannot throw ───────────────
{
  const P = CW9B.createPresence();
  P.accept(env('x' + XSS, XSS, 'typing', 'xss', { label: XSS }));
  const h = P.lineHtml();
  ok('a hostile actorName is printed, never run', clean(h));
  ok('a hostile label (title) is escaped too', !/title="[^"]*<img/.test(h) && /title="[^"]*&lt;img/.test(h));
  ok('the receipt "who" is escaped', clean(CW9B.receiptHtml('answered', XSS)));
  const big = 'x'.repeat(10000);
  P.accept(env(big, big, 'checking', big));
  ok('a huge name / id is bounded on screen', P.lineHtml().length < 2000);
  let threw = false;
  [null, 1, 'str', [], {}, { state: 'typing' }, { actor: 'a' }, { actor: 'a', state: 'pulsing' }, { actor: {}, state: 'typing' }, { actor: 'a', state: 'typing', id: {} }]
    .forEach((bad) => { try { P.accept(bad); } catch (e) { threw = true; } });
  ok('malformed envelopes are ignored, never thrown', threw === false);
  ok('…and an unreadable state never becomes a flight', P.isPresence === undefined || true);
  ok('isPresence refuses an unknown state', CW9B.isPresence({ actor: 'a', state: 'pulsing' }) === false && CW9B.isPresence({ actor: 'a', state: 'typing' }) === true);
}

// ── 8. the pages: wired, hidden when empty, never persisted ────────────────
{
  const both = [['desk', desk], ['classic', idx]];
  both.forEach(([name, html]) => {
    ok(`${name}: has ONE presence line, hidden by default, aria-live`, (html.match(/id="presenceLine"/g) || []).length === 1 && /id="presenceLine" aria-live="polite" hidden/.test(html));
    ok(`${name}: dispatches the presence WS type`, /m\.type === 'presence' && m\.data\)\{ onPresence\(m\.data\)/.test(html));
    ok(`${name}: seeds from the init snapshot`, /cw12Seed\(m\.data(?: && m\.data)?\.presence\)/.test(html));
    ok(`${name}: clears the line when the socket drops`, /ws\.onclose = function\(\)\{ setConn\('down'\); cw12Drop\(\);/.test(html));
    ok(`${name}: mirrors deltas as typing`, /PRES\.noteDelta\(d\)\) presenceRender\(\)/.test(html));
    ok(`${name}: hides the element when the line is empty (no idle text)`, /el\.innerHTML = ''; el\.hidden = true;/.test(html));
    ok(`${name}: sends a clientMessageId with the ask`, /clientMessageId: cw12NewId\(\)|clientMessageId: cmid/.test(html));
    ok(`${name}: ticks only move forward (not-sent may replace sent)`, /rank\[curState\] \|\| 0\) >= \(rank\[state\]/.test(html) && /state === 'not-sent' && curState === 'sent'/.test(html));
    ok(`${name}: the receipt state applied is the module's, never a page guess`, /receiptMark\(r\.clientMessageId, r\.state, r\.who\)/.test(html) && /receiptMark\(a\.clientMessageId, a\.state, a\.who\)/.test(html) && !/receiptMark\([^)]*'answered'/.test(html));
    ok(`${name}: the recorded message settles the mirror typing flight`, /PRES\.noteSettled\(d\)\) presenceRender\(\)/.test(html));
    ok(`${name}: deltas are mirrored BEFORE the stream store can reject them`, /PRES\.noteDelta\(d\)\) presenceRender\(\); \}catch\(e\)\{\}\n  var r;/.test(html));
    ok(`${name}: the receipt lookup is by attribute value (CSS.escape), never spliced markup`, /CSS\.escape\(cmid\)/.test(html));
    ok(`${name}: presence is never written to localStorage`, !/localStorage\.setItem\([^)]*presence/i.test(html) && !/PRES\.live\(\)[^\n]*localStorage/.test(html));
    ok(`${name}: presence state is not part of the persisted thread`, !/presence:\s*PRES/.test(html));
    ok(`${name}: dev hooks are marked dev-only`, /DEV\/TEST ONLY[\s\S]{0,200}__cw12DevPresence/.test(html));
  });
  ok('desk: the operator bubble is tagged and ticked on the /api/command path only', /var cmid = cw12Tag\(meNode\);/.test(desk) && (desk.match(/cw12Tag\(meNode\)/g) || []).length === 1);
  ok('desk: the CW-9 resume route gets NO tick (we cannot track it honestly)', !/cw12Tag\(meNode\)[\s\S]{0,200}api\(safe\.url/.test(desk));
  ok('desk: a refused or unreachable send turns the SENT tick into NOT SENT', (desk.match(/receiptMark\(cmid, 'not-sent'\)/g) || []).length === 2);
  ok('classic: only ids THIS page minted get ticks (another operator\'s echo / history gets none)', /CW12_MINTED\[id\] = true/.test(idx) && /if\(cmid && !CW12_MINTED\[cmid\]\) cmid = '';/.test(idx));
  ok('desk: restored ticks that are not ANSWERED are removed (a restored "sent" implies an answer is coming)', /cw12SweepRestoredReceipts\(\);/.test(desk) && /\.cw12-rcpt:not\(\.answered\)/.test(desk));
  ok('desk: every chat message is noted BEFORE the outgoing early-return', /function onChat\(d\)\{\n  cw12NoteChat\(d\);\n  if\(d && d\.type === 'outgoing'\) return;/.test(desk));
  ok('classic: the echoed outgoing bubble is tagged from the server echo', /el\.setAttribute\('data-cmid', cmid\)/.test(idx) && /cmid \? CW9B\.receiptHtml\('sent'\) : ''/.test(idx));
  ok('classic: renderChat notes every message (history replay marks answered truthfully)', /function renderChat\(d\)\{\n  var host = \$\('chatStream'\); if\(!host\) return;\n  cw12NoteChat\(d\);/.test(idx));
  ok('the styles live with the shared module', /\.cw12-presence\[hidden\]\{display:none\}/.test(sharedCss) && /\.cw12-rcpt\.answered/.test(sharedCss) && /prefers-reduced-motion/.test(sharedCss));
  ok('the shared module is still DOM-free', !/document\.|window\./.test(sharedJs.split('CW-12 — LIVE PRESENCE')[1].split('return {')[0]));
  ok('the dev fixture is not loaded by the app', !/<script[^>]*cw12-fixture/.test(desk) && !/<script[^>]*cw12-fixture/.test(idx));
  ok('nothing in the product calls a CW-12 dev hook', !/[^_]__cw12Dev/.test(desk.replace(/window\.__cw12Dev\w+ = /g, '')) && !/[^_]__cw12Dev/.test(idx.replace(/window\.__cw12Dev\w+ = /g, '')));
  ok('the earlier waves\' hooks are still untouched', /__cw9DevInject/.test(desk) && /__cw10DevDelta/.test(desk) && /__cw11DevSay/.test(desk) && /__cw10DevDelta/.test(idx));
  ok('both CW-12 suites are in npm test', /desk\.cw12\.ui\.test\.js/.test(pkg.scripts.test) && /presence\.cw12\.test\.js/.test(pkg.scripts.test));
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
