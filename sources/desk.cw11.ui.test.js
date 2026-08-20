// desk.cw11.ui.test.js — CW-11 FRONTEND: the reflexion wave on screen.
//
// Plain words: this suite guards the three things CW-11 adds to the desk.
//   1. THE VERDICT SPLIT. Jarvis now walks every claim back to a real read
//      before it commits a verdict. Claims that trace are `verified`; claims
//      that do not are downgraded to "suspected — unverified" instead of being
//      stated as fact. The card must show the two APART — a suspected claim
//      sitting inside the green cause block reads as proven, which is the exact
//      fabrication this wave exists to stop. And a verdict from BEFORE this
//      wave, carrying neither array, must render byte-for-byte as it did.
//   2. REFLECTION MARKERS. A round that found nothing new and a prediction that
//      turned out wrong are ORDINARY messages — no new kind, nothing changes
//      for an old client. The only addition is an optional reflection field
//      that becomes a small glyph and a faint tint. Absent = plain message.
//   3. THE LESSONS PANEL. It reads the server's lesson files. "No lessons
//      recorded yet" is a claim about the record and may only be made when a
//      list was actually read and really was empty — an answer we could not
//      read gets DIFFERENT words. Every lesson field is stored text written
//      from model output, so every one of them is escaped at the sink.
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
const clean = (h) => !/<img src=x/.test(h) && /&lt;img src=x/.test(h);

console.log('\nCW-11 UI — the verdict split, reflection markers, and the lessons panel:\n');

// ── 1. the verdict split ────────────────────────────────────────────────────
{
  const h = CW9B.verdictHtml({
    kind: 'verdict',
    verdict: {
      cause: 'Failing optic on Gi1/0/24', confidence: 'high', rounds: 3,
      verified: ['412 CRC errors read at 14:02', 'Rx power -19.4 dBm read at 14:05'],
      suspected: ['the patch was probably disturbed at 10:15'],
    },
  });
  ok('the cause still leads the card', /class="vcause">Failing optic/.test(h));
  ok('verified claims are rendered', /412 CRC errors read at 14:02/.test(h));
  ok('suspected claims are rendered', /the patch was probably disturbed/.test(h));
  ok('the two lists are in SEPARATE blocks with different classes',
    /class="vclaims verified"/.test(h) && /class="vclaims suspected"/.test(h));
  ok('the suspected block is labelled "suspected — unverified" in plain words',
    /Suspected — unverified/.test(h));
  ok('the verified block says what "verified" means',
    /traced to a read from this incident/i.test(h));
  ok('the suspected block says plainly that nothing backs them YET',
    /Nothing read on this incident backs these yet/.test(h));
  ok('the suspected block does NOT claim they are part of the cause',
    /not part of the cause above/.test(h));
  ok('the counts are on the card so the split is visible collapsed',
    /2 verified · 1 suspected/.test(h));
  // The wording must be honest, not alarming: no "warning", no "danger", no shouting.
  ok('the suspected wording is honest, not alarming',
    !/\b(WARNING|DANGER|ALERT|FABRICAT)/i.test(h));
  // and it must not borrow the broken-message / change-gate colour classes
  ok('the suspected block does not reuse the warning card classes',
    !/cw9-broken/.test(h) && !/changecard/.test(h));
  ok('the suspected list sits BELOW the verified list, under the cause',
    h.indexOf('vclaims verified') > h.indexOf('vcause') &&
    h.indexOf('vclaims suspected') > h.indexOf('vclaims verified'));
}

// ADDITIVE: the old envelope is untouched. This is the byte-for-byte proof.
{
  const old = { kind: 'verdict', verdict: { cause: 'A cause', confidence: 'high', rounds: 2 } };
  const expected =
    '<div class="verdictcard"><span class="r-lbl">✔ Cause found</span>' +
    '<div class="vcause">A cause</div>' +
    '<div class="vmeta"><span class="conf">confidence high</span>' +
    '<span class="pill grey">2 rounds</span></div></div>';
  ok('a verdict with NEITHER new array renders exactly as before the wave',
    CW9B.verdictHtml(old) === expected);
  ok('an empty verdict still renders nothing, as before',
    CW9B.verdictHtml({ kind: 'verdict', verdict: {} }) === '');
  ok('no claim lists means no verified/suspected counts appear',
    !/verified ·/.test(CW9B.verdictHtml(old)));
}

