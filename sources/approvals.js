// approvals.js — the REAL permission gate (Phase C).
//
// PURPOSE: before an agent runs a read against real kit, that intended command
// passes through here and — depending on the mode — either auto-approves (and is
// logged) or PAUSES until the operator decides. A denied command is never run
// and is never silently swapped for something else; the caller reports "denied,
// ran nothing" and the wire is never touched.
//
// This gate is a HUMAN layer ON TOP of the read-only guardrail. It can only ever
// make a read wait or not-run — it can NEVER turn a blocked write into an allowed
// one. Writes are refused by sources/guardrails.js long before the gate applies,
// and as belt-and-braces the gate re-checks any raw CLI string it is handed and
// hard-denies anything that is not read-only.
//
// Nothing here fabricates a result. On denial the caller runs nothing and says so.

const { checkCommand } = require('./guardrails');

// ── Mode ─────────────────────────────────────────────────────────────────────
// 'auto' (default): safe reads auto-approve, still fully logged.
// 'ask'          : every read waits for an operator decision.
let mode = 'auto';

// Per-triage "approve all reads for this triage" — once set, reads tagged with
// that triageId auto-approve even in ask mode, and are still logged.
const allReadsForTriage = new Set();

// ── The approval log (ring buffer) ───────────────────────────────────────────
const MAX_RECORDS = 500;
const records = [];
let seq = 0;

// Records still waiting for a decision: id → { resolve, record }.
const pending = new Map();

let onEvent = null; // server sets this to broadcast approval_* WS events
function setBroadcast(fn) { onEvent = typeof fn === 'function' ? fn : null; }
function emit(type, data) { if (onEvent) { try { onEvent(type, data); } catch (e) { /* telemetry must never break a read */ } } }

function getMode() { return mode; }
function setMode(m) {
  const next = m === 'ask' ? 'ask' : 'auto';
  if (next === mode) return mode;
  mode = next;
  emit('approval_mode', { mode });
  return mode;
}

// A public snapshot of one record (no internal handles).
function view(rec) {
  return {
    id: rec.id, seq: rec.seq, ts: rec.ts,
    agentId: rec.agentId, agentName: rec.agentName,
    command: rec.command, target: rec.target, reason: rec.reason,
    triageId: rec.triageId, front: rec.front,
    mode: rec.mode, state: rec.state,
    decidedBy: rec.decidedBy, decidedAt: rec.decidedAt,
    outcome: rec.outcome, outcomeOk: rec.outcomeOk,
  };
}

function push(rec) {
  records.push(rec);
  if (records.length > MAX_RECORDS) records.splice(0, records.length - MAX_RECORDS);
}

