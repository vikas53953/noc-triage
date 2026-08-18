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
// {who, what, ticket, result}. Secrets are scrubbed in the store.
//
// TEXT IS STORED RAW (secrets scrubbed); HTML-escaping happens ONCE at the
// display sink. The audit lines below carry the ticket's raw title — that is
// fine: the audit sinks are a plain-text log file (COPILOT_AUDIT.log) and a
// JSON API. If a FUTURE consumer ever renders ticket text (title/description/
// worknotes) or an audit line into HTML, it MUST escape at its own sink — do not
// re-introduce escaping here, or every write compounds it (the CW-3 review's
// HIGH defect). The desk ticket pane (public/desk.html) already esc()s on render.

const store = require('./ticket-store');
const session = require('./session-log');
const snow = require('./servicenow-client'); // CW-6: real ServiceNow Table API

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

// ── CW-6: ServiceNow two-way sync (internal queue is TRUTH, SNOW is a mirror) ──
// The transport + field mapping live in sources/servicenow-client.js; the
// decisions about WHAT to sync and how to fold the answer back into the ticket's
// `snow` slot live HERE, next to the truth. Two operator-driven, confirmed
// actions, never keyword-triggered:
//   • pushToSnow — CREATE the INC if snow.id is null, else UPDATE it; record the
//     real snow:{id, number, url, syncedAt, snapshotUpdatedOn}. NEVER a fake INC.
//   • pullFromSnow — READ the SNOW incident and surface its state/worknotes as a
//     MIRROR. It NEVER overwrites internal truth. If BOTH sides changed since the
//     last sync it returns conflict:true and touches nothing — surfaced honestly,
//     never silently clobbered.
// Honest not-connected: with no creds every op returns {ok:false, connected:false}
// and does NOTHING (no INC, no slot write). Creds never touch this layer — the
// client holds them; here we only ever see the non-secret sys_id/number.

// The most recent moment an internal ticket was touched (any history entry or
// work note). Used to tell "did the internal side change since the last sync?".
function lastTouchedTs(ticket) {
  const stamps = [ticket.ts];
  for (const h of ticket.history || []) if (h && h.ts) stamps.push(h.ts);
  for (const w of ticket.worknotes || []) if (w && w.ts) stamps.push(w.ts);
  return stamps.filter(Boolean).sort().pop() || ticket.ts || null;
}

// A concise, secret-free work note describing this sync, plus the latest internal
// work note so the SNOW journal mirrors the ticket thread. Nothing invented.
function syncNote(ticket, operator, verb) {
  const latest = (ticket.worknotes || [])[ticket.worknotes.length - 1];
  const head = `[noc-triage] ${verb} from internal ticket ${ticket.id} by ${operator} — status ${ticket.status}, severity ${ticket.severity}.`;
  return latest && latest.text ? `${head}\nLatest work note: ${latest.text}` : head;
}

// PUSH: mirror the internal ticket into ServiceNow. Create-or-update by snow.id.
// Returns { ok, connected, number?, url?, ticket? } or an honest failure.
async function pushToSnow(id, { who } = {}) {
  const operator = operatorOf(who);
  if (!operator) return { ok: false, status: 428, error: 'Tell me your name first.' };
  const ticket = store.get(id);
  if (!ticket) return { ok: false, status: 404, error: `No ticket with id "${id}".` };

  if (!snow.connected()) {
    // Honest no-op — never fabricate an INC when ServiceNow is not connected.
    session.audit({ who: operator, what: `ticket ${id} ServiceNow push`, result: 'not connected — nothing synced' });
    return { ok: false, connected: false, status: 200 };
  }

  const existing = ticket.snow && ticket.snow.id ? ticket.snow.id : null;
  const verb = existing ? 'updated' : 'created';
  const res = existing
    ? await snow.updateIncident(existing, ticket, { note: syncNote(ticket, operator, verb) })
    : await snow.createIncident(ticket, { note: syncNote(ticket, operator, verb) });

  if (!res.ok) {
    const err = res.connected === false ? 'not connected' : (res.error || `status ${res.status || '?'}`);
    session.audit({ who: operator, what: `ticket ${id} ServiceNow push (${verb})`, result: `failed — ${err}` });
    return { ok: false, connected: res.connected !== false, status: res.status || 502, error: err };
  }

  const inc = res.incident;
  const ts = now();
  const url = snow.incidentUrl(inc.sysId);
  const next = {
    ...ticket,
    snow: {
      id: inc.sysId || (ticket.snow && ticket.snow.id) || null,
      number: inc.number || (ticket.snow && ticket.snow.number) || null,
      url: url || (ticket.snow && ticket.snow.url) || null,
      syncedAt: ts,                       // last time WE pushed the internal truth
      state: inc.state || null,           // the SNOW state we just set
      snapshotUpdatedOn: inc.updatedOn || null, // SNOW's sys_updated_on baseline
      lastOp: verb,
      conflict: false,                    // a fresh push clears any prior conflict
    },
  };
  const stored = store.replace(id, next);
  store.emit('ticket_update', stored);
  snow.recordSync({ op: `push (${verb})`, ticket: id, number: inc.number, result: 'ok' });
  session.audit({
    who: operator,
    what: `ticket ${id} ServiceNow push (${verb})`,
    result: `${verb} ${inc.number || inc.sysId}`,
  });
  return { ok: true, connected: true, number: inc.number || null, url, ticket: stored };
}

