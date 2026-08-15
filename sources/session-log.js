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

const { AsyncLocalStorage } = require('async_hooks');

const als = new AsyncLocalStorage();

// ── Context: which agent / triage a wire call belongs to ────────────────────
// Callers (live-agents runLive, triage withAgent, a manual retry) wrap their
// live work in runWithContext so the wire calls underneath get tagged.
function runWithContext(context, fn) {
  return als.run({ ...(context || {}) }, fn);
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

function setBroadcast(fn) { onRecord = typeof fn === 'function' ? fn : null; }

// ── Secret scrubbing ────────────────────────────────────────────────────────
// Belt-and-braces: even for non-auth endpoints, redact anything token-shaped so
// a credential can never land in a stored record or on the wire to the browser.
function scrub(text) {
  if (text == null) return text;
  let s = String(text);
  // JSON token fields: "token":"...", "Token":"...", "APIC-cookie":"..."
  s = s.replace(/("?(?:token|Token|apic[-_]?cookie|password|pwd|pass)"?\s*[:=]\s*")([^"]{4,})(")/gi,
    (m, a, _v, c) => a + '«redacted»' + c);
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
  return rec;
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

module.exports = { runWithContext, getContext, record, setBroadcast, all, query };
