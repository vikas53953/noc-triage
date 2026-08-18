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
//   3. CLASS 3+4 FOLLOW-UP — the object test must FAIL CLOSED. The old suite was
//      blind here: every "must refuse" case used a BARE object ("clear counters",
//      "set boot system"), which is the one shape the old one-token-lookahead
//      could still see. Real operators stack determiners and adjectives ("clear
//      all the counters on sw2"), and every one of those passed silently. The
//      adjective-stacked cases below are the guard against that ever returning.
const { checkIntent, splitIntent, looksLikeChangeAsk } = require('./guardrails');

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

// ── CLASS 3+4 FOLLOW-UP ─────────────────────────────────────────────────────

console.log('\nFAIL-CLOSED OBJECT SCAN — a determiner or adjective must not defeat the refusal:');
const STACKED_REFUSE = [
  'clear all the counters on sw2',
  'clear the interface counters',
  'install the new image on sw1',
  'install that latest image',
  'set a new hostname',
  'set the new hostname on sw3',
  'wipe every single vlan',
  'delete all the old vlans on sw2',
  'remove the second access-list from sw1',
  'copy the current running-config to startup-config',
  'no shut all of the interfaces',
  'disable the spanning-tree on sw4',
  'enable the debug logging on sw2',
  'push the golden config to every switch',
  'apply the new acl to gi1/0/3',
  // Fail-closed: the object is not device vocabulary, but it is not everyday
  // English either — an unrecognised object must refuse, not pass.
  'clear the frobnicator on sw9',
  'set the thingamajig',
];
for (const t of STACKED_REFUSE) {
  const v = checkIntent(t);
  ok(JSON.stringify(t), v.destructive === true, 'FAILED OPEN — let a change through');
}

console.log('\nVERB SHIELDING — a carrier verb must not hide the write behind it:');
const SHIELDED_REFUSE = [
  'run write memory',
  'execute erase startup-config',
  'perform a reload of sw2',
  'please execute a reload of sw2',
  'issue a write mem on sw1',
  'trying to reload sw3',
  'go ahead and run the erase startup-config',
  'perform the config change on sw2',
];
for (const t of SHIELDED_REFUSE) {
  const v = checkIntent(t);
  ok(JSON.stringify(t), v.destructive === true, 'a carrier verb shielded the write');
}

console.log('\nCARRIER + READ is still a read (the shielding must not eat reads):');
const CARRIER_READ_PASS = [
  'run show version on sw1',
  'run show boot system on sw2',
  'execute show running-config on sw3',
  'please run show ip interface brief on sw2',
];
for (const t of CARRIER_READ_PASS) {
  const v = checkIntent(t);
  ok(JSON.stringify(t), v.destructive === false, `false-refused on "${v.keyword}" in "${v.clause}"`);
}

console.log('\nINNOCENT ENGLISH must still flow (the allowlist):');
const INNOCENT_PASS = [
  'clear it up with the team',
  'copy the report to the ticket',
  'set a meeting for 9',
  'set up a bridge with the on-call',
  'install the new build of the dashboard app',
  'remove me from the bridge',
  'no more escalations for now',
  'copy the summary into the postmortem',
];
for (const t of INNOCENT_PASS) {
  const v = checkIntent(t);
  ok(JSON.stringify(t), v.destructive === false, `false-refused on "${v.keyword}" in "${v.clause}"`);
}

console.log('\nEVENT REFERENCES stay prose (a past change is not an order):');
const EVENT_PASS = [
  'show version on sw2 after the reload',
  'show inventory on sw1 since the upgrade',
  'show running-config on sw3 following the planned config change',
  'show version on sw1 before the next maintenance window',
];
for (const t of EVENT_PASS) {
  const v = checkIntent(t);
  ok(JSON.stringify(t), v.destructive === false, `false-refused on "${v.keyword}" in "${v.clause}"`);
}

console.log('\nREFUSAL SINK — a change ask must be seen as a change, not as "no read command":');
const SINK_CHANGE = [
  'clear all the counters on sw2',
  'can you please go and reload sw2 for me',
  'i need you to erase the startup-config on sw1',
  'set a new hostname on sw3',
];
for (const t of SINK_CHANGE) {
  const v = looksLikeChangeAsk(t);
  ok(JSON.stringify(t), v.destructive === true, 'the sink would have said "no read command"');
}
const SINK_NOT_CHANGE = [
  'what happened on sw2 last night',
  'who is on call tonight',
  'show version on sw2 after the reload',
  'copy the report to the ticket',
];
for (const t of SINK_NOT_CHANGE) {
  const v = looksLikeChangeAsk(t);
  ok(JSON.stringify(t), v.destructive === false, `the sink called it a change ("${v.keyword}")`);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
