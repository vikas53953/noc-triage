// tickets.js — the built-in ticket queue's brain (CW-3).
//
// Plain words: this is the ONLY place a ticket is created, assigned, moved
// between states, or given a work note. Every one of those is validated here,
// audited here, and persisted through sources/ticket-store.js. The internal
// queue is the SINGLE SOURCE OF TRUTH for tickets (Gate-1 decision); ServiceNow
// (CW-6) becomes a mirror that syncs into each record's `snow` slot — never a
// second truth.
//
// INTENT-FIRST (the CW-3 contract + the console's standing law). Chat NEVER
// creates a ticket directly and there is NO keyword routing that does. When the
// operator says "open a ticket for X", the planner (jarvis.js, the real-Claude
// path — PENDING CREDITS) composes a ticket PROPOSAL from real context; the desk
// shows it; and only the operator's explicit "Create ticket" confirm calls
// create() below. This module exposes create() as the create TOOL the planner
// uses after confirmation — it is deterministic, testable, and never guesses.
//
// SAFETY vs INTENT. Tickets are APP STATE, not device wire calls, so the
// permission gate / read-only guardrail do not apply. What DOES apply: an
// operator NAME is required on every write (enforced by the CW-1 428 gate in
// server.js and re-checked here), status transitions are validated (you cannot
// close without a resolution note), and every transition is audited
// {who, what, ticket, result}. Secrets + XSS are scrubbed/escaped in the store.

const store = require('./ticket-store');
const session = require('./session-log');

const { STATUSES, SEVERITIES } = store;

// ── Validated status transitions ────────────────────────────────────────────
// A ticket moves along an honest lifecycle. Anything not in this map is refused
// out loud rather than silently written — a state machine nobody can subvert.
// Re-open paths (resolved/closed → in-progress) exist because real tickets do
// come back; a fresh ticket may also be closed directly (e.g. a duplicate).
const TRANSITIONS = {
  open:          ['assigned', 'in-progress', 'resolved', 'closed'],
  assigned:      ['open', 'in-progress', 'resolved', 'closed'],
  'in-progress': ['assigned', 'resolved', 'closed'],
  resolved:      ['in-progress', 'closed'],
  closed:        ['in-progress'], // re-open only
};

// Reaching this state requires a resolution note in the SAME call — closing a
// ticket with no record of why is exactly the audit hole this closes.
const REQUIRES_RESOLUTION = new Set(['closed']);

function isValidTransition(from, to) {
  if (from === to) return false;
  return (TRANSITIONS[from] || []).includes(to);
}

function now() { return new Date().toISOString(); }

// The operator name for a write. Prefer the explicit arg (the route passes
// req.operator); fall back to the async operator context the CW-1 middleware set.
function operatorOf(who) {
  return who || (typeof session.currentOperator === 'function' ? session.currentOperator() : null) || null;
}

// ── Create ──────────────────────────────────────────────────────────────────
// The create TOOL. Returns { ok, ticket } or { ok:false, status, error }.
// `incidentId` / `incidentLabel` are pre-validated by the caller (the route
// resolves them against the REAL incident list); this layer never fabricates a
// link — a link is only stored when the caller proved the incident is real.
function create({ severity, title, description, incidentId, incidentLabel, who } = {}) {
  const operator = operatorOf(who);
  if (!operator) return { ok: false, status: 428, error: 'Tell me your name first.' };

  const sev = String(severity || '').toUpperCase().trim();
  if (!SEVERITIES.includes(sev)) {
    return { ok: false, status: 400, error: `Severity must be one of ${SEVERITIES.join(', ')}.` };
  }
  const t = String(title || '').trim();
  if (!t) return { ok: false, status: 400, error: 'A ticket needs a title.' };
  const desc = String(description == null ? '' : description).trim();

  const ts = now();
  const rec = {
    id: store.nextId(ts),
    ts,
    createdBy: operator,
    severity: sev,
    title: t,
    description: desc,
    status: 'open',
    assignee: null,
    incidentId: incidentId || null,
    incidentLabel: incidentLabel || null,
    worknotes: [],
    history: [{ ts, status: 'open', by: operator }],
    snow: { id: null, syncedAt: null }, // CW-6 mirror slot — never a second truth
  };
  const stored = store.insert(rec);
  store.emit('ticket_new', stored);
  session.audit({
    who: operator,
    what: `ticket ${stored.id} created (${sev})${stored.incidentId ? ` linked to ${stored.incidentId}` : ''}: ${stored.title}`,
    result: 'open',
  });
  return { ok: true, ticket: stored };
}

