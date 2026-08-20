// investigation.js — CW-7, the ITERATIVE INVESTIGATION LOOP engine.
//
// Plain words: Jarvis stops being one-shot. Given a problem it (1) GRILLS the
// problem to make sure it is specific enough — asking the operator when it is
// not, and running NOTHING until they answer — then (2) runs a probe → report →
// narrow loop, each round delegating ONE read-only probe to the right agent,
// updating the standing hypotheses and a confidence score from the REAL report,
// until (3) the root cause is isolated (confidence stop) or the safety cap /
// a stuck state stops it honestly, then plans the fix.
//
// WHAT THIS FILE OWNS (and what it deliberately does NOT):
//   • It ORCHESTRATES: counts rounds, enforces the hard cap, enforces the
//     confidence threshold, drives probes through the EXISTING permission gate
//     (via ctx.probe → live.gatherForJarvis), audits every round, streams the
//     rounds over the websocket. That is all deterministic, safety-only code.
//   • It NEVER picks the probe, states a hypothesis, or scores confidence. Every
//     one of those is a REASONING decision made by the injected PLANNER. This is
//     the intent-first law: deterministic code moves the loop, the LLM does the
//     thinking. There is no "if symptom X then check Y" table anywhere here.
//
// THE PLANNER IS INJECTABLE. The real planner (sources/jarvis.js →
// investigationPlanner) reasons with live Claude calls. A SCRIPTED planner can be
// injected (setPlanner) so the whole orchestration — grill/wait, narrowing over N
// rounds, the confidence stop, the cap stop, the stuck stop, deny=zero-wire — is
// fully deterministically testable WITHOUT API credits. When credits return, the
// real planner drops in unchanged and the same loop runs for real.
//
// LAWS (absolute, mirrored from docs/copilot-cw7-contract.md):
//   • NEVER fabricate a probe result or a root cause. Every narrowing step is fed
//     the REAL agent report (ctx.probe's finding) and cites it; an unproven
//     hypothesis stays labelled unproven with its confidence.
//   • Read-only probes only; the gate + guardrail are unchanged and reused. A
//     probe denied at the gate makes ZERO wire calls and stops the loop honestly.
//   • Bounded: the round cap is a hard stop — the loop can never run away.
//   • Honest under a dead LLM: if reasoning is unavailable (no key), the loop says
//     so and stops. It never invents a canned investigation.

const session = require('./session-log');
// CW-11 Part 1: the round reflection. The engine OWNS the bound ("exactly one
// reflection pass per round") by calling this once, right after the round is
// recorded; reflexion.js enforces the same bound a second time in its own store.
// With no reflexion planner wired up this is inert — every pre-CW-11 behaviour is
// unchanged, because a round with no evidence records behind it is never reflected on.
const reflexion = require('./reflexion');
// CW-11 Part 4: the lessons memory, written when an investigation closes with a
// verdict. Inert with no reasoning planner wired up.
const lessons = require('./lessons');

// ── Config (env-tunable, safe defaults) ──────────────────────────────────────
// The safety cap: the loop can never run more than this many probe rounds. A
// value below 1 or non-numeric falls back to the default — the cap can never be
// disabled by a bad env value.
function maxRounds() {
  const n = Number(process.env.INVESTIGATION_MAX_ROUNDS);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 6;
}
// Confidence (0..1) at or above which the root cause is treated as isolated.
function confidenceThreshold() {
  const n = Number(process.env.INVESTIGATION_CONFIDENCE_THRESHOLD);
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : 0.85;
}

// ── Host plumbing (injected by server.js) ────────────────────────────────────
// ctx: {
//   probe({agentId, question, device, incidentId}) -> Promise<finding>
//        finding = { agentId, name, stance, text, connected }  (from gatherForJarvis)
//   broadcast(type, data)         -> stream an event to the desk
//   roster() -> [{ id, name, connected, sees, note }]
//   audit({ who, what, device, result, detail })   -> the copilot audit trail
// }
let ctx = null;
function init(hostCtx) { ctx = hostCtx || {}; }

