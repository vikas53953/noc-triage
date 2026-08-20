// claude.cache.test.js — CW-10 item 2: the cached prefix is BYTE-STABLE.
//
// Prompt caching is a prefix match: one changed byte anywhere before the
// breakpoint and the whole cache is thrown away — silently, with no error, just
// a bill. The classic ways to do that by accident are a clock, a uuid, an
// unsorted JSON blob or a varying tool list sitting in the SYSTEM prompt.
//
// This suite asserts the property rather than the intention: it runs the SAME
// conversation twice through a mock transport and compares the assembled system
// block BYTE FOR BYTE, then audits the app's real system prompts for the known
// silent invalidators. It needs no API key and spends nothing.

const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.ANTHROPIC_API_KEY = 'test-key-never-real';

const spend = require('./spend-store');
spend._setDir(fs.mkdtempSync(path.join(os.tmpdir(), 'cw10-cache-')));

const claude = require('./claude');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`); }
}

const seen = [];
function jsonResponse(body) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}
claude._test._setFetch(async (url, init) => {
  seen.push(init && init.body ? JSON.parse(init.body) : null);
  return jsonResponse({
    id: 'msg', type: 'message', role: 'assistant', model: 'claude-opus-5',
    content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  });
});

// A realistic system prompt: long, fixed, written once as a module constant —
// exactly the shape every prompt in jarvis.js has.
const SYSTEM = [
  'You are Jarvis, L4 / Principal Engineer, on a live NOC bridge.',
  'State no network fact you were not given. Never invent a device or a number.',
].join('\n');

(async () => {
  console.log('\nTWO CALLS OF ONE CONVERSATION — the cached prefix must not move:');

  // Turn 1 and turn 2 of the SAME conversation: same system prompt, different
  // volatile user content (a new clock and a new operator line each turn).
  await claude.reason({
    system: SYSTEM,
    messages: [{ role: 'user', content: `Current time (UTC): ${new Date().toISOString()}\n\nOperator: what is the campus health?` }],
    purpose: 'plan',
  });
  await new Promise((r) => setTimeout(r, 5));
  await claude.reason({
    system: SYSTEM,
    messages: [{ role: 'user', content: `Current time (UTC): ${new Date().toISOString()}\n\nOperator: and the WAN?` }],
    purpose: 'plan',
  });

  const a = seen[0], b = seen[1];
  ok('two calls really went out', seen.length === 2, `calls=${seen.length}`);
  ok('the assembled system block is BYTE-IDENTICAL across the two calls',
    JSON.stringify(a.system) === JSON.stringify(b.system), JSON.stringify(a.system) + ' !== ' + JSON.stringify(b.system));
  ok('it carries the cache breakpoint (cache_control ephemeral)',
    a.system[0].cache_control && a.system[0].cache_control.type === 'ephemeral');
  ok('the volatile per-turn content DID change (so the test is really comparing turns)',
    JSON.stringify(a.messages) !== JSON.stringify(b.messages));
  ok('tools are stable across the two calls (a varying tool list invalidates everything)',
    JSON.stringify(a.tools || null) === JSON.stringify(b.tools || null));
  ok('the model is stable across the two calls (a model switch is a cache miss)', a.model === b.model);

  // The web note is a fixed constant, so turning research on does not make the
  // prefix drift turn to turn.
  seen.length = 0;
  claude._test._setWebResearch(true, 'test');
  await claude.reason({ system: SYSTEM, messages: [{ role: 'user', content: 'one' }], web: true });
  await claude.reason({ system: SYSTEM, messages: [{ role: 'user', content: 'two' }], web: true });
  ok('with web research ON, the system block is still byte-identical turn to turn',
    JSON.stringify(seen[0].system) === JSON.stringify(seen[1].system));
  ok('and the tool list itself is byte-identical (max_uses included)',
    JSON.stringify(seen[0].tools) === JSON.stringify(seen[1].tools));
  claude._test._setWebResearch(null, 'reset');

  // ── The silent-invalidator audit, run against the REAL prompts ────────────
  console.log('\nSILENT INVALIDATORS — audited against the app\'s real system prompts:');
  const src = fs.readFileSync(path.join(__dirname, 'jarvis.js'), 'utf8');
  // Every `system:` argument in jarvis.js must be a bare CONSTANT identifier —
  // never a template literal, never a concatenation. That is what keeps a clock
  // or an id out of the cached prefix; the volatile parts belong in `messages`.
  const systemArgs = [...src.matchAll(/\bsystem:\s*([^,\n]+)/g)].map((m) => m[1].trim());
  ok('every system: argument is a constant identifier, not an interpolated string',
    systemArgs.length > 0 && systemArgs.every((s) => /^[A-Z][A-Z0-9_]*$/.test(s)),
    JSON.stringify(systemArgs));

  // And each of those constants must itself be free of a clock / id / random.
  const badPrompt = [];
  for (const name of new Set(systemArgs)) {
    const decl = new RegExp(`const ${name}\\s*=\\s*\`([\\s\\S]*?)\`;`);
    const m = src.match(decl);
    if (!m) continue;
    if (/\$\{|Date\.now|new Date|toISOString|randomUUID|Math\.random/.test(m[1])) badPrompt.push(name);
  }
  ok('no system prompt constant contains a clock, a uuid or an interpolation',
    badPrompt.length === 0, badPrompt.join(', '));

  // The wrapper builds the block from the system string alone — same string in,
  // same bytes out, no matter what else changed around it.
  const one = claude._test.buildBody({ system: SYSTEM, messages: [{ role: 'user', content: 'x' }], maxTokens: 100, effort: 'high' });
  const two = claude._test.buildBody({ system: SYSTEM, messages: [{ role: 'user', content: 'y' }], maxTokens: 999, effort: 'low' });
  ok('buildBody is deterministic: same system string → identical system bytes',
    JSON.stringify(one.system) === JSON.stringify(two.system));

  console.log(`\nCW-10 cache byte-stability: ${pass} passed, ${fail} failed.`);
  if (fail) process.exit(1);
})().catch((err) => { console.error('test crashed:', err); process.exit(1); });
