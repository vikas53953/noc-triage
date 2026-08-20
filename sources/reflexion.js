// reflexion.js — CW-11, JARVIS CHECKS ITS OWN WORK.
//
// Plain words: three self-checks that run on the work Jarvis has already done,
// each one bounded, each one grounded in evidence that was actually read.
//
//   1. ROUND REFLECTION (Part 1). After each investigation round, compare the
//      round's evidence against every earlier round. Nothing new → say so in one
//      short honest line and CHANGE APPROACH next round (a different check, a
//      different agent, a different system). CW-9 already diffed the evidence
//      and said "nothing new"; what it never did was change what it tried next.
//      That is the gap this part closes.
//   2. VERDICT SELF-CHECK (Part 2). Before a verdict is committed, ONE bounded
//      pass traces EVERY claim in it to a specific evidence record from THIS
//      incident. A claim with no record behind it is downgraded to
//      "suspected — unverified" (or dropped). The verdict envelope then carries
//      verified[] and suspected[] separately.
//   3. PREDICTION FOLLOW-THROUGH (Part 3). A verdict carries an if/then. After
//      the change is applied through the CW-2 engine (the approval gate is
//      untouched), run the check that should PROVE the "then". Holds → one
//      confirm line. Fails → say plainly that the hypothesis was wrong and
//      reopen the investigation carrying the falsified hypothesis as context.
//      Where no write path exists (the observer-role sandbox), the follow-through
//      check is EXPOSED for the operator to trigger after their manual fix — it
//      never pretends to have applied anything.
//
// WHO DOES WHAT (the intent-first law, unchanged):
//   • The LLM does every judgement: whether a round really added anything, which
//     approach to change to, which evidence record backs which claim, whether a
//     prediction held. There is not one keyword rule in this file.
//   • Deterministic code does SAFETY ONLY: it counts the passes (exactly one per
//     round, exactly one per verdict — never a loop), it computes the evidence
//     diff from the REAL records, and it throws away any evidence id the model
//     returned that does not name a record this incident actually produced.
//
// GUARDRAILS THIS FILE ENFORCES IN CODE (contract-pinned):
//   • BOUNDED — one reflection pass per round, one self-check per verdict. A
//     second call returns the FIRST result and makes no second model call.
//   • EVIDENCE-GROUNDED — a round with no read behind it gets NO reflection at
//     all (no read, no claim), and a traced claim may only cite ids that exist.
//   • SILENT WHEN CLEAN — a round that genuinely added something returns null,
//     and nothing extra is said.
//
// TESTABLE WITHOUT CREDITS. setPlanner() takes a scripted planner exactly like
// conduct.js and investigation.js, so every law above is proven offline.

const conduct = require('./conduct');

// ── Host plumbing (injected by server.js) ───────────────────────────────────
// ctx: {
//   probe({agentId, question, device}) -> Promise<finding>   (the SAME gated read
//        path the investigation loop uses — nothing here opens its own)
//   reopen({ prediction, report, line }) -> void|Promise     (start a fresh
//        investigation carrying the falsified hypothesis as context)
//   audit({ who, what, device, result, detail }) -> void
//   say(line) -> void                                        (one honest line to the desk)
// }
let ctx = {};
function init(hostCtx) { ctx = hostCtx || {}; }

// ── The injected planner (the LLM half) ─────────────────────────────────────
// planner = {
//   available(): boolean,
//   reflect({ understood, roundNo, repeated, priorChecks, agentsTried, roster })
//     -> { line, avoidAgentIds[], avoidChecks[], nextAngle }
//   trace({ cause, summary, claimsHint, evidence })
//     -> { claims: [{ text, evidenceIds[] }] }
//   predict({ cause, summary, ifThen, roster })
//     -> { then, agentId, question, device } | null
//   judge({ prediction, report })
//     -> { held: true|false|null, line }
// }
let planner = null;
function setPlanner(p) { planner = p || null; }
function getPlanner() { return planner; }
function available() {
  return Boolean(planner && (typeof planner.available !== 'function' || planner.available()));
}

// ── The per-incident evidence index ─────────────────────────────────────────
// Every evidence record this incident produced, tagged with a short id (E1, E2…)
// that the model can cite and that this file can VERIFY. Two records are the same
// record when either their normalised identity (CW-9 identityKey — volatile query
// params stripped) or their raw output hash repeats, which is exactly the test the
// bridge already uses to decide whether a check is new.
const books = new Map();   // key -> book