// ── The gate ─────────────────────────────────────────────────────────────────
// meta: { agentId, agentName, command, target, triageId, front, reason, cli }
//   command — human label of the read ("show version", "read campus front")
//   target  — what it runs against ("sw1 via Catalyst Center", source label)
//   cli     — OPTIONAL raw device CLI string; if present it is re-checked against
//             the read-only guardrail and hard-denied if it is not a read.
// executeFn: the async function that ACTUALLY performs the read. It runs ONLY on
//   approval. On denial it is never called — so a denied command makes no wire call.
//
// Returns { approved, denied, result, record, blocked }.
//   approved:true  → executeFn ran; result is its return value (errors propagate).
//   denied:true    → executeFn was NOT run; nothing happened, nothing faked.
async function gate(meta, executeFn) {
  const m = meta || {};
  const rec = {
    id: `apr-${Date.now().toString(36)}-${(++seq).toString(36)}`,
    seq,
    ts: new Date().toISOString(),
    agentId: m.agentId || null,
    agentName: m.agentName || m.agentId || 'agent',
    command: String(m.command || 'read'),
    target: m.target || null,
    reason: m.reason || null,
    triageId: m.triageId || null,
    front: m.front || null,
    mode,
    state: 'pending',
    decidedBy: null,
    decidedAt: null,
    outcome: null,
    outcomeOk: null,
  };

  // Belt-and-braces: the gate is a read-only surface. A raw CLI string that is
  // not a read is refused here too, so the gate can NEVER be a path to a write.
  if (m.cli != null) {
    const verdict = checkCommand(m.cli);
    if (!verdict.allowed) {
      rec.state = 'denied';
      rec.decidedBy = 'guardrail';
      rec.decidedAt = new Date().toISOString();
      rec.outcome = `blocked — not read-only: ${verdict.reason}`;
      rec.outcomeOk = false;
      push(rec);
      emit('approval_new', view(rec));
      return { approved: false, denied: true, blocked: true, record: view(rec) };
    }
  }

  const autoNow = mode === 'auto' || (rec.triageId && allReadsForTriage.has(rec.triageId));

  if (autoNow) {
    rec.state = mode === 'auto' ? 'auto' : 'approved';
    rec.decidedBy = mode === 'auto' ? 'auto' : 'all-reads-this-triage';
    rec.decidedAt = new Date().toISOString();
    push(rec);
    emit('approval_new', view(rec));
    return runApproved(rec, executeFn);
  }

  // ── Ask mode: PAUSE until the operator decides ─────────────────────────────
  push(rec);
  emit('approval_new', view(rec));

  const decision = await new Promise((resolve) => { pending.set(rec.id, { resolve, record: rec }); });

  if (decision === 'deny') {
    rec.state = 'denied';
    rec.decidedBy = 'operator';
    rec.decidedAt = new Date().toISOString();
    rec.outcome = 'denied — ran nothing';
    rec.outcomeOk = false;
    emit('approval_update', view(rec));
    return { approved: false, denied: true, record: view(rec) };
  }

  if (decision === 'approve-all') {
    if (rec.triageId) allReadsForTriage.add(rec.triageId);
    rec.decidedBy = 'all-reads-this-triage';
  } else {
    rec.decidedBy = 'operator';
  }
  rec.state = 'approved';
  rec.decidedAt = new Date().toISOString();
  emit('approval_update', view(rec));
  return runApproved(rec, executeFn);
}

// Run the (approved/auto) read, record its honest outcome, and let any error
// propagate so the caller's own honest failure handling still fires.
async function runApproved(rec, executeFn) {
  try {
    const result = await executeFn();
    rec.outcomeOk = true;
    const detail = result && typeof result === 'object' && result.detail ? String(result.detail) : null;
    rec.outcome = detail ? `ran — ${detail}` : 'ran — read completed';
    emit('approval_update', view(rec));
    return { approved: true, denied: false, result, record: view(rec) };
  } catch (err) {
    rec.outcomeOk = false;
    rec.outcome = `failed — ${err && err.message ? err.message : String(err)}`;
    emit('approval_update', view(rec));
    throw err;
  }
}

// ── Operator decision ────────────────────────────────────────────────────────
// decision ∈ 'approve-once' | 'approve-all' | 'deny'.
function decide(id, decision) {
  const valid = { 'approve-once': 'approve-once', 'approve-all': 'approve-all', deny: 'deny' };
  const d = valid[decision];
  if (!d) return { error: 'bad_decision', reason: `Decision must be approve-once, approve-all or deny — got "${decision}".` };
  const entry = pending.get(id);
  if (!entry) return { error: 'not_pending', reason: 'That request is not waiting for a decision (already decided, or unknown).' };
  pending.delete(id);
  entry.resolve(d === 'approve-once' ? 'approve-once' : d === 'approve-all' ? 'approve-all' : 'deny');
  return { ok: true, id, decision: d };
}

// ── Query ────────────────────────────────────────────────────────────────────
function list({ triageId, limit } = {}) {
  let out = records;
  if (triageId) out = out.filter((r) => r.triageId === triageId);
  out = out.map(view);
  if (limit && out.length > limit) out = out.slice(out.length - limit);
  return out;
}
function state() {
  return { mode, pending: pending.size, allReadsForTriage: [...allReadsForTriage] };
}

module.exports = { gate, decide, setMode, getMode, setBroadcast, list, state };
