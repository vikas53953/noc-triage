// desk.cw9.ui.test.js — CW-9 FRONTEND: the bridge-conduct renderers on the desk.
//
// Plain words: the live session pane prints RAW device output. That is the most
// hostile string on the whole page — it comes off a switch, through an agent,
// onto a black screen. This suite pins the two things that must never slip:
//   1. every device-supplied value is escaped BEFORE it reaches the DOM, and
//   2. the transport label is honest — a Command Runner read is never dressed
//      up as SSH, and an absent transport says so instead of guessing.
// It also pins the split layout, the mobile stack and the additive contract
// (a message with no `kind` must render exactly as it did before this wave).
//
// DETERMINISTIC: no browser, no network. The pure helpers are extracted verbatim
// from public/desk.html between the CW9-PURE-START / CW9-PURE-END markers and run
// in a vm sandbox, so this tests the SHIPPED code, not a copy of it.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
function ok(name, cond) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}`); }
}

const deskPath = path.join(__dirname, '..', 'public', 'desk.html');
const desk = fs.readFileSync(deskPath, 'utf8');

console.log('\nCW-9 desk UI — split terminal, envelope rendering, escaping:\n');

// ── extract the pure block and run it ───────────────────────────────────────
const m = desk.match(/\/\* CW9-PURE-START[\s\S]*?\*\/([\s\S]*?)\/\* CW9-PURE-END \*\//);
ok('pure helper block is present in desk.html', !!m);
const sandbox = {};
if (m) vm.runInNewContext(m[1] + '\n;this.api = { cw9Esc, cw9Transport, cw9OpenLine, cw9LineClass, cw9OutputHtml, cw9TermBlockHtml, cw9ResumeTarget };', sandbox);
const A = sandbox.api || {};

// ── 1. escaping every sink ──────────────────────────────────────────────────
const XSS = '<img src=x onerror=alert(1)>';
ok('esc neutralises angle brackets', A.cw9Esc(XSS) === '&lt;img src=x onerror=alert(1)&gt;');
ok('esc handles quotes and ampersands', A.cw9Esc(`a&b"c'd`) === 'a&amp;b&quot;c&#39;d');
ok('esc of null is empty, not "null"', A.cw9Esc(null) === '');

const hostile = A.cw9TermBlockHtml({
  host: '<b>sw1</b>',
  command: 'show run | i <script>',
  output: 'line one <script>alert(1)</script>\nEthernet1/5 is down (sfpAbsent)',
  transport: 'ssh',
}, '10:22');
ok('hostile host never reaches the DOM as markup', hostile.indexOf('<b>sw1</b>') === -1);
ok('hostile command is escaped', hostile.indexOf('| i &lt;script&gt;') !== -1);
ok('raw output can never open a tag', !/<script/i.test(hostile));
ok('raw output keeps its text, escaped', hostile.indexOf('&lt;script&gt;alert(1)&lt;/script&gt;') !== -1);
ok('an event-handler attribute cannot survive', A.cw9OutputHtml(XSS).indexOf('onerror=alert(1)&gt;') !== -1
  && A.cw9OutputHtml(XSS).indexOf('<img') === -1);

// ── 2. honest transport labels ──────────────────────────────────────────────
ok('ssh is labelled SSH', A.cw9Transport('ssh').label === 'SSH');
ok('cmdrunner is labelled Command Runner, never SSH', A.cw9Transport('cmdrunner').label === 'Command Runner');
ok('api is labelled API read', A.cw9Transport('api').label === 'API read');
ok('an absent transport says so, it does not guess', A.cw9Transport(undefined).label === 'transport not stated');
ok('an unknown transport is not silently upgraded', A.cw9Transport('telnet').key === 'unknown');
const cmdBlock = A.cw9TermBlockHtml({ host: 'sw1', command: 'show version', output: 'ok', transport: 'cmdrunner' }, '');
ok('a Command Runner block never prints an ssh line', cmdBlock.indexOf('ssh sw1') === -1);
ok('a Command Runner block names the real path', cmdBlock.indexOf('command-runner --device sw1') !== -1);
ok('an ssh block prints the ssh line', A.cw9TermBlockHtml({ host: 'apic1', command: 'x', output: 'y', transport: 'ssh' }, '').indexOf('ssh apic1') !== -1);

