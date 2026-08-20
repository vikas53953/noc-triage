// desk.cw9.ui.test.js — CW-9 FRONTEND: the bridge-conduct envelope.
//
// Plain words: this suite guards the three things on this screen that can hurt
// someone if they slip:
//   1. RAW device output reaches a black screen. It must be escaped before it
//      touches the DOM, always — it is the most hostile string on the page.
//   2. The `resume` route arrives INSIDE an agent-authored message and the desk
//      POSTs the operator's typed words to it. It must be proven same-origin by
//      RESOLVING it, never by inspecting its characters — a review found that a
//      single backslash ("/\evil.example/steal") defeats a character check and
//      resolves to another host.
//   3. A malformed envelope must never make a message vanish, and never leave an
//      empty bubble behind. On a P1 bridge, silence is the worst failure mode.
// It also pins the honest transport label, the display cap on huge output, the
// split layout, the stack threshold, and the additive contract (a message with
// no `kind` renders exactly as it did before this wave).
//
// DETERMINISTIC: no browser, no network. public/cw9-bridge.js is the SHIPPED
// module both pages load, and it is required here directly — the code under test
// is the code that runs.

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

console.log('\nCW-9 bridge envelope — escaping, same-origin routes, never-silent rendering:\n');

// ── 1. escaping every sink ──────────────────────────────────────────────────
const XSS = '<img src=x onerror=alert(1)>';
ok('esc neutralises angle brackets', CW9B.esc(XSS) === '&lt;img src=x onerror=alert(1)&gt;');
ok('esc handles quotes and ampersands', CW9B.esc(`a&b"c'd`) === 'a&amp;b&quot;c&#39;d');
ok('esc of null is empty, not "null"', CW9B.esc(null) === '');

const hostile = CW9B.termBlockHtml({
  host: '<b>sw1</b>',
  command: 'show run | i <script>',
  output: 'line one <script>alert(1)</script>\nEthernet1/5 is down (sfpAbsent)',
  transport: 'ssh',
}, '10:22');
ok('hostile host never reaches the DOM as markup', hostile.indexOf('<b>sw1</b>') === -1);
ok('hostile command is escaped', hostile.indexOf('| i &lt;script&gt;') !== -1);
ok('raw output can never open a tag', !/<script/i.test(hostile));
ok('raw output keeps its text, escaped', hostile.indexOf('&lt;script&gt;alert(1)&lt;/script&gt;') !== -1);
ok('an event-handler attribute cannot survive',
  CW9B.outputHtml(XSS).html.indexOf('onerror=alert(1)&gt;') !== -1 && CW9B.outputHtml(XSS).html.indexOf('<img') === -1);
// every card builder, with a payload in every field it prints
const allCards = [
  CW9B.rosterHtml({ roster: { engaged: [{ agent: XSS, why: XSS }], stoodDown: [{ agent: XSS, why: XSS }] } }),
  CW9B.findingHtml({ finding: { agent: XSS, line: XSS, cli: { host: XSS, command: XSS, output: XSS, transport: XSS } } }, XSS).html,
  CW9B.verdictHtml({ verdict: { cause: XSS, confidence: XSS, rounds: XSS } }),
  CW9B.changeHtml({ change: { id: XSS, state: XSS, steps: [XSS] } }),
  CW9B.askHtml({ questions: [XSS] }),
  CW9B.placeholderHtml(XSS, XSS),
].join('');
// The payload's TEXT (including the string "onerror=") is allowed to appear —
// escaped, as visible characters. What must never appear is a real TAG the
// envelope put there. So: every tag emitted must be one this module writes, and
// no tag may carry an event handler.
const ALLOWED_TAGS = ['div', 'span', 'pre', 'ol', 'li', 'b', 'details', 'summary', '/div', '/span', '/pre', '/ol', '/li', '/b', '/details', '/summary'];
const emittedTags = (allCards.match(/<[^>]+>/g) || []).map((t) => t.slice(1, -1));
const badTag = emittedTags.find((t) => {
  const name = t.split(/[\s>]/)[0].toLowerCase();
  return ALLOWED_TAGS.indexOf(name) === -1 || /\son\w+\s*=/i.test(t);
});
ok('no card builder can emit a tag from envelope data', badTag === undefined);
if (badTag) console.log('       leaked tag: <' + badTag + '>');
ok('the payload text still survives, escaped', allCards.indexOf('&lt;img src=x onerror=alert(1)&gt;') !== -1);

// ── 2. HIGH: the resume route is proven same-origin by RESOLVING it ─────────
const ORIGIN = 'http://localhost:3111';
const R = (u) => CW9B.resolveResume({ resume: u }, ORIGIN);
ok('a plain relative route is used', R('/api/bridge/resume').url === '/api/bridge/resume');
ok('a query string survives', R('/api/x?a=1').url === '/api/x?a=1');
ok('an object route with a field is honoured',
  CW9B.resolveResume({ resume: { url: '/api/x', field: 'answer' } }, ORIGIN).field === 'answer');
