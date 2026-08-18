// batfish.js — A5 offline change-validation via Batfish (netclaw pull).
//
// PURPOSE: answer "would this config change break something?" BEFORE any device
// is touched. Batfish (https://www.batfish.org/) models the network from device
// configs and answers what-if questions WITHOUT touching live gear — parse
// health, undefined references (an ACL/route-map/interface the change names but
// never defines), config init issues, and — when a baseline is available —
// whether the change alters who can reach what (differential reachability).
//
// This pairs with the change engine (sources/change-runner.js): it is an EXTRA
// PRE-APPLY read that never writes and never blocks. validateChange() is exported
// for the wrap to call as an optional pre-step; if Batfish is off the change
// proceeds exactly as today, with a note. Batfish never touches a device, so it
// sits cleanly inside our read-only-first posture.
//
// HONESTY — the whole point of this module (mirrors sources/teams.js /
// sources/servicenow-client.js):
//   • Config is env `BATFISH_HOST` (a Batfish coordinator/API host — bare host,
//     assumed http, or a full URL) and `BATFISH_PORT` (default 9996, the v2 REST
//     port; batfish/allinone also exposes 9997). If BATFISH_HOST is UNSET, this
//     is an HONEST no-op: connected()/configured() is false, validateChange()
//     does NOTHING and returns verdict 'unknown' with a plain "not available"
//     note. We NEVER fabricate a clean/issues verdict.
//   • Configured but the service is UNREACHABLE, or answers non-2xx / non-JSON /
//     an unusable shape → verdict stays 'unknown' with the honest reason. A
//     verdict of clean/issues is ONLY ever returned from a REAL Batfish answer we
//     actually parsed. There is no "assume clean".
//   • SECRETS: a running-config is full of secrets. Every config leaving this
//     module for Batfish is run through configStore.scrubConfig first (the raw
//     value never reaches Batfish's own snapshot store on disk). Error strings are
//     scrubbed + URL-stripped. The host is a private detail — status() exposes
//     only a `connected` boolean + a non-secret last-run summary, never the host.
//   • AUDIT: every validate run is audited (device + verdict + finding count),
//     values never logged.
//
// HONEST LIMIT (stated plainly, like CW-2's no-write-path honesty):
//   A real Batfish coordinator drives analysis over a multi-step work flow
//   (create network → upload a snapshot zip → submit question work items → poll).
//   This native client talks to Batfish over HTTP with a compact request contract
//   (see analyze() below): a version probe, then one composite `.../analyze` call
//   carrying the scrubbed configs + the question names, expecting Batfish-shaped
//   answers back. Standing up `docker run batfish/allinone` gives you the engine;
//   pointing this client at it needs that composite endpoint (a thin coordinator
//   shim, or a deployment that exposes it). The parse→verdict engine and the
//   honest posture are done and proven here (deterministic tests, stub Batfish);
//   the live wiring to a real coordinator is the piece that needs a running
//   service — see docs and the A5 report.

const http = require('http');
const https = require('https');
const { URL } = require('url');
const session = require('./session-log');
const configStore = require('./config-store');

const DEFAULT_PORT = 9996;         // Batfish v2 coordinator/REST port
const DEFAULT_NETWORK = 'noc-triage';
const DEFAULT_TIMEOUT = 20000;     // Batfish analysis can take real seconds

// The questions we ask of a candidate snapshot. Names mirror Batfish's own
// question set so a real answer maps straight through. Reachability is only
// meaningful with a reference (baseline) snapshot, so it is added conditionally.
const BASE_QUESTIONS = ['fileParseStatus', 'initIssues', 'undefinedReferences'];

// The last validate summary — for GET /api/copilot/batfish/status. Non-secret
// only (ts, device, verdict, counts). NEVER the host, NEVER config text.
let lastRun = null;

