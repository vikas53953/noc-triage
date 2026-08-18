// capabilities.class9.test.js — QA Class 9: the capability gate must let an ask
// ABOUT this console's own incidents reach the planner, while still refusing a
// genuinely off-topic ask and still routing a real change to the proposal flow.
// DETERMINISTIC: pure string logic, no key, no network.
//
// THE DEFECT: "summarise INC-20260817-013" (and shift-handover asks) were bounced
// by the gate as "outside what I am wired to do" while the capability card
// advertises the handover — the exact contradiction QA logged. The gate now
// recognises this console's own incident-id shapes + handover vocabulary as NOC
// language, so a question/read about them passes through to real reasoning.

const cap = require('./capabilities');

let passed = 0, failed = 0;
function ok(name, cond) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}`); }
}

console.log('\nCLASS 9 — capability gate lets incident asks through, keeps its guards:\n');

const pass = (t) => cap.checkAsk(t).allowed === true;
const refuse = (t) => { const r = cap.checkAsk(t); return r.allowed === false && !r.changeProposal; };
const propose = (t) => cap.checkAsk(t).changeProposal === true;

// Incident asks now reach the planner (defect closed).
ok('summarise a real INC id passes', pass('summarise INC-20260817-013'));
ok('summarise a trg id passes', pass('summarise trg-abc-013'));
ok('shift handover passes', pass('give me a shift handover'));
ok('handover summary passes', pass('give me a handover summary'));
ok('who is on this incident passes', pass('who is on this incident?'));
ok('what is open right now passes', pass('what incidents are open right now?'));
ok('latest incident passes', pass('what is the latest incident?'));

// The gate still holds its two guards — no over-permissiveness crept in.
ok('genuinely off-topic still refused', refuse('order me a pizza'));
ok('a real change is still a proposal, not an answer', propose('reload sw1'));

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
