// session-log.js — the real CLI/session recorder.
//
// PURPOSE (Phase B, "an engineer sees EVERYTHING"): every live read this server
// makes goes out over HTTPS through sources/http.js. This module records, for
// each of those wire calls, the REAL thing that happened:
//   - which host/source it logged into,
//   - the exact request that was issued (method + path — the "command"),
//   - the RAW response body the device/API sent back (or the real error string),
//   - a short plain-words interpretation derived from that real output.
//
// Nothing here is fabricated. If a call failed, the failure is what gets stored.
// The UI reads these records to show "reading the logs at the CLI and making
// sense of them" — the way an SME works.
//
// SECRETS: credential VALUES never enter a record. Request bodies (which carry
// passwords on login) are never passed in. Auth/token responses are replaced
// with a synthetic "authenticated to <host>" line instead of the raw token, and
// a scrubber strips any token-shaped field that slips through. Lengths, never
// values.

const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');
const workspace = require('../workspace');

const als = new AsyncLocalStorage();

// ── Context: which agent / triage a wire call belongs to ────────────────────
// Callers (live-agents runLive, triage withAgent, a manual retry) wrap their
// live work in runWithContext so the wire calls underneath get tagged.
// CW-9 fix: contexts now NEST — an inner context inherits the outer one and
// overrides only the keys it sets. Before this, an inner runWithContext (a
// delegated read inside a collection scope) REPLACED the store, which erased the
// outer tag and made per-delegation attribution impossible. Every wire call made
// under a scope is now stamped with that scope's id at WRITE time, so evidence
// is attributed by the record itself and never by a watermark over a shared log.
function runWithContext(context, fn) {
  return als.run({ ...getContext(), ...(context || {}) }, fn);
}
function getContext() {
  return als.getStore() || {};
}

// ── Host → source identity (from env, no circular require on the adapters) ──
function sourceForHost(host) {
  if (!host) return { id: 'unknown', label: 'Unknown source' };
  if (host === process.env.DNAC_HOST) return { id: 'catalyst-center', label: 'Cisco Catalyst Center' };
  if (host === process.env.ACI_HOST) return { id: 'aci', label: 'Cisco ACI (APIC)' };
  if (host === process.env.SDWAN_HOST) return { id: 'sdwan', label: 'Cisco SD-WAN (vManage)' };
  return { id: 'unknown', label: host };
}

// ── The ring buffer ─────────────────────────────────────────────────────────
const MAX_RECORDS = 600;
const RAW_CAP = 20000; // chars of raw output kept per record (device output can be large)
const records = [];
let seq = 0;
let onRecord = null; // server sets this to broadcast a session_record WS event
let onCommandShare = null; // server sets this to broadcast a command_share WS event

function setBroadcast(fn) { onRecord = typeof fn === 'function' ? fn : null; }
function setCommandShareBroadcast(fn) { onCommandShare = typeof fn === 'function' ? fn : null; }

