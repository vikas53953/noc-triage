// Doc-accuracy checks for sources/artifacts.js (Class 10 follow-up).
//
// Every case below is a live-review finding turned into a regression guard. The
// leadership doc is read by non-technical leadership, so the laws are:
//   1. No committed hypothesis  → say so in plain words + an honest status line.
//      NEVER fall back to the raw verdict/alarm scrape.
//   2. The doc must not contradict itself — "What broke" comes from the same
//      committed verdict the headline uses, and chronic/pre-window noise is
//      labelled already-broken-before, never "a live problem that started now".
//   3. Affected CIs follow the committed verdict (primary = confirmed in-window
//      AND in scope; unread fronts ride along marked secondary; nothing else).
//      Nothing implicated ⇒ an honest minimal list, never the full estate.
//   4. A date is printed in the SAME timezone as the time beside it.
//   5. Plain labels everywhere in the leadership doc — no raw front keys.

const A = require('./artifacts');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`); }
}

// ── Fixtures: shaped exactly like a real record (the live WAN case) ───────────
const ALARM_DUMP = '7 devices, 254 active alarms — top 3: license-not-synced (83, chronic); '
  + 'license-out-of-compliance (83, chronic); security-root-cert-chain-installed (23, chronic)';

function ev(front, state, detail, extra) {
  return Object.assign({ front, state, detail, source: 'src', ts: '2026-08-18T04:33:00.000Z', age: null, groups: null, count: null }, extra || {});
}

function baseRec(over) {
  return Object.assign({
    id: 'trg-test-1', incidentId: 'INC-20260818-001', severity: 'P2',
    title: 'Slow WAN', description: 'Branch users in DC1 report slow WAN since 2pm',
    status: 'closed', operatorTz: 'Asia/Kolkata',
    openedAt: '2026-08-18T04:32:00.000Z', closedAt: '2026-08-18T04:33:00.000Z',
    verdictAt: '2026-08-18T04:33:00.000Z', generatedAt: '2026-08-18T04:33:10.000Z',
    durationHuman: '60 seconds', staffed: [], operatorPosts: [], commandLog: [],
    blindSpots: [{ front: 'firewall', reason: 'no firewall source wired up' }],
    affectedCIs: [], evidenceFinal: [], evidenceHistory: [], timeline: [],
    provenance: 'test', mttr: null, lifecycle: null, sla: null, roles: {},
  }, over || {});
}

// The reported live case: WAN incident, full estate sweep, no hypothesis committed,
// wan carries 2 new alarms among 254 chronic ones, fabric/incidents also "active".
const LIVE = baseRec({
  affectedCIs: [
    { ci: 'True_Test', type: 'tenant', front: 'fabric' },
    { ci: 'apic1', type: 'node', front: 'fabric' },
    { ci: 'Manager01', type: 'device', front: 'wan' },
    { ci: 'incidents', type: 'front', front: 'incidents' },
  ],
  evidenceFinal: [
    ev('campus', 'clean', '4/4 reachable, health 100'),
    ev('fabric', 'degraded', '2 nodes, health 0, 5 crit / 2 major faults', { age: { inWindow: 4, older: 3 } }),
    ev('wan', 'degraded', ALARM_DUMP, { groups: { total: 254, newCount: 2, chronicCount: 252 } }),
    ev('incidents', 'degraded', '0 Catalyst issues, 7 ACI faults', { age: { inWindow: 4, older: 3 } }),
    ev('firewall', 'blind', 'no firewall source (Cisco Secure Firewall / FMC) wired up'),
  ],
  verdict: {
    verdict: `Live evidence in the 14:00 window points at fabric, wan, incidents. wan: ${ALARM_DUMP}`,
    impact: 'Confirmed live impact IN the 14:00 window on: fabric, wan, incidents. 1 front(s) read clean (campus).',
    nextChecks: ['Review the active SD-WAN alarms in vManage against the WAN card.'],
    activeInWindow: ['fabric', 'wan', 'incidents'],
    preExisting: [], suspect: [], clean: ['campus'],
    hypothesis: null,
    blindSpots: [{ front: 'firewall', risk: 'high', reason: 'no source' }],
    window: { timeAnchor: '2026-08-17T08:30:00.000Z', scope: ['wan', 'DC1', 'loadbalancer'], source: 'heuristic' },
  },
});

// Same shape, but wan is chronic-only (0 new) while the verdict still lists it active.
const CHRONIC_ONLY = baseRec({
  affectedCIs: [{ ci: 'Manager01', type: 'device', front: 'wan' }],
  evidenceFinal: [
    ev('campus', 'clean', '4/4 reachable, health 100'),
    ev('wan', 'degraded', ALARM_DUMP, { groups: { total: 254, newCount: 0, chronicCount: 254 } }),
  ],
  verdict: {
    verdict: `Nothing NEW in the window. wan: ${ALARM_DUMP}`,
    impact: 'No NEW impact.', nextChecks: [],
    activeInWindow: ['wan'], preExisting: [], suspect: [], clean: ['campus'],
    hypothesis: null, blindSpots: [],
    window: { timeAnchor: '2026-08-17T08:30:00.000Z', scope: ['wan'], source: 'heuristic' },
  },
});

// A committed hypothesis — the praised path must not regress.
const WITH_HYP = baseRec({
  evidenceFinal: LIVE.evidenceFinal,
  affectedCIs: LIVE.affectedCIs,
  verdict: Object.assign({}, LIVE.verdict, {
    hypothesis: {
      hypothesis: 'A WAN edge router lost its control connections to the DC1 hub.',
      confidence: 'medium', why: 'Two new alarms landed inside the window on the WAN edge.',
      ifThen: 'Check BFD session state on vEdge-DC1-01.',
      ranked: [{ cause: 'Control-connection loss', likelihood: 'likely' }, { cause: 'Fabric fault', likelihood: 'possible' }],
    },
  }),
});

// ── 1. tsDoc: date in the same timezone as the time beside it ────────────────
console.log('\nFINDING 4 — tsDoc date/timezone:');
{
  const rec = baseRec({ generatedAt: '2026-08-18T19:00:00Z', evidenceFinal: [], verdict: null });
  const doc = A.renderSltDoc(rec);
  const line = doc.split('\n').find((l) => l.includes('local ·')) || '';
  ok('IST 19:00Z shows the LOCAL date 2026-08-19 first', /2026-08-19 00:30 local/.test(line), line);
  ok('the UTC half keeps its own date 2026-08-18', /· 2026-08-18 19:00 UTC/.test(line), line);
  const same = A.renderSltDoc(baseRec({ generatedAt: '2026-08-18T04:33:00Z', verdict: null }))
    .split('\n').find((l) => l.includes('local ·')) || '';
  ok('same-day dual clock is unchanged (one date)', /2026-08-18 10:03 local · 04:33 UTC/.test(same), same);
  const utcOnly = A.renderSltDoc(baseRec({ operatorTz: null, generatedAt: '2026-08-18T19:00:00Z', verdict: null }))
    .split('\n').find((l) => l.includes('UTC')) || '';
  ok('no operator timezone → UTC date + UTC time', /2026-08-18 19:00 UTC/.test(utcOnly) && !/local/.test(utcOnly), utcOnly);
}

// ── 2. No hypothesis → plain words, never the alarm scrape ───────────────────
console.log('\nFINDING 1 — no-hypothesis leadership headline:');
{
  const doc = A.renderSltDoc(LIVE);
  const found = doc.split('## What we found')[1].split('## What broke')[0];
  ok('says plainly that no cause was committed', /No cause has been committed/.test(found), found.trim().slice(0, 120));
  ok('carries an honest status line (what was checked)', /We checked \d+ connected area/.test(found), found.trim().slice(0, 200));
  ok('no raw alarm scrape in "What we found"', !/license-not-synced|254 active alarms/.test(found), found.trim().slice(0, 200));
  ok('no raw verdict string anywhere in the leadership doc', !doc.includes(LIVE.verdict.verdict), 'raw verdict leaked');
  ok('alarm-type jargon never reaches the leadership doc', !/license-not-synced|security-root-cert-chain-installed/.test(doc));
}

// ── 3. Internal consistency: chronic noise is never "a live problem now" ─────
console.log('\nFINDING 2 — the doc agrees with itself:');
{
  const doc = A.renderSltDoc(CHRONIC_ONLY);
  const broke = doc.split('## What broke')[1].split('## Who or what')[0];
  ok('chronic-only front is NOT called a live problem', !/A live problem that started during this incident/.test(broke), broke.trim());
  ok('chronic-only front is labelled already-broken-before', /already there before it began|pre-date this incident/.test(broke), broke.trim());
  ok('no alarm dump in "What broke"', !/top 3:|license-not-synced/.test(broke), broke.trim());

  const doc2 = A.renderSltDoc(LIVE);
  const broke2 = doc2.split('## What broke')[1].split('## Who or what')[0];
  ok('a front with real new evidence IS reported as broken', /A live problem that started during this incident/.test(broke2), broke2.trim());
  ok('the WAN line reports the 2 real new alarms, not 254', /2 new alarms appeared during this incident/.test(broke2), broke2.trim());
  ok('the 252 chronic alarms are named as already there', /252 alarms here were already there before it began/.test(broke2), broke2.trim());
  ok('the fabric line reports 4 new faults', /4 new faults appeared during this incident/.test(broke2), broke2.trim());
}

// ── 3b. Faults we cannot date are reported honestly, never as "started now" ──
console.log('\nFINDING 2 (b) — no timing data ⇒ no timing claim:');
{
  // Alert-opened incident: no time anchor, so no reader can age anything.
  const undated = baseRec({
    affectedCIs: [{ ci: 'Manager01', type: 'device', front: 'wan' }, { ci: 'True_Test', type: 'tenant', front: 'fabric' }],
    evidenceFinal: [
      ev('campus', 'clean', '4/4 reachable, health 100'),
      ev('fabric', 'degraded', '2 nodes, health 0, 5 crit / 2 major faults'),
      ev('wan', 'degraded', ALARM_DUMP),
    ],
    verdict: {
      verdict: 'x', impact: 'x', nextChecks: [], activeInWindow: ['fabric', 'wan'],
      preExisting: [], suspect: [], clean: ['campus'], hypothesis: null, blindSpots: [],
      window: { timeAnchor: null, scope: ['wan'], source: 'alert' },
    },
  });
  const doc = A.renderSltDoc(undated);
  const broke = doc.split('## What broke')[1].split('## Who or what')[0];
  ok('undated faults are NOT claimed to have started during the incident',
    !/A live problem that started during this incident/.test(broke), broke.trim());
  ok('the doc says plainly that the timing is unknown',
    /do not record when they started/.test(broke), broke.trim());
  ok('the alarm-type dump is still trimmed out', !/top 3:|license-not-synced/.test(broke), broke.trim());
  const sn = A.buildServiceNow(undated);
  ok('an undated but in-scope front keeps its CI on the ticket',
    sn.affectedCIs.map((x) => x.ci).includes('Manager01'), JSON.stringify(sn.affectedCIs));
  ok('an undated OUT-of-scope front stays off the ticket',
    !sn.affectedCIs.map((x) => x.ci).includes('True_Test'), JSON.stringify(sn.affectedCIs));
}

// ── 4. Plain labels + no raw front keys / engine jargon ──────────────────────
console.log('\nFINDING 5 — plain words everywhere the doc composes:');
{
  const doc = A.renderSltDoc(LIVE);
  const affected = doc.split('## Who or what it affected')[1].split('## Recommended')[0];
  ok('"Who or what it affected" uses plain labels', /Wide-area \/ internet edge/.test(affected), affected.trim());
  ok('"Who or what it affected" drops the raw front-key list', !/fabric, wan, incidents/.test(affected), affected.trim());
  const stands = doc.split('## Where it stands now')[1];
  ok('"Where it stands now" is plain, not the verdict string', !/license-not-synced|activeInWindow|front\(s\)/.test(stands), stands.trim().slice(0, 200));
  ok('"Where it stands now" states the honest position', /No cause has been committed/.test(stands), stands.trim().slice(0, 200));
  ok('blind spots stay honest and named', /no monitoring connected/.test(stands) || /What we could not see/.test(doc));
}

// ── 5. Praised behaviour must not regress ────────────────────────────────────
console.log('\nREGRESSION GUARD — hypothesis path, confidence, next steps:');
{
  const doc = A.renderSltDoc(WITH_HYP);
  ok('headline is the committed hypothesis', /\*\*Most likely cause:\*\* A WAN edge router lost its control connections/.test(doc));
  ok('confidenceLine() still speaks', /moderate confidence in this finding/.test(doc));
  ok('why + ranked alternatives kept', /Why we think so:/.test(doc) && /Other possibilities we weighed/.test(doc));
  ok('Recommended next steps kept', /## Recommended next steps[\s\S]*Review the active SD-WAN alarms/.test(doc));
  ok('fastest-way-to-confirm kept', /Fastest way to confirm: Check BFD session state/.test(doc));
  ok('"Where it stands now" reflects the committed cause', /We have a leading cause/.test(doc));
}

// ── 6. Affected CIs follow the verdict ───────────────────────────────────────
console.log('\nFINDING 3 + 6 — ServiceNow CI scope follows the committed verdict:');
{
  const sn = A.buildServiceNow(LIVE);
  const cis = sn.affectedCIs.map((x) => x.ci);
  ok('WAN CI stays on the WAN ticket', cis.includes('Manager01'), JSON.stringify(cis));
  ok('out-of-scope fabric tenant True_Test is OFF the ticket', !cis.includes('True_Test'), JSON.stringify(cis));
  ok('out-of-scope fabric node apic1 is OFF the ticket', !cis.includes('apic1'), JSON.stringify(cis));
  ok('out-of-scope incidents CI is OFF the ticket', !cis.includes('incidents'), JSON.stringify(cis));
  ok('surviving CI is marked primary', sn.affectedCIs.every((x) => x.scope === 'primary'), JSON.stringify(sn.affectedCIs));

  // A site name in the parsed scope must never become a front.
  ok('site name "DC1" in scope does not widen the front set',
    !sn.affectedCIs.some((x) => x.front === 'DC1'), JSON.stringify(sn.affectedCIs));

  // Unread front → its CIs ride along, clearly marked secondary.
  const unread = baseRec({
    affectedCIs: [{ ci: 'Manager01', type: 'device', front: 'wan' }, { ci: 'sw1', type: 'device', front: 'campus' }],
    evidenceFinal: [ev('wan', 'degraded', ALARM_DUMP, { groups: { total: 254, newCount: 2, chronicCount: 252 } }), ev('campus', 'suspect', 'Catalyst Center read failed: timeout')],
    verdict: {
      verdict: 'x', impact: 'x', nextChecks: [], activeInWindow: ['wan'], preExisting: [],
      suspect: ['campus'], clean: [], hypothesis: null, blindSpots: [],
      window: { timeAnchor: null, scope: ['wan'], source: 'heuristic' },
    },
  });
  const sn2 = A.buildServiceNow(unread);
  const campus = sn2.affectedCIs.find((x) => x.ci === 'sw1');
  ok('unread front CI is kept', !!campus, JSON.stringify(sn2.affectedCIs));
  ok('unread front CI is marked secondary', campus && campus.scope === 'secondary', JSON.stringify(campus));
  ok('secondary CI is flagged in the ticket text', /SECONDARY \/ unconfirmed/.test(A.renderServiceNowText(unread, sn2)));

  // Nothing implicated → honest minimal list, NEVER the whole estate.
  const nothing = baseRec({
    affectedCIs: [{ ci: 'True_Test', type: 'tenant', front: 'fabric' }, { ci: 'Manager01', type: 'device', front: 'wan' }],
    evidenceFinal: [ev('campus', 'clean', '4/4 reachable'), ev('wan', 'degraded', ALARM_DUMP, { groups: { total: 254, newCount: 0, chronicCount: 254 } })],
    verdict: {
      verdict: 'x', impact: 'x', nextChecks: [], activeInWindow: ['wan'], preExisting: [],
      suspect: [], clean: ['campus'], hypothesis: null, blindSpots: [],
      window: { timeAnchor: null, scope: ['fabric'], source: 'heuristic' },
    },
  });
  // wan is chronic-only ⇒ not confirmed ⇒ nothing implicated at all.
  const sn3 = A.buildServiceNow(nothing);
  ok('nothing implicated ⇒ NOT the full harvested CI list', sn3.affectedCIs.length === 0, JSON.stringify(sn3.affectedCIs));
  ok('nothing implicated ⇒ the ticket says so honestly',
    /None could be tied to this incident by the verdict/.test(A.renderServiceNowText(nothing, sn3)));

  // Legacy record (no window-aware split) still passes CIs through untouched.
  const legacy = baseRec({
    affectedCIs: [{ ci: 'True_Test', type: 'tenant', front: 'fabric' }],
    evidenceFinal: [ev('fabric', 'degraded', '2 nodes, health 0')],
    verdict: { verdict: 'legacy verdict', impact: 'x', nextChecks: [] },
  });
  const sn4 = A.buildServiceNow(legacy);
  ok('legacy record keeps its CI list (no invented scope)', sn4.affectedCIs.length === 1, JSON.stringify(sn4.affectedCIs));
}

// ── 7. Engineer doc keeps the raw evidence verbatim (honesty law) ────────────
console.log('\nHONESTY — the engineer doc still carries the raw strings:');
{
  const eng = A.renderEngineerDoc(LIVE);
  ok('engineer doc keeps the full alarm detail verbatim', eng.includes(ALARM_DUMP));
  ok('engineer doc keeps the raw verdict verbatim', eng.includes(LIVE.verdict.verdict));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