// the exact bypass the reviewer proved, plus its neighbours
ok('BYPASS: a backslash authority is refused (/\\attacker.example/steal)', R('/\\attacker.example/steal') === null);
ok('BYPASS: a double backslash authority is refused', R('/\\\\evil.example/x') === null);
ok('BYPASS: a leading backslash pair is refused (\\/\\evil)', R('\\/\\evil') === null);
ok('BYPASS: a scheme-relative route is refused (https:/evil)', R('https:/evil') === null);
ok('a protocol-relative route is refused', R('//evil.example/x') === null);
ok('an absolute off-host route is refused', R('https://evil.example/x') === null);
ok('a whitespace-prefixed backslash route is refused', R('  /\\evil.example/x') === null);
ok('a tab/newline-obfuscated route is refused', R('/\t\\evil.example/x') === null);
ok('a javascript: route is refused', R('javascript:alert(1)') === null);
ok('a data: route is refused', R('data:text/html,<script>alert(1)</script>') === null);
ok('an encoded backslash stays on this origin (it is only a path)',
  R('/%5Cevil/x') !== null && R('/%5Cevil/x').url.indexOf('/%5Cevil') === 0);
ok('what is returned is a resolved origin-local path, never the raw string',
  R('/api/a\\b').url.indexOf('\\') === -1);
ok('an absolute route ON this origin is accepted and normalised',
  R(ORIGIN + '/api/ok').url === '/api/ok');
ok('a triage id falls back to the stable bridge route',
  CW9B.resolveResume({ triageId: 'trg-abc-1' }, ORIGIN).url === '/api/triage/trg-abc-1/message');
