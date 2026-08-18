// live-agents.session.class9.test.js — QA Class 9, defect 2 (per-operator /
// per-conversation session isolation). DETERMINISTIC: no API key, no network.
//
// THE DEFECT: one GLOBAL Jarvis session — every operator's conversational state
// (the device they settled on, the incident they're working, their parked
// "which device?" question) lived under the literal key 'default', and no client
// ever sent anything else. Operator B's answer landed in operator A's context.
//
// THE FIX (proven here): ALL conversational memory is keyed by the conversation
// id ctx.conversationId() returns, and server.js now hands every socket/request a
// UNIQUE id (never the shared 'default'). Two operators therefore hold two
// separate minds. This test drives that id directly to prove no bleed in either
// direction, plus the structured/ quoted/ remembered incident resolution.

const assert = require('assert');
const live = require('./live-agents');
const incidentRead = require('./incident-read');

let passed = 0, failed = 0;
function ok(name, cond) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}`); }
}

// A controllable conversation id — this is exactly what server.js supplies, one
// distinct value per operator's socket. Flipping it here IS "operator A vs B".
let currentConv = 'op-A::default';
live.init({ conversationId: () => currentConv });

const C = live._conversation;

// Give incident-read a known engine so ownIncidentIdsFor can resolve real ids.
incidentRead._setEngine({
  listIncidents() {
    return [
      { triageId: 'trg-abc-013', incidentId: 'INC-20260817-013', severity: 'P1', status: 'closed', owner: 'Asha', title: 'DC apps slow', openedAt: '2026-08-17T08:30:00Z', sla: { targetMs: 1, breached: true } },
      { triageId: 'trg-def-014', incidentId: 'INC-20260817-014', severity: 'P3', status: 'open', owner: null, title: 'Branch slow', openedAt: '2026-08-17T09:10:00Z', sla: { targetMs: 1, breached: false } },
    ];
  },
  getTriage() { return null; },
});

console.log('\nCLASS 9 / defect 2 — per-operator / per-conversation isolation (no bleed):\n');

// ── Operator A settles on a device and an incident ──────────────────────────
currentConv = 'op-A::default';
C.rememberDevice('sw1');
C.rememberIncident('INC-20260817-013');
ok('A remembers its own device', C.rememberedDevice() === 'sw1');
ok('A remembers its own incident', C.rememberedIncident() === 'INC-20260817-013');

// ── Operator B is a DIFFERENT conversation — starts empty (no bleed A→B) ─────
currentConv = 'op-B::default';
ok('B does NOT see A\'s device', C.rememberedDevice() === null);
ok('B does NOT see A\'s incident', C.rememberedIncident() === null);

// B settles on its OWN, different, device + incident.
C.rememberDevice('sw2');
C.rememberIncident('INC-20260817-014');
ok('B remembers its own device', C.rememberedDevice() === 'sw2');
ok('B remembers its own incident', C.rememberedIncident() === 'INC-20260817-014');

// ── Back to A — its context is intact and UNCHANGED by B (no bleed B→A) ──────
currentConv = 'op-A::default';
ok('A still has its own device after B wrote', C.rememberedDevice() === 'sw1');
ok('A still has its own incident after B wrote', C.rememberedIncident() === 'INC-20260817-013');

// ── A parked "which device?" question must not surface for B either ─────────
C.rememberPendingChoice({ agentId: 'config-keeper', command: 'show version', candidates: ['sw1', 'sw2'] });
ok('A has a parked choice', !!C.pendingChoiceNow());
currentConv = 'op-B::default';
ok('B does NOT see A\'s parked choice', C.pendingChoiceNow() === null);

// ── forgetConversation clears ONLY the current conversation ─────────────────
currentConv = 'op-A::default';
C.forgetConversation();
ok('A cleared its own device', C.rememberedDevice() === null);
ok('A cleared its own parked choice', C.pendingChoiceNow() === null);
currentConv = 'op-B::default';
ok('B is untouched by A\'s forget (device)', C.rememberedDevice() === 'sw2');
ok('B is untouched by A\'s forget (incident)', C.rememberedIncident() === 'INC-20260817-014');

// ── ownIncidentIdsFor: structured id > quoted id > remembered, no guessing ──
currentConv = 'op-C::fresh';
// 1) structured planner id (the reliable path) wins.
ok('structured incident hint resolves', JSON.stringify(C.ownIncidentIdsFor('summarise it', 'INC-20260817-013')) === JSON.stringify(['INC-20260817-013']));
// after a structured/quoted resolve, the conversation remembers it.
ok('resolved incident is remembered for follow-ups', C.rememberedIncident() === 'INC-20260817-013');
// 2) a quoted id in the sub-question resolves when no structured hint given.
currentConv = 'op-D::fresh';
ok('quoted incident id in prose resolves', JSON.stringify(C.ownIncidentIdsFor('who is on INC-20260817-014?', null)) === JSON.stringify(['INC-20260817-014']));
// 3) no id anywhere and nothing remembered → empty (grounds on the LIST, never guesses).
currentConv = 'op-E::fresh';
ok('no id + no memory → empty (no guess)', C.ownIncidentIdsFor('what is open right now?', null).length === 0);
// 4) follow-up with no id falls back to the remembered incident (continuity).
currentConv = 'op-F::fresh';
C.ownIncidentIdsFor('summarise INC-20260817-013', null); // establishes memory
ok('follow-up with no id reuses the remembered incident', JSON.stringify(C.ownIncidentIdsFor('and who is on it?', null)) === JSON.stringify(['INC-20260817-013']));
// ...and that memory is STILL isolated — a different conversation does not inherit it.
currentConv = 'op-G::fresh';
ok('remembered incident does NOT bleed to another conversation', C.ownIncidentIdsFor('and who is on it?', null).length === 0);

incidentRead._setEngine(null);
console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