// Only suspected: honest, and no fake green claim.
{
  const h = CW9B.verdictHtml({ verdict: { cause: 'Nothing proves a cause yet', suspected: ['maybe upstream'] } });
  ok('a verdict with only suspected claims shows no verified block',
    /vclaims suspected/.test(h) && !/vclaims verified/.test(h));
  ok('a verdict with only verified claims shows no suspected block',
    !/vclaims suspected/.test(CW9B.verdictHtml({ verdict: { cause: 'c', verified: ['read at 14:02'] } })));
}

// A wrong-shaped list must never be silently treated as empty.
{
  const h = CW9B.verdictHtml({ verdict: { cause: 'c', verified: 'not a list', suspected: { a: 1 } } });
  ok('a wrong-shaped claim list is called out, not pretended empty',
    (h.match(/cannot read/g) || []).length === 2);
  ok('and it is not guessed at', /not being guessed at/.test(h));
}

// The cap: a verdict cannot fill the pane, and it says how many it is not showing.
{
  const many = Array.from({ length: 20 }, (_, i) => 'claim number ' + i);
  const h = CW9B.verdictHtml({ verdict: { cause: 'c', verified: many } });
  ok('claims are capped for display', (h.match(/<li>/g) || []).length === CW9B.CLAIM_MAX);
  ok('and the card says how many it is not showing', /8 more not shown here/.test(h));
  ok('and where all of them are', /the incident record holds all 20/.test(h));
}

// XSS: a claim is model-written text going straight to the DOM.
{
  const h = CW9B.verdictHtml({
    verdict: { cause: XSS, confidence: XSS, verified: [XSS], suspected: [{ nested: XSS }] },
  });
  ok('a hostile cause is escaped', clean(h));
  ok('a hostile verified claim is escaped', (h.match(/&lt;img src=x/g) || []).length >= 3);
  ok('a hostile claim nested in an object is escaped too, not printed as [object Object]',
    !/\[object Object\]/.test(h) && /nested/.test(h));
}

