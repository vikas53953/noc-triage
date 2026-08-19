// Understand-first triage — offline behaviour test (no LLM, no live kit).
//
// The owner's complaint: opening "user not able to access www.google.com"
// produced the SAME generic 4-front sweep as everything else, and Jarvis never
// asked a single narrowing question. The fix adds an UNDERSTAND phase at the top
// of the bridge (behind TRIAGE_UNDERSTAND_FIRST, default ON): a vague symptom is
// ASKED about before any sweep; a scoped one is swept only on the relevant fronts.
//
// This test injects a MOCK understand planner through triage.init(ctx.understand)
// and stubs every live reader / gate / persistence seam, so the whole bridge runs
// offline and deterministically. It asserts the four behaviours the spec names:
//   (a) vague problem  → questions posted, phase 'awaiting-info', NO sweep.
//   (b) scoping answer → sweep runs, SCOPED to relevantFronts (rest skipped).
//   (c) flag '0'       → understand NOT called, full 4-front sweep (old behaviour).
//   (d) understand throws → fall back to the full sweep (a triage never dead-ends).

// ── Stub every seam the bridge touches BEFORE requiring triage. The module holds
//    the same object references we patch here, so method swaps take effect. ──
const catalyst = require('./catalyst-center');
const aci = require('./aci');
const sdwan = require('./sdwan');
const approvals = require('./approvals');
const session = require('./session-log');
const baseline = require('./baseline-store');
const configStore = require('./config-store');
const incidentStore = require('./incident-store');
const artifacts = require('./artifacts');
const correlation = require('./correlation');
const notifier = require('./notifier');
const jarvis = require('./jarvis');

// Live readers — fast canned reads (no network).
catalyst.getDevices = async () => [{ hostname: 'sw1', id: '1', reachability: 'Reachable' }];
catalyst.getHealth = async () => ({ score: 100 });
catalyst.getIssues = async () => [];
catalyst.getRunningConfig = async () => ({ ok: true, text: 'hostname sw1' });
aci.getFabricNodes = async () => [{ id: '101', name: 'LF-101', role: 'leaf' }];
aci.getFabricHealth = async () => ({ score: 100 });
aci.getFaults = async () => [];
aci.countByAge = () => ({ inWindow: 0, older: 0 });
sdwan.getDevices = async () => [{ hostname: 've1' }];
sdwan.getAlarms = async () => [];
sdwan.clusterAlarms = () => ({ total: 0, newCount: 0, chronicCount: 0, groups: [] });

// Gate + session + persistence — auto-approve, no pauses, no disk.
approvals.gate = async (_meta, run) => ({ result: await run() });
session.runWithContext = async (_c, fn) => fn();
session.emitCommandShare = () => {};
session.audit = () => {};
baseline.delta = () => null;
baseline.record = () => {};
configStore.diff = () => ({ firstSnapshot: true });
configStore.snapshot = () => {};
incidentStore.assign = () => ({ incidentId: 'INC-TEST-1' });
artifacts.writeForTriage = () => null;
artifacts.getRecord = () => null;
correlation.correlate = () => ({ note: 'no cross-domain correlation (test)', clusters: [], topCandidate: null });
correlation.applyNarration = () => {};
notifier.notify = () => Promise.resolve();

// Jarvis reasoning used by the sweep half — all offline no-ops.
jarvis.extractSymptom = async () => ({ timeAnchor: null, timeAnchorMs: null, scope: null, rawSymptom: 'test', note: 'test', source: 'none' });
jarvis.rankBlindSpots = () => [];
jarvis.synthesizeTriageVerdict = async () => null;
jarvis.narrateCorrelation = async () => null;

const triage = require('./triage');

// ── Capture every broadcast the bridge emits. ──
let events = [];
function resetEvents() { events = []; }
function evOf(type) { return events.filter((e) => e.type === type); }
// Live-front evidence cards emitted during a sweep (state !== 'skipped') and the
// skipped ones — filtered to the four LIVE_FRONTS (blind cards are ignored).
const LIVE = ['campus', 'fabric', 'wan', 'incidents'];
function readFronts() {
  return evOf('triage_evidence').filter((e) => LIVE.includes(e.body.front) && e.body.state !== 'skipped'
    && e.body.state !== 'waiting' && e.body.state !== 'blind').map((e) => e.body.front);
}
function skippedFronts() {
  return evOf('triage_evidence').filter((e) => LIVE.includes(e.body.front) && e.body.state === 'skipped').map((e) => e.body.front);
}

// ── Mock understand planner — a scripted queue of responses. ──
let understandCalls = [];
let understandScript = [];
function mockUnderstand(args) {
  understandCalls.push(args);
  const next = understandScript.shift();
  if (typeof next === 'function') return next(args);
  return Promise.resolve(next);
}
let understandThrows = false;

triage.init({
  agents: {},
  broadcast: (type, body) => { events.push({ type, body }); },
  updateAgentStatus: () => {},
  appendToActivityLog: () => {},
  understand: (args) => (understandThrows ? Promise.reject(new Error('reasoning unavailable (test)')) : mockUnderstand(args)),
});

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitClosed(id, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const t = triage.getTriage(id);
    if (t && t.status === 'closed') return t;
    await sleep(40);
  }
  return triage.getTriage(id);
}
async function waitPhase(id, phase, ms = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const t = triage.getTriage(id);
    if (t && t.phase === phase) return t;
    await sleep(30);
  }
  return triage.getTriage(id);
}

