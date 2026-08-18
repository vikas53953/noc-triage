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

const { AsyncLocalStorage } = require('async_hooks');
const { checkCommand } = require('./guardrails');

// ── Re-entrancy ──────────────────────────────────────────────────────────────
// The gate belongs at the CHOKE POINT — the place a command actually reaches the
// wire — so no caller (present or future) can route around it. But an outer
// caller may already have gated the same operator request (a Jarvis delegation
// gates the whole sub-question; Config-Keeper gates the direct read). Prompting
// twice for one operator action would train the operator to click through.
//
// So an approved gate publishes itself on this async context. A gate that opens
// INSIDE an approved gate is already covered by that operator decision: it does
// NOT prompt again, it still re-checks the raw CLI against the read-only
// guardrail, and it still writes its own record — stamped `covered-by <id>` —
// so the approval log always shows the EXACT command that ran, under the
// decision that authorised it. Nothing runs that no one approved.
const gateCtx = new AsyncLocalStorage();

// ── Mode ─────────────────────────────────────────────────────────────────────
// The three permission modes are the SINGLE SOURCE OF TRUTH for the gate. The
// server, /api/capabilities and the UI read this set (MODES) — nobody hardcodes
// their own copy, so the advertised set can never drift from what the gate does.
//
// 'auto' (default): safe reads auto-approve, still fully logged.
// 'ask'          : every read waits for an operator decision.
// 'deny'         : LOCKDOWN — every gated action is denied at the gate, no wire
//                  call is made, nothing can be approved past it. The only way
//                  through is for an operator to change the mode. This is the
//                  fail-CLOSED state; it is also where an unknown/garbage mode
//                  can be snapped to, so a bad value never lands on 'auto'.
const MODES = Object.freeze(['auto', 'ask', 'deny']);
let mode = 'auto';

// Per-triage "approve all reads for this triage" — once set, reads tagged with
// that triageId auto-approve even in ask mode, and are still logged.
const allReadsForTriage = new Set();

// ── The approval log (ring buffer) ───────────────────────────────────────────
const MAX_RECORDS = 500;
const records = [];
let seq = 0;

// Records still waiting for a decision: id → { resolve, record, timer }.
const pending = new Map();