// Bounded like every other in-memory store here: a console left running for weeks
// must not grow forever.
const MAX_BOOKS = 200;
const MAX_RECORDS = 400;

function bookFor(key) {
  const k = String(key || 'default');
  let b = books.get(k);
  if (!b) {
    b = {
      key: k,
      seq: 0,
      records: [],                 // [{ eid, round, host, command, output, source, transport, line, ts }]
      byIdentity: new Map(),       // identityKey|outputKey -> eid
      reflections: new Map(),      // roundNo -> reflection result (or null)
      verdictCheck: undefined,     // set once — the ONE self-check pass
    };
    books.set(k, b);
    while (books.size > MAX_BOOKS) books.delete(books.keys().next().value);
  }
  return b;
}

function forget(key) { books.delete(String(key || 'default')); }

/**
 * Tag one round's real evidence records and say which of them are NEW.
 * Deterministic — this is the read-diff, not a judgement.
 * Returns { tagged:[{...entry, eid, repeatOf}], fresh:[…], repeated:[…] }.
 */
function indexEvidence(key, roundNo, cli) {
  const b = bookFor(key);
  const list = Array.isArray(cli) ? cli : [];
  const tagged = [];
  const fresh = [];
  const repeated = [];
  for (const e of list) {
    const idKey = conduct.identityKey(e);
    const outKey = conduct.outputKey(e);
    const priorEid = b.byIdentity.get(idKey) || b.byIdentity.get(outKey) || null;
    if (priorEid) {
      const entry = { ...e, eid: priorEid, round: roundNo, repeatOf: priorEid };
      tagged.push(entry);
      repeated.push(entry);
      continue;
    }
    const eid = `E${++b.seq}`;
    const entry = {
      eid,
      round: roundNo,
      host: e.host || 'unknown host',
      command: e.command || '',
      output: e.output == null ? '' : String(e.output),
      source: e.source || null,
      transport: e.transport || null,
      line: e.line || '',
      ts: e.ts || new Date().toISOString(),
      repeatOf: null,
    };
    b.byIdentity.set(idKey, eid);
    b.byIdentity.set(outKey, eid);
    b.records.push(entry);
    if (b.records.length > MAX_RECORDS) b.records.splice(0, b.records.length - MAX_RECORDS);
    tagged.push(entry);
    fresh.push(entry);
  }
  return { tagged, fresh, repeated };
}

function evidenceOf(key) {
  return bookFor(key).records.map((r) => ({ ...r }));
}

// ── PART 1 — the round reflection ───────────────────────────────────────────
/**
 * Reflect on ONE finished round. Called by the investigation engine straight
 * after the round is recorded.
 *
 * Returns null when there is nothing honest to say (SILENT WHEN CLEAN):
 *   • the round produced NEW evidence — the normal narration already covers it;
 *   • the round read NOTHING at all — no read, so no reflection claim (the
 *     engine's own honest "no reading came back" line stands);
 *   • no reasoning is wired up — we say nothing rather than invent a line.
 *
 * Returns { nothingNew:true, line, avoidAgentIds[], avoidChecks[], nextAngle }
 * when every check in the round repeated something already on the record.
 *
 * BOUNDED: exactly ONE pass per round. Called twice for the same round, the
 * cached first answer comes back and the planner is NOT called again.
 */