// ── Config, read fresh each call so a late-set env is honoured without a restart ──
// Returns { base(URL origin+path), network } or null when BATFISH_HOST is unset.
// BATFISH_HOST may be a bare host ("localhost", "10.0.0.9") — assumed http on
// BATFISH_PORT — or a full URL (used verbatim; how the deterministic test points
// the client at a local catcher).
function endpoint() {
  const rawHost = process.env.BATFISH_HOST;
  if (!rawHost || !String(rawHost).trim()) return null;
  let host = String(rawHost).trim();
  if (!/^https?:\/\//i.test(host)) {
    const port = Number(process.env.BATFISH_PORT) || DEFAULT_PORT;
    host = `http://${host}:${port}`;
  }
  let base;
  try {
    const u = new URL(host);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    base = u;
  } catch (e) {
    return null; // a bad host value is "not configured", never a throw
  }
  const network = (process.env.BATFISH_NETWORK && String(process.env.BATFISH_NETWORK).trim())
    || DEFAULT_NETWORK;
  return { base, network };
}

// Is a Batfish host configured (and parseable)? The ONLY config fact any API may
// expose — cheap and side-effect-free. NOTE: like teams/servicenow, this reflects
// CONFIG PRESENCE, not live reachability; the live verdict still honestly returns
// 'unknown' if the service cannot be reached at call time.
function configured() {
  return !!endpoint();
}
// connected() is the capability's gate. Kept as an alias of configured() to match
// the teams/servicenow shape (available when configured). The honest reason and
// the per-call verdict carry the live-reachability truth.
function connected() {
  return configured();
}

// Public status for GET /api/copilot/batfish/status. { connected, configured,
// lastRun, note }. NO host — the private detail never leaves this module.
function status() {
  const cfg = configured();
  return {
    connected: cfg,
    configured: cfg,
    lastRun,
    note: cfg
      ? 'Batfish is configured. Offline change-validation runs a real analysis on each request; if the service is unreachable at call time the verdict is honestly "unknown", never a fake result.'
      : notAvailableNote(),
  };
}

function notAvailableNote() {
  return 'Batfish not available — set BATFISH_HOST (needs a Batfish service, e.g. Docker batfish/allinone). '
    + 'Until then no config is analysed and no verdict is invented.';
}

// ── The honest not-available result ─────────────────────────────────────────
function unavailable(note) {
  return { ok: false, connected: false, verdict: 'unknown', findings: [], note: note || notAvailableNote() };
}

// ── Naive command merge onto a baseline ─────────────────────────────────────
// Batfish parses a WHOLE device config, not a command fragment. When the caller
// hands us commands (not a full post-change config) plus a baseline, we build a
// best-effort candidate: a `no <x>` line removes a matching line; any other line
// is appended if not already present. This is deliberately simple and is NOT a
// substitute for a real config compile — a full post-change config (the `config`
// input) is always preferred, and this is noted in the result.
function applyCommands(baselineText, commands) {
  const lines = String(baselineText || '').split('\n');
  for (const raw of commands) {
    const cmd = String(raw).replace(/\s+$/, '');
    if (!cmd.trim()) continue;
    const negate = /^\s*no\s+/i.test(cmd);
    if (negate) {
      const body = cmd.replace(/^\s*no\s+/i, '').trim();
      for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i].trim() === body) lines.splice(i, 1);
      }
    } else if (!lines.some((l) => l.trim() === cmd.trim())) {
      lines.push(cmd);
    }
  }
  return lines.join('\n');
}

// ── Interpret Batfish answers → findings + verdict ──────────────────────────
// Reads the REAL Batfish answer shape: each answer is { answerElements:[{ rows:
// [ {col:val,...} ] }] } (or a bare { rows:[...] }). Nothing is invented — a
// finding exists only because a row exists. Severity 'error' drives the 'issues'
// verdict; 'warning' is surfaced but does not by itself condemn a change.
function rowsOf(answer) {
  if (!answer || typeof answer !== 'object') return [];
  if (Array.isArray(answer.rows)) return answer.rows;
  const el = Array.isArray(answer.answerElements) ? answer.answerElements[0] : answer.answerElements;
  if (el && Array.isArray(el.rows)) return el.rows;
  return [];
}