// ── Approval timeout (Wave 3 — DEFAULT OFF) ──────────────────────────────────
// Env APPROVAL_TIMEOUT_MS. 0 / unset = DISABLED (the default): a pending approval
// waits FOREVER for the operator, exactly as before — no timer is ever armed.
// When set to a positive number, a pending approval that is not decided within
// the window auto-resolves to DENY (the safe choice — a denied read runs nothing)
// and is logged as "auto-denied (timeout)". Read fresh each gate call so an
// operator can opt in without a restart. A malformed/negative value = disabled.
function approvalTimeoutMs() {
  const n = Number(process.env.APPROVAL_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

let onEvent = null; // server sets this to broadcast approval_* WS events
function setBroadcast(fn) { onEvent = typeof fn === 'function' ? fn : null; }
function emit(type, data) { if (onEvent) { try { onEvent(type, data); } catch (e) { /* telemetry must never break a read */ } } }

function getMode() { return mode; }
function modes() { return [...MODES]; }

// Set the global permission mode. FAILS CLOSED: an unknown / empty / non-string
// value is REJECTED and the mode is left unchanged — it is NEVER silently
// coerced to 'auto' (the least-safe state), which was the Class-5 defect. The
// caller (the HTTP route) surfaces the rejection as a 400 with the valid set.
//
// Returns a result object (not a bare string):
//   { ok:true,  mode, changed }              — accepted; `mode` is the new mode
//   { ok:false, error, mode, valid, reason } — rejected; `mode` is the UNCHANGED
//                                              current mode (always a safe value)
// The value is trimmed + lower-cased first so " Deny " / "AUTO" are accepted;
// anything not in MODES is rejected. Rejection leaves a safe mode in force.
function setMode(m) {
  const next = typeof m === 'string' ? m.trim().toLowerCase() : '';
  if (!MODES.includes(next)) {
    return {
      ok: false,
      error: 'bad_mode',
      mode,               // unchanged — and never 'auto'-by-accident
      valid: [...MODES],
      reason: `Permission mode must be one of: ${MODES.join(', ')}. Got ${JSON.stringify(m)} — ignored; mode stays "${mode}".`,
    };
  }
  if (next === mode) return { ok: true, mode, changed: false };
  mode = next;
  emit('approval_mode', { mode });
  return { ok: true, mode, changed: true };
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
    // Wave 3 — when the approval timeout is enabled, the deadline a pending
    // approval auto-DENIES at, so the UI can show a countdown. null when the
    // timeout is disabled (the default) — the UI then shows no countdown.
    timeoutAt: rec.timeoutAt || null,
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
    timeoutAt: null,   // set below only in ask mode when the timeout is enabled
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

  // ── Global DENY / lockdown ─────────────────────────────────────────────────
  // When the gate is in 'deny' mode the console is LOCKED DOWN: EVERY gated
  // action — a read, a change, an auto-approve, a per-triage "approve all", even
  // a re-entrant call already covered by an outer decision — is denied right
  // here, before the wire is ever touched. executeFn is never called, so zero
  // wire calls are made and nothing can be approved past the lock. The only way
  // through is for an operator to change the mode. This check sits ABOVE the
  // re-entrancy short-circuit on purpose: if an operator flips to deny while an
  // outer action is mid-flight, its not-yet-run nested reads still stop dead.
  if (mode === 'deny') {
    rec.state = 'denied';
    rec.decidedBy = 'lockdown';
    rec.decidedAt = new Date().toISOString();
    rec.outcome = 'denied — permission gate is in lockdown (deny mode). No wire call was made; nothing can be approved until an operator changes the mode.';
    rec.outcomeOk = false;
    push(rec);
    emit('approval_new', view(rec));
    return { approved: false, denied: true, lockdown: true, record: view(rec) };
  }

  // Already inside an approved gate → covered by that decision (see the
  // re-entrancy note at the top). Logged in full, never re-prompted.
  const outer = gateCtx.getStore();
  if (outer) {
    rec.state = 'approved';
    rec.decidedBy = `covered-by ${outer.id}`;
    rec.decidedAt = new Date().toISOString();
    push(rec);
    emit('approval_new', view(rec));
    return runApproved(rec, executeFn);
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
  // Arm the auto-deny timeout ONLY when the operator has opted in (env set > 0).
  // Default (unset) = no timer: the approval waits forever, exactly as before.
  const timeoutMs = approvalTimeoutMs();
  if (timeoutMs > 0) {
    rec.timeoutAt = new Date(Date.now() + timeoutMs).toISOString();
  }
  push(rec);
  emit('approval_new', view(rec));

  const decision = await new Promise((resolve) => {
    let timer = null;
    if (timeoutMs > 0) {
      // The safe auto-resolution: DENY. A denied read runs NOTHING (executeFn is
      // never called), so the timeout can never trigger a wire call.
      timer = setTimeout(() => {
        if (pending.has(rec.id)) {
          pending.delete(rec.id);
          resolve('deny-timeout');
        }
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref(); // never keep the process alive
    }
    pending.set(rec.id, { resolve, record: rec, timer });
  });

  if (decision === 'deny' || decision === 'deny-timeout') {
    const byTimeout = decision === 'deny-timeout';
    rec.state = 'denied';
    rec.decidedBy = byTimeout ? 'timeout' : 'operator';
    rec.decidedAt = new Date().toISOString();
    rec.outcome = byTimeout ? 'auto-denied (timeout) — ran nothing' : 'denied — ran nothing';
    rec.outcomeOk = false;
    emit('approval_update', view(rec));
    return { approved: false, denied: true, timedOut: byTimeout, record: view(rec) };
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
    // Publish this approved decision to everything it runs, so a nested gate is
    // covered by it instead of prompting the operator a second time.
    const result = await gateCtx.run({ id: rec.id, command: rec.command }, executeFn);
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
  if (entry.timer) { try { clearTimeout(entry.timer); } catch (e) { /* never throw on teardown */ } }
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

module.exports = { gate, decide, setMode, getMode, modes, MODES, setBroadcast, list, state };