async function reflectRound(key, { roundNo, cli, understood, priorRounds, roster, agentId } = {}) {
  const b = bookFor(key);
  const rn = Number(roundNo);
  if (b.reflections.has(rn)) return b.reflections.get(rn);      // ← the bound, in code

  const { fresh, repeated } = indexEvidence(key, rn, cli);

  // No read behind this round → no reflection claim. (EVIDENCE-GROUNDED.)
  if (!fresh.length && !repeated.length) { b.reflections.set(rn, null); return null; }
  // The round genuinely added something → stay quiet. (SILENT WHEN CLEAN.)
  if (fresh.length) { b.reflections.set(rn, null); return null; }

  // Everything repeated. Say so honestly and change approach.
  const priorChecks = b.records.map((r) => ({ eid: r.eid, round: r.round, source: r.source, command: r.command }));
  const agentsTried = uniq((priorRounds || []).map((r) => (r.probe && r.probe.agentId) || r.agent).filter(Boolean)
    .concat(agentId ? [agentId] : []));
  const sourcesTried = uniq(b.records.map((r) => r.source).filter(Boolean));

  let out = null;
  if (available() && typeof planner.reflect === 'function') {
    try {
      out = await planner.reflect({
        understood: understood || '',
        roundNo: rn,
        repeatedCount: repeated.length,
        repeated: repeated.map((r) => ({ eid: r.eid, source: r.source, command: r.command })),
        priorChecks,
        agentsTried,
        sourcesTried,
        roster: roster || [],
      });
    } catch (err) {
      out = null;     // reasoning failed — fall back to the honest default line
    }
  }

  // The honest fallback: still TRUE, still evidence-grounded, just not reasoned.
  const line = conduct.capText(
    (out && typeof out.line === 'string' && out.line.trim())
      ? out.line.trim()
      : `Round ${rn} turned up nothing new — ${repeated.length} check(s) repeated readings I already have. ` +
        `Same angle is not working, so I am changing approach.`);

  // Deterministic screen on the change-of-approach instruction: it may only name
  // agents that are actually on this bridge, and checks that were actually run.
  const rosterIds = new Set((roster || []).map((a) => a.id));
  const knownCommands = new Set(b.records.map((r) => String(r.command || '')));
  const result = {
    nothingNew: true,
    round: rn,
    line,
    repeatedCount: repeated.length,
    // What the NEXT round must not do again. Names only real agents / real checks.
    avoidAgentIds: uniq(((out && out.avoidAgentIds) || agentsTried).map(String))
      .filter((id) => !rosterIds.size || rosterIds.has(id)),
    avoidChecks: uniq(((out && out.avoidChecks) || []).map(String)).filter((c) => knownCommands.has(c))
      .concat(uniq(b.records.map((r) => String(r.command || '')).filter(Boolean))).slice(0, 30),
    sourcesTried,
    nextAngle: (out && typeof out.nextAngle === 'string' && out.nextAngle.trim()) ? out.nextAngle.trim() : null,
    reasoned: Boolean(out),
  };
  result.avoidChecks = uniq(result.avoidChecks);
  b.reflections.set(rn, result);
  audit(`reflection on round ${rn}`, 'nothing-new',
    `${repeated.length} repeated check(s) — changing approach${result.nextAngle ? `: ${result.nextAngle}` : ''}`);
  return result;
}

function reflectionOf(key, roundNo) {
  const b = books.get(String(key || 'default'));
  return b ? (b.reflections.get(Number(roundNo)) || null) : null;
}

// ── PART 2 — the verdict self-check ─────────────────────────────────────────
/**
 * ONE bounded pass over the verdict about to be committed. Every claim is traced
 * to a specific evidence record from THIS incident; a claim with no real record
 * behind it comes back as SUSPECTED — unverified.
 *
 * Returns null when there is nothing to check against (no reasoning, or this
 * incident produced no evidence at all — in which case the caller's existing
 * honest wording stands and nothing is dressed up as verified).
 *
 * Returns { ran:true, verified:[{claim, evidenceIds}], suspected:[{claim, why}],
 *           causeSupported:boolean, droppedIds:[…] }.
 *
 * BOUNDED: exactly ONE pass per verdict. A second call returns the first result.
 */
