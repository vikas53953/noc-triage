// incident-read.class9.test.js — QA Class 9, defect 1 (chat sees the app's own
// incidents). DETERMINISTIC: no API key, no network. Drives incident-read against
// a known in-memory triage engine (via _setEngine) and proves the chat brain can
// now SEE this console's own incidents, resolve a real id to its real record, and
// answer a bogus id with an honest "no such incident" (never a fabrication).

const assert = require('assert');
const incidentRead = require('./incident-read');

let passed = 0, failed = 0;
function ok(name, cond) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}`); }
}

// ── A known, fixed set of incidents (the shape triage.js really returns) ─────
const T_013 = {
  id: 'trg-abc-013', incidentId: 'INC-20260817-013', severity: 'P1', status: 'closed',
  title: 'DC apps slow from Pune', description: 'finance cannot reach payroll from Pune since 2pm',
  openedAt: '2026-08-17T08:30:00.000Z', closedAt: '2026-08-17T08:52:00.000Z', mttr: '22m',
  source: 'operator',
  roles: { commander: 'Vikas', owner: 'Asha', scribe: 'Ravi', joiners: ['Meera'] },
  sla: { targetMs: 900000, breached: true },
  verdict: {
    verdict: 'WAN overlay degraded',
    impact: 'Payroll unreachable from Pune branch',
    hypothesis: {
      hypothesis: 'SD-WAN overlay tunnel flap on the Pune branch edge',
      ranked: [
        { cause: 'overlay tunnel flap', likelihood: 'likely' },
        { cause: 'ACI contract drop', likelihood: 'possible' },
      ],
      ifThen: 'check the Pune vEdge BFD sessions — if stable, pivot to the ACI contract',
      confidence: 'medium',
      why: 'campus reads clean and the fabric fault pre-dates the window',
    },
  },
  correlation: { topCandidate: { summary: 'wan + fabric events co-occurred at 14:03' } },
};
const T_014 = {
  id: 'trg-def-014', incidentId: 'INC-20260817-014', severity: 'P3', status: 'open',
  title: 'Branch 3 slow internet', description: 'branch 3 users report slow internet since 2pm',
  openedAt: '2026-08-17T09:10:00.000Z', closedAt: null, mttr: null, source: 'alert',
  roles: { commander: '', owner: '', scribe: '', joiners: [] },
  sla: { targetMs: 3600000, breached: false },
  verdict: null,
};

const fakeEngine = {
  listIncidents() {
    // Same compact row shape listIncidents() emits (urgent-first: open P1-ish first).
    return [
      { triageId: T_013.id, incidentId: T_013.incidentId, severity: T_013.severity, source: T_013.source, status: T_013.status, owner: T_013.roles.owner, title: T_013.title, openedAt: T_013.openedAt, sla: T_013.sla },
      { triageId: T_014.id, incidentId: T_014.incidentId, severity: T_014.severity, source: T_014.source, status: T_014.status, owner: null, title: T_014.title, openedAt: T_014.openedAt, sla: T_014.sla },
    ];
  },
  getTriage(id) {
    if (id === T_013.id) return T_013;
    if (id === T_014.id) return T_014;
    return null;
  },
};

incidentRead._setEngine(fakeEngine);

console.log('\nCLASS 9 / defect 1 — Jarvis chat can SEE this console\'s own incidents:\n');

// 1. The grounding summary the planner reasons over lists the REAL incidents.
const sum = incidentRead.summaryText(12);
ok('summary lists INC-20260817-013', sum.includes('INC-20260817-013'));
ok('summary lists INC-20260817-014', sum.includes('INC-20260817-014'));
ok('summary carries severity + status', sum.includes('P1') && sum.includes('closed') && sum.includes('open'));
ok('summary carries the committed verdict headline', sum.includes('SD-WAN overlay tunnel flap on the Pune branch edge'));
ok('summary shows the owner on the record that has one', sum.includes('Asha'));
ok('summary flags the SLA breach honestly', /BREACHED/.test(sum));

// 2. A real incident id resolves to the REAL full record.
const rec = incidentRead.recordText('INC-20260817-013');
ok('real id → the real hypothesis', rec.includes('SD-WAN overlay tunnel flap on the Pune branch edge'));
ok('real id → the real ranked causes', rec.includes('overlay tunnel flap') && rec.includes('likely'));
ok('real id → the real next check', rec.includes('check the Pune vEdge BFD sessions'));
ok('real id → the real confidence', /Confidence: medium/.test(rec));
ok('who-is-on-it → the real roles', rec.includes('Vikas') && rec.includes('Asha') && rec.includes('Ravi') && rec.includes('Meera'));
ok('real id → the real correlation', rec.includes('wan + fabric events co-occurred'));

// case-insensitive id + the trg- id both resolve to the same record.
ok('lower-case INC id still resolves', incidentRead.recordText('inc-20260817-013').includes('Pune vEdge'));
ok('trg- id resolves too', incidentRead.recordText('trg-abc-013').includes('Pune vEdge'));

// An open incident with no verdict yet is honest about it (never invents one).
const recOpen = incidentRead.recordText('INC-20260817-014');
ok('open incident → honest "not committed yet"', /not committed yet/.test(recOpen));

// 3. A BOGUS id yields an honest "no such incident" — NEVER a fabrication.
const bogus = incidentRead.recordText('INC-20991231-999');
ok('bogus id → NO SUCH INCIDENT (honest)', /NO SUCH INCIDENT/.test(bogus));
ok('bogus id → explicit "do not invent"', /Do NOT invent/i.test(bogus));
ok('bogus id → invents no hypothesis/roles', !/hypothesis|commander|owner:/i.test(bogus));

// 4. Identity resolution (not intent guessing): quoted ids are found, prose is not.
ok('idsMentionedIn finds a quoted INC id', JSON.stringify(incidentRead.idsMentionedIn('please summarise INC-20260817-013 for me')) === JSON.stringify(['INC-20260817-013']));
ok('idsMentionedIn finds a quoted trg id', incidentRead.idsMentionedIn('look at trg-abc-013').length === 1);
ok('idsMentionedIn finds nothing in a plain ask', incidentRead.idsMentionedIn('what incidents are open right now?').length === 0);

// 5. count is honest.
ok('count reports the real number', incidentRead.count() === 2);

// 6. A boot-time / broken engine degrades to "no incidents", never a crash.
incidentRead._setEngine({ listIncidents() { throw new Error('mid-boot'); }, getTriage() { throw new Error('mid-boot'); } });
ok('broken engine → summary says none, no crash', /no incidents on record/i.test(incidentRead.summaryText()));
ok('broken engine → bogus-style honest record, no crash', /NO SUCH INCIDENT/.test(incidentRead.recordText('INC-20260817-013')));
incidentRead._setEngine(null); // release the override

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
