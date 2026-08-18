// A4 — live-events store.
//
// An in-memory ring buffer of the most recent device events that arrived over
// the NATIVE live feeds (syslog UDP + SNMP-trap UDP). It is the single place
// those feeds deposit a parsed event, and the single place the bridge/triage
// reads them back from — by time window, so a live event can sit alongside the
// APIC faults / vManage alarms as timestamped evidence the LLM reasons over.
//
// Honesty laws kept (HANDOFF):
//   • Nothing is ever fabricated here. Only a feed that really received a packet
//     writes an event. Feeds OFF → this store stays empty and count() is 0.
//   • Every stored text/raw field is secret-scrubbed (session-log's scrubber)
//     BEFORE it lands, so a credential in a syslog line can never rest here or
//     stream to the browser.
//   • We store the text SCRUBBED but NOT html-escaped — escaping is the DOM
//     sink's job (the UI owns that). Callers that render to a DOM must escape.
//   • The buffer is capped; the oldest event falls off. No unbounded growth.
const session = require('./session-log');

// Cap the ring. Configurable, but a sane default so a busy device storm can
// never exhaust memory. Oldest events are dropped first.
const CAP = (() => {
  const n = Number(process.env.LIVE_EVENTS_CAP);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 500;
})();

// The ring. Plain array, newest last. We also keep monotonic counters per
// source so status can report "how many have we ever received" independent of
// how many are still resident in the (capped) buffer.
const buffer = [];
let seq = 0;
const received = { syslog: 0, trap: 0 };

// Parse any timestamp-ish value to epoch-ms, or null if it isn't real. Never
// invents a time — an unparseable ts becomes null and the caller decides.
function toMs(ts) {
  if (ts === null || ts === undefined || ts === '') return null;
  if (typeof ts === 'number') return Number.isFinite(ts) ? ts : null;
  if (ts instanceof Date) { const m = ts.getTime(); return Number.isNaN(m) ? null : m; }
  const m = Date.parse(ts);
  return Number.isNaN(m) ? null : m;
}

// Cap a scrubbed string so one giant packet can't bloat the store or the wire.
function scrubCap(v, cap = 2000) {
  if (v == null) return '';
  return session.scrub(String(v)).slice(0, cap);
}

// ── Add an event ─────────────────────────────────────────────────────────────
// Called ONLY by the feeds, and only for a packet that really arrived. Returns
// the stored event (scrubbed), or null if the event named nothing to store
// (defensive — a feed should have dropped a malformed packet before here).
//
// evt = { source:'syslog'|'trap', device, severity, severityNum?, facility?,
//         trapOid?, trapName?, varbinds?, ts, text, raw }
//   • device  — the sending host/IP (real; never invented)
//   • severity— a lowercase label ('critical','error','warning', …) or null.
//               SNMP traps carry no syslog severity → null is the honest value.
//   • ts      — epoch-ms or ISO/parseable; unparseable → receipt time is stamped
//               and flagged (tsStamped:true) so nothing claims a time it lacked.
function add(evt) {
  if (!evt || typeof evt !== 'object') return null;
  const source = evt.source === 'trap' ? 'trap' : (evt.source === 'syslog' ? 'syslog' : null);
  if (!source) return null;

  const text = scrubCap(evt.text, 2000);
  const device = scrubCap(evt.device, 200) || null;
  // An event must carry SOMETHING real — a device or some text. Otherwise it is
  // not evidence and we refuse it (the feed already logs the drop).
  if (!device && !text) return null;

  let tsMs = toMs(evt.ts);
  let tsStamped = false;
  if (tsMs === null) { tsMs = Date.now(); tsStamped = true; }

  const stored = {
    id: `ev-${Date.now().toString(36)}-${(++seq).toString(36)}`,
    source,
    device,
    severity: typeof evt.severity === 'string' && evt.severity.trim() ? evt.severity.trim().toLowerCase() : null,
    severityNum: Number.isInteger(evt.severityNum) ? evt.severityNum : null,
    facility: evt.facility == null ? null : scrubCap(evt.facility, 40),
    trapOid: evt.trapOid == null ? null : scrubCap(evt.trapOid, 120),
    trapName: evt.trapName == null ? null : scrubCap(evt.trapName, 120),
    varbinds: Array.isArray(evt.varbinds)
      ? evt.varbinds.slice(0, 40).map((v) => ({
          oid: scrubCap(v && v.oid, 120),
          name: v && v.name ? scrubCap(v.name, 120) : null,
          value: scrubCap(v && v.value, 500),
        }))
      : null,
    ts: tsMs,                       // epoch-ms — the single time we reason about
    isoTs: new Date(tsMs).toISOString(),
    tsStamped,                      // true = the packet had no parseable time; we stamped receipt
    text,                           // secret-scrubbed; NOT html-escaped (DOM sink escapes)
    raw: scrubCap(evt.raw, 2000),   // original line/decoded trap, secret-scrubbed
    receivedAt: Date.now(),
  };

  buffer.push(stored);
  received[source] += 1;
  while (buffer.length > CAP) buffer.shift();
  return stored;
}

// ── Read back ────────────────────────────────────────────────────────────────

// Recent events, newest first, capped by `limit`. Optional `source` filter.
function recent(limit = 100, source = null) {
  const n = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 100;
  let list = buffer;
  if (source === 'syslog' || source === 'trap') list = list.filter((e) => e.source === source);
  return list.slice(-n).reverse();
}

// THE INGESTION HOOK the bridge/triage calls: every stored event whose
// timestamp falls at/after startMs (and at/before endMs when given), newest
// first. Events are already secret-scrubbed. An event whose time we had to
// stamp (tsStamped) still counts from its receipt time — honest, never dropped
// silently, and the flag travels with it so a caller can weigh it.
//
//   startMs — epoch-ms lower bound (inclusive). null/undefined → from the start.
//   endMs   — epoch-ms upper bound (inclusive). null/undefined → to now.
//   opts.source — optional 'syslog' | 'trap' filter.
function getInWindow(startMs, endMs, opts = {}) {
  const lo = toMs(startMs);
  const hi = toMs(endMs);
  const src = opts.source === 'syslog' || opts.source === 'trap' ? opts.source : null;
  return buffer
    .filter((e) => {
      if (src && e.source !== src) return false;
      if (lo !== null && e.ts < lo) return false;
      if (hi !== null && e.ts > hi) return false;
      return true;
    })
    .slice()
    .reverse();
}

// How many events are resident right now, total or per source.
function count(source = null) {
  if (source === 'syslog' || source === 'trap') return buffer.filter((e) => e.source === source).length;
  return buffer.length;
}

// Monotonic "ever received" counters (survive the ring dropping old events).
function totals() {
  return { syslog: received.syslog, trap: received.trap };
}

// Test/lifecycle helper: wipe the buffer + counters. Never called in prod flow.
function _reset() {
  buffer.length = 0;
  seq = 0;
  received.syslog = 0;
  received.trap = 0;
}

module.exports = {
  CAP,
  add,
  recent,
  getInWindow,   // ← the hook triage/bridge reads by time window
  count,
  totals,
  _reset,
  toMs,
};
