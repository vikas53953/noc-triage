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
  // A bare event after a time separator with NO subject is still a reference,
  // not an instruction — these must keep passing after the pronoun fix.
  'show version on sw2 after the upgrade window',
  'show running-config on sw3 after restart',
  'show version on sw1 after the reload',
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
  // OBJECT-LESS write intent after a subject pronoun — the review's must-fix.
  // "after you reload" (no object) is an instruction, not a past-event noun, and
  // must be refused exactly as the with-object variant above already was.
  'show version on sw2 after you reload',
  'show version then you reboot',
  'show running-config and you wipe it',
  'show version once we reload',
  'show inventory before I erase startup-config',
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

console.log('\nCLASS 4 — English homonyms must NOT false-refuse:');
const HOMONYMS_PASS = [
  'no rush',
  'no more',
  'no, that is fine',
  'no target was named, so I asked which switch',
  'if no target was named the planner asks',
  'clear it up',
  'let us clear it up',
  'clear the air on this',
  'copy the report',
  'copy the report to the incident record',
  'set up a call with the on-call',
  'remove me from the bridge',
  'kill the noise on this thread',
  'enable the team to see it',
  'disable the alert for now',
  'please can you brief me on the outage',
];
for (const t of HOMONYMS_PASS) {
  const v = checkIntent(t);
  ok(JSON.stringify(t), v.destructive === false, `false-refused on "${v.keyword}" in "${v.clause}"`);
}

console.log('\nCLASS 4 — real writes in ANY inflection must refuse AND be named:');
const WRITES_REFUSE = [
  'reload sw1',
  'reboots sw2',
  'he reloads it',
  'she reloads the router',
  'reloading sw3 now',
  'wipe the config',
  'wipes the startup-config',
  'wiping the config on sw2',
  'erases the flash',
  'write mem',
  'write memory',
  'clear counters',
  'no shutdown',
  'copy running-config startup-config',
  'delete flash',
  'set boot system',
];
for (const t of WRITES_REFUSE) {
  const v = checkIntent(t);
  ok(JSON.stringify(t), v.destructive === true && !!v.keyword, 'let a real write through');
}

console.log('\nCLASS 4 — compound read-then-write stays safe:');
const cs = splitIntent('show version on sw1 then reload it');
ok('read half runs', /show version/i.test(cs.readText) && !/reload/i.test(cs.readText), cs.readText);
ok('reload refused and named', cs.destructive === true && cs.change && cs.change.keyword === 'reload', JSON.stringify(cs.change));

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
