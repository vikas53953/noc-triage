// notifier.js — the on-call webhook notifier (Wave 3).
//
// PURPOSE: push a COMPACT JSON event to a configured on-call webhook
// (PagerDuty / Opsgenie / Slack-shaped) on the three moments an on-call engineer
// actually wants a page:
//   (a) a read needs operator approval (ask mode) — someone has to decide,
//   (b) a verdict lands — the bridge committed a ruling,
//   (c) an SLA breach — an incident blew its time-to-verdict target.
//
// HONESTY — the whole point of this module:
//   • The target is env `ONCALL_WEBHOOK`. If it is UNSET, this is an HONEST
//     no-op: status() reports configured:false and notify() sends NOTHING and
//     never pretends to have paged anyone. We never fabricate a delivery.
//   • The notifier NEVER blocks a triage. notify() fires the POST in the
//     background and swallows every failure (logged, never thrown) — a down
//     pager can never stall or crash a live bridge.
//   • The webhook URL itself may carry a secret (a Slack token lives in the
//     path). So we NEVER log or expose the full URL — status()/logs surface the
//     HOST only (e.g. "hooks.slack.com"). The payload is secret-scrubbed before
//     it leaves, same scrubber every wire record uses.
//
// This module composes + sends only. It knows nothing about triage internals —
// callers hand it a plain compact event object.

const http = require('http');
const https = require('https');
const { URL } = require('url');
const session = require('./session-log');
// CW-4: Teams rides the SAME bridge-event seam as the on-call page, so a bridge
// moment fans out to both from ONE place instead of being sprinkled per caller.
// Teams is an HONEST no-op when TEAMS_WEBHOOK is unset and can never throw here.
const teams = require('./teams');

const DEFAULT_TIMEOUT = 8000;

// Read the webhook fresh each call so a late-set env (or a test) is honoured
// without a restart. Returns null when unset/blank → the no-op path.
function webhookUrl() {
  const raw = process.env.ONCALL_WEBHOOK;
  if (!raw || !String(raw).trim()) return null;
  return String(raw).trim();
}

// Parse the URL once; an unparseable webhook is treated as "not configured"
// rather than throwing — a bad env must never take a read down.
function parsed() {
  const raw = webhookUrl();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u;
  } catch (e) {
    return null;
  }
}

// Public status for GET /api/notifier/status. `target` is the HOST only — never
// the full URL — so a Slack-token-in-path webhook can be shown as configured
// without leaking the secret.
function status() {
  const u = parsed();
  if (!u) return { configured: false };
  return { configured: true, target: u.host };
}

// Build the compact event body sent to the webhook. Generic + Slack-friendly:
// a top-level `text` gives Slack an out-of-the-box message; the structured
// fields suit PagerDuty/Opsgenie custom-payload mapping. Only real, caller-
// provided fields — nothing invented.
function buildPayload(event, info = {}) {
  const i = info || {};
  const summary = i.summary || defaultSummary(event, i);
  return {
    event,                                   // 'approval_needed' | 'verdict' | 'sla_breach'
    ts: new Date().toISOString(),
    source: 'noc-triage',
    incidentId: i.incidentId || null,
    triageId: i.triageId || null,
    severity: i.severity || null,
    title: i.title || null,
    front: i.front || null,
    origin: i.origin || null,                // how the triage was opened (operator|alert)
    summary,
    detail: i.detail || null,
    // Slack compatibility: a plain human line it can post directly.
    text: `[${(i.severity || 'NOC')}] ${summary}`,
  };
}

function defaultSummary(event, i) {
  const inc = i.incidentId || i.triageId || 'incident';
  if (event === 'approval_needed') {
    return `Approval needed on ${inc}: ${i.command || 'a read'}${i.target ? ` against ${i.target}` : ''}`;
  }
  if (event === 'verdict') {
    return `Verdict on ${inc}${i.title ? ` — ${i.title}` : ''}`;
  }
  if (event === 'sla_breach') {
    return `SLA BREACH on ${inc}${i.title ? ` — ${i.title}` : ''}`;
  }
  return `${event} on ${inc}`;
}

// Fire an event at the webhook. NON-BLOCKING by contract: returns a promise for
// callers/tests that want to await the outcome, but a live triage calls this
// WITHOUT awaiting and the internal handling guarantees it can never throw.
//
// Returns { delivered:boolean, configured:boolean, reason?, status?, host? }.
//   configured:false  → honest no-op, nothing was sent, no pretence of paging.
//   delivered:true     → the webhook accepted it (2xx).
//   delivered:false + configured:true → we tried; reason carries the real error.
function notify(event, info = {}) {
  // CW-4: mirror this bridge event to Teams from the same seam. Fire-and-forget,
  // honest no-op when no TEAMS_WEBHOOK is set — it NEVER blocks or throws onto the
  // on-call path, and is independent of whether the on-call webhook is configured.
  try {
    const tp = teams.onBridgeEvent(event, info);
    if (tp && typeof tp.catch === 'function') tp.catch(() => { /* audited inside teams */ });
  } catch (e) { /* telemetry must never break the notifier */ }

  const u = parsed();
  if (!u) {
    // Honest no-op — never pretend to page when no webhook is set.
    return Promise.resolve({ delivered: false, configured: false, reason: 'not configured' });
  }
  const payload = buildPayload(event, info);
  // Secret-scrub the serialized body (belt-and-braces — the payload is our own
  // composed fields, but the scrubber guarantees no token-shaped value leaks).
  let body;
  try {
    body = session.scrub(JSON.stringify(payload));
  } catch (e) {
    body = JSON.stringify({ event, ts: payload.ts, summary: payload.summary });
  }
  return send(u, body).then(
    (res) => {
      if (!res.ok) {
        logQuiet(`on-call webhook ${u.host} rejected ${event} — ${res.status || res.error}`);
      }
      return { delivered: !!res.ok, configured: true, status: res.status || null, host: u.host, reason: res.ok ? null : (res.error || `status ${res.status}`) };
    },
    (err) => {
      // Unreachable in practice (send never rejects) — final belt-and-braces.
      logQuiet(`on-call webhook ${u.host} error on ${event} — ${err && err.message}`);
      return { delivered: false, configured: true, host: u.host, reason: err && err.message ? err.message : 'send failed' };
    }
  );
}

// Low-level POST. Never rejects — resolves { ok, status } or { ok:false, error }.
function send(u, body) {
  const lib = u.protocol === 'https:' ? https : http;
  const opts = {
    method: 'POST',
    hostname: u.hostname,
    port: u.port || (u.protocol === 'https:' ? 443 : 80),
    path: u.pathname + (u.search || ''),
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
    timeout: DEFAULT_TIMEOUT,
  };
  return new Promise((resolve) => {
    let settled = false;
    const settle = (r) => { if (!settled) { settled = true; resolve(r); } };
    const req = lib.request(opts, (res) => {
      // Drain so the socket frees; we only care about the status code.
      res.on('data', () => {});
      res.on('end', () => settle({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode }));
    });
    req.on('error', (err) => settle({ ok: false, error: err.code || err.message }));
    req.on('timeout', () => { req.destroy(); settle({ ok: false, error: 'timeout' }); });
    req.write(body);
    req.end();
  });
}

// Notifier telemetry must never break a read — log to the server window only.
function logQuiet(line) {
  try { console.warn(`[notifier] ${line}`); } catch (e) { /* never throw from telemetry */ }
}

module.exports = { status, notify, buildPayload };