// The reasoning planner. Default is set by server.js (the real jarvis planner);
// tests inject a scripted one. Kept behind a setter so the ENGINE never imports
// jarvis directly — that would make it impossible to test without the LLM.
let planner = null;
function setPlanner(p) { planner = p || null; }
function getPlanner() { return planner; }

// ── The store ────────────────────────────────────────────────────────────────
const investigations = new Map();   // id -> record
const dayCounters = new Map();      // 'YYYYMMDD' -> n
function nextId() {
  const d = new Date();
  const day = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
  const n = (dayCounters.get(day) || 0) + 1;
  dayCounters.set(day, n);
  return `INV-${day}-${String(n).padStart(3, '0')}`;
}

function now() { return new Date().toISOString(); }

// A public snapshot the desk / GET route render. No internals leak.
function snapshot(rec) {
  return {
    id: rec.id,
    problem: rec.problem,
    operatorTz: rec.operatorTz || null,
    // CW-9: the engaged set the bridge announced (null = the whole roster).
    agents: rec.agents ? rec.agents.slice() : null,
    who: rec.who || null,
    status: rec.status,
    understood: rec.understood || null,
    questions: rec.questions.slice(),
    answers: rec.answers.slice(),
    hypotheses: rec.hypotheses.map((h) => ({ ...h })),
    confidence: rec.confidence,
    rounds: rec.rounds.map((r) => ({ ...r, hypotheses: (r.hypotheses || []).map((h) => ({ ...h })) })),
    rootCause: rec.rootCause || null,
    fixPlan: rec.fixPlan ? { ...rec.fixPlan } : null,
    // CW-11 (ADDITIVE, null until the verdict is composed): the self-check result
    // (verified vs suspected claims) and the parked proving check for the if/then.
    selfCheck: rec.selfCheck ? { ...rec.selfCheck } : null,
    prediction: rec.prediction ? { ...rec.prediction } : null,
    stuckReason: rec.stuckReason || null,
    cap: rec.cap,
    threshold: rec.threshold,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
  };
}

function emit(type, rec, extra) {
  rec.updatedAt = now();
  try {
    if (ctx && typeof ctx.broadcast === 'function') {
      ctx.broadcast(type, extra ? { id: rec.id, ...extra } : snapshot(rec));
    }
  } catch (e) { /* streaming must never break the loop */ }
  // CW-9: an optional per-run OBSERVER. The bridge (Jarvis in chat) uses it to
  // narrate the same loop round-by-round in the pinned envelope — one short
  // 'say' plus the finding evidence — without this engine knowing anything about
  // chat. A throwing observer can never break the investigation.
  try {
    const obs = rec.observer;
    if (obs) {
      if (type === 'investigation_round' && typeof obs.onRound === 'function') obs.onRound(snapshot(rec), extra);
      else if (typeof obs.onUpdate === 'function') obs.onUpdate(snapshot(rec));
    }
  } catch (e) { /* narration must never break the loop */ }
}

function audit(rec, what, result, detail, device) {
  try {
    if (ctx && typeof ctx.audit === 'function') {
      ctx.audit({ who: rec.who || 'unknown', what, device: device || null, result, detail });
    }
  } catch (e) { /* telemetry must never break the loop */ }
}