ok('a path-shaped id can never escape the route', CW9B.resolveResume({ triageId: '../../etc' }, ORIGIN) === null);
ok('no stated route and no id → the normal ask path', CW9B.resolveResume({}, ORIGIN) === null);
ok('a non-string route is refused', R({}) === null && R(42) === null && R(null) === null);
ok('desk.html no longer character-checks a route', !/charAt\(1\) !== '\/'/.test(desk));
ok('desk.html resolves the route through the shared guard',
  /CW9B\.resolveResume\(/.test(desk) && /location\.origin/.test(desk));
ok('desk.html re-checks the route again at send time',
  /re-check the route at SEND time/.test(desk) && /if\(!safe\)\{/.test(desk));

// ── 3. MEDIUM: wrong-typed fields degrade, they never throw ────────────────
const wrongShapes = [
  { kind: 'ask', questions: 'oops' },
  { kind: 'ask', questions: { a: 1 } },
  { kind: 'roster', roster: { engaged: 'x', stoodDown: 'y' } },
  { kind: 'roster', roster: { stoodDown: { a: 'b' } } },
  { kind: 'change', change: { id: 'C1', steps: 'x' } },
  { kind: 'finding', finding: { cli: 'not-an-object' } },
  { kind: 'finding', finding: null },
  { kind: 'verdict', verdict: null },
  { kind: 'roster' }, { kind: 'change' }, {}, null,
];
let threw = null;
for (const s of wrongShapes) {
  try {
    CW9B.askHtml(s); CW9B.rosterHtml(s); CW9B.changeHtml(s);
    CW9B.verdictHtml(s); CW9B.findingHtml(s, '10:00');
  } catch (e) { threw = JSON.stringify(s) + ' → ' + e.message; break; }
}
ok('no envelope shape can throw out of a card builder', threw === null);
if (threw) console.log('       ' + threw);
ok('arr() coerces every non-array to an empty list',
  CW9B.arr('x').length === 0 && CW9B.arr({}).length === 0 && CW9B.arr(null).length === 0 && CW9B.arr([1]).length === 1);
ok('a wrong-typed question list says so instead of pretending it was empty',
  CW9B.askHtml({ questions: 'oops' }).indexOf('cannot list') !== -1);
ok('a wrong-typed roster still renders a card that says so',
  CW9B.rosterHtml({ roster: { engaged: 'x' } }).indexOf('cannot list') !== -1);
ok('wrong-typed change steps warn before anyone approves',
  CW9B.changeHtml({ change: { id: 'C1', steps: 'x' } }).indexOf('cannot list') !== -1);
ok('desk render is wrapped in try/catch with an honest fallback',
  /catch\(err\)\{[\s\S]{0,220}cw9Broken\(/.test(desk));
ok('the classic console render is wrapped too', /catch\(err\)\{[\s\S]{0,200}placeholderHtml/.test(idx));
ok('hydration replays each stored message inside its own try',
  /envelopes\.forEach\(function\(d\)\{\s*try\{ cw9Render\(d\); \}/.test(desk));
ok('a failed replay is counted and reported, not swallowed',
  /stored message[\s\S]{0,120}could not be replayed/.test(desk));

// ── 4. MEDIUM: an empty envelope is never an empty bubble ──────────────────
ok('an empty verdict renders nothing from the builder', CW9B.verdictHtml({ kind: 'verdict', verdict: {} }) === '');
ok('an empty roster renders nothing from the builder',
  CW9B.rosterHtml({ kind: 'roster', roster: { engaged: [], stoodDown: [] } }) === '');
ok('an empty change renders nothing from the builder', CW9B.changeHtml({ kind: 'change', change: {} }) === '');
ok('the placeholder names the kind and stays escaped',
  CW9B.placeholderHtml('verdict', 'it arrived empty').indexOf('<b>verdict</b>') !== -1);
ok('the classic console paints the placeholder instead of a blank bubble',
  /CW9B\.isEnvelope\(d\) && !hasText[\s\S]{0,400}placeholderHtml\(d\.kind/.test(idx));
ok('the desk paints the placeholder for an empty envelope too',
  /cw9Broken\(kind, 'it arrived empty'\)/.test(desk));

// ── 5. MEDIUM: huge output is capped for display and for persistence ───────
const big = Array.from({ length: 30000 }, (_, i) => 'line ' + i + ' of a show tech-support').join('\n');
const t0 = Date.now();
const capped = CW9B.outputHtml(big);
const took = Date.now() - t0;
ok('a 30k-line read is capped to the display limit', capped.truncated === true);
ok('the cap is honest about what is not shown',
  capped.html.indexOf('output truncated for display') !== -1 &&
  capped.html.indexOf('of 30000 lines shown') !== -1 &&
  /\((\d[\d.]*) (KB|MB) in total\)/.test(capped.html));
ok('the note counts the lines actually shown, not a claimed number',
  capped.html.indexOf(capped.shownLines + ' of 30000 lines shown') !== -1);
ok('the capped html is bounded', capped.html.length <= CW9B.MAX_CHARS + 500);
ok('a capped block is small enough for the saved thread to hold',
  CW9B.termBlockHtml({ host: 'sw1', transport: 'ssh', command: 'show tech-support', output: big }, '10:00').length < 100000);
ok('capping a 30k-line read is fast (<150ms — it used to block for 1.5s)', took < 150);
if (took >= 150) console.log('       took ' + took + 'ms');
ok('a multi-MB string is never copied whole just to test emptiness',
  !/raw\.replace\(\/\\s\/g, ''\)/.test(pub('cw9-bridge.js')));
ok('a small read is not truncated', CW9B.outputHtml('a\nb\nc').truncated === false);
ok('empty output says so rather than showing a blank screen',
  CW9B.outputHtml('   ').html.indexOf('the device returned nothing') !== -1);
ok('the finding block is built ONCE and reused by the pane',
  /var f = CW9B\.findingHtml\([\s\S]{0,200}cw9TermAppendHtml\(f\.blockHtml\)/.test(desk));
ok('persistence trims whole elements instead of silently stopping',
  /function cw9FitHtml/.test(desk) && !/if\(html\.length \+ term\.length > 250000\) return;/.test(desk));
ok('a trimmed thread tells the operator once',
  /larger than this browser can keep/.test(desk));

// ── 6. honest transport labels ─────────────────────────────────────────────
ok('ssh is labelled SSH', CW9B.transport('ssh').label === 'SSH');
ok('cmdrunner is labelled Command Runner, never SSH', CW9B.transport('cmdrunner').label === 'Command Runner');
ok('api is labelled API read', CW9B.transport('api').label === 'API read');
ok('an absent transport says so, it does not guess', CW9B.transport(undefined).label === 'transport not stated');
ok('an unknown transport is not silently upgraded', CW9B.transport('telnet').key === 'unknown');
const cmdBlock = CW9B.termBlockHtml({ host: 'sw1', command: 'show version', output: 'ok', transport: 'cmdrunner' }, '');
ok('a Command Runner block never prints an ssh line', cmdBlock.indexOf('ssh sw1') === -1);
ok('a Command Runner block names the real path', cmdBlock.indexOf('command-runner --device sw1') !== -1);
ok('an ssh block prints the ssh line',
  CW9B.termBlockHtml({ host: 'apic1', command: 'x', output: 'y', transport: 'ssh' }, '').indexOf('ssh apic1') !== -1);

// ── 7. output colouring is whole-line only ─────────────────────────────────
ok('an error line is red', CW9B.lineClass('Ethernet1/5 is down (sfpAbsent)') === 'r');
ok('a warning line is amber', CW9B.lineClass('Last link flapped: 10:17:52') === 'a');
ok('a healthy line is green', CW9B.lineClass('GigabitEthernet0/1 is up') === 'g');
ok('a neutral line gets no class', CW9B.lineClass('Hardware: 1000/10000 Ethernet') === '');
ok('the class span wraps the whole escaped line',
  CW9B.outputHtml('all up\n<hack> is down').html.indexOf('<span class="r">&lt;hack&gt; is down</span>') !== -1);

// ── 8. the V2 layout actually shipped, and grows with the screen ───────────
ok('the split container exists', /id="centerSplit"/.test(desk) && /class="centersplit"/.test(desk));
ok('the persistent session pane exists', /id="termPane"/.test(desk) && /id="termBody"/.test(desk));
ok('the pane can be collapsed by the operator', /id="termToggle"/.test(desk));
ok('the terminal column GROWS with the screen (not a fixed strip)',
  /grid-template-columns:minmax\(0,1fr\) minmax\(340px,\.6fr\)/.test(desk));
ok('the stack threshold clears a 1440px laptop', /@media \(max-width:1599px\)\{/.test(desk));
ok('the terminal stacks under the chat below that',
  /@media \(max-width:1599px\)\{[\s\S]*?\.centersplit\{display:flex;flex-direction:column/.test(desk));
const sharedCss = pub('cw9-bridge.css');
ok('the terminal screen is dark and monospaced',
  /\.tb-body\{[\s\S]*?font-family:var\(--mono\)/.test(sharedCss) && /\.tb-body\{[\s\S]*?background:#04070b/.test(sharedCss));
ok('the terminal scrolls horizontally inside the pane', /\.tb-body\{[\s\S]*?overflow-x:auto/.test(sharedCss));
ok('the mono text is readable (>= .78rem)', /\.tb-body\{[\s\S]*?font-size:\.7[89]rem|\.tb-body\{[\s\S]*?font-size:\.8/.test(sharedCss));

// ── 9. the five kinds, and old messages untouched ─────────────────────────
ok('the module owns the list of kinds', CW9B.KINDS.join(',') === 'ask,roster,finding,verdict,change');
ok('a message with no kind is not an envelope', CW9B.isEnvelope({ text: 'hi' }) === false);
ok('an unknown kind is not an envelope', CW9B.isEnvelope({ kind: 'say' }) === false);
ok('null / a bare string are not envelopes', CW9B.isEnvelope(null) === false && CW9B.isEnvelope('x') === false);
ok('onChat still paints plain replies exactly as before',
  /if\(cw9Render\(d\)\)\{[\s\S]*?\}\s*jvMsg\(d\.agentName \|\| d\.agent \|\| 'Jarvis', d\.text \|\| '', d\.timestamp\);/.test(desk));
ok('stood-down agents are struck through', /\.rpill\.off\{[^}]*line-through/.test(sharedCss));
ok('engaged agents are green', /\.rpill\.on\{[^}]*var\(--ok\)/.test(sharedCss));
ok('the change card is held for approval, never applied',
  /held for approval/.test(sharedCss + CW9B.changeHtml({ change: { id: 'C1', steps: ['x'] } })) &&
  CW9B.changeHtml({ change: { id: 'C1', steps: ['x'] } }).indexOf('Nothing has been sent to any device') !== -1);

// ── 10. reload restores the pane, the trim note and the pending question ──
ok('the session pane is persisted with the thread', /term:termFit\.html, termBlocks:CW9\.blocks/.test(desk));
ok('the session pane is restored on reload', /if\(typeof st\.term === 'string'/.test(desk));
ok('the pending question survives a reload', /if\(st\.awaiting\)\{/.test(desk));
ok('the restored route is re-checked against this origin',
  /CW9B\.resolveResume\(\{ resume: st\.awaiting \}, location\.origin\)/.test(desk));
ok('chat-store history rehydrates the call', /function cw9Hydrate/.test(desk) && /data\.chatHistory/.test(desk));

// ── 11. ONE implementation, loaded by both pages ──────────────────────────
ok('both pages load the shared module',
  /src="\/cw9-bridge\.js"/.test(desk) && /src="\/cw9-bridge\.js"/.test(idx));
ok('both pages load the shared stylesheet',
  /href="\/cw9-bridge\.css"/.test(desk) && /href="\/cw9-bridge\.css"/.test(idx));
ok('the desk keeps no private copy of the helpers',
  !/function cw9Esc\(/.test(desk) && !/function cw9Transport\(/.test(desk) && !/function cw9LineClass\(/.test(desk));
ok('the classic console keeps no private copy either',
  !/function cw9ClassicTransport\(/.test(idx) && !/function cw9ClassicLineClass\(/.test(idx) && !/function cw9ClassicTerm\(/.test(idx));
ok('the shared module is DOM-free (it must run in node and in a browser)',
  !/\bdocument\.|window\.(?!CW9B)/.test(pub('cw9-bridge.js')));

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
