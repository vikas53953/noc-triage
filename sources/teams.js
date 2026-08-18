// teams.js — CW-4 Microsoft Teams bridge (honest one-way post + reply ingestion).
//
// PURPOSE: push bridge/incident updates into a Microsoft Teams channel via an
// Incoming Webhook, on the same three real moments the on-call notifier fires
// (approval needed / verdict committed / SLA breach), plus an operator-driven
// test post and a planner-driven "post this to Teams" action.
//
// HONESTY — the whole point of this module (mirrors sources/notifier.js):
//   • The target is env `TEAMS_WEBHOOK` (a Teams Incoming Webhook URL). If it is
//     UNSET, this is an HONEST no-op: status() reports connected:false, post()
//     sends NOTHING and returns {ok:false, connected:false}. We NEVER fake a
//     "sent to Teams ✓".
//   • On an HTTP error we return an honest, secret-scrubbed {ok:false, error}
//     — never a fake success.
//   • The webhook URL is a SECRET. It is NEVER logged, NEVER returned by any API,
//     and NEVER stored. status()/lastPost expose only a `connected` boolean and a
//     post-result summary (ok/error/status) — never the URL and never the host.
//   • Posting never blocks a bridge: onBridgeEvent() fires the POST in the
//     background and swallows every failure (audited, never thrown).
//
// ONE-WAY LIMIT (stated plainly, like CW-2's no-write-path honesty):
//   Teams Incoming Webhooks are POST-ONLY. Reading replies back needs a Teams
//   bot / Power-Automate flow registration, which a webhook cannot do. So the
//   POST path is REAL; for "surface replies" we expose injectInbound() (wired to
//   POST /api/copilot/teams/inbound) that a FUTURE bot/flow calls to feed a real
//   reply into the bridge. We do NOT fabricate inbound replies — the store is
//   empty until a real bot feeds it.

const http = require('http');
const https = require('https');
const { URL } = require('url');
const session = require('./session-log');

const DEFAULT_TIMEOUT = 8000;
const INBOUND_CAP = 100;

// The last post ATTEMPT result — for GET /api/copilot/teams/status. Carries only
// non-secret fields (ok/error/status/event/incident/ts). NEVER the URL/host.
let lastPost = null;

// Real inbound replies fed by a future Teams bot/flow. Empty until one calls
// injectInbound — never seeded, never fabricated.
const inbound = [];

// Read the webhook fresh each call so a late-set env (or a test) is honoured
// without a restart. Returns null when unset/blank → the honest no-op path.
function webhookUrl() {
  const raw = process.env.TEAMS_WEBHOOK;
  if (!raw || !String(raw).trim()) return null;
  return String(raw).trim();
}

// Parse the URL once; an unparseable/non-http webhook is treated as "not
// connected" rather than throwing — a bad env must never take the bridge down.
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

// Is a webhook configured (and parseable)? The ONLY fact any API may expose.
function connected() {
  return !!parsed();
}

// Public status for GET /api/copilot/teams/status. connected boolean + the last
// post-attempt summary. NO url, NO host — the secret never leaves this module.
function status() {
  return { connected: connected(), lastPost: lastPost };
}

// Build a Teams MessageCard (legacy connector card — what an Incoming Webhook
// accepts). Only real, caller-provided fields; nothing invented.
function buildCard({ title, text, facts, incidentId, themeColor } = {}) {
  const sections = [];
  const factList = [];
  if (incidentId) factList.push({ name: 'Incident', value: String(incidentId) });
  if (Array.isArray(facts)) {
    for (const f of facts) {
      if (f && f.name != null && f.value != null) {
        factList.push({ name: String(f.name), value: String(f.value) });
      }
    }
  }
  if (factList.length) sections.push({ facts: factList });
  return {
    '@type': 'MessageCard',
    '@context': 'http://schema.org/extensions',
    themeColor: themeColor || '0076D7',
    summary: title || 'noc-triage bridge update',
    title: title || 'noc-triage bridge update',
    text: text || '',
    sections,
  };
}

// POST a card to the webhook. THE one real send path.
// Returns { ok, connected, status?, error? }.
//   connected:false → honest no-op, nothing sent, NEVER a fake success.
//   ok:true         → Teams accepted it (2xx).
//   ok:false + connected:true → we tried; `error` carries the real, scrubbed reason.
// `meta` (event/who) is used only for the audit line + lastPost summary; it never
// changes what is sent.
function post(card, meta = {}) {
  const u = parsed();
  const m = meta || {};
  if (!u) {
    // Honest no-op — never pretend to have posted when no webhook is set.
    const result = { ok: false, connected: false };
    recordPost({ ...m, ok: false, connected: false, error: 'not connected' });
    return Promise.resolve(result);
  }
  let body;
  try {
    // Belt-and-braces scrub of the serialized card (our own composed fields, but
    // the scrubber guarantees no token-shaped value could ride along).
    body = session.scrub(JSON.stringify(card));
  } catch (e) {
    body = JSON.stringify({ text: 'noc-triage bridge update' });
  }
  return send(u, body).then((res) => {
    const out = res.ok
      ? { ok: true, connected: true, status: res.status || null }
      : { ok: false, connected: true, status: res.status || null, error: scrubErr(res.error || `status ${res.status}`) };
    recordPost({ ...m, ...out });
    return out;
  });
}