// ── Create (synchronous) ─────────────────────────────────────────────────────
// The route calls this to get an id back immediately, then run(id) drives the
// (async, LLM-backed) understand + probe loop in the background, streaming rounds.
function create({ problem, operatorTz, who, agents, observer, understood, hypotheses } = {}) {
  const id = nextId();
  const rec = {
    id,
    problem: String(problem || '').trim(),
    operatorTz: operatorTz || null,
    who: who || 'unknown',
    // CW-9 (optional, additive): the agents the bridge ENGAGED. When set, the
    // probe planner may only task those — so the roster message the operator was
    // shown ("standing down X, Y") stays true, and a stood-down front can never
    // be swept behind their back. Absent → the whole roster, exactly as before.
    agents: Array.isArray(agents) && agents.length ? agents.map(String) : null,
    // CW-9 (optional): narrate this run in the bridge envelope. Never persisted,
    // never in a snapshot.
    observer: observer && typeof observer === 'object' ? observer : null,
    status: 'starting',
    // CW-9: when the SHARED conduct gate (sources/conduct.js) already understood
    // the problem, its result is seeded here and this engine does NOT ask a
    // second time — there is exactly ONE understanding gate in the system.
    understood: (understood && String(understood)) || null,
    questions: [],
    answers: [],
    hypotheses: Array.isArray(hypotheses) ? hypotheses.map((h, i) => normalizeHypothesis(h, i)) : [],
    confidence: 0,
    rounds: [],
    rootCause: null,
    fixPlan: null,
    // CW-11: filled in at verdict time only.
    selfCheck: null,
    prediction: null,
    roster: null,
    stuckReason: null,
    cap: maxRounds(),
    threshold: confidenceThreshold(),
    createdAt: now(),
    updatedAt: now(),
  };
  investigations.set(id, rec);
  audit(rec, `investigation opened: "${rec.problem.slice(0, 120)}"`, 'opened', `id=${id}`);
  return snapshot(rec);
}

function get(id) {
  const rec = investigations.get(String(id || ''));
  return rec ? snapshot(rec) : null;
}

// ── The honest "no reasoning" stop ───────────────────────────────────────────
// When the planner cannot reason (no API key / credits), the loop says so and
// stops. It NEVER falls back to a canned investigation and invents nothing.
function stopReasoningUnavailable(rec, why) {
  rec.status = 'reasoning-unavailable';
  rec.stuckReason = why ||
    'Reasoning is unavailable — Jarvis has no API key/credits to think with, so I stopped rather than fake an investigation. ' +
    'Add ANTHROPIC_API_KEY (with credits) and start it again and I will investigate for real.';
  audit(rec, 'investigation stopped', 'reasoning-unavailable', rec.stuckReason);
  emit('investigation_update', rec);
  return snapshot(rec);
}

// ── run() — understand, then loop ────────────────────────────────────────────
async function run(id) {
  const rec = investigations.get(String(id || ''));
  if (!rec) return null;
  if (!planner || typeof planner.available !== 'function' || !planner.available()) {
    return stopReasoningUnavailable(rec);
  }
  // The shared conduct gate already understood this problem (CW-9): go straight
  // to probing rather than re-grilling the operator through a second gate.
  if (rec.understood) {
    rec.status = 'investigating';
    rec.questions = [];
    emit('investigation_update', rec);
    return probeLoop(rec);
  }
  return understandThenLoop(rec);
}

async function understandThenLoop(rec) {
  // 1. UNDERSTAND / GRILL. Is the problem specific enough to investigate?
  let u;
  try {
    u = await planner.understand({
      problem: rec.problem, operatorTz: rec.operatorTz, answers: rec.answers.slice(),
    });
  } catch (err) {
    return stopReasoningUnavailable(rec,
      `Reasoning failed while I was trying to understand the problem — ${err && err.message ? err.message : 'error'}. ` +
      `I stopped rather than guess. Nothing was probed.`);
  }
  rec.understood = (u && u.understood) || rec.understood || rec.problem;
  if (u && Array.isArray(u.hypotheses)) {
    rec.hypotheses = u.hypotheses.map((h, i) => normalizeHypothesis(h, i));
  }

  // AMBIGUOUS → ask the operator and WAIT. Fire NO probe. (Ambiguity-ask law.)
  if (u && u.specific === false) {
    rec.status = 'awaiting-operator';
    rec.questions = Array.isArray(u.questions) ? u.questions.map(String).filter(Boolean) : [];
    if (!rec.questions.length) {
      rec.questions = ['Can you narrow this down — which devices or sites, and since when did it start?'];
    }
    audit(rec, 'investigation grilling the operator', 'awaiting-operator',
      `${rec.questions.length} clarifying question(s) — ran no probe`);
    emit('investigation_update', rec);
    return snapshot(rec);
  }

  // Understood and specific → into the probe loop.
  rec.status = 'investigating';
  rec.questions = [];
  emit('investigation_update', rec);
  return probeLoop(rec);
}