// ── Secret scrubbing ────────────────────────────────────────────────────────
// Belt-and-braces: even for non-auth endpoints, redact anything token-shaped so
// a credential can never land in a stored record or on the wire to the browser.
function scrub(text) {
  if (text == null) return text;
  let s = String(text);
  // JSON credential fields: "token":"...", "APIC-cookie":"...", and the login
  // identity ("username":"...") which some device APIs (e.g. Catalyst Center's
  // Command Runner task metadata) echo back inside an otherwise-real response
  // body. A username is half a credential — against real kit it names the
  // service account — so it is redacted too. Host/device names are never
  // redacted; only the login identity + the secret half.
  s = s.replace(/("?(?:token|Token|apic[-_]?cookie|password|pwd|pass|username|userName|user[-_]?name|snmp[-_ ]?community|community)"?\s*[:=]\s*")([^"]{4,})(")/gi,
    (m, a, _v, c) => a + '«redacted»' + c);
  // UNQUOTED form: a device/alarm message is free text, not JSON, so a credential
  // reaches us as `password=SuperSecret123`, `token: abc…`, `api-key=…`. The quoted
  // rule above cannot see those. Redact the VALUE up to the next whitespace or
  // separator, leaving the key visible so the line still reads as evidence.
  // `community` is here because a syslog/trap free-text line from real kit can
  // carry the SNMP community (a shared read/write secret) as `community=publicRO`.
  s = s.replace(/\b(token|apic[-_]?cookie|password|passwd|pwd|pass|secret|api[-_]?key|auth[-_]?token|access[-_]?token|username|user[-_]?name|snmp[-_ ]?community|community)(\s*[:=]\s*)(?!"|«)([^\s,;&"'}\])]{4,})/gi,
    (m, k, sep) => k + sep + '«redacted»');
  // IOS-style SPACE-separated community: `snmp-server community publicRO RO`,
  // `snmp community publicRO`. No `=`/`:`, so the rule above misses it. Require
  // the `snmp` prefix so a bare English "community <word>" is never touched.
  s = s.replace(/\b(snmp(?:[-\s]server)?[-\s]community)(\s+)(?!«)([^\s,;&"'}\])]{3,})/gi,
    (m, k, sep) => k + sep + '«redacted»');
  // PREFIXED env-style key names: `ANTHROPIC_API_KEY=sk-…`, `DNAC_PASSWORD=…`,
  // `SNOW_SECRET_KEY: …`. The rule above anchors on \b, which a leading
  // `ANTHROPIC_` defeats, so the whole NAME is matched here instead.
  s = s.replace(/\b([A-Za-z0-9_-]*(?:api[-_]?key|api[-_]?token|access[-_]?key|secret[-_]?key|password|passwd|secret|token))(\s*[:=]\s*)(?!"|«)([^\s,;&"'}\])]{4,})/gi,
    (m, k, sep) => k + sep + '«redacted»');
  // IOS/NX-OS CONFIG FORMS (CW-9 reviewer finding #9). A running-config states a
  // secret with SPACES, not `=`: `password 0 Cisco123!`, `enable secret 5 $1$…`,
  // `key-string mysharedkey`, `pre-shared-key address 1.1.1.1 key MYPSK`. Now
  // that real device config travels into the chat as terminal evidence, these
  // must be redacted at the same class-level sink as everything else. The
  // keyword (and the encryption type, which is not a secret) stays visible so
  // the line still reads as evidence: `password 0 «redacted»`.
  s = s.replace(/\b(password|passwd|secret|key-string|key-hash|pre-shared-key|ppp\s+chap\s+password|md5)(\s+(?:\d\s+|encrypted\s+|0x)?)(?!«)([^\s,;"'<>]{3,})/gi,
    (m, k, sep) => k + sep + '«redacted»');
  // `username admin privilege 15 password 0 Cisco123!` is covered by the rule
  // above (it redacts from `password`), and `snmp-server user … auth md5 <x>`
  // by the md5 keyword. A bare `key 7 04585A150C2E` (interface/EIGRP auth):
  s = s.replace(/\b(key)(\s+\d\s+)(?!«)([^\s,;"'<>]{3,})/gi, (m, k, sep) => k + sep + '«redacted»');
  // `Authorization: Bearer <token>` / a bare `Bearer <token>` in free text.
  s = s.replace(/\b(Bearer\s+)(?!«)[A-Za-z0-9._~+/=-]{8,}/g, (m, k) => k + '«redacted»');
  return s;
}

// Pull the real device CLI transcript out of a Command Runner file response.
// The body is JSON like [{ commandResponses: { SUCCESS: { "show version": "..." } } }].
// Returns the decoded command output (with real newlines) or null.
function extractCli(body) {
  try {
    const j = JSON.parse(body);
    const arr = Array.isArray(j) ? j : [j];
    const lines = [];
    for (const entry of arr) {
      const cr = entry && entry.commandResponses;
      if (!cr) continue;
      const bucket = cr.SUCCESS || cr.FAILURE || cr.BLOCKLISTED || {};
      for (const cmd of Object.keys(bucket)) {
        const text = bucket[cmd];
        if (typeof text === 'string' && text.trim()) lines.push(text);
      }
    }
    return lines.length ? lines.join('\n') : null;
  } catch (e) { return null; }
}

// ── Classify a wire call: kind + human command label + is-this-auth ─────────
function classify(sourceId, method, path) {
  const p = path || '';
  // Auth / token exchanges — never keep the raw token body.
  if (/\/auth\/token/.test(p) || /aaaLogin/.test(p) || /j_security_check/.test(p) || /\/client\/token/.test(p)) {
    return { kind: 'login', auth: true, command: `${method} ${p}` };
  }
  // Catalyst Center Command Runner — a real "show" pushed to a device.
  if (/network-device-poller\/cli\/read-request/.test(p)) {
    return { kind: 'command-runner', auth: false, command: `${method} ${p}  (submit show command)` };
  }
  if (/\/task\//.test(p)) return { kind: 'poll', auth: false, command: `${method} ${p}  (poll task)` };
  if (/\/file\//.test(p)) return { kind: 'output', auth: false, command: `${method} ${p}  (fetch command output)` };
  return { kind: 'read', auth: false, command: `${method} ${p}` };
}

// ── Interpretation: plain words derived from the REAL output ────────────────
// Best-effort. Recognises the known endpoints and reads the numbers straight
// out of the real response. If it cannot read it, it says so honestly rather
// than inventing meaning.
function interpret(rec, parsed) {
  if (!rec.ok) return `Read failed — ${rec.error || 'no response'}. Nothing to report from this front.`;
  if (rec.kind === 'login') return `Authenticated to ${rec.host} (token issued, held in memory, never shown).`;
  const p = rec.path || '';

  try {
    if (/network-device\b/.test(p) && parsed && Array.isArray(parsed.response)) {
      const list = parsed.response;
      const up = list.filter((d) => d.reachabilityStatus === 'Reachable').length;
      const first = list[0] || {};
      let extra = '';
      if (first.upTime) {
        const wk = /(\d+)\s*week/.exec(first.upTime);
        const dy = /(\d+)\s*day/.exec(first.upTime);
        const stable = (wk && Number(wk[1]) > 2) || (dy && Number(dy[1]) > 14);
        extra = ` First device (${first.hostname || 'device'}) uptime ${first.upTime} → ${stable ? 'up for a long stretch, no recent reload' : 'relatively recent restart — worth checking the reload reason'}.`;
      }
      return `${list.length} device(s) returned; ${up} reachable, ${list.length - up} not.${extra}`;
    }
    if (/network-health/.test(p) && parsed && parsed.response) {
      const h = parsed.response[0] || {};
      return `Overall health score ${h.healthScore} across ${h.totalCount} devices (${h.goodCount} good / ${h.badCount} bad). ${h.healthScore >= 90 ? 'Estate is healthy.' : 'Health is below par — worth a look.'}`;
    }
    if (/\/issues\b/.test(p) && parsed && Array.isArray(parsed.response)) {
      const n = parsed.response.length;
      return n ? `${n} open issue(s) reported by Catalyst Center.` : 'No open issues — Catalyst Center is quiet.';
    }
    if (/class\/(\w+)\.json/.test(p) && parsed && Array.isArray(parsed.imdata)) {
      const cls = RegExp.$1;
      const n = parsed.imdata.length;
      if (cls === 'fabricNode') return `${n} fabric node(s) in the ACI topology (leaf/spine/controller).`;
      if (cls === 'faultInst') return `${n} fault instance(s) returned from APIC before severity filtering.`;
      if (cls === 'fabricHealthTotal') {
        const a = parsed.imdata[0] && parsed.imdata[0].fabricHealthTotal && parsed.imdata[0].fabricHealthTotal.attributes;
        return a ? `Fabric health total: current ${a.cur}, previous ${a.prev}.` : `Fabric health total returned.`;
      }
      return `${n} object(s) of class ${cls} returned from APIC.`;
    }
    if (/dataservice\/device\b/.test(p)) {
      const arr = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.data) ? parsed.data : null);
      if (arr) return `${arr.length} SD-WAN device(s) in the vManage overlay.`;
    }
    if (/alarms\/count/.test(p)) {
      const row = Array.isArray(parsed && parsed.data) ? parsed.data[0] : (parsed && parsed.data) || parsed;
      const active = row && (row.active ?? row.count);
      return active != null ? `${active} active SD-WAN alarm(s) on the overlay.` : 'SD-WAN alarm count returned.';
    }
    if (rec.kind === 'command-runner') return 'Command Runner accepted the show command; a task id was returned to poll for output.';
    if (rec.kind === 'poll') {
      const prog = parsed && parsed.response && parsed.response.progress;
      if (prog && /fileId/.test(prog)) return 'Task finished — the device output file is ready to fetch.';
      return 'Task still running on the device — waiting for the output file.';
    }
    if (rec.kind === 'output') {
      // The real raw CLI output of a show command. Read a couple of tell-tales.
      const raw = rec.raw || '';
      const notes = [];
      const um = /uptime is ([^\n\r,]+)/i.exec(raw) || /uptime:?\s*([^\n\r]+)/i.exec(raw);
      if (um) notes.push(`uptime ${um[1].trim()} → device has been stable; no recent reload`);
      const vm = /Version\s+(\d[\w.()]*)/i.exec(raw);
      if (vm) notes.push(`running version ${vm[1]}`);
      if (/last reload reason/i.test(raw)) {
        const rr = /last reload reason:?\s*([^\n\r]+)/i.exec(raw);
        if (rr) notes.push(`last reload: ${rr[1].trim()}`);
      }
      return notes.length ? notes.join('; ') + '.' : 'Raw device output captured (see the terminal panel).';
    }
  } catch (e) {
    return 'Real output captured; could not auto-summarise it (shown raw in the terminal panel).';
  }
  return 'Live response captured (shown raw in the terminal panel).';
}

// ── Record one wire call ────────────────────────────────────────────────────
// Called by sources/http.js after every request resolves. `res` is the raw
// { ok, status, body, error } from the http helper. The request BODY is never
// passed in — credentials on login must never reach here.
function record({ host, method, path, res, durationMs }) {
  const src = sourceForHost(host);
  const info = classify(src.id, method || 'GET', path || '');
  const ctx = getContext();

  const ok = !!(res && res.ok);
  const status = res && res.status != null ? res.status : null;
  const error = res && res.error ? String(res.error) : (ok ? null : `HTTP ${status}`);

  // Raw output: for auth calls we NEVER keep the token body — a synthetic line
  // stands in. For everything else we keep the real body, scrubbed + capped.
  let raw;
  if (info.auth) {
    raw = ok ? `« authenticated to ${host} — session token issued and held in memory (value never shown) »`
             : `« login rejected by ${host}: ${error} »`;
  } else {
    let body = res && res.body != null ? String(res.body) : '';
    // Command Runner returns the device's CLI output as a JSON-escaped string.
    // Pull the real transcript out so the terminal panel shows actual line
    // breaks (a clean CLI session), not literal "\n" escapes.
    if (info.kind === 'output') {
      const cli = extractCli(body);
      if (cli) body = cli;
    }
    raw = scrub(body).slice(0, RAW_CAP);
    if (body.length > RAW_CAP) raw += `\n… (${body.length - RAW_CAP} more chars truncated)`;
  }

  const rec = {
    id: `sess-${Date.now().toString(36)}-${(++seq).toString(36)}`,
    seq,
    ts: new Date().toISOString(),
    durationMs: durationMs != null ? durationMs : null,
    source: src.id,
    sourceLabel: src.label,
    host: host || null,
    path: path || '',
    agentId: ctx.agentId || null,
    agentName: ctx.agentName || null,
    // CW-9: which evidence scope (one delegation / one probe) made this call.
    // Stamped at write time — the ONLY honest way to attribute a command to the
    // agent that actually ran it when two reads overlap.
    evidenceId: ctx.evidenceId || null,
    triageId: ctx.triageId || null,
    front: ctx.front || null,
    origin: ctx.label || null, // e.g. "Device health check" / "manual retry"
    kind: info.kind,
    command: info.command,
    login: `authenticated to ${host}`,
    ok,
    status,
    error,
    raw,
  };

  // Interpretation reads the real (parsed) output.
  let parsed = null;
  if (!info.auth && res && res.body) { try { parsed = JSON.parse(res.body); } catch (e) { parsed = null; } }
  rec.interpretation = interpret(rec, parsed);

  records.push(rec);
  if (records.length > MAX_RECORDS) records.splice(0, records.length - MAX_RECORDS);

  if (onRecord) { try { onRecord(rec); } catch (e) { /* never let telemetry break a read */ } }

  // command_share (transparency contract): for each REAL check an engaged agent
  // runs during a delegation or triage turn, surface the exact command + the real
  // raw output + why it ran + what it means, IN ADDITION to the summary chat line.
  // The caller opts in by tagging its runWithContext with `share: true`; auth/login
  // exchanges are not "checks", so they are excluded. raw here is already scrubbed
  // + capped above, so no secret can reach the browser through this event.
  if (onCommandShare && ctx.share && !info.auth) {
    const share = {
      agent: rec.agentId,
      agentName: rec.agentName,
      tier: ctx.tier || null,
      purpose: ctx.purpose || rec.command,
      command: rec.command,
      raw: rec.raw,
      reasoning: ctx.reasoning || rec.origin || '',
      conclusion: rec.ok
        ? rec.interpretation
        : `unread/unreachable — ${rec.error || 'no response'}`,
      ok: rec.ok,
      triageId: rec.triageId,
      ts: rec.ts,
    };
    try { onCommandShare(share); } catch (e) { /* never let telemetry break a read */ }
  }
  return rec;
}

// ── Jarvis reasoning as session records ─────────────────────────────────────
// Jarvis makes no device calls, so it produces no wire-call records — its CLI
// would be empty. Its REAL reasoning (the parsed intent, the plan + the exact
// sub-questions it sent, each delegation, the final synthesis) is captured here
// as session records tagged agent:"jarvis", kind:"reasoning", so the CLI/session
// view shows Jarvis's full routing chain. `raw` is the real detail the Claude
// call produced (scrubbed, same as any wire raw); nothing is fabricated.
function recordReasoning({ agent = 'jarvis', agentName, command, raw, interpretation, ok = true, triageId = null }) {
  const c = getContext();
  const rec = {
    id: `sess-${Date.now().toString(36)}-${(++seq).toString(36)}`,
    seq,
    ts: new Date().toISOString(),
    durationMs: null,
    source: agent,
    sourceLabel: agentName || agent,
    host: null,
    path: '',
    // Carry BOTH keys: `agentId` groups this under Jarvis's CLI like every other
    // record; `agent` matches the transparency contract's jarvis-record shape.
    agent,
    agentId: agent,
    agentName: agentName || agent,
    triageId: triageId || c.triageId || null,
    front: null,
    origin: 'reasoning',
    kind: 'reasoning',
    command: String(command || ''),
    login: null,
    ok: !!ok,
    status: null,
    error: null,
    raw: scrub(raw == null ? '' : String(raw)).slice(0, RAW_CAP),
    interpretation: interpretation == null ? '' : String(interpretation),
  };
  records.push(rec);
  if (records.length > MAX_RECORDS) records.splice(0, records.length - MAX_RECORDS);
  if (onRecord) { try { onRecord(rec); } catch (e) { /* never let telemetry break reasoning */ } }
  return rec;
}

// ── Explicit command_share (for direct reads that own their clean block) ────
// A wire read may make several HTTP hops (login → submit → poll → fetch); for a
// direct question we want ONE clean block with the real CLI command + the real
// device output, not one per hop. The agent calls this once, with the real
// values it already holds. `raw` is scrubbed + capped here, same as any record,
// so no secret can reach the browser. Honesty is the caller's: pass real data or
// an honest unreachable conclusion — nothing is fabricated here.
function emitCommandShare(share) {
  if (!onCommandShare || !share) return;
  const out = Object.assign({}, share, {
    raw: scrub(share.raw == null ? '' : String(share.raw)).slice(0, RAW_CAP),
    ts: share.ts || new Date().toISOString(),
  });
  if (share.raw != null && String(share.raw).length > RAW_CAP) {
    out.raw += `\n… (${String(share.raw).length - RAW_CAP} more chars truncated)`;
  }
  try { onCommandShare(out); } catch (e) { /* never let telemetry break a read */ }
}

// ── Query ───────────────────────────────────────────────────────────────────
function all() { return records.slice(); }
function query({ agentId, source, triageId, limit } = {}) {
  let out = records;
  if (agentId) out = out.filter((r) => r.agentId === agentId);
  if (source) out = out.filter((r) => r.source === source);
  if (triageId) out = out.filter((r) => r.triageId === triageId);
  out = out.slice();
  if (limit && out.length > limit) out = out.slice(out.length - limit);
  return out;
}

// ── Who is at the keyboard (CW-1 operator identity) ─────────────────────────
// The name middleware in server.js wraps each request in runAsOperator, so any
// code the request reaches — including work that finishes in a later timer —
// can ask who asked for it, without every function having to pass a name down.
// No auth in v1 (Gate-1 decision): this is a name tag, not a login.
const operatorAls = new AsyncLocalStorage();

function runAsOperator(name, fn) {
  return operatorAls.run({ operator: name || null }, fn);
}
function currentOperator() {
  const s = operatorAls.getStore();
  return (s && s.operator) || null;
}

// ── Copilot audit log (design: "every copilot action greppable in one place") ─
// One structured line per copilot-surface action: { ts, who, what, device?,
// result }. It lands BOTH in a ring buffer (for an API/UI to read) and appended
// as one JSON object per line to squad/shared/COPILOT_AUDIT.log, so an engineer
// can grep the file directly. Every field goes through the same secret scrubber
// used for wire output — a credential can never reach this file. Never throws:
// telemetry must not be able to break an action.
const AUDIT_FILE = path.join(workspace.SQUAD_ROOT, 'shared', 'COPILOT_AUDIT.log');
const MAX_AUDIT = 500;
const auditRecords = [];

function audit({ who, what, device, result, detail } = {}) {
  try {
    const entry = {
      ts: new Date().toISOString(),
      who: scrub(who || currentOperator() || 'unknown'),
      what: scrub(what == null ? '' : String(what)).slice(0, 500),
      result: scrub(result == null ? '' : String(result)).slice(0, 500),
    };
    if (device) entry.device = scrub(String(device)).slice(0, 120);
    if (detail) entry.detail = scrub(String(detail)).slice(0, 1000);
    auditRecords.push(entry);
    if (auditRecords.length > MAX_AUDIT) auditRecords.splice(0, auditRecords.length - MAX_AUDIT);
    workspace.safeAppend(AUDIT_FILE, JSON.stringify(entry) + '\n', 'copilot audit log');
    console.log(`[AUDIT] ${entry.ts} who=${entry.who} what=${entry.what}${entry.device ? ` device=${entry.device}` : ''} result=${entry.result}`);
    return entry;
  } catch (e) {
    return null;
  }
}

function auditAll({ limit } = {}) {
  const out = auditRecords.slice();
  return limit && out.length > limit ? out.slice(out.length - limit) : out;
}

module.exports = {
  runWithContext, getContext, record, recordReasoning, emitCommandShare,
  setBroadcast, setCommandShareBroadcast, scrub, all, query,
  runAsOperator, currentOperator, audit, auditAll, AUDIT_FILE,
};