// ── Assign ────────────────────────────────────────────────────────────────────
function assign(id, { assignee, who } = {}) {
  const operator = operatorOf(who);
  if (!operator) return { ok: false, status: 428, error: 'Tell me your name first.' };
  const ticket = store.get(id);
  if (!ticket) return { ok: false, status: 404, error: `No ticket with id "${id}".` };

  const name = String(assignee == null ? '' : assignee).trim();
  if (!name) return { ok: false, status: 400, error: 'Name who this ticket is assigned to.' };

  const next = { ...ticket };
  next.assignee = name;
  // An unassigned ticket that gets an owner naturally becomes "assigned"; a
  // ticket already in flight (in-progress/resolved) keeps its state — only the
  // owner changes. This is a re-assignment, not a state reset.
  const stateChanged = ticket.status === 'open';
  if (stateChanged) next.status = 'assigned';
  next.history = (ticket.history || []).concat([{
    ts: now(), status: next.status, by: operator, note: `assigned to ${name}`,
  }]);

  const stored = store.replace(id, next);
  store.emit('ticket_update', stored);
  session.audit({
    who: operator,
    what: `ticket ${id} assigned to ${name}`,
    result: stateChanged ? `open → assigned` : `owner changed (status ${ticket.status})`,
  });
  return { ok: true, ticket: stored };
}

// ── Status transition (validated) ───────────────────────────────────────────
function setStatus(id, { status, note, who } = {}) {
  const operator = operatorOf(who);
  if (!operator) return { ok: false, status: 428, error: 'Tell me your name first.' };
  const ticket = store.get(id);
  if (!ticket) return { ok: false, status: 404, error: `No ticket with id "${id}".` };

  const to = String(status || '').toLowerCase().trim();
  if (!STATUSES.includes(to)) {
    return { ok: false, status: 400, error: `Status must be one of ${STATUSES.join(', ')}.` };
  }
  const from = ticket.status;
  if (!isValidTransition(from, to)) {
    return {
      ok: false,
      status: 409,
      error: `Cannot move a ticket from "${from}" to "${to}". Allowed from "${from}": ${(TRANSITIONS[from] || []).join(', ') || '(none)'}.`,
    };
  }
  const resolution = String(note == null ? '' : note).trim();
  if (REQUIRES_RESOLUTION.has(to) && !resolution) {
    return { ok: false, status: 400, error: `Closing a ticket needs a resolution note — say what resolved it.` };
  }

  const next = { ...ticket, status: to };
  const historyEntry = { ts: now(), status: to, by: operator };
  if (resolution) historyEntry.note = resolution;
  next.history = (ticket.history || []).concat([historyEntry]);
  // A resolution note is also kept as a work note, so the ticket's own thread
  // shows why it closed without a reader having to dig into history.
  if (resolution) {
    next.worknotes = (ticket.worknotes || []).concat([{ ts: historyEntry.ts, who: operator, text: resolution }]);
  }

  const stored = store.replace(id, next);
  store.emit('ticket_update', stored);
  session.audit({
    who: operator,
    what: `ticket ${id} ${from} → ${to}`,
    result: resolution ? resolution.slice(0, 300) : to,
  });
  return { ok: true, ticket: stored };
}

// ── Work note ─────────────────────────────────────────────────────────────────
function addNote(id, { text, who } = {}) {
  const operator = operatorOf(who);
  if (!operator) return { ok: false, status: 428, error: 'Tell me your name first.' };
  const ticket = store.get(id);
  if (!ticket) return { ok: false, status: 404, error: `No ticket with id "${id}".` };

  const body = String(text == null ? '' : text).trim();
  if (!body) return { ok: false, status: 400, error: 'A work note needs some text.' };

  const entry = { ts: now(), who: operator, text: body };
  const next = { ...ticket, worknotes: (ticket.worknotes || []).concat([entry]) };
  const stored = store.replace(id, next);
  store.emit('ticket_update', stored);
  session.audit({
    who: operator,
    what: `ticket ${id} work note added`,
    result: body.slice(0, 300),
  });
  return { ok: true, ticket: stored };
}

// ── Reads (pass-through to the store) ───────────────────────────────────────
function list(opts) { return store.list(opts); }
function get(id) { return store.get(id); }

module.exports = {
  create, assign, setStatus, addNote, list, get,
  isValidTransition, TRANSITIONS, REQUIRES_RESOLUTION,
  STATUSES, SEVERITIES,
};