function normalizeHypothesis(h, i) {
  if (typeof h === 'string') return { id: `h${i + 1}`, text: h, status: 'standing' };
  return {
    id: (h && h.id) || `h${i + 1}`,
    text: (h && h.text) || String(h || ''),
    status: (h && h.status) || 'standing',
  };
}

// ── The probe loop ───────────────────────────────────────────────────────────
async function probeLoop(rec) {
  const full = (ctx && typeof ctx.roster === 'function') ? ctx.roster() : [];
  // CW-9: when the bridge engaged a named set of agents, the planner may only
  // task those — a stood-down front is never quietly swept anyway.
  const roster = rec.agents ? full.filter((a) => rec.agents.includes(a.id)) : full;
  rec.roster = roster;   // CW-11: the prediction's proving check may only task these
  if (rec.agents && !roster.length) {
    return stopStuck(rec,
      'The agents engaged on this bridge are not on the live roster, so there is nobody I am allowed to probe. Nothing was read.');
  }

  // The loop can never run past the cap: the `for` bound IS the hard stop.
  while (rec.rounds.length < rec.cap) {
    const roundNo = rec.rounds.length + 1;

    // CW-11: did the LAST round turn up nothing new? Then this round MUST come at
    // it from a different angle — a different check, agent or system. The
    // instruction is carried to the planner (reasoning picks the new angle) and
    // enforced below (deterministic code refuses a straight repeat).
    const mustChange = rec.rounds.length ? reflexion.reflectionOf(rec.id, rec.rounds.length) : null;

    // a. The planner picks the HIGHEST-VALUE probe (or says it is stuck). The
    //    engine does NOT choose here — it only asks and enforces.
    let pick;
    let rejected = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        pick = await planner.probe({
          problem: rec.problem, understood: rec.understood,
          hypotheses: rec.hypotheses.map((h) => ({ ...h })),
          rounds: rec.rounds.map((r) => ({ ...r })),
          roster,
          // Additive: a planner that ignores these behaves exactly as before.
          mustChange: mustChange ? {
            why: mustChange.line,
            nextAngle: mustChange.nextAngle,
            avoidAgentIds: mustChange.avoidAgentIds,
            avoidChecks: mustChange.avoidChecks,
            sourcesTried: mustChange.sourcesTried,
          } : null,
          rejectedPick: rejected,
        });
      } catch (err) {
        return stopReasoningUnavailable(rec,
          `Reasoning failed while choosing the next probe — ${err && err.message ? err.message : 'error'}. ` +
          `I stopped rather than guess. ${rec.rounds.length} round(s) had run.`);
      }
      // Only when a change of approach was REQUIRED do we screen the pick, and we
      // give exactly ONE second chance — never a loop.
      if (!mustChange || !pick || pick.stuck || !isRepeatProbe(rec, pick)) break;
      if (attempt === 1) {
        return stopStuck(rec,
          `The last round turned up nothing new, and I could not find a different angle to try — ` +
          `I kept coming back to ${probeKey(pick)}. I am stopping rather than running the same check again ` +
          `and calling it progress.`);
      }
      rejected = { agentId: pick.agentId, question: pick.question, device: pick.device || null,
        why: 'that is the same probe as an earlier round — pick a different check, agent or system' };
    }

    // STUCK: no probe would narrow further / it needs something unavailable.
    if (!pick || pick.stuck) {
      return stopStuck(rec, (pick && pick.stuck) ||
        'I have no further probe that would narrow this down with what I can reach.');
    }

    const probe = {
      agentId: String(pick.agentId || ''),
      agentName: agentNameFor(roster, pick.agentId),
      question: String(pick.question || ''),
      device: pick.device || null,
      incidentId: pick.incidentId || null,
      rationale: pick.rationale || null,
    };

    // b. Delegate the read-only probe through the EXISTING gate + read path.
    //    deny = zero wire is guaranteed by that path, not by anything here.
    let finding;
    try {
      finding = await ctx.probe({
        agentId: probe.agentId, question: probe.question,
        device: probe.device, incidentId: probe.incidentId,
      });
    } catch (err) {
      // A probe that could not even run is an honest unreachable report, never a
      // fabricated result.
      finding = { agentId: probe.agentId, name: probe.agentName, stance: 'unreachable', connected: true,
        text: `The probe could not complete — ${err && err.message ? err.message : 'error'}. No reading, nothing invented.` };
    }
    const report = {
      agentId: finding.agentId || probe.agentId,
      agentName: finding.name || probe.agentName,
      stance: finding.stance || 'evidence',
      text: String(finding.text || '').trim(),
      // CW-9 evidence envelope: the real reads behind this report — host, exact
      // command, raw scrubbed output, honest transport. Empty when the probe
      // read nothing (denied / not connected / unreachable).
      cli: Array.isArray(finding.cli) ? finding.cli : [],
    };

    // A probe DENIED at the gate ran ZERO wire calls. That is a safety fact the
    // engine acts on (gate enforcement is the engine's job): the loop stops
    // honestly rather than spin denied rounds — it needs the operator to approve.
    if (report.stance === 'denied') {
      recordRound(rec, roundNo, probe, report, rec.hypotheses, rec.confidence, 'blocked');
      audit(rec, `investigation probe DENIED (round ${roundNo})`, 'blocked',
        `${probe.agentName}: ${probe.question}`, probe.device);
      return stopBlocked(rec);
    }

    // b2. CW-11 ROUND REFLECTION — exactly one pass, on the REAL records this
    //     round produced. Null when the round added something new (silent when
    //     clean) or read nothing at all (no read, no claim). A failure here can
    //     never break the loop.
    let reflection = null;
    try {
      reflection = await reflexion.reflectRound(rec.id, {
        roundNo, cli: report.cli, understood: rec.understood, agentId: probe.agentId,
        priorRounds: rec.rounds.map((r) => ({ ...r })), roster,
      });
    } catch (e) { reflection = null; }

    // c. Narrow: feed the REAL report to the planner; it updates the hypothesis
    //    set + confidence. The engine copies those verbatim — it never edits a
    //    hypothesis or moves a confidence number itself.
    let assessed;
    try {
      assessed = await planner.assess({
        understood: rec.understood,
        hypotheses: rec.hypotheses.map((h) => ({ ...h })),
        probe: { ...probe }, report: { ...report },
      });
    } catch (err) {
      // We already have a real report on the record; stop honestly rather than
      // invent a narrowing.
      recordRound(rec, roundNo, probe, report, rec.hypotheses, rec.confidence, 'reasoning-unavailable', reflection);
      return stopReasoningUnavailable(rec,
        `Reasoning failed while narrowing from ${probe.agentName}'s report — ${err && err.message ? err.message : 'error'}. ` +
        `The report is on the record; I did not invent a conclusion.`);
    }
    if (assessed && Array.isArray(assessed.hypotheses)) {
      rec.hypotheses = assessed.hypotheses.map((h, i) => normalizeHypothesis(h, i));
    }
    rec.confidence = clampConfidence(assessed && assessed.confidence, rec.confidence);

    recordRound(rec, roundNo, probe, report, rec.hypotheses, rec.confidence, 'ok', reflection);
    audit(rec, `investigation probe (round ${roundNo})`, report.stance,
      `${probe.agentName}: ${probe.question} → confidence ${rec.confidence.toFixed(2)}`, probe.device);

    // d. TERMINATION — confidence first, then the hard cap.
    if (rec.confidence >= rec.threshold) {
      return planFix(rec);
    }
    // The while-bound enforces the cap; if this was the last allowed round and we
    // did not hit confidence, fall out of the loop into the honest capped stop.
  }

  // Cap reached without isolating the root cause → honest best-hypothesis report.
  return stopCapped(rec);
}

