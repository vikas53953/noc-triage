// Intake gate checks for sources/triage.js.
//
// The logged failure: "lunch is cold today" was posted to intake and the console
// opened a real INC, ran a full estate sweep and paged L3/L4. Intake accepted
// ANY input with a vowel in it, because the only gate was a keysmash test.
//
// The fix is not the old hardcoded keyword gate — that one bounced real reports
// like "voice calls breaking up". Intake now asks WHICH SITE, DEVICE OR SERVICE
// when nothing in the sentence is network-shaped, and accepts anything that
// names a device, a network noun, a site, the people at one, a service, or a
// symptom. This file guards both halves: the ask, and the acceptance.
//
// The gate is tested directly (namesNetworkSubject / looksLikeGarbage) because
// calling startTriage on an ACCEPTED description would open a bridge and read
// real kit. The refusal path IS exercised end-to-end through startTriage, since
// it returns before anything is emitted or read.
const triage = require('./triage');
const { namesNetworkSubject, looksLikeGarbage, startTriage } = triage;

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`); }
}

// What intake would DO with this text: 'open', 'garbage' or 'ask'.
function verdict(desc) {
  if (looksLikeGarbage(desc)) return 'garbage';
  if (!namesNetworkSubject(desc)) return 'ask';
  return 'open';
}

console.log('\nINTAKE MUST ASK (real English, but nothing network-shaped in it):');
const MUST_ASK = [
  'lunch is cold today',
  'the coffee machine is out of beans again',
  'happy friday everyone',
  'can someone bring the cake to the party',
  'my dog ate my homework',
  'what time is the football on',
];
for (const t of MUST_ASK) {
  ok(JSON.stringify(t), verdict(t) === 'ask', `intake would ${verdict(t)}`);
}

console.log('\nINTAKE MUST STILL REFUSE EMPTY / KEYSMASH:');
for (const t of ['', '   ', 'asdfghjkl', 'zxcvbnm qwrtypsdfghjklzxcvbnm']) {
  ok(JSON.stringify(t), verdict(t) === 'garbage', `intake would ${verdict(t)}`);
}

console.log('\nINTAKE MUST OPEN A TRIAGE (real operator reports, plain words):');
const MUST_OPEN = [
  'branch 3 users report slow internet since 2pm',
  'voice calls breaking up',
  "users can't reach the file server",
  "finance can't reach payroll from Pune",
  'sw3 users report slowness',
  'sw2 packet loss since 2pm',
  '10.10.20.176 is unreachable',
  'the whole Pune office is down',
  'wifi keeps dropping on the second floor',
  'printers offline in the london branch',
  'everything is really slow this morning for the sales team',
  'bgp neighbour flapping on the core router',
  'vpn users timing out',
  'teams calls are choppy for remote staff',
];
for (const t of MUST_OPEN) {
  ok(JSON.stringify(t), verdict(t) === 'open', `intake would ${verdict(t)}`);
}

console.log('\nEND TO END — the ask comes back from startTriage, and NOTHING is opened:');
const asked = startTriage('P2', 'lunch is cold today', null);
ok('refused', asked.refused === true, JSON.stringify(asked));
ok('marked as an ask, not a rejection', asked.ask === true, JSON.stringify(asked));
ok('asks which site / device / service in plain words',
  /which site, device, or service/i.test(asked.reason || ''), asked.reason);
ok('says it opened nothing', /opened nothing|read nothing/i.test(asked.reason || ''), asked.reason);
ok('no triage id handed back', !asked.triageId && !asked.incidentId, JSON.stringify(asked));

const noneOpened = triage.listTriages();
ok('triage list is still empty', Array.isArray(noneOpened) ? noneOpened.length === 0 : true,
  JSON.stringify(noneOpened).slice(0, 120));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
