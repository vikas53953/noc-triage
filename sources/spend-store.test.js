// spend-store.test.js — CW-10 item 4: token accounting that can be trusted.
//
// Two things must both be true, and both are asserted here:
//   1. the numbers are REAL — every field comes from the API's own
//      response.usage, and the summary adds them up per day / purpose / model;
//   2. the file can never become a prompt log — no system prompt, no operator
//      message, no answer, no findings, ever reach disk here.
// Plus the operational guards: a rotation at the size cap, a corrupt file that
// does not crash a live reasoning call, and a summary endpoint shape the Desk
// panel can render.

const os = require('os');
const path = require('path');
const fs = require('fs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw10-spend-test-'));
const spend = require('./spend-store');
spend._setDir(dir);

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`); }
}

const FILE = path.join(dir, 'spend.json');
const today = new Date().toISOString().slice(0, 10);

console.log('\nONE RECORD PER MODEL CALL — straight from response.usage:');
const rec = spend.record({
  purpose: 'synthesize',
  model: 'claude-sonnet-5',
  conversationId: 'conv-1',
  usage: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 },
});
ok('the record carries every field the contract pins',
  rec && rec.ts && rec.purpose === 'synthesize' && rec.model === 'claude-sonnet-5'
  && rec.conversationId === 'conv-1' && rec.input_tokens === 1200 && rec.output_tokens === 300
  && rec.cache_read_input_tokens === 900 && rec.cache_creation_input_tokens === 0, JSON.stringify(rec));
ok('it is on disk immediately (a crash cannot lose the spend)', fs.existsSync(FILE));

spend.record({ purpose: 'probe', model: 'claude-sonnet-5', incidentId: 'INC-20260820-001', usage: { input_tokens: 400, output_tokens: 50 } });
spend.record({ purpose: 'probe', model: 'claude-opus-5', conversationId: 'conv-1', usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 4000 } });
ok('an incidentId is recorded when that is the id the app holds',
  spend.all()[1].incidentId === 'INC-20260820-001' && spend.all()[1].conversationId === undefined);

console.log('\nPROMPT TEXT CAN NEVER REACH THIS FILE:');
spend.record({
  purpose: 'plan', model: 'claude-opus-5', usage: { input_tokens: 1, output_tokens: 1 },
  // Everything a careless caller might try to pass through:
  system: 'SECRET SYSTEM PROMPT', messages: [{ role: 'user', content: 'operator said something private' }],
  text: 'the composed answer', prompt: 'a prompt',
});
const raw = fs.readFileSync(FILE, 'utf8');
ok('a stray system/messages/text/prompt field is dropped, not written',
  !/SECRET SYSTEM PROMPT/.test(raw) && !/operator said something private/.test(raw)
  && !/composed answer/.test(raw) && !/"prompt"/.test(raw));
const keys = new Set();
for (const r of spend.all()) Object.keys(r).forEach((k) => keys.add(k));
const ALLOWED = new Set(['ts', 'purpose', 'model', 'conversationId', 'incidentId',
  'input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']);
ok('the record shape is a closed set of numbers + short labels',
  [...keys].every((k) => ALLOWED.has(k)), [...keys].join(','));
ok('a prose purpose is trimmed to a label, never kept as text',
  spend.record({ purpose: 'x'.repeat(500), model: 'm', usage: {} }).purpose.length <= 40);

console.log('\nSUMMARY — per day, per purpose, per model:');
const s = spend.summary();
ok('totals add up across every record',
  s.total.input_tokens === 1200 + 400 + 100 + 1 + 0 && s.total.output_tokens === 300 + 50 + 10 + 1 + 0,
  JSON.stringify(s.total));
ok('cache reads are totalled separately (that is where the saving shows)',
  s.total.cache_read_input_tokens === 4900, String(s.total.cache_read_input_tokens));
ok('per-purpose is broken out', s.byPurpose.probe.calls === 2 && s.byPurpose.synthesize.calls === 1, JSON.stringify(Object.keys(s.byPurpose)));
ok('per-model is broken out', s.byModel['claude-sonnet-5'].calls === 2 && s.byModel['claude-opus-5'].calls === 2);
ok('per-day is broken out, and today is one of the days', Boolean(s.byDay[today]) && s.today.calls === s.byDay[today].calls);
ok('the last 7 days include today', s.week.calls >= s.today.calls);

// A record from last month must not land in today or this week.
spend.record({ ts: '2026-01-01T00:00:00.000Z', purpose: 'plan', model: 'm', usage: { input_tokens: 9999, output_tokens: 1 } });
const s2 = spend.summary();
ok('an old record counts in the total and byDay, but not in today',
  s2.total.input_tokens === s.total.input_tokens + 9999 && s2.today.calls === s.today.calls && Boolean(s2.byDay['2026-01-01']));

console.log('\nOPERATIONAL GUARDS:');
// A corrupt file must never take down a live reasoning call — and must never be
// silently destroyed either (PR #74 review, minor 7).
fs.writeFileSync(FILE, '{ this is not json');
spend._reset();
ok('a corrupt file reads as empty instead of throwing', spend.all().length === 0);
ok('and a new record still writes', Boolean(spend.record({ purpose: 'plan', model: 'm', usage: { input_tokens: 5, output_tokens: 5 } })));
const aside = fs.readdirSync(dir).filter((f) => /^spend\.corrupt-\d+\.json$/.test(f));
ok('the unreadable file is KEPT ASIDE, not overwritten and lost', aside.length === 1, fs.readdirSync(dir).join(','));
ok('and the kept-aside copy is the original bytes',
  fs.readFileSync(path.join(dir, aside[0]), 'utf8') === '{ this is not json');

// A junk member in a hand-edited store must not inflate the call count
// (PR #74 review, minor 6): a headline number that disagrees with its own
// breakdown is worse than no number.
fs.writeFileSync(FILE, JSON.stringify([
  null, 5, 'x', [1, 2],
  { ts: new Date().toISOString(), purpose: 'plan', model: 'm', input_tokens: 10, output_tokens: 2 },
]));
spend._reset();
const junk = spend.summary();
ok('calls counts only the real records, not the junk', junk.calls === 1, `calls=${junk.calls}`);
ok('and the totals agree with that count', junk.total.calls === junk.calls && junk.total.input_tokens === 10);

// Rotation at the cap: fill past it and check the file is trimmed and the older
// half preserved in spend.1.json.
process.env.SPEND_MAX_BYTES = '20000';
delete require.cache[require.resolve('./spend-store')];
const spend2 = require('./spend-store');
spend2._setDir(dir);
fs.writeFileSync(FILE, '[]');
spend2._reset();
for (let i = 0; i < 400; i++) spend2.record({ purpose: 'probe', model: 'claude-sonnet-5', conversationId: `c-${i}`, usage: { input_tokens: i, output_tokens: 1 } });
const size = fs.statSync(FILE).size;
ok('the live file stays under the 20KB cap set for this test', size <= 20000, `size=${size}`);
ok('nothing is lost silently — the pre-rotation file is kept as spend.1.json', fs.existsSync(path.join(dir, 'spend.1.json')));
ok('the NEWEST records are the ones kept', spend2.all()[spend2.all().length - 1].conversationId === 'c-399');
ok('the summary still works after a rotation', spend2.summary().calls === spend2.all().length);

console.log(`\nCW-10 spend store: ${pass} passed, ${fail} failed.`);
if (fail) process.exit(1);
