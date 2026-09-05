// presence.js — CW-12 Live Presence (backend half).
//
// Plain words: the console should feel alive — "Jarvis is typing…",
// "Router-Expert is checking…", "Config-Keeper is waiting for your approval" —
// and the operator's own message should show it was picked up. WhatsApp ticks
// for a NOC bridge.
//
// THE LAW OF THIS WAVE (docs/copilot-cw12-presence-contract.md, rule 3):
// presence is driven by REAL events only. A "typing" line may show ONLY while a
// model call or an agent read is actually in flight, and it must clear the
// moment that work ends — success, error, abort, or denial alike. A pulsing
// indicator on a dead request is a fabrication-class defect, the same class as
// an invented number. So this module never invents a state: it only mirrors
// start/end pairs that the real seams report (claude.js for model calls,
// updateAgentStatus for agent reads, the approvals gate for waits), and it
// never persists anything — presence is a statement about NOW.
//
// THE WIRE SHAPE (additive — an old client ignores the type entirely):
//   { type:'presence', data:{ actor, actorName, state, id, since?, at,
//                             requestId?, clientMessageId?, messageId?, reason? } }
//   state ∈ 'picked-up' | 'thinking' | 'typing' | 'checking' | 'waiting-approval' | 'done'
//   'picked-up' is a one-shot receipt for the operator's message (carries the
//   requestId the server minted and the clientMessageId the page sent, so the
//   page can tick the right bubble). Everything else is a flight: start with a
//   working state, end with 'done' under the SAME actor + id.
//
// One tracker instance per server. `broadcast(type, data)` is the server's own
// WS fan-out; `now()` is injectable so the tests are deterministic.

const STATES = ['picked-up', 'thinking', 'typing', 'checking', 'waiting-approval', 'done'];
const WORKING = ['thinking', 'typing', 'checking', 'waiting-approval'];

// A flight that has been "in flight" this long without its end is not a live
// fact any more — it is a leak somewhere upstream. It is dropped from the
// snapshot a reconnecting client receives (never shown as live), and an honest
// 'done' with reason 'expired' is broadcast so any client still showing it
// clears. Model calls time out at CLAUDE_TIMEOUT_MS (default 60s, with a few
// retries) and agent reads have their own timeouts, so ten minutes is far past
// any real duration.
const MAX_AGE_MS = 10 * 60 * 1000;
const ID_MAX = 96;

function str(v, max) {
  const s = (typeof v === 'string' || typeof v === 'number') ? String(v) : '';
  return max ? s.slice(0, max) : s;
}

function create({ broadcast, now } = {}) {
  const fanout = typeof broadcast === 'function' ? broadcast : () => {};
  // Presence is telemetry about work; it must never be able to break the work.
  const emit = (type, data) => { try { fanout(type, data); } catch (e) { /* a dead socket is not a reasoning failure */ } };
  const clock = typeof now === 'function' ? now : () => Date.now();
  const flights = new Map();   // key actor|id → { actor, actorName, state, id, since, requestId, messageId, label }
  let seq = 0;

  const keyOf = (actor, id) => `${actor}|${id}`;

  function envelope(f, state, extra) {
    const at = new Date(clock()).toISOString();
    const out = {
      actor: f.actor, actorName: f.actorName, state, id: f.id, at,
      ...(f.since ? { since: f.since } : {}),
      ...(f.requestId ? { requestId: f.requestId } : {}),
      ...(f.clientMessageId ? { clientMessageId: f.clientMessageId } : {}),
      ...(f.messageId ? { messageId: f.messageId } : {}),
      ...(f.label ? { label: f.label } : {}),
      ...(extra || {}),
    };
    return out;
  }

  // Start (or re-state) a flight. Calling start again for the same actor+id with
  // a new state — e.g. a model call that was 'thinking' and begins streaming,
  // so it is now 'typing' — updates the state in place and broadcasts it; the
  // `since` stays the original start, because the work did not restart.
  function start(spec) {
    const s = spec || {};
    const actor = str(s.actor, ID_MAX);
    if (!actor) return null;
    const state = WORKING.includes(s.state) ? s.state : null;
    if (!state) return null;
    const id = str(s.id, ID_MAX) || `${actor}-${(++seq).toString(36)}`;
    const k = keyOf(actor, id);
    const existing = flights.get(k);
    const f = existing || {
      actor, id,
      since: new Date(clock()).toISOString(),
    };
    f.actorName = str(s.actorName, 120) || f.actorName || actor;
    f.state = state;
    if (s.requestId) f.requestId = str(s.requestId, ID_MAX);
    if (s.clientMessageId) f.clientMessageId = str(s.clientMessageId, ID_MAX);
    if (s.messageId) f.messageId = str(s.messageId, ID_MAX);
    if (s.label !== undefined) f.label = str(s.label, 160);
    flights.set(k, f);
    emit('presence', envelope(f, state));
    return id;
  }

  // End a flight. Unknown actor+id → nothing happens and nothing is sent: an
  // end without a start is not a fact the client needs (and a 'done' for a
  // flight it never saw would be noise). `reason` is honest colour for the
  // client ('done' | 'error' | 'aborted' | 'denied' | 'expired').
  function end(spec) {
    const s = spec || {};
    const actor = str(s.actor, ID_MAX);
    const id = str(s.id, ID_MAX);
    if (!actor || !id) return false;
    const k = keyOf(actor, id);
    const f = flights.get(k);
    if (!f) return false;
    flights.delete(k);
    const reason = ['done', 'error', 'aborted', 'denied', 'expired'].includes(s.reason) ? s.reason : 'done';
    emit('presence', envelope(f, 'done', { reason }));
    return true;
  }

  // The one-shot receipt: the operator's message has been handed to an actor
  // that has started on it. Not a flight — nothing to end.
  function pickedUp(spec) {
    const s = spec || {};
    const actor = str(s.actor, ID_MAX) || 'jarvis';
    const f = {
      actor, id: `pickup-${(++seq).toString(36)}`,
      actorName: str(s.actorName, 120) || actor,
      requestId: str(s.requestId, ID_MAX),
      clientMessageId: str(s.clientMessageId, ID_MAX),
    };
    emit('presence', envelope(f, 'picked-up'));
    return true;
  }

  // Drop every flight older than MAX_AGE_MS, telling clients honestly why.
  function expire() {
    const cutoff = clock() - MAX_AGE_MS;
    let n = 0;
    for (const [k, f] of flights) {
      if (Date.parse(f.since) < cutoff) {
        flights.delete(k);
        emit('presence', envelope(f, 'done', { reason: 'expired' }));
        n++;
      }
    }
    return n;
  }

  // What is in flight RIGHT NOW — for the init snapshot a (re)connecting
  // client receives, so a reload mid-answer shows the true state rather than
  // silence, and a reload after the answer shows nothing (no ghost).
  function snapshot() {
    expire();
    return Array.from(flights.values()).map((f) => envelope(f, f.state));
  }

  function size() { return flights.size; }

  return { start, end, pickedUp, snapshot, expire, size, STATES, WORKING, MAX_AGE_MS };
}

module.exports = { create, STATES, WORKING, MAX_AGE_MS };