function agentNameFor(roster, agentId) {
  const a = (roster || []).find((x) => x.id === agentId);
  return (a && a.name) || agentId || 'agent';
}

function clampConfidence(v, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return typeof fallback === 'number' ? fallback : 0;
  return Math.max(0, Math.min(1, n));
}

function recordRound(rec, roundNo, probe, report, hypotheses, confidence, status, reflection) {
  const round = {
    round: roundNo,
    probe: { agentId: probe.agentId, agentName: probe.agentName, question: probe.question,
      device: probe.device || null, rationale: probe.rationale || null },
    agent: probe.agentName,
    report: { agentName: report.agentName, stance: report.stance, text: report.text,
      cli: Array.isArray(report.cli) ? report.cli : [] },
    hypotheses: hypotheses.map((h) => ({ ...h })),
    confidence,
    status,
    // CW-11 (ADDITIVE, null on every clean round): the honest "nothing new" line
    // plus the change of approach the next round must take.
    reflection: reflection || null,
    ts: now(),
  };
  rec.rounds.push(round);
  // WS shape per contract: {round, probe, agent, report, hypotheses[], confidence, status}
  // (+ CW-11's additive `reflection`, null unless the round repeated itself).
  emit('investigation_round', rec, {
    round: round.round, probe: round.probe, agent: round.agent, report: round.report,
    hypotheses: round.hypotheses, confidence: round.confidence, status: round.status,
    reflection: round.reflection,
  });
}