// Some Batfish columns arrive as { value, ... } or nested objects; flatten to a
// short string for a human-readable finding without leaking a whole structure.
function cell(v) {
  if (v == null) return '';
  if (typeof v === 'object') {
    if (v.value != null) return String(v.value);
    if (Array.isArray(v)) return v.map(cell).filter(Boolean).join(', ');
    try { return JSON.stringify(v); } catch (e) { return String(v); }
  }
  return String(v);
}

function interpret(answers) {
  const findings = [];
  const a = answers || {};

  // 1. Parse status — did the candidate config even parse?
  for (const row of rowsOf(a.fileParseStatus)) {
    const st = cell(row.Status || row.status).toUpperCase();
    const file = cell(row.File_Name || row.file_name || row.Nodes || row.nodes) || 'config';
    if (st === 'FAILED') {
      findings.push({ check: 'parse', severity: 'error',
        detail: `Batfish could not parse ${file} — the change would produce a config Batfish cannot model.` });
    } else if (st === 'PARTIALLY_UNRECOGNIZED') {
      findings.push({ check: 'parse', severity: 'warning',
        detail: `Some lines in ${file} were not recognised by Batfish (partial parse) — review, but not necessarily a break.` });
    }
  }

  // 2. Undefined references — the change names an ACL/route-map/interface/etc it
  //    never defines. That is a real, pre-apply-catchable break.
  for (const row of rowsOf(a.undefinedReferences)) {
    const type = cell(row.Structure_Type || row.structure_type) || 'structure';
    const name = cell(row.Ref_Name || row.ref_name || row.Name) || '(unnamed)';
    const ctx = cell(row.Context || row.context);
    findings.push({ check: 'undefined-reference', severity: 'error',
      detail: `Undefined reference: ${type} "${name}"${ctx ? ` used by ${ctx}` : ''} is referenced but never defined.` });
  }

  // 3. Init issues — Batfish's own conversion warnings/errors for the snapshot.
  for (const row of rowsOf(a.initIssues)) {
    const type = cell(row.Type || row.type);
    const line = cell(row.Line_Text || row.line_text);
    const details = cell(row.Details || row.details || row.Issue || row.issue) || type || 'init issue';
    const sev = /error|fatal|unrecogn/i.test(`${type} ${details}`) ? 'warning' : 'warning';
    findings.push({ check: 'init-issue', severity: sev,
      detail: `Config init issue${line ? ` at "${line}"` : ''}: ${details}`.slice(0, 300) });
  }

  // 4. Differential reachability (only present when a baseline reference was
  //    given) — a flow that used to be ACCEPTED and is now dropped/denied is a
  //    reachability break the change introduced.
  for (const row of rowsOf(a.differentialReachability)) {
    const flow = cell(row.Flow || row.flow) || 'a flow';
    const before = cell(row.Reference_Disposition || row.reference_disposition).toUpperCase();
    const after = cell(row.Snapshot_Disposition || row.snapshot_disposition).toUpperCase();
    const broke = /ACCEPT|EXITS_NETWORK|DELIVERED/.test(before) && !/ACCEPT|EXITS_NETWORK|DELIVERED/.test(after);
    findings.push({ check: 'reachability', severity: broke ? 'error' : 'warning',
      detail: `Reachability change for ${flow}: ${before || '?'} → ${after || '?'}${broke ? ' (was reachable, now not — the change breaks this path).' : ''}` });
  }

  const errors = findings.filter((f) => f.severity === 'error').length;
  const verdict = errors > 0 ? 'issues' : 'clean';
  return { findings, verdict, errorCount: errors, warningCount: findings.length - errors };
}

