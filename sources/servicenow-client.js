// servicenow-client.js — CW-6 real two-way ServiceNow sync (Table API).
//
// PURPOSE: create / update / read a real ServiceNow INCIDENT record via the
// Table API (/api/now/table/incident) using Basic auth, so an internal ticket
// (the SINGLE SOURCE OF TRUTH, sources/tickets.js) can be MIRRORED into
// ServiceNow when connected. The orchestration that decides WHAT to push/pull
// and how to fold the answer back into a ticket's `snow` slot lives in
// sources/tickets.js — this module is only the honest transport + field mapping.
//
// HONESTY — the whole point of this module (mirrors sources/teams.js CW-4):
//   • Config is env `SNOW_INSTANCE`, `SNOW_USER`, `SNOW_PASS`. If ANY is unset,
//     this is an HONEST no-op: connected() is false, every op returns
//     {ok:false, connected:false} and does NOTHING — never a fabricated INC
//     number / sys_id. We only ever return a real sys_id/number ServiceNow gave.
//   • On an HTTP error (401/403/timeout/5xx/non-JSON) we return an honest,
//     secret-scrubbed {ok:false, connected:true, status?, error} — never a fake
//     success and never a made-up incident.
//   • The credentials are SECRETS. The user/pass never leave this module: they
//     ride only in the Basic auth header on the wire, are NEVER logged, NEVER
//     returned by any function, NEVER persisted. status() exposes only a
//     `connected` boolean + a non-secret last-sync summary. Error strings are
//     scrubbed and URL-stripped as a final guard.
//   • The instance HOST is not a secret (it names where we sync), but it is a
//     private detail, so it is not returned by status() either — only the
//     boolean + last-sync summary leave this module.
//
// THE EXISTING STRUCTURED EXPORT STAYS: sources/artifacts.js still builds the
// copy-ready ServiceNow export as the FALLBACK for when this live sync is not
// connected. This module does not touch it.

const http = require('http');
const https = require('https');
const { URL } = require('url');
const session = require('./session-log');

const DEFAULT_TIMEOUT = 15000;
const TABLE_PATH = '/api/now/table/incident';

// The last SUCCESSFUL sync summary — for GET /api/copilot/servicenow/status.
// Carries only non-secret fields (ts, op, ticket, number, result). NEVER creds,
// NEVER the host. Null until a real sync has happened.
let lastSync = null;