// CW-11: is this pick simply an earlier probe again? Compared on the agent plus
// the normalised question — a re-worded question that names the same check on the
// same target is still the same check. Used ONLY to enforce a required change of
// approach; it never picks a probe and never blocks a first attempt.
function probeKey(pick) {
  const q = String((pick && pick.question) || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const d = String((pick && pick.device) || '').toLowerCase().trim();
  return `${String((pick && pick.agentId) || '').toLowerCase()}|${d}|${q}`;
}
function isRepeatProbe(rec, pick) {
  const key = probeKey(pick);
  return rec.rounds.some((r) => probeKey({ agentId: r.probe && r.probe.agentId,
    question: r.probe && r.probe.question, device: r.probe && r.probe.device }) === key);
}

// ── PLAN THE FIX (root cause isolated) ───────────────────────────────────────
async function planFix(rec) {
  const confirmed = rec.hypotheses.find((h) => h.status === 'confirmed');
  let fix;
  try {
    fix = await planner.fix({
      understood: rec.understood,
      hypotheses: rec.hypotheses.map((h) => ({ ...h })),
      rounds: rec.rounds.map((r) => ({ ...r })),
      rootCause: confirmed ? confirmed.text : null,
    });
  } catch (err) {
    // We isolated a cause but could not compose the plan — report the cause
    // honestly, no fabricated remediation.
    rec.status = 'resolved';
    rec.rootCause = confirmed ? confirmed.text : (rec.hypotheses[0] && rec.hypotheses[0].text) || null;
    rec.fixPlan = { summary: `Root cause isolated, but the fix plan could not be composed (${err && err.message ? err.message : 'error'}). ` +
      `The evidence is in the rounds above.`, proposal: null };
    audit(rec, 'investigation resolved (no fix plan)', 'resolved', String(rec.rootCause || '').slice(0, 200));
    emit('investigation_update', rec);
    return snapshot(rec);
  }
  rec.status = 'resolved';
  rec.rootCause = (fix && fix.rootCause) || (confirmed ? confirmed.text : null);
  // ── CW-11 Part 2 — THE VERDICT SELF-CHECK, before the verdict is committed ──
  // Exactly ONE bounded pass, tracing every claim to a real evidence record from
  // THIS incident. Unsupported claims come back as "suspected — unverified" and
  // ride the record additively; a failure here can never break the close.
  try {
    rec.selfCheck = await reflexion.selfCheckVerdict(rec.id, {
      cause: rec.rootCause, summary: (fix && fix.summary) || '',
      hypotheses: rec.hypotheses, rounds: rec.rounds,
    });
  } catch (e) { rec.selfCheck = null; }
  if (rec.selfCheck && rec.selfCheck.ran && rec.selfCheck.causeSupported === false) {
    audit(rec, 'verdict self-check downgraded the cause', 'suspected',
      'no evidence record from this incident backs the cause — labelled suspected, unverified');
  }
  // ── CW-11 Part 3 — park the check that would PROVE the "then" ──────────────
  // Composed here, registered by the caller against the change record it drafts
  // (or, where there is no write path, exposed for the operator to trigger).
  // It is PARKED here, in the engine, so every path that closes an investigation
  // gets a follow-through the operator can trigger — not only the chat bridge.
  // Until a change record is bound to it (the bridge does that when it drafts the
  // fix), it is operator-triggered: this console has applied nothing and says so.
  try {
    const composed = await reflexion.composePrediction({
      cause: rec.rootCause, summary: (fix && fix.summary) || '',
      ifThen: (fix && fix.ifThen) || null, roster: rec.roster || [],
    });
    const lead = rec.hypotheses.find((h) => h.status === 'confirmed')
      || rec.hypotheses.find((h) => h.status !== 'eliminated');
    rec.prediction = composed ? reflexion.registerPrediction({
      key: rec.id, investigationId: rec.id,
      hypothesis: (lead && lead.text) || rec.rootCause || '',
      then: composed.then,
      check: { agentId: composed.agentId, question: composed.question, device: composed.device },
      operatorTriggered: true,
    }) : null;
  } catch (e) { rec.prediction = null; }
  rec.fixPlan = {
    summary: (fix && fix.summary) || 'Fix plan composed from the evidence gathered above.',
    // A config fix is offered as a PROPOSAL routed through the CW-2 change engine
    // (approve-first) — never auto-applied. The desk renders this as a card whose
    // approve button POSTs to /api/copilot/change. A manual/external fix has none.
    proposal: fix && fix.proposal ? sanitizeProposal(fix.proposal) : null,
  };
  audit(rec, 'investigation resolved — root cause isolated', 'resolved',
    `confidence ${rec.confidence.toFixed(2)} — ${String(rec.rootCause || '').slice(0, 160)}` +
    (rec.fixPlan.proposal ? ` — change proposal on ${rec.fixPlan.proposal.device}` : ''));
  emit('investigation_update', rec);
  // CW-11 Part 4 — the investigation closed with a verdict, so write its lesson.
  // It lives HERE, in the engine, so EVERY path that closes an investigation gets
  // one (the chat bridge, the REST route, a reopened run) rather than only the one
  // that happened to be wired first. Fire-and-forget; a missing note never breaks
  // a close, and with no reasoning nothing is written at all.
  writeLesson(rec);
  return snapshot(rec);
}

// CW-11 Part 4 — four short facts about a closed investigation, composed by the
// model and scrubbed on the way to disk (sources/lessons.js). Never throws.
function writeLesson(rec) {
  try {
    if (!lessons.available()) return;
    const id = rec.incidentId || rec.id;
    Promise.resolve()
      .then(() => lessons.recordFromIncident({
        incidentId: id,
        problem: rec.problem || rec.understood || '',
        cause: rec.rootCause || '',
        verdict: (rec.fixPlan && rec.fixPlan.summary) || '',
        rounds: rec.rounds.map((r) => ({
          round: r.round, agent: r.agent,
          question: (r.probe && r.probe.question) || '',
          stance: (r.report && r.report.stance) || '',
          text: String((r.report && r.report.text) || '').slice(0, 600),
          nothingNew: Boolean(r.reflection && r.reflection.nothingNew),
        })),
      }))
      .catch(() => { /* a missing lesson never breaks a close */ });
  } catch (e) { /* same */ }
}

// A proposal is what the operator will confirm; keep it printable and bounded,
// exactly like the change route's own intake. It is NEVER applied here — it is
// carried to the desk for an explicit approve-first confirm.
function sanitizeProposal(p) {
  const device = String((p && p.device) || '').trim();
  const reason = String((p && p.reason) || '').trim();
  const cmds = Array.isArray(p && p.commands) ? p.commands : [];
  const commands = cmds
    .map((c) => String(c == null ? '' : c).replace(/[^\x20-\x7E]/g, '').replace(/\s+$/, ''))
    .filter((c) => c.trim())
    .slice(0, 100);
  if (!device || !commands.length) return null;
  return { device, commands, reason: reason || 'Fix proposed by the CW-7 investigation.', route: 'POST /api/copilot/change' };
}

// ── The honest stops ─────────────────────────────────────────────────────────
function stopCapped(rec) {
  rec.status = 'capped';
  const best = bestStanding(rec);
  rec.rootCause = null;
  rec.stuckReason =
    `I hit the round cap (${rec.cap} probes) without isolating the root cause to a confident conclusion, ` +
    `so I am stopping rather than claiming a false certainty.`;
  rec.fixPlan = {
    summary: `Hit the round cap: no confident root cause after ${rec.cap} rounds (confidence ${rec.confidence.toFixed(2)}, ` +
      `threshold ${rec.threshold}). Best-supported hypothesis so far: ` +
      `${best ? `"${best.text}"` : 'none stands out'}. Still unknown: what the remaining probes could not rule out — ` +
      `the rounds above list every real report I have. This is an honest best guess, not a verdict.`,
    proposal: null,
  };
  audit(rec, 'investigation hit the round cap', 'capped',
    `${rec.cap} rounds, confidence ${rec.confidence.toFixed(2)} — honest best hypothesis, no fabricated verdict`);
  emit('investigation_update', rec);
  return snapshot(rec);
}

function stopStuck(rec, reason) {
  rec.status = 'stuck';
  rec.stuckReason = reason;
  const best = bestStanding(rec);
  rec.fixPlan = {
    summary: `Stuck after ${rec.rounds.length} round(s): ${reason} ` +
      (best ? `Best-supported so far: "${best.text}" (confidence ${rec.confidence.toFixed(2)}).` : '') +
      ` Nothing was fabricated — the rounds above are the real reports.`,
    proposal: null,
  };
  audit(rec, 'investigation stuck', 'stuck', String(reason).slice(0, 300));
  emit('investigation_update', rec);
  return snapshot(rec);
}

function stopBlocked(rec) {
  rec.status = 'blocked';
  rec.stuckReason =
    'A probe was denied at the permission gate, so it ran nothing on any device — and I will not invent a reading. ' +
    'The console is in deny/ask mode: approve the reads (or switch permission mode) and start the investigation again.';
  rec.fixPlan = { summary: rec.stuckReason, proposal: null };
  audit(rec, 'investigation blocked at the gate', 'blocked', 'probe denied — zero wire calls, nothing invented');
  emit('investigation_update', rec);
  return snapshot(rec);
}

function bestStanding(rec) {
  const standing = rec.hypotheses.filter((h) => h.status !== 'eliminated');
  return standing.find((h) => h.status === 'confirmed') || standing[0] || rec.hypotheses[0] || null;
}

// ── answer() — the operator resumes a grilled investigation ──────────────────
async function answer(id, text, who) {
  const rec = investigations.get(String(id || ''));
  if (!rec) return null;
  if (rec.status !== 'awaiting-operator') {
    // Not waiting on the operator — record the note but do not restart a finished
    // or running loop.
    return { error: `Investigation ${rec.id} is not waiting for an answer (status: ${rec.status}).`, investigation: snapshot(rec) };
  }
  const answerText = String(text || '').trim();
  if (!answerText) return { error: 'An empty answer does not narrow anything — say what changed and I will resume.', investigation: snapshot(rec) };
  rec.answers.push({ text: answerText, at: now(), who: who || rec.who });
  if (who) rec.who = who;
  audit(rec, 'operator answered the investigation grill', 'answered', answerText.slice(0, 200));
  emit('investigation_update', rec);
  // Re-assess: is it specific enough NOW? (Same reasoning path — the answer is
  // folded into `answers` the planner sees.)
  if (!planner || typeof planner.available !== 'function' || !planner.available()) {
    return stopReasoningUnavailable(rec);
  }
  return understandThenLoop(rec);
}

module.exports = {
  init, setPlanner, getPlanner, create, run, answer, get,
  maxRounds, confidenceThreshold,
  // Exposed for the deterministic investigation tests only.
  _store: investigations,
};