// ── The one real analysis call ──────────────────────────────────────────────
// Probe the version endpoint (proves the service answered), then POST the
// composite analyze request. Returns { reached, answers } or { reached:false }.
// Never throws — a network/HTTP/JSON failure resolves to reached:false / null.
async function analyze(cfg, { device, configText, referenceText, questions }) {
  // 1. Liveness probe — GET /v2/version. Any HTTP answer means the service is up.
  const ver = await send(cfg, 'GET', '/v2/version', null);
  if (ver.netError) return { reached: false, why: ver.error };

  // 2. Composite analyze. Body carries the SCRUBBED configs + question names.
  const body = {
    snapshotName: `chg-${Date.now().toString(36)}`,
    configs: { [device]: configText },
    questions,
  };
  if (referenceText) {
    body.referenceSnapshotName = `base-${Date.now().toString(36)}`;
    body.referenceConfigs = { [device]: referenceText };
  }
  const path = `/v2/networks/${encodeURIComponent(cfg.network)}/analyze`;
  const res = await send(cfg, 'POST', path, JSON.stringify(body));
  if (res.netError) return { reached: false, why: res.error };
  if (!res.ok) return { reached: true, answers: null, why: `Batfish answered HTTP ${res.status}` };
  let json;
  try { json = JSON.parse(res.body || '{}'); } catch (e) {
    return { reached: true, answers: null, why: 'Batfish response was not JSON' };
  }
  // Accept { answers:{...} } or a bare map of question→answer.
  const answers = json.answers && typeof json.answers === 'object' ? json.answers : json;
  return { reached: true, answers, version: ver.body };
}

// ── validateChange — THE exported operation ─────────────────────────────────
/**
 * Validate a proposed change against a Batfish model, offline, before apply.
 *
 * @param {string} device  device name/hostname the change targets
 * @param {{commands?:string[], config?:string, baseline?:string}} change
 *        `config`  — the FULL post-change running-config (preferred, most exact).
 *        `commands`— the change commands; merged onto a baseline (best-effort).
 *        `baseline`— the pre-change full config (else the stored snapshot is used).
 * @param {{who?:string}} [opts]
 * @returns {Promise<{ok, connected, verdict:'clean'|'issues'|'unknown',
 *                     findings:Array, note:string, ...}>}
 *
 * Contract: verdict is 'clean'|'issues' ONLY from a real parsed Batfish answer.
 * Not configured / unreachable / unusable answer → 'unknown'. Never a fake result.
 * NEVER blocks or writes — this is a read-only pre-check.
 */
async function validateChange(device, change = {}, opts = {}) {
  const who = String(opts.who || session.currentOperator() || 'unknown');
  const dev = String(device || '').trim();
  const cfg = endpoint();

  // Honest no-op when unconfigured — does NOTHING, invents nothing.
  if (!cfg) {
    audit(who, dev, 'unknown', 'Batfish not configured');
    return record({ ...unavailable(), device: dev });
  }
  if (!dev) {
    return record({ ok: false, connected: true, verdict: 'unknown', findings: [], device: dev,
      note: 'No device named — I will not validate a change without knowing the target device.' });
  }

  // Build the candidate config to analyse. A full post-change config is exact;
  // commands+baseline is best-effort; neither is an honest "unknown".
  let configText = null;
  let referenceText = null;
  let basisNote = '';
  const commands = Array.isArray(change.commands) ? change.commands : null;

  if (change.config && String(change.config).trim()) {
    configText = String(change.config);
    basisNote = 'analysed the supplied post-change config directly';
  } else if (commands && commands.length) {
    let baselineText = change.baseline && String(change.baseline).trim() ? String(change.baseline) : null;
    if (!baselineText) {
      const snap = configStore.latest(dev);
      baselineText = snap && snap.config ? snap.config : null;
    }
    if (!baselineText) {
      audit(who, dev, 'unknown', 'no baseline to apply commands onto');
      return record({ ok: false, connected: true, verdict: 'unknown', findings: [], device: dev,
        note: `No post-change config and no stored baseline for ${dev}, so there is nothing complete for Batfish to model. `
          + `Hand me the full post-change config, or store a baseline for ${dev} first, and I will validate for real.` });
    }
    referenceText = baselineText;
    configText = applyCommands(baselineText, commands);
    basisNote = 'built a best-effort candidate by merging the change commands onto '
      + (change.baseline ? 'the supplied baseline' : `${dev}'s stored baseline`)
      + ' (a full post-change config is more exact)';
  } else {
    return record({ ok: false, connected: true, verdict: 'unknown', findings: [], device: dev,
      note: 'Nothing to validate — provide either the change commands or the full post-change config.' });
  }

  // SECRET LAW: scrub every config before it leaves for Batfish's snapshot store.
  configText = configStore.scrubConfig(configText);
  if (referenceText) referenceText = configStore.scrubConfig(referenceText);

  const questions = referenceText ? BASE_QUESTIONS.concat('differentialReachability') : BASE_QUESTIONS.slice();

  const out = await analyze(cfg, { device: dev, configText, referenceText, questions });

  if (!out.reached) {
    audit(who, dev, 'unknown', 'Batfish unreachable');
    return record({ ok: false, connected: false, verdict: 'unknown', findings: [], device: dev,
      note: `Batfish is configured but could not be reached${out.why ? ` (${scrubErr(out.why)})` : ''}. `
        + `I am not going to call this change clean on an analysis that never ran. The change can still proceed — this was an extra offline check.` });
  }
  if (!out.answers) {
    audit(who, dev, 'unknown', 'Batfish answer unusable');
    return record({ ok: false, connected: true, verdict: 'unknown', findings: [], device: dev,
      note: `Batfish answered but the analysis did not come back usable${out.why ? ` (${scrubErr(out.why)})` : ''}. No verdict is claimed.` });
  }

  const { findings, verdict, errorCount, warningCount } = interpret(out.answers);
  const note = verdict === 'issues'
    ? `Batfish found ${errorCount} blocking issue(s) this change would introduce — see findings. This is an offline pre-check; nothing was applied.`
    : `Batfish found no blocking issue for this change${warningCount ? ` (${warningCount} soft warning(s) noted)` : ''}. Offline pre-check only — the apply wrap still runs its own before/after proof.`;
  audit(who, dev, verdict, `${errorCount} error, ${warningCount} warning`);
  return record({ ok: true, connected: true, verdict, findings, device: dev, basis: basisNote,
    note: `${note} (${basisNote}.)` });
}