// ── Config, read fresh each call so a late-set env is honoured without a restart ──
// Returns { base, user, pass } or null when ANY of the three is missing/blank.
// `base` is a normalised origin: SNOW_INSTANCE may be a bare host
// ("dev12345.service-now.com") — assumed HTTPS — or a full URL (used verbatim,
// which is how the deterministic test points the client at a local catcher).
function creds() {
  const rawInstance = process.env.SNOW_INSTANCE;
  const user = process.env.SNOW_USER;
  const pass = process.env.SNOW_PASS;
  if (!rawInstance || !String(rawInstance).trim()) return null;
  if (!user || !String(user).trim()) return null;
  if (!pass || !String(pass).trim()) return null;

  let instance = String(rawInstance).trim();
  if (!/^https?:\/\//i.test(instance)) instance = `https://${instance}`;
  let base;
  try {
    const u = new URL(instance);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    base = u;
  } catch (e) {
    return null; // a bad instance value is "not connected", never a throw
  }
  return { base, user: String(user), pass: String(pass) };
}

// Is a real ServiceNow instance + creds configured? The ONLY config fact any API
// may expose. Cheap and side-effect-free.
function connected() {
  return !!creds();
}

// Public status for GET /api/copilot/servicenow/status. connected boolean + the
// last-sync summary. NO host, NO creds — the secrets never leave this module.
function status() {
  return { connected: connected(), lastSync };
}

// ── Internal severity → ServiceNow impact/urgency (1-3) ─────────────────────
// ServiceNow impact/urgency are 1 (high) … 3 (low). Our queue is P1..P4.
function impactUrgency(severity) {
  switch (String(severity || '').toUpperCase()) {
    case 'P1': return { impact: '1', urgency: '1' };
    case 'P2': return { impact: '2', urgency: '2' };
    case 'P3': return { impact: '3', urgency: '2' };
    default:   return { impact: '3', urgency: '3' }; // P4 / unknown
  }
}

// ── Internal status → ServiceNow incident state code ────────────────────────
// SNOW incident states: 1 New, 2 In Progress, 6 Resolved, 7 Closed. We map our
// lifecycle onto them; the reverse map is used to mirror a pulled state back to
// plain words for the desk.
const STATE_TO_SNOW = {
  open: '1', assigned: '2', 'in-progress': '2', resolved: '6', closed: '7',
};
const SNOW_TO_LABEL = {
  '1': 'New', '2': 'In Progress', '3': 'On Hold', '6': 'Resolved',
  '7': 'Closed', '8': 'Canceled',
};
function snowStateLabel(code) {
  return SNOW_TO_LABEL[String(code)] || `state ${code}`;
}

// ── Build the incident body from an internal ticket ─────────────────────────
// Only real, ticket-provided fields; nothing invented. `includeState` lets a
// create omit the state (let SNOW default to New) while an update sets it.
function incidentBody(ticket, { note } = {}) {
  const iu = impactUrgency(ticket.severity);
  const body = {
    short_description: String(ticket.title || '').slice(0, 160),
    description: String(ticket.description || '') || String(ticket.title || ''),
    impact: iu.impact,
    urgency: iu.urgency,
    state: STATE_TO_SNOW[ticket.status] || '1',
    // A back-reference so a human in ServiceNow can find the source of truth.
    correlation_id: String(ticket.id || ''),
    correlation_display: 'noc-triage internal ticket (source of truth)',
  };
  if (note) body.work_notes = String(note).slice(0, 4000);
  return body;
}

// A human link to the incident in the ServiceNow UI (non-secret; the sys_id and
// number are not secrets). Built from the same base the creds resolved.
function incidentUrl(sysId) {
  const c = creds();
  if (!c || !sysId) return null;
  return `${c.base.origin}/nav_to.do?uri=incident.do?sys_id=${encodeURIComponent(sysId)}`;
}

// ── The three real Table API operations ─────────────────────────────────────
// Each returns { ok, connected, status?, incident?|error }. `incident` carries
// only the non-secret fields we read back: sys_id, number, state, sys_updated_on,
// and the parsed work_notes/comments journal when present.

// CREATE — POST the incident. Returns the real sys_id + number ServiceNow minted.
async function createIncident(ticket, { note } = {}) {
  const c = creds();
  if (!c) return notConnected();
  const body = JSON.stringify(incidentBody(ticket, { note }));
  const res = await send(c, 'POST', TABLE_PATH, body);
  return foldRecord(res);
}

// UPDATE — PATCH the incident by sys_id (state / work notes). Never creates.
async function updateIncident(sysId, ticket, { note } = {}) {
  const c = creds();
  if (!c) return notConnected();
  if (!sysId) return { ok: false, connected: true, error: 'no sys_id to update' };
  const body = JSON.stringify(incidentBody(ticket, { note }));
  const res = await send(c, 'PATCH', `${TABLE_PATH}/${encodeURIComponent(sysId)}`, body);
  return foldRecord(res);
}

// READ — GET the incident's current state + journal, to mirror it back.
async function readIncident(sysId) {
  const c = creds();
  if (!c) return notConnected();
  if (!sysId) return { ok: false, connected: true, error: 'no sys_id to read' };
  const q = '?sysparm_display_value=all&sysparm_fields=sys_id,number,state,sys_updated_on,work_notes,comments,short_description';
  const res = await send(c, 'GET', `${TABLE_PATH}/${encodeURIComponent(sysId)}${q}`);
  return foldRecord(res);
}

function notConnected() {
  return { ok: false, connected: false };
}

// Turn a raw transport result into the honest, non-secret record shape. On any
// failure the error is scrubbed + URL-stripped. On success we pull ONLY the
// non-secret fields out of ServiceNow's { result: {...} } envelope.
function foldRecord(res) {
  if (!res.ok) {
    return {
      ok: false,
      connected: true,
      status: res.status != null ? res.status : null,
      error: scrubErr(res.error || `status ${res.status}`),
    };
  }
  let json;
  try { json = JSON.parse(res.body || '{}'); } catch (e) {
    return { ok: false, connected: true, status: res.status || null, error: 'ServiceNow response was not JSON' };
  }
  const r = json.result || json;
  const incident = normalizeResult(Array.isArray(r) ? r[0] : r);
  if (!incident.sysId && !incident.number) {
    return { ok: false, connected: true, status: res.status || null, error: 'ServiceNow response carried no incident record' };
  }
  return { ok: true, connected: true, status: res.status || null, incident };
}

// Read the non-secret incident fields from a Table API result. Handles both the
// flat form and the display-value form (fields become { value, display_value }).
function normalizeResult(r) {
  if (!r || typeof r !== 'object') return {};
  const val = (f) => {
    const v = r[f];
    if (v && typeof v === 'object') return v.value != null ? v.value : (v.display_value != null ? v.display_value : '');
    return v != null ? v : '';
  };
  const disp = (f) => {
    const v = r[f];
    if (v && typeof v === 'object') return v.display_value != null ? v.display_value : (v.value != null ? v.value : '');
    return v != null ? v : '';
  };
  const stateCode = String(val('state') || '');
  return {
    sysId: String(val('sys_id') || ''),
    number: String(val('number') || ''),
    state: stateCode,
    stateLabel: stateCode ? snowStateLabel(stateCode) : '',
    updatedOn: String(val('sys_updated_on') || ''),
    shortDescription: String(disp('short_description') || ''),
    // The work-notes journal, when the field was requested with display values.
    worknotes: String(disp('work_notes') || ''),
    comments: String(disp('comments') || ''),
  };
}

// ── Secret scrubbing for errors ─────────────────────────────────────────────
// A transport error must never carry creds or a full URL. Run the shared
// scrubber, then strip anything URL-shaped and Basic-auth-shaped as a final net.
function scrubErr(err) {
  let s = session.scrub(String(err == null ? 'sync failed' : err));
  s = s.replace(/https?:\/\/\S+/gi, '«url»');
  s = s.replace(/Basic\s+[A-Za-z0-9+/=]+/gi, 'Basic «redacted»');
  return s.slice(0, 200);
}

// ── The last-sync summary writer (non-secret only) ──────────────────────────
// Called by the sync orchestration (tickets.js) after a real push/pull so
// status() can report it. NEVER creds, NEVER host.
function recordSync({ op, ticket, number, result } = {}) {
  lastSync = {
    ts: new Date().toISOString(),
    op: op || null,
    ticket: ticket || null,
    number: number || null,
    result: result || null,
  };
  return lastSync;
}

// ── Low-level HTTP(S). Never rejects — resolves { ok, status, body } or ─────
// { ok:false, error }. Supports http AND https so the deterministic test can
// point SNOW_INSTANCE at a local http catcher (mirrors sources/teams.js send()).
// The Basic auth header is built HERE and never leaves — it is not logged and
// the request/response are NOT routed through session-log (whose recorder would
// otherwise capture the instance host); this module owns all its own telemetry.
function send(c, method, pathAndQuery, body) {
  const u = c.base;
  const lib = u.protocol === 'https:' ? https : http;
  const auth = 'Basic ' + Buffer.from(`${c.user}:${c.pass}`).toString('base64');
  const headers = {
    'Authorization': auth,
    'Accept': 'application/json',
  };
  if (body) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = Buffer.byteLength(body);
  }
  const opts = {
    method,
    hostname: u.hostname,
    port: u.port || (u.protocol === 'https:' ? 443 : 80),
    path: (u.pathname === '/' ? '' : u.pathname.replace(/\/$/, '')) + pathAndQuery,
    headers,
    timeout: DEFAULT_TIMEOUT,
    // DevNet/self-signed tolerance is not needed for real ServiceNow (valid
    // certs); cert checking stays ON by default for https.
  };
  return new Promise((resolve) => {
    let settled = false;
    const settle = (r) => { if (!settled) { settled = true; resolve(r); } };
    const req = lib.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => settle({
        ok: res.statusCode >= 200 && res.statusCode < 300,
        status: res.statusCode,
        body: data,
      }));
    });
    req.on('error', (err) => settle({ ok: false, error: err.code || err.message }));
    req.on('timeout', () => { req.destroy(); settle({ ok: false, error: 'timeout' }); });
    if (body) req.write(body);
    req.end();
  });
}

module.exports = {
  connected, status, createIncident, updateIncident, readIncident,
  incidentUrl, recordSync, snowStateLabel,
  // exposed for tests / the sync layer
  _internals: { impactUrgency, incidentBody, STATE_TO_SNOW, normalizeResult, scrubErr },
};