async function selfCheckVerdict(key, { cause, summary, hypotheses, rounds } = {}) {
  const b = bookFor(key);
  if (b.verdictCheck !== undefined) return b.verdictCheck;      // ← the bound, in code
  b.verdictCheck = null;                                        // claimed, so a re-entrant call cannot double-run

  const evidence = b.records;
  if (!evidence.length || !available() || typeof planner.trace !== 'function') return b.verdictCheck;

  let out = null;
  try {
    out = await planner.trace({
      cause: String(cause || ''),
      summary: String(summary || ''),
      hypotheses: Array.isArray(hypotheses) ? hypotheses.map((h) => ({ ...h })) : [],
      rounds: Array.isArray(rounds) ? rounds.length : 0,
      evidence: evidence.map((r) => ({
        eid: r.eid, round: r.round, host: r.host, source: r.source,
        command: r.command, line: r.line,
        // The raw reading is what a claim has to be traceable TO, so it goes in —
        // already scrubbed + capped upstream by the session log / conduct layer.
        output: String(r.output || '').slice(0, 2000),
      })),
    });
  } catch (err) {
    return b.verdictCheck;   // the check could not run — claim nothing about it
  }
  if (!out || !Array.isArray(out.claims)) return b.verdictCheck;

  // DETERMINISTIC ENFORCEMENT: a cited id must name a record this incident really
  // produced. Anything else is thrown away — the model cannot invent an id and it
  // cannot cite another incident's reading.
  const real = new Set(evidence.map((r) => r.eid));
  const verified = [];
  const suspected = [];
  const droppedIds = [];
  const seen = new Set();
  for (const c of out.claims) {
    const text = String((c && c.text) || '').trim();
    if (!text || seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    const cited = uniq((Array.isArray(c && c.evidenceIds) ? c.evidenceIds : []).map(String));
    const good = cited.filter((id) => real.has(id));
    for (const id of cited) if (!real.has(id)) droppedIds.push(id);
    if (good.length) verified.push({ claim: conduct.capLine(text), evidenceIds: good });
    else {
      suspected.push({
        claim: conduct.capLine(text),
        why: cited.length
          ? 'the records it cited are not readings from this incident'
          : 'no reading from this incident backs it',
      });
    }
  }

  // Is the CAUSE itself supported? Decided the same way every other claim is: by
  // the evidence ids the model traced the ROOT CAUSE to, filtered down to records
  // this incident really produced. Never by string-matching the cause against a
  // claim — the first cut did that and mislabelled a properly-evidenced cause as
  // "suspected" simply because the model worded the claim differently.
  const citedForCause = uniq((Array.isArray(out.causeEvidenceIds) ? out.causeEvidenceIds : []).map(String));
  for (const id of citedForCause) if (!real.has(id)) droppedIds.push(id);
  const causeEvidenceIds = citedForCause.filter((id) => real.has(id));
  const causeSupported = Boolean(String(cause || '').trim()) && causeEvidenceIds.length > 0;

  b.verdictCheck = {
    ran: true,
    verified,
    suspected,
    causeSupported,
    causeEvidenceIds,
    droppedIds: uniq(droppedIds),
    evidenceCount: evidence.length,
  };
  audit('verdict self-check', suspected.length ? 'downgraded' : 'clean',
    `${verified.length} claim(s) traced to real records, ${suspected.length} downgraded to suspected` +
    (droppedIds.length ? `, ${uniq(droppedIds).length} invented evidence id(s) dropped` : ''));
  return b.verdictCheck;
}

function verdictCheckOf(key) {
  const b = books.get(String(key || 'default'));
  return b && b.verdictCheck ? b.verdictCheck : null;
}

// ── PART 3 — prediction follow-through ──────────────────────────────────────
// A verdict's if/then, parked with the proving check that would settle it. It is
// NEVER run at registration time — it runs after a change is applied, or when the
// operator triggers it because there is no write path and they fixed it by hand.
const predictions = new Map();   // id -> record
let predSeq = 0;
const MAX_PREDICTIONS = 200;

function predictionSnapshot(p) {
  return {
    id: p.id,
    key: p.key,
    incidentId: p.incidentId || null,
    investigationId: p.investigationId || null,
    changeId: p.changeId || null,
    hypothesis: p.hypothesis,
    then: p.then,
    check: { ...p.check },
    state: p.state,                 // 'waiting' | 'held' | 'failed' | 'inconclusive'
    // TRUE when this console cannot apply the fix itself (observer-role sandbox).
    // The operator applies the change; this check is here for them to trigger.
    operatorTriggered: Boolean(p.operatorTriggered),
    message: p.message,
    result: p.result || null,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

/**
 * Park the check that would prove a verdict's "then". Deterministic, no model
 * call — the check itself was composed by the planner (composePrediction below).
 */
function registerPrediction({ key, incidentId, investigationId, changeId, hypothesis, then, check, operatorTriggered } = {}) {
  const c = check || {};
  const agentId = String(c.agentId || '').trim();
  const question = String(c.question || '').trim();
  if (!agentId || !question) return null;      // no runnable proving check → park nothing
  const id = `PRED-${Date.now().toString(36)}-${(++predSeq).toString(36)}`;
  const rec = {
    id,
    key: String(key || 'default'),
    incidentId: incidentId || null,
    investigationId: investigationId || null,
    changeId: changeId || null,
    hypothesis: String(hypothesis || '').trim(),
    then: String(then || '').trim(),
    check: { agentId, question, device: c.device || null },
    state: 'waiting',
    operatorTriggered: Boolean(operatorTriggered),
    message: operatorTriggered
      ? `I cannot apply this change myself on this account (read-only/observer), so nothing has been applied. ` +
        `Apply the fix yourself and then trigger this check — POST /api/copilot/predictions/${id}/check — and I will tell you honestly whether my call was right.`
      : `Parked: after the change is applied I will run "${question}" to prove whether this was really the cause.`,
    result: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  predictions.set(id, rec);
  while (predictions.size > MAX_PREDICTIONS) predictions.delete(predictions.keys().next().value);
  audit('prediction parked', rec.operatorTriggered ? 'operator-triggered' : 'waiting',
    `${rec.then ? rec.then.slice(0, 120) : 'prediction'} — proving check: ${question}`);
  return predictionSnapshot(rec);
}

/**
 * Bind a parked prediction to the change record that would satisfy it. Called
 * when the bridge drafts a CW-2 change for the fix: until then the prediction is
 * operator-triggered (this console has applied nothing and says so), and after it
 * the follow-through fires automatically IF and only if that change really applies.
 */
function attachChange(id, changeId) {
  const p = predictions.get(String(id || ''));
  if (!p || !changeId) return null;
  p.changeId = String(changeId);
  p.operatorTriggered = false;
  p.message = `Parked against ${p.changeId}: nothing has been applied. If and when that change really ` +
    `lands, I will run "${p.check.question}" to prove whether this was the cause — or trigger it yourself ` +
    `with POST /api/copilot/predictions/${p.id}/check.`;
  p.updatedAt = new Date().toISOString();
  return predictionSnapshot(p);
}

function listPredictions({ key, incidentId } = {}) {
  return Array.from(predictions.values())
    .filter((p) => (!key || p.key === String(key)) && (!incidentId || p.incidentId === incidentId))
    .map(predictionSnapshot)
    .reverse();
}
function getPrediction(id) {
  const p = predictions.get(String(id || ''));
  return p ? predictionSnapshot(p) : null;
}

/**
 * Compose the proving check for a verdict. One model call; null when there is no
 * reasoning available or the model cannot name a real check — nothing is invented.
 */
async function composePrediction({ cause, summary, ifThen, roster } = {}) {
  if (!available() || typeof planner.predict !== 'function') return null;
  let out;
  try {
    out = await planner.predict({ cause: String(cause || ''), summary: String(summary || ''),
      ifThen: ifThen || null, roster: roster || [] });
  } catch (err) { return null; }
  if (!out || !out.agentId || !out.question) return null;
  const ids = new Set((roster || []).map((a) => a.id));
  if (ids.size && !ids.has(String(out.agentId))) return null;   // only a real agent may be tasked
  return { then: String(out.then || '').trim(), agentId: String(out.agentId), question: String(out.question),
    device: out.device || null };
}

/**
 * RUN the parked check and settle the prediction honestly.
 *
 * held        → one confirm line, the verdict stands.
 * failed      → say plainly the hypothesis was wrong, and REOPEN the investigation
 *               carrying the falsified hypothesis as context (never close on hope).
 * inconclusive→ the check could not read anything (denied / unreachable): say so.
 *               Nothing is confirmed and nothing is declared wrong.
 *
 * BOUNDED: a settled prediction is not re-run.
 */
async function runFollowThrough(id, { who } = {}) {
  const p = predictions.get(String(id || ''));
  if (!p) return { error: `No prediction with id "${id}".` };
  if (p.state !== 'waiting') return { prediction: predictionSnapshot(p), rerun: false,
    message: `That follow-through already ran — it came back "${p.state}".` };
  if (!ctx || typeof ctx.probe !== 'function') {
    return { error: 'No read path is wired up, so the proving check could not run. Nothing is being claimed.' };
  }

  let finding;
  try {
    finding = await ctx.probe({ agentId: p.check.agentId, question: p.check.question, device: p.check.device });
  } catch (err) {
    finding = { agentId: p.check.agentId, stance: 'unreachable', text:
      `The proving check could not run — ${(err && err.message) || 'error'}. No reading, nothing invented.` };
  }
  const report = {
    agentId: (finding && finding.agentId) || p.check.agentId,
    agentName: (finding && finding.name) || p.check.agentId,
    stance: (finding && finding.stance) || 'evidence',
    text: String((finding && finding.text) || '').trim(),
    cli: Array.isArray(finding && finding.cli) ? finding.cli : [],
  };

  // A check that read NOTHING can neither confirm nor falsify anything. That is a
  // safety fact, decided here, not by the model.
  // Stances that mean NO READING HAPPENED. A refusal at the guardrail, a denial at
  // the gate, an unreachable source and a not-connected agent all produce prose,
  // not evidence — and prose about why nothing ran can never confirm a prediction.
  const NO_READING = new Set(['denied', 'unreachable', 'refused', 'not-connected', 'notconnected', 'blocked']);
  const readSomething = report.cli.length > 0 || (!NO_READING.has(String(report.stance).toLowerCase()) && Boolean(report.text));
  let held = null;
  let line = '';
  if (!readSomething) {
    line = `The proving check read nothing back (${report.stance}), so I can neither confirm nor drop my call. ` +
      `Nothing is being claimed either way.`;
  } else if (available() && typeof planner.judge === 'function') {
    try {
      const j = await planner.judge({
        prediction: { hypothesis: p.hypothesis, then: p.then, check: { ...p.check } },
        report: { ...report },
      });
      if (j && (j.held === true || j.held === false)) held = j.held;
      if (j && typeof j.line === 'string' && j.line.trim()) line = j.line.trim();
    } catch (err) { held = null; }
  }
  if (held === null && !line) {
    line = `I ran the proving check and got a real reading, but I could not judge it (no reasoning available), ` +
      `so I am not claiming my call was right. The reading is on the record.`;
  }
  if (!line) {
    line = held
      ? `Prediction held: ${p.then} — confirmed by the check I just ran. The verdict stands.`
      : `My prediction was WRONG. I said "${p.then}" and the check does not show it, so the cause I named is not proven. ` +
        `I am reopening the investigation with that hypothesis ruled out.`;
  }

  p.state = held === true ? 'held' : held === false ? 'failed' : 'inconclusive';
  p.result = { line: conduct.capText(line), report, at: new Date().toISOString(), who: who || null };
  p.updatedAt = p.result.at;
  audit(`prediction follow-through (${p.id})`, p.state, conduct.capLine(line), p.check.device);
  try { if (typeof ctx.say === 'function') ctx.say(p.result.line, predictionSnapshot(p)); } catch (e) { /* never break the check */ }

  // FAILED → reopen, carrying the falsified hypothesis as context. Never a silent close.
  let reopened = null;
  if (p.state === 'failed' && typeof ctx.reopen === 'function') {
    try {
      reopened = await ctx.reopen({
        prediction: predictionSnapshot(p),
        report,
        falsified: p.hypothesis || p.then,
        who: who || null,
      });
    } catch (err) { reopened = null; }
  }
  return { prediction: predictionSnapshot(p), held, line: p.result.line, report, reopened };
}

// ── small shared helpers ────────────────────────────────────────────────────
function uniq(list) { return Array.from(new Set((list || []).filter((v) => v != null && v !== ''))); }

function audit(what, result, detail, device) {
  try {
    if (ctx && typeof ctx.audit === 'function') {
      ctx.audit({ who: 'jarvis', what: `reflexion — ${what}`, device: device || null, result, detail });
    }
  } catch (e) { /* telemetry never breaks a self-check */ }
}

module.exports = {
  init, setPlanner, getPlanner, available,
  // Part 1
  indexEvidence, evidenceOf, reflectRound, reflectionOf,
  // Part 2
  selfCheckVerdict, verdictCheckOf,
  // Part 3
  composePrediction, registerPrediction, attachChange, listPredictions, getPrediction, runFollowThrough,
  forget,
  // Exposed for the deterministic CW-11 tests only.
  _books: books, _predictions: predictions,
};