// ── 3. output colouring is whole-line only (never splices into device text) ──
ok('an error line is red', A.cw9LineClass('Ethernet1/5 is down (sfpAbsent)') === 'r');
ok('a warning line is amber', A.cw9LineClass('Last link flapped: 10:17:52') === 'a');
ok('a healthy line is green', A.cw9LineClass('GigabitEthernet0/1 is up') === 'g');
ok('a neutral line gets no class', A.cw9LineClass('Hardware: 1000/10000 Ethernet') === '');
const coloured = A.cw9OutputHtml('all up\n<hack> is down');
ok('the class span wraps the whole escaped line', coloured.indexOf('<span class="r">&lt;hack&gt; is down</span>') !== -1);
ok('empty output says so rather than showing a blank screen', A.cw9OutputHtml('   ').indexOf('the device returned nothing') !== -1);

// ── 4. resume target: same-origin only ──────────────────────────────────────
ok('a stated relative route is used', A.cw9ResumeTarget({ resume: '/api/bridge/resume' }).url === '/api/bridge/resume');
ok('an object route with a field is honoured', A.cw9ResumeTarget({ resume: { url: '/api/x', field: 'answer' } }).field === 'answer');
ok('an absolute off-host route is refused', A.cw9ResumeTarget({ resume: 'https://evil.example/x' }) === null);
ok('a protocol-relative route is refused', A.cw9ResumeTarget({ resume: '//evil.example/x' }) === null);
ok('a triage id falls back to the stable bridge route',
  A.cw9ResumeTarget({ triageId: 'trg-abc-1' }).url === '/api/triage/trg-abc-1/message');
ok('a path-shaped id can never escape the route', A.cw9ResumeTarget({ triageId: '../../etc' }) === null);
ok('no stated route and no id → the normal ask path', A.cw9ResumeTarget({}) === null);

// ── 5. the V2 layout actually shipped in the page ───────────────────────────
ok('the split container exists', /id="centerSplit"/.test(desk) && /class="centersplit"/.test(desk));
ok('the persistent session pane exists', /id="termPane"/.test(desk) && /id="termBody"/.test(desk));
ok('the pane can be collapsed by the operator', /id="termToggle"/.test(desk));
ok('the terminal stacks under the chat on a narrow screen',
  /@media \(max-width:1240px\)\{[\s\S]*?\.centersplit\{display:flex;flex-direction:column/.test(desk));
ok('the terminal screen is dark and monospaced',
  /\.tb-body\{[\s\S]*?font-family:var\(--mono\)/.test(desk) && /\.tb-body\{[\s\S]*?background:#04070b/.test(desk));
ok('the terminal scrolls horizontally inside the pane', /\.tb-body\{[\s\S]*?overflow-x:auto/.test(desk));

// ── 6. the five kinds are rendered, and old messages are untouched ──────────
for (const kind of ['ask', 'roster', 'finding', 'verdict', 'change']) {
  ok(`kind '${kind}' has a renderer`, new RegExp(`kind === '${kind}'`).test(desk));
}
ok("a message with no kind falls through to the old bubble path",
  /if\(kind !== 'ask' && kind !== 'roster' && kind !== 'finding' && kind !== 'verdict' && kind !== 'change'\) return false;/.test(desk));
ok('onChat still paints plain replies exactly as before',
  /if\(cw9Render\(d\)\)\{[\s\S]*?\}\s*jvMsg\(d\.agentName \|\| d\.agent \|\| 'Jarvis', d\.text \|\| '', d\.timestamp\);/.test(desk));
ok('stood-down agents are struck through', /\.rpill\.off\{[^}]*line-through/.test(desk));
ok('engaged agents are green', /\.rpill\.on\{[^}]*var\(--ok\)/.test(desk));
ok('the change card is held for approval, never applied',
  /held for approval/.test(desk) && /Nothing has been sent to any device/.test(desk));

// ── 7. reload restores the session pane too ─────────────────────────────────
ok('the session pane is persisted with the thread', /term:term, termBlocks:CW9\.blocks/.test(desk));
ok('the session pane is restored on reload', /if\(typeof st\.term === 'string'/.test(desk));
ok('chat-store history rehydrates the call', /function cw9Hydrate/.test(desk) && /data\.chatHistory/.test(desk));

// ── 8. the classic console renders the same envelope (no blank bubbles) ─────
const idx = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
ok('index.html renders the envelope kinds too', /function cw9RenderClassic/.test(idx));
ok('index.html escapes the cli output', /cw9ClassicTerm/.test(idx) && /escapeHtml/.test(idx));

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