// A convenience wrapper for callers that hand fields, not a pre-built card.
function postMessage({ title, text, facts, incidentId, themeColor } = {}, meta = {}) {
  return post(buildCard({ title, text, facts, incidentId, themeColor }), {
    incidentId: incidentId || (meta && meta.incidentId) || null,
    ...meta,
  });
}

// Auto-post seam — mirrors the notifier's compact event shape so bridge events
// (approval_needed / verdict / sla_breach) fan out to Teams from ONE place
// (sources/notifier.js calls this right where it fires the on-call page). Honest
// no-op when unconnected; fire-and-forget; can never throw onto the bridge.
function onBridgeEvent(event, info = {}) {
  try {
    if (!connected()) return Promise.resolve({ ok: false, connected: false });
    const i = info || {};
    const inc = i.incidentId || i.triageId || null;
    const title = teamsTitle(event, i);
    const text = i.summary || title;
    const facts = [];
    if (i.severity) facts.push({ name: 'Severity', value: i.severity });
    if (i.front) facts.push({ name: 'Front', value: i.front });
    if (i.origin) facts.push({ name: 'Opened by', value: i.origin });
    const p = postMessage(
      { title, text, facts, incidentId: inc, themeColor: colorFor(event) },
      { event, who: 'auto (bridge event)', incidentId: inc }
    );
    if (p && typeof p.catch === 'function') p.catch(() => { /* audited inside post */ });
    return p;
  } catch (e) {
    logQuiet(`onBridgeEvent error (ignored) — ${e && e.message}`);
    return Promise.resolve({ ok: false, connected: connected(), error: 'send failed' });
  }
}

function teamsTitle(event, i) {
  const inc = i.incidentId || i.triageId || 'incident';
  if (event === 'approval_needed') return `🔐 Approval needed on ${inc}`;
  if (event === 'verdict') return `✅ Verdict committed on ${inc}`;
  if (event === 'sla_breach') return `🚨 SLA breach on ${inc}`;
  return `noc-triage — ${event} on ${inc}`;
}

function colorFor(event) {
  if (event === 'sla_breach') return 'D93F3F';
  if (event === 'verdict') return '2EA043';
  if (event === 'approval_needed') return 'E3A008';
  return '0076D7';
}

// Inject a REAL inbound reply fed by a future Teams bot/Power-Automate flow.
// Records it (scrubbed) so the bridge/desk can surface it. Returns the stored
// reply. We never fabricate — this is only called with data a real bot supplies.
function injectInbound({ from, text, incidentId } = {}) {
  const t = String(text == null ? '' : text).trim();
  if (!t) return { ok: false, error: 'empty reply — nothing to inject' };
  const reply = {
    id: `tin-${Date.now().toString(36)}-${(inbound.length + 1).toString(36)}`,
    from: session.scrub(String(from == null ? 'Teams' : from)).slice(0, 120),
    text: session.scrub(t).slice(0, 2000),
    incidentId: incidentId ? session.scrub(String(incidentId)).slice(0, 60) : null,
    ts: new Date().toISOString(),
    source: 'teams-inbound',
  };
  inbound.push(reply);
  if (inbound.length > INBOUND_CAP) inbound.splice(0, inbound.length - INBOUND_CAP);
  return { ok: true, reply };
}

function inboundReplies({ limit } = {}) {
  const n = Math.min(Number(limit) || 50, INBOUND_CAP);
  return inbound.slice(-n);
}

// Update the last-post summary + write an audit line {who, incident, result}.
// NEVER stores the URL/host — only the non-secret result fields.
function recordPost(m = {}) {
  const ok = !!m.ok;
  lastPost = {
    ts: new Date().toISOString(),
    ok,
    connected: m.connected !== undefined ? !!m.connected : connected(),
    event: m.event || null,
    incidentId: m.incidentId || null,
    status: m.status != null ? m.status : null,
    error: ok ? null : (m.error || (m.connected === false ? 'not connected' : 'post failed')),
  };
  try {
    session.audit({
      who: m.who || session.currentOperator() || 'unknown',
      what: `teams post${m.event ? ` (${m.event})` : ''}`,
      device: m.incidentId ? undefined : undefined,
      result: ok ? `posted (HTTP ${m.status || '2xx'})` : `not sent — ${lastPost.error}`,
      detail: m.incidentId ? `incident ${m.incidentId}` : undefined,
    });
  } catch (e) { /* audit must never break a post */ }
}

// Scrub an error string — a transport error should never carry the URL. We keep
// only the code/message and strip anything URL-shaped as a final guard.
function scrubErr(err) {
  let s = session.scrub(String(err == null ? 'send failed' : err));
  s = s.replace(/https?:\/\/\S+/gi, '«url»');
  return s.slice(0, 200);
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
      // Teams answers "1" on success; drain so the socket frees.
      res.on('data', () => {});
      res.on('end', () => settle({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode }));
    });
    req.on('error', (err) => settle({ ok: false, error: err.code || err.message }));
    req.on('timeout', () => { req.destroy(); settle({ ok: false, error: 'timeout' }); });
    req.write(body);
    req.end();
  });
}

// Telemetry must never break a post — log to the server window only, host-free.
function logQuiet(line) {
  try { console.warn(`[teams] ${line}`); } catch (e) { /* never throw from telemetry */ }
}

module.exports = {
  connected, status, post, postMessage, buildCard, onBridgeEvent,
  injectInbound, inboundReplies,
};