// PULL: read the SNOW incident and surface its state/worknotes as a MIRROR.
// NEVER overwrites internal truth. Returns { ok, connected, conflict, mirror, ticket }.
async function pullFromSnow(id, { who } = {}) {
  const operator = operatorOf(who);
  if (!operator) return { ok: false, status: 428, error: 'Tell me your name first.' };
  const ticket = store.get(id);
  if (!ticket) return { ok: false, status: 404, error: `No ticket with id "${id}".` };

  if (!snow.connected()) {
    session.audit({ who: operator, what: `ticket ${id} ServiceNow pull`, result: 'not connected — nothing mirrored' });
    return { ok: false, connected: false, status: 200 };
  }
  const sysId = ticket.snow && ticket.snow.id;
  if (!sysId) {
    return { ok: false, connected: true, status: 409, error: 'This ticket has not been pushed to ServiceNow yet — push it first.' };
  }

  const res = await snow.readIncident(sysId);
  if (!res.ok) {
    const err = res.connected === false ? 'not connected' : (res.error || `status ${res.status || '?'}`);
    session.audit({ who: operator, what: `ticket ${id} ServiceNow pull`, result: `failed — ${err}` });
    return { ok: false, connected: res.connected !== false, status: res.status || 502, error: err };
  }

  const inc = res.incident;
  const prev = ticket.snow || {};
  // Did the SNOW side change since our last sync/pull baseline?
  const snowChanged = !!(prev.snapshotUpdatedOn && inc.updatedOn && inc.updatedOn !== prev.snapshotUpdatedOn);
  // Did the internal side change since our last push?
  const internalChanged = !!(prev.syncedAt && lastTouchedTs(ticket) && lastTouchedTs(ticket) > prev.syncedAt);
  const conflict = snowChanged && internalChanged;

  const mirror = {
    number: inc.number || prev.number || null,
    sysId: inc.sysId || sysId,
    state: inc.state || null,
    stateLabel: inc.stateLabel || (inc.state ? snow.snowStateLabel(inc.state) : null),
    worknotes: inc.worknotes || '',
    comments: inc.comments || '',
    updatedOn: inc.updatedOn || null,
  };

  // Record the mirror in the snow slot WITHOUT touching internal truth (title,
  // status, worknotes, assignee are all left exactly as they were). On a conflict
  // we deliberately DO NOT advance the baseline — advancing it would let the next
  // pull hide the conflict. The internal ticket stays the source of truth; a merge
  // is a separate, explicit, operator-confirmed action (a push resolves it).
  const nextSnow = {
    ...prev,
    number: mirror.number,
    url: prev.url || snow.incidentUrl(mirror.sysId),
    mirror,
    mirroredAt: now(),
    conflict,
  };
  if (!conflict) nextSnow.snapshotUpdatedOn = inc.updatedOn || prev.snapshotUpdatedOn || null;

  const stored = store.replace(id, { ...ticket, snow: nextSnow });
  store.emit('ticket_update', stored);
  snow.recordSync({ op: 'pull', ticket: id, number: mirror.number, result: conflict ? 'conflict' : 'mirrored' });
  session.audit({
    who: operator,
    what: `ticket ${id} ServiceNow pull`,
    result: conflict
      ? `CONFLICT — both changed; internal truth kept, SNOW ${mirror.number} at ${mirror.stateLabel}`
      : `mirrored ${mirror.number} at ${mirror.stateLabel}`,
  });
  return { ok: true, connected: true, conflict, mirror, ticket: stored };
}

// ── Reads (pass-through to the store) ───────────────────────────────────────
function list(opts) { return store.list(opts); }
function get(id) { return store.get(id); }

module.exports = {
  create, assign, setStatus, addNote, list, get,
  pushToSnow, pullFromSnow,
  isValidTransition, TRANSITIONS, REQUIRES_RESOLUTION,
  STATUSES, SEVERITIES,
};
