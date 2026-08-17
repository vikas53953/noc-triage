// CW-2 pre-work checks for sources/guardrails.js.
//
// Two jobs, both reviewer-logged debts:
//   1. checkIntent must judge the COMMAND CLAUSE, never free prose/rationale.
//      The logged failure: a delegated read whose justification says "after the
//      upgrade" / "after restart" was refused as a change.
//   2. splitIntent must separate a compound "read then change" so the read half
//      can be honoured and the change half refused OUT LOUD.
//
// Every "must still refuse" case below is a regression guard: the fix may not
// buy honesty for prose by going quiet on a real write.
const { checkIntent, splitIntent } = require('./guardrails');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`); }
}

console.log('\nMUST PASS (rationale/prose, not a command):');
const MUST_PASS = [
  'show version on sw2 — I need to confirm the image after the upgrade',
  'run show version on sw1 to verify it came back up after restart',
  'show running-config on sw2, checking the config after the change window',
  'show ip interface brief on sw3 since the last reload',
  'show version on sw1 because of the maintenance window',
  'show inventory on sw4 following the planned upgrade',
  'no, show me the version',
  'show me the running config',
  'write me a report on the campus estate',
];
for (const t of MUST_PASS) {
  const v = checkIntent(t);
  ok(JSON.stringify(t), v.destructive === false, `refused on "${v.keyword}" in "${v.clause}"`);
}

console.log('\nMUST STILL REFUSE (a real change hiding in the sentence):');
const MUST_REFUSE = [
  'show version on sw1; reload',
  'show ip arp\nreload',
  'show version after you reload the router',
  'and afterwards reload it',
  'please erase startup-config',
  'reload sw1 then show me the version',
  'show version then wipe the config',
  'configure terminal',
  'no shut on gi1/0/3',
  'after the upgrade, wipe the config',
  'show version | write erase',
];
for (const t of MUST_REFUSE) {
  const v = checkIntent(t);
  ok(JSON.stringify(t), v.destructive === true, 'let a change through');
}

console.log('\nCOMPOUND read-then-change split:');
const c1 = splitIntent('reload sw1 then show me the version');
ok('compound detected', c1.compound === true);
ok('change half is the reload', c1.change && c1.change.keyword === 'reload', JSON.stringify(c1.change));
ok('read half carries no change text', /show/i.test(c1.readText) && !/reload/i.test(c1.readText), c1.readText);

const c2 = splitIntent('show version on sw2 after the upgrade');
ok('pure read is not compound', c2.compound === false && c2.destructive === false);

const c3 = splitIntent('erase startup-config');
ok('pure change has no read half', c3.destructive === true && c3.compound === false);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
