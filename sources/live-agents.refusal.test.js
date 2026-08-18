// Refusal-sink checks for sources/live-agents.js. No network, no device, no LLM:
// every case below is refused BEFORE anything is sent anywhere, which is exactly
// why it can be tested offline.
//
// Two logged defects live here:
//
//   4. THE WRONG REPLY. A change ask that did not lead its clause with a write
//      verb ("maybe we should reload sw2 tonight") fell through to the read
//      parser, found no read command, and was answered "🤔 I could not find a
//      read command in that" — telling an operator who asked for a CHANGE that
//      they had failed to name a read. The honest answer is that it IS a change
//      and this path is read-only.
//
//   5. THE MISSING AUDIT. Refused writes were audit-logged on ONE branch only
//      (the deterministic screen in server.js). Everything refused further down
//      left no trace: no activity line, no audit record. The record is now
//      written at the single sink, so every refused write is on the record
//      exactly once — whatever path produced it.
const live = require('./live-agents');
const session = require('./session-log');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`); }
}

const said = [];
const activity = [];
live.init({
  agents: { 'config-keeper': { name: 'Config-Keeper', icon: '🔧' } },
  say: (a, t) => said.push(String(t)),
  updateAgentStatus: () => {},
  appendToActivityLog: (l) => activity.push(String(l)),
  addTaskToBoard: () => {}, moveTaskOnBoard: () => {},
  broadcast: () => {},
  conversationId: () => 'refusal-test',
});

function auditCount() { return session.auditAll().length; }

async function run(request) {
  said.length = 0; activity.length = 0;
  const before = auditCount();
  await live.handle('config-keeper', request);
  await new Promise((r) => setTimeout(r, 250));   // the reply is said on a timer
  return { text: said.join('\n'), activity: activity.join('\n'), audits: auditCount() - before };
}

(async () => {
  console.log('\nITEM 4 — a change ask gets the CHANGE answer, not "no read command":');
  for (const ask of [
    'maybe we should reload sw2 tonight',
    'clear all the counters on sw2',
    'i think it is time to erase the startup-config on sw1',
  ]) {
    const r = await run(ask);
    ok(`${JSON.stringify(ask)} — named as a change`,
      /change to the device/i.test(r.text) && /read-only/i.test(r.text), r.text.slice(0, 160));
    ok(`${JSON.stringify(ask)} — NOT answered "could not find a read command"`,
      !/could not find a read command/i.test(r.text), r.text.slice(0, 160));
    ok(`${JSON.stringify(ask)} — offers the read instead`,
      /show you the device/i.test(r.text), r.text.slice(0, 160));
    ok(`${JSON.stringify(ask)} — says nothing was sent`,
      /Nothing was sent to any device/i.test(r.text), r.text.slice(0, 160));

    console.log('  (item 5 — the same refusal must leave a trace)');
    ok(`${JSON.stringify(ask)} — exactly one audit record`, r.audits === 1, `got ${r.audits}`);
    ok(`${JSON.stringify(ask)} — one activity line naming the refusal`,
      /Refused a state-changing request/.test(r.activity), r.activity.slice(0, 160));
  }

  console.log('\nA GENUINE "no read command" ask still gets that answer:');
  const vague = await run('what do you reckon about the estate');
  ok('vague ask still says no read command found',
    /could not find a read command/i.test(vague.text) || /cannot answer that one/i.test(vague.text),
    vague.text.slice(0, 160));
  ok('vague ask is NOT audited as a refused change', vague.audits === 0, `got ${vague.audits}`);

  // ── Reviewer addition (PR #52 review) ─────────────────────────────────────
  // A COMPOUND ask is a refused write too. It used to be said and logged by the
  // RENDERER, so when the read half threw (source unreachable — the normal state
  // with no sandbox credentials) the operator was told only "source unreachable"
  // and the refusal left no message, no activity line and no audit record.
  console.log('\nCOMPOUND ask — the refused change half is said AND recorded, even when the read fails:');
  for (const ask of [
    'reload sw2 then show version',
    'maybe we should reload sw2, and show me the version',
  ]) {
    const r = await run(ask);
    ok(`${JSON.stringify(ask)} — the change is named out loud`,
      /did NOT do the change/i.test(r.text), r.text.slice(0, 160));
    ok(`${JSON.stringify(ask)} — exactly one audit record`, r.audits === 1, `got ${r.audits}`);
    ok(`${JSON.stringify(ask)} — one refusal activity line`,
      (r.activity.match(/Refused a state-changing request/g) || []).length === 1, r.activity.slice(0, 200));
    ok(`${JSON.stringify(ask)} — the record does not claim nothing was sent`,
      /only the read half was run/.test(r.activity), r.activity.slice(0, 200));
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
