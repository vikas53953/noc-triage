// SYNTHESIS-REFUSAL class fix (2026-08-19) — offline, deterministic, no network.
//
// The OPTIONAL write-up/summary (jarvis Call 2) is sometimes declined HTTP-200 by
// the safety classifier when the findings carry device config, credential-looking
// strings, or HTML/script literals in a ticket title (all legitimate DATA a read
// returned). The fix: on a synthesis refusal, retry the summary EXACTLY ONCE on
// the SAME model with the hostile/sensitive literals REDACTED/neutralised (secrets
// → [redacted], markup → inert note) — data hygiene, NOT switching to a more
// permissive model to defeat the refusal. Only if THAT also refuses do we relay
// the already-on-screen readings with a SHORT, calm note.
//
// We mock claude.reason (no LLM) to drive the refusal shapes and count the calls.
const claude = require('./claude');
const jarvis = require('./jarvis');
const { synthesizeAnswer, relayFindings, neutralizeFindingText } = jarvis._test;

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`); }
}

// Capture what Jarvis says + its status, so we can assert the fallback message.
const said = [];
jarvis.init({
  say: (agentId, text) => said.push({ agentId, text: String(text) }),
  status: () => {},
  log: () => {},
  nameOf: (id) => id,
  gather: () => Promise.resolve(null),
  roster: () => [],
});

// Swap claude.reason for a scripted mock; restore after. jarvis calls it as a
// property at call time, so reassigning the property is enough.
const realReason = claude.reason;
let calls = [];
function mockReason(script) {
  calls = [];
  claude.reason = async (args) => { calls.push(args); return script(calls.length, args); };
}
function restore() { claude.reason = realReason; }

const findings = [
  { name: 'Config-Keeper', stance: 'evidence', text: 'Ran show running-config on sw1: enable secret 9 $9$abcd1234EFGH; snmp-server community publicR0 RW; password 0 Cisco123!' },
  { name: 'Incident-Handler', stance: 'evidence', text: 'Latest incident title "<img src=x onerror=alert(1)>" sev2.' },
];

(async () => {
  console.log('\nSYNTHESIS refusal — exactly ONE neutral retry, then a short honest relay:');

  // 1) Primary refuses, retry ALSO refuses → relayed, and exactly 2 calls (1 + 1).
  mockReason(() => ({ refused: true, text: '', stopReason: 'refusal' }));
  {
    const res = await synthesizeAnswer('what is going on', findings);
    ok('both refuse → result is a relay', res.relayed === true, JSON.stringify(res));
    ok('both refuse → EXACTLY one retry (2 synthesis calls total)', calls.length === 2, `got ${calls.length}`);
    ok('the retry runs on the SAME model (no permissive-model switch to defeat the refusal)',
      calls[1] && (calls[1].model == null), calls[1] && String(calls[1].model));
    ok('the retry sends NEUTRALISED findings (no raw <img onerror>)',
      calls[1] && !/onerror=/.test(calls[1].messages[0].content) && /\[markup:img\]/.test(calls[1].messages[0].content),
      calls[1] && calls[1].messages[0].content.slice(0, 200));
    ok('the retry redacts the secret value ($9$…)',
      calls[1] && !/\$9\$abcd1234EFGH/.test(calls[1].messages[0].content), 'secret leaked into retry');
  }

  // 2) The relay MESSAGE is the short form, not the old big alarming paragraph.
  said.length = 0;
  relayFindings('what is going on', findings, 'the write-up step was declined by the model');
  const relayText = said.map((s) => s.text).join('\n');
  ok('fallback message is the SHORT form', /Summary skipped on this one/.test(relayText), relayText);
  ok('fallback message points to the on-screen readings', /readings from each engineer are above/i.test(relayText), relayText);
  ok('fallback message stays honest (all real)', /all real/i.test(relayText), relayText);
  ok('fallback message is ONE short line (< 160 chars)', relayText.trim().length < 160, `len ${relayText.trim().length}`);
  ok('fallback message does NOT re-dump the raw config body',
    !/running-config/i.test(relayText) && !/onerror/i.test(relayText), relayText);

  // 3) Primary refuses, retry SUCCEEDS → the retry answer is used, still one retry.
  mockReason((n) => n === 1
    ? { refused: true, text: '', stopReason: 'refusal' }
    : { refused: false, text: 'Campus healthy; one incident open on sw1.', stopReason: 'end_turn' });
  {
    const res = await synthesizeAnswer('what is going on', findings);
    ok('retry succeeds → answer used, retried flagged', res.answer === 'Campus healthy; one incident open on sw1.' && res.retried === true, JSON.stringify(res));
    ok('retry succeeds → still exactly one retry (2 calls)', calls.length === 2, `got ${calls.length}`);
  }

  // 4) Primary SUCCEEDS → no retry at all (1 call), no neutralisation needed.
  mockReason(() => ({ refused: false, text: 'All fronts clean.', stopReason: 'end_turn' }));
  {
    const res = await synthesizeAnswer('what is going on', findings);
    ok('primary succeeds → answer used', res.answer === 'All fronts clean.', JSON.stringify(res));
    ok('primary succeeds → NO retry (exactly 1 call)', calls.length === 1, `got ${calls.length}`);
  }

  // 5) neutralizeFindingText: data in, inert out (unit-level).
  {
    const n = neutralizeFindingText('title "<script>alert(1)</script>" secret 5 $1$mERr$aBcDeFgH community public');
    ok('neutralise: script tag → inert markup note', /\[markup:script\]/.test(n) && !/<script>/.test(n), n);
    ok('neutralise: secret value redacted', /secret \[redacted\]/.test(n), n);
    ok('neutralise: hash blob redacted', !/\$1\$mERr/.test(n), n);
  }

  restore();
  console.log(`\nSYNTH-REFUSAL: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