async function main() {
  const GOOGLE = 'user not able to access www.google.com';

  // ── (a) Vague problem → asks, does NOT sweep ────────────────────────────────
  console.log('\n(a) VAGUE PROBLEM → clarifying questions, phase awaiting-info, NO sweep:');
  process.env.TRIAGE_UNDERSTAND_FIRST = '1';
  resetEvents(); understandCalls = []; understandThrows = false;
  understandScript = [{ specific: false, understood: 'A single user cannot reach www.google.com.',
    questions: ['Which user / source subnet?', 'Is DNS resolving?', 'Can they reach other sites?'], hypotheses: [], relevantFronts: [] }];
  const r1 = triage.startTriage('P1', GOOGLE, null);
  ok('triage opened', !!r1.triageId, JSON.stringify(r1));
  const ta = await waitPhase(r1.triageId, 'awaiting-info');
  ok('phase is awaiting-info', ta.phase === 'awaiting-info', ta.phase);
  ok('understand was called once', understandCalls.length === 1, `${understandCalls.length}`);
  ok('NO live front was swept', readFronts().length === 0, readFronts().join(','));
  ok('NO triage_symptom emitted (sweep never started)', evOf('triage_symptom').length === 0);
  ok('a triage_awaiting event was emitted', evOf('triage_awaiting').length === 1);
  const qMsgs = evOf('triage_message').filter((e) => /Which user|narrow this/i.test(e.body.text || ''));
  ok('clarifying questions posted as a message', qMsgs.length >= 1, `${qMsgs.length}`);
  ok('the questions are on the record', (ta.clarify && ta.clarify.questions || []).length === 3);

  // ── (b) Answer that scopes it → sweep runs, scoped to relevantFronts ────────
  console.log('\n(b) SCOPING ANSWER → sweep runs SCOPED to relevantFronts (rest skipped):');
  understandScript = [{ specific: true, understood: 'One user on 10.1.1.0/24 cannot reach www.google.com; DNS/upstream edge.',
    questions: [], hypotheses: [{ id: 'h1', text: 'upstream/DNS at the campus edge' }], relevantFronts: ['campus'] }];
  const resumeRes = await triage.resumeUnderstanding(r1.triageId, 'Just one user on 10.1.1.0, DNS not resolving, other sites also fail');
  ok('resume accepted the answer', resumeRes && resumeRes.ok === true, JSON.stringify(resumeRes));
  ok('resume moved to triaging', resumeRes.phase === 'triaging', resumeRes.phase);
  const tb = await waitClosed(r1.triageId);
  ok('bridge ran to close', tb && tb.status === 'closed', tb && tb.status);
  ok('relevantFronts scoped to [campus]', JSON.stringify(tb.relevantFronts) === JSON.stringify(['campus']), JSON.stringify(tb.relevantFronts));
  ok('campus WAS read', readFronts().includes('campus'), readFronts().join(','));
  ok('fabric was NOT read', !readFronts().includes('fabric'), readFronts().join(','));
  ok('wan was NOT read', !readFronts().includes('wan'), readFronts().join(','));
  ok('incidents was NOT read', !readFronts().includes('incidents'), readFronts().join(','));
  ok('the 3 out-of-scope fronts were skipped honestly',
    ['fabric', 'wan', 'incidents'].every((f) => skippedFronts().includes(f)), skippedFronts().join(','));

  // ── (c) Flag '0' → old full-sweep behaviour, understand NOT called ──────────
  console.log("\n(c) TRIAGE_UNDERSTAND_FIRST='0' → full 4-front sweep, understand never called:");
  process.env.TRIAGE_UNDERSTAND_FIRST = '0';
  resetEvents(); understandCalls = []; understandThrows = false; understandScript = [];
  const r3 = triage.startTriage('P1', GOOGLE, null);
  const tc = await waitClosed(r3.triageId);
  ok('bridge ran to close', tc && tc.status === 'closed', tc && tc.status);
  ok('understand was NOT called', understandCalls.length === 0, `${understandCalls.length}`);
  ok('all four live fronts were swept', LIVE.every((f) => readFronts().includes(f)), readFronts().join(','));
  ok('nothing was skipped', skippedFronts().length === 0, skippedFronts().join(','));
  ok('phase stayed triaging', tc.phase === 'triaging', tc.phase);

  // ── (d) understand throws → fall back to the full sweep ─────────────────────
  console.log('\n(d) UNDERSTAND THROWS → fail-safe fallback to the full sweep:');
  process.env.TRIAGE_UNDERSTAND_FIRST = '1';
  resetEvents(); understandCalls = []; understandThrows = true; understandScript = [];
  const r4 = triage.startTriage('P1', GOOGLE, null);
  const td = await waitClosed(r4.triageId);
  ok('bridge ran to close (never dead-ended)', td && td.status === 'closed', td && td.status);
  ok('all four live fronts were swept', LIVE.every((f) => readFronts().includes(f)), readFronts().join(','));
  ok('nothing was skipped', skippedFronts().length === 0, skippedFronts().join(','));
  const fallbackMsg = evOf('triage_message').filter((e) => /Reasoning unavailable|full sweep/i.test(e.body.text || ''));
  ok('said reasoning was unavailable and fell back', fallbackMsg.length >= 1, `${fallbackMsg.length}`);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