// ── 1b. PINNED TO THE REAL BACKEND (PR #77, conduct.verdictMsg) ────────────
// A claim is an OBJECT, not a string: verified [{claim, evidenceIds[]}] and
// suspected [{claim, why}]. `confidence` is a NUMBER 0..1 or null — not the
// word "high". `causeSupported` is true / false / null. Every one of those was
// guessed differently on this branch, and each wrong guess showed something
// false or unreadable to an operator.
{
  const real = CW9B.verdictHtml({
    kind: 'verdict',
    verdict: {
      cause: 'Failing optic on Gi1/0/24', confidence: 0.82, rounds: 3, causeSupported: true,
      verified: [{ claim: '412 CRC errors since the last clear', evidenceIds: ['ev-14', 'ev-17'] }],
      suspected: [{ claim: 'the patch was disturbed at 10:15', why: 'no reading from this incident backs it' }],
    },
  });
  ok('a claim OBJECT renders its sentence, not its JSON',
    /412 CRC errors since the last clear/.test(real) && !/"claim"/.test(real) && !/evidenceIds"/.test(real));
  ok('a verified claim names the evidence records behind it',
    /from ev-14, ev-17/.test(real));
  ok('a suspected claim says WHY it is not backed',
    /no reading from this incident backs it/.test(real));
  ok('the supporting detail is set apart from the claim itself', /class="vcsrc"/.test(real));
  ok('a numeric confidence is shown as a percentage, not as a raw 0.82',
    /confidence 82%/.test(real) && !/0\.82/.test(real));
}
{
  // confidence 0 is the most alarming value there is, and it is FALSY — the
  // first cut dropped it off the card entirely.
  const zero = CW9B.verdictHtml({ verdict: { cause: 'c', confidence: 0, verified: [{ claim: 'a' }] } });
  ok('a confidence of exactly 0 is shown, not silently dropped', /confidence 0%/.test(zero));
  ok('a null confidence shows nothing rather than "null"',
    !/confidence/.test(CW9B.verdictHtml({ verdict: { cause: 'c', confidence: null } })));
  ok('an out-of-range number is clamped rather than printed as 420%',
    /confidence 100%/.test(CW9B.verdictHtml({ verdict: { cause: 'c', confidence: 4.2 } })));
  ok('an old string confidence still renders as it did',
    /confidence high/.test(CW9B.verdictHtml({ verdict: { cause: 'c', confidence: 'high' } })));
}
// causeSupported:false — the self-check found nothing backing THE CAUSE.
{
  const down = CW9B.verdictHtml({
    verdict: { cause: 'Probably the optic', causeSupported: false, confidence: 0,
      suspected: [{ claim: 'a guess', why: 'nothing read backs it' }] },
  });
  ok('an unsupported cause does NOT claim "Cause found"', !/Cause found/.test(down));
  ok('it is labelled suspected — unverified at the top of the card',
    /class="r-lbl">Suspected — unverified/.test(down));
  ok('the card stops looking like a found cause', /class="verdictcard unsupported"/.test(down));
  ok('and it says plainly that nothing read backs it',
    /none of them back it/.test(down) && /not a cause/.test(down));
  ok('it tells the operator to confirm before acting', /confirm it before acting/.test(down));
  ok('the downgraded card is amber, not the green of a finding',
    /\.verdictcard\.unsupported\{border-color:var\(--warn\)/.test(sharedCss));
  // the other direction: supported / not-run must be untouched
  ok('causeSupported:true still reads "Cause found"',
    /Cause found/.test(CW9B.verdictHtml({ verdict: { cause: 'c', causeSupported: true } })));
  ok('causeSupported null (the self-check never ran) reads exactly as before',
    CW9B.verdictHtml({ verdict: { cause: 'c', causeSupported: null } }) === CW9B.verdictHtml({ verdict: { cause: 'c' } }));
  ok('a non-boolean causeSupported is not treated as false',
    /Cause found/.test(CW9B.verdictHtml({ verdict: { cause: 'c', causeSupported: 'no' } })));
}
// The lists also work when the backend puts them on the envelope, not the verdict.
{
  const h = CW9B.verdictHtml({ kind: 'verdict', verdict: { cause: 'c' }, verified: ['a read'], suspected: ['a guess'] });
  ok('the arrays are read from the envelope too', /a read/.test(h) && /a guess/.test(h));
}

// ── 2. reflection markers ───────────────────────────────────────────────────
// PINNED (PR #77): the backend's round reflection is {nothingNew, line,
// nextAngle} — there is NO `type` field on a real one. Reading only `type`
// meant every reflection the backend actually sends rendered nothing at all.
ok('the real backend shape {nothingNew:true} lights the nothing-new marker',
  CW9B.reflectionOf({ reflection: { nothingNew: true, line: 'nothing new', nextAngle: 'the optic' } }) === 'nothing-new');
ok('nothingNew:false is a CLEAN round and must stay unmarked',
  CW9B.reflectionOf({ reflection: { nothingNew: false, line: '' } }) === '');
ok('reflection:null (every clean round) is unmarked',
  CW9B.reflectionOf({ reflection: null }) === '');
ok('an explicit type still wins over the flags, for any future shape',
  CW9B.reflectionOf({ reflection: { type: 'confirmed', nothingNew: true } }) === 'confirmed');
ok('an explicit BAD type is refused rather than falling back to a flag',
  CW9B.reflectionOf({ reflection: { type: 'exploded', nothingNew: true } }) === '');
ok('reflection:{type} is read', CW9B.reflectionOf({ reflection: { type: 'nothing-new' } }) === 'nothing-new');
ok('the plain string form is read too', CW9B.reflectionOf({ reflection: 'reopened' }) === 'reopened');
ok('case and stray space do not matter', CW9B.reflectionOf({ reflection: ' Confirmed ' }) === 'confirmed');
ok('a message with NO reflection field is plain', CW9B.reflectionOf({ text: 'hi' }) === '');
ok('an unknown reflection type is ignored rather than half-rendered',
  CW9B.reflectionOf({ reflection: 'exploded' }) === '');
ok('a hostile reflection type cannot reach the DOM',
  CW9B.reflectionOf({ reflection: XSS }) === '' && CW9B.reflectionGlyphHtml(XSS) === '');
ok('a prototype key is not mistaken for a reflection type',
  CW9B.reflectionOf({ reflection: 'constructor' }) === '' &&
  CW9B.reflectionOf({ reflection: '__proto__' }) === '');
ok('null / an array are not reflection fields',
  CW9B.reflectionOf({ reflection: null }) === '' && CW9B.reflectionOf({ reflection: ['confirmed'] }) === '');
{
  const g = CW9B.reflectionGlyphHtml('nothing-new');
  ok('the nothing-new marker says what it means in words, not only a glyph',
    /nothing new this round/.test(g) && /changing approach/.test(g));
  ok('the reopened marker says the hypothesis was WRONG',
    /the hypothesis was wrong/.test(CW9B.reflectionGlyphHtml('reopened')));
  ok('the confirmed marker says the prediction HELD',
    /the prediction held/.test(CW9B.reflectionGlyphHtml('confirmed')));
  ok('the marker carries its own class so the page can tint the message',
    /class="cw11-refl nothing-new"/.test(g));
}
// The whole point of part 1/3: these stay ORDINARY messages.
ok('no new envelope kind was added for reflection',
  CW9B.KINDS.join(',') === 'ask,roster,finding,verdict,change');
ok('a reflection message is NOT treated as an envelope',
  CW9B.isEnvelope({ text: 'nothing new', reflection: { type: 'nothing-new' } }) === false);

// ── 3. the "using lesson from INC-…" chip ───────────────────────────────────
{
  // PINNED (PR #77): the backend's lesson hit is {id, lookFirst, why} and it
  // names the field `lesson`. `lessonRef`/`incident` were this branch's guess.
  const realHit = CW9B.lessonRefChipHtml({ id: 'INC-2041', why: 'the same thing happening on the network',
    lookFirst: 'the optic levels on the complaining port' });
  ok('the real backend hit {id, lookFirst, why} names the incident',
    /using lesson from INC-2041/.test(realHit));
  ok('and it carries what that lesson says to look at first',
    /looking first at: the optic levels/i.test(realHit));
  ok('the desk reads the backend\'s `lesson` field, not only its own guess',
    /d\.lessonRef \|\| d\.lesson_ref \|\| d\.lesson/.test(desk));
  const c = CW9B.lessonRefChipHtml({ incident: 'INC-2041', why: 'same symptom words' });
  ok('the chip names the incident it is leaning on', /using lesson from INC-2041/.test(c));
  ok('the chip explains itself on hover', /same symptom words/.test(c));
  ok('a bare string lessonRef works', /using lesson from INC-99/.test(CW9B.lessonRefChipHtml('INC-99')));
  ok('no lessonRef means no chip',
    CW9B.lessonRefChipHtml(undefined) === '' && CW9B.lessonRefChipHtml({}) === '' &&
    CW9B.lessonRefChipHtml('   ') === '');
  ok('a hostile incident id is escaped', clean(CW9B.lessonRefChipHtml({ incident: XSS })));
  ok('a hostile "why" is escaped', clean(CW9B.lessonRefChipHtml({ incident: 'INC-1', why: XSS })));
  ok('an absurd incident id is trimmed rather than run across the bubble',
    CW9B.lessonRefChipHtml('X'.repeat(500)).indexOf('…') !== -1);
  ok('the chip never claims the old cause IS this cause',
    !/cause/i.test(CW9B.lessonRefChipHtml({ incident: 'INC-1' })));
}

// ── 4. the lessons panel: the three honest states ───────────────────────────
{
  const read = CW9B.normalizeLessons({ lessons: [] });
  ok('an empty list is EMPTY, not unreadable', read.empty === true && read.unreadable === false);
  ok('a bare empty array is empty too', CW9B.normalizeLessons([]).empty === true);
  const bad = CW9B.normalizeLessons({ ok: true });
  ok('an object naming no list is UNREADABLE, not empty', bad.unreadable === true && bad.empty === false);
  ok('a string / a number / null are unreadable',
    CW9B.normalizeLessons('nope').unreadable === true &&
    CW9B.normalizeLessons(7).unreadable === true &&
    CW9B.normalizeLessons(null).unreadable === true);

  const e = CW9B.lessonsHtml([]);
  const u = CW9B.lessonsHtml({ ok: true });
  ok('the empty state uses the exact honest words', /No lessons recorded yet/.test(e));
  ok('the unreadable state uses DIFFERENT words', /Lessons can.?t be read/.test(u));
  ok('the unreadable state never claims there are no lessons',
    !/No lessons recorded yet/.test(u) && /will not guess either way/.test(u));
  ok('the missing-endpoint state is a third, different claim',
    /Lessons aren.?t available/.test(CW9B.lessonsNoteHtml('this server does not keep lessons yet')) &&
    !/No lessons recorded yet/.test(CW9B.lessonsNoteHtml('x')));
  ok('the empty state explains where lessons come from', /when an incident is closed/.test(e));
}

// the list itself
{
  const h = CW9B.lessonsHtml({
    lessons: [{
      id: 'INC-2041', incident: 'INC-2041', date: '2026-07-14',
      cause: 'Failing optic on Gi1/0/24',
      fastestCheck: 'show interface transceiver detail',
      wasted: '40 minutes on BGP that was never involved',
      keywords: ['packet loss', 'CRC'],
    }],
  });
  ok('the incident is shown', /INC-2041/.test(h));
  ok('the cause is shown', /Failing optic on Gi1\/0\/24/.test(h));
  ok('the fastest check is shown, and labelled in plain words',
    /found fastest by/.test(h) && /show interface transceiver detail/.test(h));
  ok('what wasted time is shown', /40 minutes on BGP/.test(h));
  ok('the symptom keywords are shown as chips', /class="ls-kw">packet loss/.test(h));
  ok('the date is shown', /2026-07-14/.test(h));
  ok('each lesson has its own delete button carrying its id',
    /class="ls-del" data-lesson-id="INC-2041"/.test(h));
  ok('the panel states the LESSONS-ARE-FACTS-NOT-RULES guardrail on screen',
    /never runs a check/.test(h) && /never approves a change/.test(h) &&
    /never overrides a question/.test(h));
}

// A lesson whose id could not be a URL segment gets NO delete button.
{
  const h = CW9B.lessonsHtml({ lessons: [{ incident: 'a lesson/with a bad id', cause: 'c' }] });
  ok('an unusable id means no delete button rather than a guessed route',
    !/ls-del/.test(h) && /class="ls-nodel"/.test(h));
  ok('and the panel says why', /no id the server would accept/.test(h));
}
{
  const h = CW9B.lessonsHtml({ lessons: [{ id: '../../etc/passwd', incident: 'x', cause: 'c' }] });
  ok('a path-traversal id is refused a delete button', !/ls-del/.test(h));
}

// Every lesson field is STORED TEXT, so every one is a sink.
{
  const h = CW9B.lessonsHtml({
    lessons: [{ id: 'INC-1', incident: XSS, date: XSS, cause: XSS, fastestCheck: XSS, wasted: XSS, keywords: [XSS] }],
  });
  ok('every lesson field is escaped', clean(h) && (h.match(/&lt;img src=x/g) || []).length >= 6);
  // The stronger promise: an id only ever reaches the button (and therefore the
  // DELETE route) when it is a plain name. Anything else gets no button at all,
  // so there is no attribute to break out of and no route to guess.
  // PINNED to lessons.safeId in PR #77: starts alphanumeric, then
  // alphanumeric / . / _ / -, at most 64, never containing "..". Anything the
  // SERVER would refuse must get no button here — a button that posts a route
  // the server answers with 400 is a button that lies about what it does.
  const hostileIds = ['"><b>x', '../../etc/passwd', XSS, 'a b', 'INC-1?x=1', '',
    'INC_2041.v2:1',        // ':' — legal on the old guess, refused by the server
    '.hidden',              // must start alphanumeric
    'a..b',                 // the ".." the server bars outright
    'X'.repeat(65),         // over the server's 64-char limit
    'INC-2041.v2'];         // the one the server WOULD accept
  const rendered = hostileIds.map((id) => CW9B.lessonsHtml({ lessons: [{ id, problem: 'x', cause: 'c' }] }));
  ok('only an id the SERVER would accept ever reaches a delete button',
    rendered.every((r) => {
      const m = /data-lesson-id="([^"]*)"/.exec(r);
      return m === null || (/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(m[1]) && m[1].indexOf('..') === -1);
    }));
  ok('the one server-legal id in that set DID get a button',
    /data-lesson-id="INC-2041\.v2"/.test(rendered[10]));
  ok('every id the server would refuse got none', rendered.slice(0, 10).every((r) => !/ls-del/.test(r)));
}
{
  const h = CW9B.lessonsHtml({ lessons: [{ id: 'i', incident: 'x', cause: { deep: 'an object' } }] });
  ok('a wrong-typed lesson field reads as something human, not [object Object]',
    !/\[object Object\]/.test(h) && /an object/.test(h));
}
{
  const rows = Array.from({ length: 400 }, (_, i) => ({ id: 'INC-' + i, incident: 'INC-' + i, cause: 'c' + i }));
  ok('the rendered list is capped so one panel cannot hold a thousand rows',
    CW9B.normalizeLessons({ lessons: rows }).list.length === CW9B.LESSON_MAX);
  ok('a long stored field is trimmed, not left to run off the panel',
    /…/.test(CW9B.lessonsHtml({ lessons: [{ id: 'i', incident: 'x', cause: 'y'.repeat(900) }] })));
}