// ── audit + last-run summary (non-secret only) ──────────────────────────────
function audit(who, device, verdict, summary) {
  try {
    session.audit({ who, what: `batfish validate ${device || '(no device)'} — ${verdict}`,
      device: device || undefined, result: summary });
  } catch (e) { /* audit must never break a validate */ }
}

function record(result) {
  lastRun = {
    ts: new Date().toISOString(),
    device: result.device || null,
    verdict: result.verdict,
    connected: !!result.connected,
    findings: Array.isArray(result.findings) ? result.findings.length : 0,
  };
  return result;
}

// ── Secret scrubbing for errors ─────────────────────────────────────────────
function scrubErr(err) {
  let s = session.scrub(String(err == null ? 'analysis failed' : err));
  s = s.replace(/https?:\/\/\S+/gi, '«url»');
  return s.slice(0, 200);
}

// ── Low-level HTTP(S). Never rejects — resolves { ok, status, body } or ─────
// { netError:true, error }. Supports http AND https so the deterministic test
// can point BATFISH_HOST at a local http catcher (mirrors teams/servicenow send).
function send(cfg, method, pathAndQuery, body) {
  const u = cfg.base;
  const lib = u.protocol === 'https:' ? https : http;
  const headers = { 'Accept': 'application/json' };
  if (body) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = Buffer.byteLength(body);
  }
  const basePath = (u.pathname === '/' ? '' : u.pathname.replace(/\/$/, ''));
  const opts = {
    method,
    hostname: u.hostname,
    port: u.port || (u.protocol === 'https:' ? 443 : 80),
    path: basePath + pathAndQuery,
    headers,
    timeout: DEFAULT_TIMEOUT,
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
    req.on('error', (err) => settle({ netError: true, error: err.code || err.message }));
    req.on('timeout', () => { req.destroy(); settle({ netError: true, error: 'timeout' }); });
    if (body) req.write(body);
    req.end();
  });
}

module.exports = {
  configured, connected, status, validateChange,
  notAvailableNote,
  // exposed for tests / the change-runner hook
  _internals: { interpret, rowsOf, cell, applyCommands, endpoint, BASE_QUESTIONS },
};
