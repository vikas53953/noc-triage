// jarvis.junior.test.js — the two "acts junior" UX defects, closed as classes.
//
// DEFECT 1 (truncation): an operator-facing line was hard-sliced with `.slice(0,N)`,
// so the capability answer and plan rationales were cut mid-WORD ("…ask about an i").
// jarvis.softClip trims WITHOUT splitting a word and marks the cut with an honest
// ellipsis. DETERMINISTIC — pure string logic, no LLM.
//
// DEFECT 2 (brusque greeting/help): a bare "hi" / "help" / meta-ask was bounced by
// the capability gate as "outside what I am wired to do" BEFORE the helpful list.
// capabilities.checkAsk now lets a greeting or a meta/help ask through to the planner
// (which answers it warmly), while KEEPING the honest refusal for a genuine unbuilt
// ask and the change-proposal flow. DETERMINISTIC — no key, no network.

const cap = require('./capabilities');
const jarvis = require('./jarvis');
const { softClip } = jarvis._test;

let passed = 0, failed = 0;
function ok(name, cond) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}`); }
}

const allowed = (t) => cap.checkAsk(t).allowed === true;
const refused = (t) => { const r = cap.checkAsk(t); return r.allowed === false && !r.changeProposal; };
const proposed = (t) => cap.checkAsk(t).changeProposal === true;

console.log('\nDEFECT 2 — greeting / help / meta reach the planner, not a brusque refusal:\n');
// Greetings pass (no "I can't do that yet").
['hi', 'hey jarvis', 'hello', 'yo', 'howdy', 'morning', 'good morning', 'thanks', 'thank you']
  .forEach((t) => ok(`greeting passes: ${JSON.stringify(t)}`, allowed(t)));
// Bare meta / help asks pass.
['help', 'commands', 'capabilities', 'menu', 'what can you do', 'what can you do?', 'who are you', 'what can you help with']
  .forEach((t) => ok(`meta/help passes: ${JSON.stringify(t)}`, allowed(t)));

console.log('\n  guards still hold (no over-permissiveness):\n');
ok('genuinely off-topic still refused', refused('order me a pizza'));
ok('unbuilt ability still refused (teams)', refused('post this update to the teams channel'));
ok('unbuilt ability still refused (servicenow)', refused('open a servicenow incident for this'));
ok('a real change is still a proposal, not an answer', proposed('reload sw1'));
ok('a greeting that OPENS a real ask is NOT swallowed as a greeting', allowed('morning, why is sw1 down?'));
// isGreetingOrMeta itself must not claim a real request that merely starts with a greeting word.
ok('greeting detector rejects a real request', cap._internals.isGreetingOrMeta('hey jarvis, run show version on sw2') === false);

console.log('\nDEFECT 1 — softClip never cuts a word, and marks the cut honestly:\n');
const long = 'This is the first sentence. This is a much longer second sentence that keeps going and going well past the limit so it must be trimmed somewhere in the middle.';
const clipped = softClip(long, 60);
ok('short text is returned untouched', softClip('all good here', 200) === 'all good here');
ok('clipped text is within a small margin of the limit', clipped.length <= 66);
ok('clipped text ends with an honest ellipsis', /…$/.test(clipped));
ok('clipped text never ends mid-word (last real char before … is punctuation or a whole word)',
  !/\w\s*…$/.test(clipped) ? true : /\b\w+\s*…$/.test(clipped)); // no partial-word tail
ok('clipped text contains no split word fragment vs source', long.startsWith(clipped.replace(/\s*…$/, '').replace(/\.$/, '')) || long.includes(clipped.replace(/\s*…$/, '')));
ok('prefers a sentence boundary when one is available', softClip(long, 40).replace(/\s*…$/, '') === 'This is the first sentence.');

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