// ── 4b. PER-ROW HONESTY (the blocker a review found) ────────────────────────
// Classifying only the CONTAINER meant an unrecognised ROW was dropped in
// silence — so a real payload under different field names rendered "no lessons
// recorded yet" about data that plainly exists. Every row now gets its own
// verdict, and rows we cannot read are counted and reported.
{
  const foreign = { lessons: [{ zzz: 1 }, { qqq: 2 }] };
  const s = CW9B.normalizeLessons(foreign);
  ok('rows we cannot read are COUNTED, not dropped in silence',
    s.badRows === 2 && s.list.length === 0 && s.rows === 2);
  ok('a list with unreadable rows in it is NOT "empty"', s.empty === false);
  const h = CW9B.lessonsHtml(foreign);
  ok('all-unreadable rows give the CAN\'T-BE-READ state, never the empty one',
    /Lessons can.?t be read/.test(h) && !/No lessons recorded yet/.test(h));
  ok('and it says how many rows it could not read',
    /2 lessons came back in a shape this panel does not recognise/.test(h));
}
{
  // the mixed case: some readable, some not
  const mixed = { lessons: [{ id: 'INC-1', incident: 'INC-1', cause: 'a real cause' }, { zzz: 1 }, { qqq: 2 }] };
  const s = CW9B.normalizeLessons(mixed);
  ok('a mixed list keeps the readable rows AND counts the rest',
    s.list.length === 1 && s.badRows === 2);
  const h = CW9B.lessonsHtml(mixed);
  ok('the readable lesson is still shown', /a real cause/.test(h));
  ok('and the panel says out loud that 2 more could not be read',
    /2 more lessons can.?t be read/.test(h));
  ok('and that what is shown is NOT all of them', /not all of them/.test(h));
  ok('the mixed note is a caveat beside real data, not the empty state',
    !/No lessons recorded yet/.test(h));
}
// The other direction: a genuinely empty record must still say "empty", and a
// fully readable list must NOT grow a caveat it has no reason to show.
{
  ok('a genuinely empty list is still EMPTY, not "unreadable"',
    CW9B.normalizeLessons({ lessons: [] }).badRows === 0 &&
    /No lessons recorded yet/.test(CW9B.lessonsHtml({ lessons: [] })));
  const good = { lessons: [{ id: 'INC-1', incident: 'INC-1', cause: 'c' }, { id: 'INC-2', incident: 'INC-2', cause: 'c' }] };
  ok('a fully readable list shows no "can\'t be read" caveat at all',
    !/can.?t be read/.test(CW9B.lessonsHtml(good)) &&
    CW9B.normalizeLessons(good).badRows === 0);
  ok('an empty slot in the list counts as a row that could not be read',
    CW9B.normalizeLessons({ lessons: [{}, null, ''] }).badRows === 3 &&
    CW9B.normalizeLessons({ lessons: [{}, null, ''] }).empty === false);
}
// ── 4c. PINNED TO THE REAL BACKEND (PR #77) ────────────────────────────────
// GET /api/lessons answers {lessons:[…], dir}, and one lesson really is
// { id, closedAt, problem, cause, fastestCheck, wastedTime, keywords[] }.
// Note what this branch had GUESSED wrong: `wasted` (really `wastedTime`),
// `date` (really `closedAt`), an `incident` field that does not exist, and
// `problem` — a real field that was being dropped entirely.
{
  const real = {
    dir: 'squad/lessons',
    lessons: [{
      id: 'INC-2041', closedAt: '2026-07-14T09:12:00.000Z',
      problem: 'users on sw1-hyd seeing packet loss since 2pm',
      cause: 'Failing optic on sw1-hyd Gi1/0/24.',
      fastestCheck: 'show interface transceiver detail',
      wastedTime: '40 minutes on BGP state that was never involved',
      keywords: ['packet loss', 'CRC'],
    }],
  };
  const s = CW9B.normalizeLessons(real);
  ok('the real backend payload is read — no unreadable rows',
    s.list.length === 1 && s.badRows === 0 && s.unreadable === false);
  const l = s.list[0];
  ok('the id doubles as the incident, since the record has no `incident` field',
    l.id === 'INC-2041' && l.incident === 'INC-2041');
  ok('`wastedTime` is read (this branch had guessed `wasted`)',
    /40 minutes on BGP/.test(l.wasted));
  ok('`closedAt` is read (this branch had guessed `date`)', /2026-07-14/.test(l.date));
  ok('the ISO stamp is tidied to a date and a minute, not printed raw',
    l.date === '2026-07-14 09:12 UTC');
  ok('a date we do not recognise is shown exactly as it arrived, not reformatted',
    CW9B.normalizeLessons({ lessons: [{ id: 'i', problem: 'x', date: 'last Tuesday' }] }).list[0].date === 'last Tuesday');
  ok('`problem` is read — a real field the panel used to drop', /packet loss since 2pm/.test(l.problem));
  const h = CW9B.lessonsHtml(real);
  ok('and the problem is on screen, labelled in plain words',
    /looked like/.test(h) && /users on sw1-hyd seeing packet loss/.test(h));
  ok('every other real field lands too',
    /INC-2041/.test(h) && /Failing optic/.test(h) && /show interface transceiver detail/.test(h) &&
    /40 minutes on BGP/.test(h) && /ls-kw">packet loss/.test(h));
  ok('the delete button carries the id the server will accept',
    /data-lesson-id="INC-2041"/.test(h));
  ok('the pin is written down where the next person will see it',
    /PINNED TO THE BACKEND \(PR #77, sources\/lessons\.js/.test(sharedJs));
  // the per-row honesty must SURVIVE the pin — that is what covers future drift
  ok('a row under names the pin does not cover is still counted, not dropped',
    CW9B.normalizeLessons({ lessons: [real.lessons[0], { totally: 'different' }] }).badRows === 1);
}
// The fallback names stay, for older files and for drift after this pin.
{
  const alt = { lessons: [{ lesson_id: 'INC-7', root_cause: 'a root cause', check: 'show optics', symptoms: ['loss'] }] };
  ok('a snake_case payload is still read rather than reported unreadable',
    CW9B.normalizeLessons(alt).list.length === 1);
  const h = CW9B.lessonsHtml(alt);
  ok('and every field of it lands on screen',
    /INC-7/.test(h) && /a root cause/.test(h) && /show optics/.test(h) && /ls-kw">loss/.test(h));
}
// The collapsed hint must not read "none yet" over data it could not read.
ok('the panel hint counts the unreadable rows too, so a collapsed panel cannot lie',
  /if\(!s\.total\) return s\.badRows \? \(s\.badRows \+ ' unreadable'\) : 'none yet';/.test(desk) &&
  /s\.badRows \? ' · ' \+ s\.badRows \+ ' unreadable' : ''/.test(desk));

// ── 5. the page wiring ──────────────────────────────────────────────────────
ok('the Lessons panel is on the desk, in the queue footer',
  /id="lessonPanel"/.test(desk) && /class="lessonpanel"/.test(desk));
ok('it sits inside .qfoot with the Spend panel',
  desk.indexOf('id="lessonPanel"') > desk.indexOf('class="qfoot"') &&
  desk.indexOf('id="lessonPanel"') < desk.indexOf('id="newForm"'));
ok('the desk reads the real endpoint', /api\('\/api\/lessons'\)/.test(desk));
ok('a delete goes to the per-lesson route, with the id encoded',
  /api\('\/api\/lessons\/' \+ encodeURIComponent\(id\), \{ method:'DELETE' \}\)/.test(desk));
ok('a 404 is reported as "not kept yet", never as "no lessons"',
  /r\.status === 404[\s\S]{0,300}does not keep lessons yet/.test(desk));
ok('a failed delete says the lesson is STILL on the server',
  /still on the server/.test(desk));
// PINNED (PR #77): the route answers {error:'…'} in plain words on 400/404/500.
// "HTTP 404" tells an operator nothing; the server's own sentence does.
ok('a failed delete shows the server\'s own words, not just a status number',
  /body && body\.error\) \? body\.error : \('HTTP ' \+ r\.status\)/.test(desk));
ok('delete takes two clicks — the first only arms it',
  /Click again to delete/.test(desk) && /LESSONS\.armed/.test(desk));
ok('the arming lapses on its own so a stray click later cannot delete',
  /setTimeout\(lessonDisarm, 5000\)/.test(desk));
ok('the panel does not poll the server while it is closed',
  /if\(!p\.open\) return;\s*\/\* closed: don.t poll/.test(desk));
// THE .qfoot BACKSTOP (the CW-10 class rule): a panel in the footer must scroll
// inside itself, or it pushes the queue and the "new triage" button out of a
// column that clips its overflow at 620px / 760px shells.
ok('the lessons body scrolls INSIDE the panel, like the spend body',
  /\.ls-body\{[\s\S]{0,200}overflow-y:auto/.test(sharedCss) &&
  /\.ls-body\{[\s\S]{0,200}max-height:clamp\(96px, 26vh, 300px\)/.test(sharedCss));
ok('and it contains its own scroll chaining', /\.ls-body\{[\s\S]{0,220}overscroll-behavior:contain/.test(sharedCss));
ok('the queue footer still caps itself at half the column',
  /\.qfoot\{[\s\S]{0,240}max-height:50%/.test(desk));
// A browser pass at 620px with both panels open found the ONE action in that
// column scrolled out of sight inside the footer. Pinning it is what keeps the
// rule's promise now that there are two panels down there.
ok('"Open a new triage" is pinned to the bottom of the footer, so panels cannot bury it',
  /\.qfoot #newToggle\{position:sticky;bottom:0/.test(desk));
ok('the reflection marker and the lesson chip are decorated onto the message, additively',
  /function cw11Decorate\(node, d\)/.test(desk) &&
  /cw11Decorate\(jvMsg\(d\.agentName \|\| d\.agent \|\| 'Jarvis', d\.text \|\| '', d\.timestamp\), d\)/.test(desk));
ok('the bridge (triage) message path decorates the same way',
  /cw11Decorate\(jvMsg\(d\.agentName \|\| d\.agent \|\| 'Engineer'/.test(desk));
ok('the bridge path also forwards the new verdict arrays',
  /verified:d\.verified, suspected:d\.suspected/.test(desk));
// The bridge path REBUILDS the envelope field by field, so a field left out is
// a field it silently loses. A review proved the plain path kept the reflection
// marker while the bridge path — the one a real P1 call runs on — dropped it.
// Both CW-11 message fields must be on that rebuild.
ok('the bridge path forwards the reflection marker, not just the verdict arrays',
  /reflection:d\.reflection/.test(desk));
ok('the bridge path forwards lessonRef too', /lessonRef:d\.lessonRef \|\| d\.lesson_ref/.test(desk));
{
  // both directions: every field cw11Decorate READS must be on the rebuilt
  // object, and the rebuild must not have quietly lost one of the older ones.
  const rebuild = /cw9Render\(\{ kind:d\.kind,[\s\S]*?\}\)\)\{/.exec(desk);
  const block = rebuild ? rebuild[0] : '';
  ok('the rebuilt bridge envelope carries every field the decorator reads',
    ['reflection', 'lessonRef'].every((f) => block.indexOf(f + ':') !== -1));
  ok('and it still carries the CW-9 fields it always did',
    ['kind', 'text', 'questions', 'roster', 'finding', 'verdict', 'change', 'resume']
      .every((f) => block.indexOf(f + ':') !== -1));
}
// The dev hook must not race the panel's own read (a reviewer watched the
// fixture appear and then be wiped by the fetch the open() had started).
ok('the lessons dev hook waits for the panel\'s own read before painting',
  /__cw11DevLessons = function\(d\)\{[\s\S]{0,900}LESSONS\.inflight[\s\S]{0,200}setTimeout\(settle/.test(desk));
ok('and it has a floor, because the toggle event is queued rather than synchronous',
  /Date\.now\(\) - start < 300/.test(desk));
ok('a decoration failure can never take the message with it',
  /function cw11Decorate[\s\S]{0,900}catch\(e\)\{\}/.test(desk));
ok('the CW-11 styles live with the shared module, not on one page',
  /\.lessonpanel\{/.test(sharedCss) && /\.vclaims\.suspected\{/.test(sharedCss) &&
  /\.cw11-refl\{/.test(sharedCss) && /\.cw11-lref\{/.test(sharedCss));
ok('the classic console gets the verdict split for free, from the same module',
  /cw9-bridge\.js/.test(idx) && /cw9-bridge\.css/.test(idx));

// ── 6. the module stays runnable in node and in a browser ──────────────────
ok('the shared module is still DOM-free', !/\bdocument\.|window\.(?!CW9B)/.test(sharedJs));
ok('the dev fixture is not loaded by the app',
  !/cw11-fixture/.test(desk.replace(/\/\*[\s\S]*?\*\//g, '')) &&
  fs.existsSync(path.join(__dirname, '..', 'test', 'cw11-fixture.js')));
ok('the dev hooks are marked as dev-only', /DEV\/TEST ONLY[\s\S]{0,400}__cw11DevLessons/.test(desk));
// Each hook must appear exactly ONCE — as the line that defines it. A second
// mention would mean the product itself is calling a test door.
ok('nothing in the product calls a CW-11 dev hook',
  ['__cw11DevLessons', '__cw11DevSay'].every((h) => (desk.split(h).length - 1) === 1));
ok('the earlier waves\' hooks are still untouched',
  ['__cw10DevDelta', '__cw10DevSay', '__cw10DevSpend', '__cw9DevInject']
    .every((h) => (desk.split(h).length - 1) === 1));

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
