// mcp-connector.js — the registry + safety layer that turns configured MCP
// servers into gated, audited, read-only-by-default delegation targets for Jarvis.
//
// This module is to mcp-client.js what live-agents.js is to catalyst-center.js:
// the client speaks the wire protocol; THIS decides who is configured, connects
// them, exposes their tools to the planner, and — the important part — makes sure
// EVERY tool call goes through the SAME permission gate a device read does, honours
// a READ-ONLY posture (only server-declared-safe tools auto-run; anything that
// looks like a write is refused unless explicitly approved), audits every call by
// tool + arg KEYS (never values), and NEVER fabricates a tool result.
//
// HONEST-IF-ABSENT: no servers configured → configured()=false, no roster entries,
// the capability is OFF, and nothing is invented. A server that will not connect →
// it is reported unavailable with a clear reason, and it contributes NO tools —
// never a fake one.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { McpClient } = require('./mcp-client');
const approvals = require('./approvals');
const session = require('./session-log');

const NS = 'mcp'; // namespace prefix: mcp:<server>:<tool>

// ── CW-13: adopting a real external server (NetClaw) ────────────────────────
// Three small, honest config affordances, all optional, all secret-safe:
//
//   "${VAR}" in command / args / cwd is expanded from the SERVER's environment
//   (.env.local), so one committed example config works on every machine.
//
//   envFrom: { CHILD_VAR: "PARENT_VAR" } hands the child a value from the
//   server's own environment WITHOUT the value ever being written in the config
//   file — e.g. NetClaw's CATALYST_CENTER_PASSWORD from our DNAC_PASS. A parent
//   var that is unset is simply not passed (and reported by NAME in status), so
//   the child says "not configured" honestly instead of inheriting a blank.
//
//   vettedReadOnly: { by, date, why, toolNames, sha256?, file? } — the
//   OPERATOR's record that this server is read-only by construction (NetClaw's
//   catc-mcp catalogues GET operations only), for servers that declare no MCP
//   annotations. With it, a LISTED tool that carries NO annotations is
//   auto-callable as a read; a tool that DECLARES itself a write (or carries
//   any annotation that is not a clean readOnlyHint:true) is STILL a write —
//   the server's own word always wins over the operator's vetting. The record
//   is honoured only when it names who, why and WHICH tools (a blank
//   `vettedReadOnly: true` does nothing), and — when it carries a sha256 of the
//   server file — only while that file still matches: a vetted record cannot
//   silently bless code that changed under it (review CW-13 #3). Drift or an
//   unlisted tool → write, and status says so by name.
//
//   ENV BOUNDARY (review CW-13 #1): the child sees ONLY an allowlisted base
//   (PATH, HOME, TEMP, locale, Python/venv vars …) + literal `env` + `envFrom`.
//   Never the parent's whole environment — a third-party program must not be
//   able to read ANTHROPIC_API_KEY or another integration's credentials just
//   because it was spawned by us.
const CHILD_ENV_BASE = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TEMP', 'TMP',
  'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TERM',
  'USERPROFILE', 'SYSTEMROOT', 'SystemRoot', 'COMSPEC', 'ComSpec', 'PATHEXT', 'WINDIR', 'SystemDrive',
  'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'ProgramData', 'ProgramFiles', 'PROGRAMFILES',
  'PYTHONPATH', 'PYTHONHOME', 'PYTHONIOENCODING', 'PYTHONUTF8', 'PYTHONUNBUFFERED', 'VIRTUAL_ENV',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
  'SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE', 'NODE_EXTRA_CA_CERTS', 'CURL_CA_BUNDLE',
];
const SECRETISH_NAME = /(pass|secret|token|key|auth|cred|pwd|webhook|hook|private|cert|sas|sig|otp|dsn)/i;

function expandVars(v) {
  if (typeof v !== 'string') return v;
  return v.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, k) => (process.env[k] !== undefined ? process.env[k] : m));
}
function vettingOf(rec) {
  const v = rec && rec.config && rec.config.vettedReadOnly;
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const by = String(v.by || '').trim();
  const why = String(v.why || '').trim();
  const toolNames = Array.isArray(v.toolNames) ? v.toolNames.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim().slice(0, 120)) : [];
  if (!by || !why || !toolNames.length) return null;
  // A record that pins a file hash is only valid while the file matches
  // (and a malformed pin is drift, not "unpinned" — review round 2 #4).
  if (rec.vettingDrift) return null;
  return {
    by: by.slice(0, 120), why: why.slice(0, 400), date: String(v.date || '').trim().slice(0, 40) || null,
    toolNames, sha256: (typeof v.sha256 === 'string' && /^[0-9a-f]{64}$/i.test(v.sha256)) ? v.sha256.toLowerCase() : null,
  };
}
// The bytes we hash: LF-normalised. Git for Windows' default core.autocrlf
// rewrites a checkout's line endings, which would void a byte-exact pin on the
// very machine this is for (review round 2 #2). The record therefore pins the
// LF form; CRLF ↔ LF drift is not code drift.
function pinHash(buf) {
  return crypto.createHash('sha256').update(Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n'), 'utf8')).digest('hex');
}
// Which file the pin protects: args[0] when it is a regular file (the server
// entry point), else the explicit `file`. `file` may ADD context but never
// replaces a real args[0] — a decoy target cannot leave the entry point
// unhashed (review round 2 #5).
function pinTarget(rec) {
  const v = rec.config && rec.config.vettedReadOnly;
  // The FIRST args entry that is a regular file (so `python -u server.py`
  // still pins server.py — review round 3 #2).
  const args = Array.isArray(rec.config.args) ? rec.config.args.map((a) => expandVars(String(a))) : [];
  let entry = '';
  for (const a of args) { try { if (a && fs.statSync(a).isFile()) { entry = a; break; } } catch (e) { /* not a file */ } }
  if (entry) return { file: entry, note: (v && v.file && expandVars(v.file) !== entry) ? `vettedReadOnly.file ignored — the entry point ${path.basename(entry)} is what is pinned` : null };
  return { file: expandVars((v && v.file) || ''), note: null };
}
// Verify the record's file hash against the server file on disk (before every
// connect). Sets rec.vettingDrift (an honest sentence) on mismatch / unreadable.
function checkVettingPin(rec) {
  rec.vettingDrift = null;
  rec.pinNote = null;
  const v = rec.config && rec.config.vettedReadOnly;
  if (!v || typeof v !== 'object') return;
  if (v.sha256 === undefined || v.sha256 === null || v.sha256 === '') return;   // unpinned (allowed, shown as pinned:false)
  const want = (typeof v.sha256 === 'string' && /^[0-9a-f]{64}$/i.test(v.sha256)) ? v.sha256.toLowerCase() : null;
  if (!want) { rec.vettingDrift = 'vettedReadOnly.sha256 is malformed (expected 64 hex characters) — the record is not honoured until it is fixed'; return; }
  const t = pinTarget(rec);
  rec.pinNote = t.note;
  if (!t.file) { rec.vettingDrift = 'vettedReadOnly.sha256 is set but there is no file to check (args[0] is not a file and vettedReadOnly.file is unset)'; return; }
  try {
    const got = pinHash(fs.readFileSync(t.file));
    if (got !== want) rec.vettingDrift = `vetting record does not match ${path.basename(t.file)} (sha256 of the LF-normalised file ${got.slice(0, 12)}… ≠ vetted ${want.slice(0, 12)}…) — the vetted code changed (line endings alone cannot cause this); every tool is treated as a write until re-vetted`;
  } catch (e) {
    rec.vettingDrift = `vetted file could not be read (${path.basename(t.file)}): ${e.code || e.message}`;
  }
}
// Build the child's env: an allowlisted BASE from the parent + literal `env`
// (expanded) + `envFrom` (values from the parent process, never from the file).
// Returns { env, missing:[childNames], injected:[values] }.
function childEnv(config) {
  const env = {};
  for (const k of CHILD_ENV_BASE) if (process.env[k] !== undefined) env[k] = process.env[k];
  // `injected` feeds the redactor — ONLY values that are secrets:
  //   • an envFrom entry whose CHILD or PARENT name is secret-shaped (PASSWORD,
  //     TOKEN, KEY, …) or that opts in with the object form
  //     { from: "PARENT", secret: true }. A HOST or USERNAME mapped by name is
  //     NOT redacted: the appliance identity and the account are evidence the
  //     operator needs to see (review round 2 #1 — redacting them wiped the
  //     appliance stamp out of every result and corrupted "adminStatus").
  //   • a literal `env` value that CHANGED under ${VAR} expansion — it came from
  //     the parent's environment, so it may be a credential (round 2 #3).
  //   Plain literal values are operator-written non-secrets by contract.
  const injected = [];
  const warnings = [];
  const lit = (config && config.env && typeof config.env === 'object') ? config.env : {};
  for (const k of Object.keys(lit)) {
    const raw = String(lit[k]);
    env[k] = expandVars(raw);
    if (env[k] !== raw) injected.push(env[k]);
  }
  const missing = [];
  const from = (config && config.envFrom && typeof config.envFrom === 'object') ? config.envFrom : {};
  for (const child of Object.keys(from)) {
    const spec = from[child];
    const parent = (spec && typeof spec === 'object') ? String(spec.from || '') : String(spec || '');
    const optIn = !!(spec && typeof spec === 'object' && spec.secret === true);
    // `secret: "true"` (a string) is NOT an opt-in and must not pass silently
    // (review round 3 #3): it is treated as a secret anyway AND reported.
    const badOptIn = !!(spec && typeof spec === 'object' && spec.secret !== undefined && typeof spec.secret !== 'boolean');
    if (badOptIn) warnings.push(`envFrom.${child}.secret must be true/false (got ${JSON.stringify(spec.secret)}) — treated as secret`);
    const val = parent ? process.env[parent] : undefined;
    if (val !== undefined && String(val).trim() !== '') {
      env[child] = String(val);
      if (optIn || badOptIn || SECRETISH_NAME.test(child) || SECRETISH_NAME.test(parent)) injected.push(env[child]);
    } else missing.push(child);
  }
  // proxy URLs in the allowlisted base may carry user:pass@ — those are secrets too
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) {
    const m = /\/\/([^/@\s]+@)/.exec(String(env[k] || ''));
    if (m) injected.push(m[1].slice(0, -1));
  }
  return { env, missing, injected, warnings };
}
// The redactor for anything a child says that can reach an error / status /
// chat: every value we injected, plus every secret-shaped parent value. Longer
// values first so a value that contains another is wiped whole.
function makeRedactor(injected) {
  const vals = new Set();
  for (const v of injected || []) if (v && String(v).length >= 4) vals.add(String(v));
  for (const [k, v] of Object.entries(process.env)) if (SECRETISH_NAME.test(k) && v && v.length >= 8) vals.add(v);
  // Escaped forms too (round 3 #1): a JSON-encoded or \uXXXX-escaped copy of
  // the secret (a JSON body, a Python repr/json.dumps in a traceback) is the
  // same secret. Both variants are added when they differ from the raw value.
  for (const v of [...vals]) {
    const js = JSON.stringify(v).slice(1, -1);
    if (js !== v) vals.add(js);
    const uesc = v.replace(/[^\x20-\x7e]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
    if (uesc !== v) { vals.add(uesc); const both = JSON.stringify(uesc).slice(1, -1); if (both !== uesc) vals.add(both); }
  }
  const list = [...vals].filter((v) => v.length >= 4).sort((a, b) => b.length - a.length);
  // Boundary-aware: a secret is replaced only where it stands as its own token
  // (after = : " ' space, before a newline / quote / space …), never inside a
  // longer identifier — a password "admin" must not turn "adminStatus" into
  // "[redacted]Status" and silently alter evidence (review round 2 #1).
  const res = list.map((v) => new RegExp(`(?<![A-Za-z0-9_])${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_])`, 'g'));
  return (text) => {
    let t = String(text == null ? '' : text);
    for (const re of res) t = t.replace(re, '[redacted]');
    return t;
  };
}
// Scrub FIRST (the scrubber may already have replaced a KEY=value pair), then
// redact what is left — so the marker never gets mangled into "«redacted»]".
function scrubThenRedact(rec, text) {
  const s = session.scrub(String(text == null ? '' : text));
  return rec && typeof rec.redact === 'function' ? rec.redact(s) : s;
}

// One connection record per configured server.
//   { name, transport, enabled, client, connected, tools:[...], reason, config }
const servers = new Map();
let loaded = false;

// ── Config ───────────────────────────────────────────────────────────────────
// Servers are declared in config, each: { name, transport:'stdio'|'http',
// command/args or url, enabled, env? }. Two sources, in order:
//   1. env MCP_SERVERS — a JSON array string (handy for tests + one-offs).
//   2. a JSON file — env MCP_SERVERS_FILE, else ./config/mcp-servers.json if it
//      exists. NONE of these present → zero servers → capability OFF.
// A malformed config is reported honestly (a server with a reason), never guessed.
function loadConfig() {
  const out = [];
  const raw = process.env.MCP_SERVERS;
  if (raw && String(raw).trim()) {
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) out.push(...arr);
    } catch (e) {
      out.push({ name: 'mcp (from MCP_SERVERS env)', __configError: `MCP_SERVERS is not valid JSON: ${e.message}` });
    }
  }
  const file = process.env.MCP_SERVERS_FILE || path.join(__dirname, '..', 'config', 'mcp-servers.json');
  try {
    if (fs.existsSync(file)) {
      const arr = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(arr)) out.push(...arr);
    }
  } catch (e) {
    out.push({ name: `mcp (from ${path.basename(file)})`, __configError: `config file is not valid JSON: ${e.message}` });
  }
  return out;
}

// Is ANY MCP server declared at all (enabled or not)? Drives configured() on the
// status route — "configured" means "the operator has declared MCP servers", not
// "they all connected".
function configured() {
  ensureLoaded();
  return servers.size > 0;
}

function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  for (const c of loadConfig()) {
    const name = (c && c.name) ? String(c.name) : `server-${servers.size + 1}`;
    servers.set(name, {
      name,
      transport: (c && c.transport) || 'stdio',
      enabled: c && c.enabled !== false, // default enabled unless explicitly false
      client: null,
      connected: false,
      tools: [],
      reason: c && c.__configError ? c.__configError : null,
      config: c || {},
    });
  }
}

// ── Connect every enabled server + list its tools ───────────────────────────
// Called once at startup (server.js) and by the reconnect route. Honest per
// server: one that fails leaves the others working and records its own reason.
async function connectAll() {
  ensureLoaded();
  const results = [];
  for (const rec of servers.values()) {
    results.push(await connectOne(rec));
  }
  return results;
}

async function connectOne(rec) {
  // A config error found at load time is honoured as-is — nothing to connect.
  if (rec.reason && !rec.config.command && !rec.config.url) {
    rec.connected = false; rec.tools = [];
    return snapshot(rec);
  }
  if (!rec.enabled) {
    rec.connected = false; rec.tools = []; rec.reason = 'disabled in config (enabled:false)';
    return snapshot(rec);
  }
  if (rec.transport !== 'stdio') {
    // http/SSE transport is not built in CW-8. Say so honestly — never a fake tool.
    rec.connected = false; rec.tools = [];
    rec.reason = `transport "${rec.transport}" is declared but not supported yet (CW-8 ships stdio only)`;
    return snapshot(rec);
  }
  // Tear down any previous client before reconnecting.
  if (rec.client) { try { rec.client.close(); } catch (e) { /* ignore */ } rec.client = null; }
  const ce = childEnv(rec.config);
  rec.envMissing = ce.missing;            // names only — never values
  rec.configWarnings = ce.warnings;       // shapes only — never values
  rec.redact = makeRedactor(ce.injected);
  checkVettingPin(rec);
  const redactForClient = (t) => scrubThenRedact(rec, t);
  const client = new McpClient({
    name: rec.name,
    transport: 'stdio',
    command: expandVars(rec.config.command),
    args: (rec.config.args || []).map(expandVars),
    env: ce.env,
    inheritEnv: false,                    // the boundary: only what childEnv built
    redact: redactForClient,
    cwd: expandVars(rec.config.cwd) || null,
    timeoutMs: rec.config.timeoutMs || undefined,
    maxBufferBytes: rec.config.maxBufferBytes || undefined,
  });
  try {
    await client.connect();
    const tools = await client.listTools();
    rec.client = client;
    rec.connected = true;
    rec.tools = tools;
    rec.reason = null;
  } catch (err) {
    try { client.close(); } catch (e) { /* ignore */ }
    rec.client = null;
    rec.connected = false;
    rec.tools = [];
    rec.reason = scrubThenRedact(rec, err && err.message ? err.message : String(err)).slice(0, 600);
  }
  return snapshot(rec);
}

// ── Read-only posture ────────────────────────────────────────────────────────
// The whole safety point of CW-8. A tool is AUTO-callable only when the server
// declares it read-only (MCP annotations.readOnlyHint === true). Anything else —
// a declared write (readOnlyHint:false, or destructiveHint:true), OR an UNKNOWN
// danger (no annotations at all) — is treated like a device write: fail safe,
// refuse unless the caller explicitly approved it (approve-first, mirroring the
// change engine). Returns 'read' | 'write'.
function classifyTool(tool, rec) {
  const raw = tool && tool.annotations;
  // Anything that is not a plain object is "no annotations".
  const a = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : null;
  const declares = !!(a && ('readOnlyHint' in a || 'destructiveHint' in a));
  if (declares) {
    // The server's OWN declaration always wins, and only the CLEAN read shape
    // counts as a read: readOnlyHint === true with destructiveHint absent or
    // exactly false. 'true', 1, null, 0, 'false' … are malformed → write
    // (review CW-13 #4).
    const clean = a.readOnlyHint === true && (a.destructiveHint === undefined || a.destructiveHint === false);
    return clean ? 'read' : 'write';
  }
  // Silence: unknown danger → write (fail safe) — UNLESS the operator's vetting
  // record names THIS tool and the record still matches the code on disk.
  const v = rec && vettingOf(rec);
  if (v && tool && v.toolNames.includes(tool.name)) return 'read';
  return 'write';
}

function findTool(rec, toolName) {
  if (!rec || !Array.isArray(rec.tools)) return null;
  return rec.tools.find((t) => t.name === toolName) || null;
}

// ── The gated, audited tool call — the ONE path every MCP call goes through ──
// { server, tool, args?, who?, approved? }
//   approved:true  → the operator has approved a write tool (still goes through
//                    the permission gate); default false → a write tool is refused.
// Returns a structured result (never throws for an expected outcome):
//   { ok:true, text, isError, tool, server }        — the REAL stub/server result
//   { refused:true, kind:'write'|'no-tool'|'not-connected', reason }
//   { denied:true, reason }                          — the permission gate denied it
//   { ok:false, error }                              — the call ran but errored honestly
async function callTool({ server, tool, args, who, approved } = {}) {
  ensureLoaded();
  const argObj = (args && typeof args === 'object') ? args : {};
  const argKeys = Object.keys(argObj);
  const rec = servers.get(server);

  // 1. Server / tool must really exist and be connected — never a fake tool.
  if (!rec) {
    return refuse('no-tool', `No MCP server named "${server}" is configured.`, { server, tool, argKeys, who });
  }
  if (!rec.connected) {
    return refuse('not-connected', `MCP server "${server}" is not connected: ${rec.reason || 'unavailable'}.`, { server, tool, argKeys, who });
  }
  const toolDef = findTool(rec, tool);
  if (!toolDef) {
    return refuse('no-tool', `MCP server "${server}" does not advertise a tool named "${tool}".`, { server, tool, argKeys, who });
  }

  // 2. READ-ONLY posture. A write/unknown tool is refused unless explicitly
  //    approved. This is BEFORE the gate and before the wire — zero external call.
  const kind = classifyTool(toolDef, rec);
  if (kind === 'write' && !approved) {
    return refuse('write', `"${server}:${tool}" is not declared read-only, so it is treated as a write and was NOT auto-run. ` +
      `Approve it explicitly (approve-first, like a device change) to call it.`, { server, tool, argKeys, who });
  }

  // 3. THE PERMISSION GATE — the SAME gate a device read uses. deny → zero call.
  //    No `cli` is passed: the device read-only guardrail is for device CLI, not
  //    MCP tool names; the MCP read-only posture above is this path's own guard.
  const meta = {
    agentId: `${NS}:${server}`,
    agentName: `MCP · ${server}`,
    command: `MCP tools/call ${server}:${tool}`,
    target: `external MCP server "${server}" (${kind}-tool "${tool}")`,
    reason: `call MCP tool ${tool} with args [${argKeys.join(', ') || 'none'}]`,
  };
  let g;
  try {
    g = await approvals.gate(meta, async () => {
      const res = await rec.client.callTool(tool, argObj);
      return res;
    });
  } catch (err) {
    // The call ran (gate approved) but the server/tool errored — honest, not faked.
    const msg = scrubThenRedact(rec, err && err.message ? err.message : err);
    audit({ server, tool, argKeys, who, result: `error: ${msg.slice(0, 200)}` });
    return { ok: false, error: msg, tool, server };
  }

  if (g.denied) {
    audit({ server, tool, argKeys, who, result: g.lockdown ? 'denied (lockdown)' : 'denied' });
    return { denied: true, reason: `The permission gate denied this MCP call — nothing was sent to "${server}". No fabricated result.`, tool, server };
  }

  const r = g.result || {};
  // Bounded, and HONEST about the bound (review CW-13 #5): a clipped result
  // says so, so a cut list is never presented as the whole list. Per-server
  // `maxTextChars` in config; default 4000.
  const cap = Math.max(200, Math.min(200000, Number(rec.config.maxTextChars) || 4000));
  const full = scrubThenRedact(rec, r.text || '');
  const text = full.length > cap
    ? `${full.slice(0, cap)}\n[truncated: showing ${cap} of ${full.length} characters — the result above is INCOMPLETE; ask with a smaller limit or a narrower query]`
    : full;
  audit({ server, tool, argKeys, who, result: r.isError ? 'tool-error' : (full.length > cap ? 'ok-truncated' : 'ok') });
  return { ok: true, isError: !!r.isError, text, tool, server, truncated: full.length > cap };
}

// A refusal that runs NOTHING but is still audited (an attempted call is a real
// event). Secret-safe: only arg KEYS reach the audit, never values.
function refuse(kind, reason, ctx) {
  audit({ server: ctx.server, tool: ctx.tool, argKeys: ctx.argKeys, who: ctx.who, result: `refused (${kind})` });
  return { refused: true, kind, reason: session.scrub(String(reason)) };
}

// ── Audit — every MCP call, secret-safe ──────────────────────────────────────
// {who, server, tool, argKeys, result-status}. Only arg KEYS, never values — a
// secret passed as a tool argument can never reach the log. session.audit scrubs
// again as belt-and-braces and writes the one greppable COPILOT_AUDIT.log line.
function audit({ who, server, tool, argKeys, result }) {
  try {
    session.audit({
      who: who || 'jarvis',
      what: `mcp tools/call ${server}:${tool} argKeys=[${(argKeys || []).join(', ')}]`,
      device: `mcp:${server}`,
      result,
    });
  } catch (e) { /* audit must never break a call */ }
}

// ── Exposure to the planner (delegation targets) ────────────────────────────
// Each CONNECTED tool becomes one roster entry the planner can reason over and
// choose, namespaced mcp:<server>:<tool>. Read-only tools are the auto-callable
// ones; a write tool still appears (honestly labelled) so the planner can propose
// it for approval, never so it silently runs.
function rosterEntries() {
  ensureLoaded();
  const out = [];
  for (const rec of servers.values()) {
    if (!rec.connected) continue;
    for (const t of rec.tools) {
      const kind = classifyTool(t, rec);
      out.push({
        id: `${NS}:${rec.name}:${t.name}`,
        name: `MCP · ${rec.name} · ${t.name}`,
        connected: true,
        sees: [`external MCP tool (${kind}) — ${t.description || t.name}`],
        note: kind === 'read'
          ? ((t.annotations && t.annotations.readOnlyHint === true)
            ? 'external read-only MCP tool — auto-callable through the permission gate'
            : `external MCP tool read-only by the operator's vetting record${(vettingOf(rec) || {}).sha256 ? ' (pinned)' : ' (UNPINNED — no file hash on the record)'} — auto-callable through the permission gate`)
          : 'external MCP tool that looks like a write — proposed for approval, never auto-run',
        readOnly: kind === 'read',
      });
    }
  }
  return out;
}

// Parse a roster id back into { server, tool }. Server names may contain colons in
// theory, but the namespace is mcp:<server>:<tool>; we split off the first segment
// (mcp) and the LAST segment (tool), leaving the middle as the server name.
function parseToolId(id) {
  const s = String(id || '');
  if (!s.startsWith(`${NS}:`)) return null;
  const rest = s.slice(NS.length + 1);
  const lastColon = rest.lastIndexOf(':');
  if (lastColon < 0) return null;
  return { server: rest.slice(0, lastColon), tool: rest.slice(lastColon + 1) };
}

function isMcpId(id) { return typeof id === 'string' && id.startsWith(`${NS}:`); }

// ── The Jarvis delegation seam ───────────────────────────────────────────────
// Shaped EXACTLY like live.gatherForJarvis's finding so the jarvis loop renders +
// synthesises it with no special-casing: { agentId, name, connected, stance, text }.
// The planner supplies the plain-English sub-question; a structured args object may
// ride along in opts.args (the live-LLM path fills it). With no args we call with
// {} — honest: the server answers, or errors honestly. NEVER fabricated.
async function gather(toolId, question, opts = {}) {
  const parsed = parseToolId(toolId);
  const name = parsed ? `MCP · ${parsed.server} · ${parsed.tool}` : String(toolId);
  if (!parsed) {
    return { agentId: toolId, name, connected: false, stance: 'not-connected', text: 'Not a valid MCP tool id — nothing to call.' };
  }
  const args = (opts.args && typeof opts.args === 'object') ? opts.args : parseArgsFromQuestion(question);
  const res = await callTool({ server: parsed.server, tool: parsed.tool, args, who: opts.who || 'jarvis', approved: opts.approved === true });

  if (res.refused) {
    return { agentId: toolId, name, connected: true, stance: res.kind === 'not-connected' ? 'not-connected' : 'denied',
      text: res.reason };
  }
  if (res.denied) {
    return { agentId: toolId, name, connected: true, stance: 'denied', text: res.reason };
  }
  if (res.ok === false) {
    return { agentId: toolId, name, connected: true, stance: 'unreachable',
      text: `The MCP tool errored — ${res.error}. No reading to show, and nothing was invented.` };
  }
  const body = res.text && res.text.trim() ? res.text : '(the tool returned no text content)';
  return {
    agentId: toolId, name, connected: true,
    stance: res.isError ? 'unreachable' : 'evidence',
    text: res.isError
      ? `The MCP tool reported an error: ${body}`
      : `Called external MCP tool ${parsed.server}:${parsed.tool} — real result:\n${body}`,
  };
}

// Best-effort: if the planner embedded a JSON object of arguments in the
// sub-question, use it; otherwise no args. Never guesses arg VALUES from prose.
function parseArgsFromQuestion(question) {
  const s = String(question || '');
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return {};
  try { const o = JSON.parse(m[0]); return (o && typeof o === 'object') ? o : {}; }
  catch (e) { return {}; }
}

// ── Status (no secrets) ─────────────────────────────────────────────────────
function snapshot(rec) {
  const out = { name: rec.name, connected: !!rec.connected, toolCount: rec.connected ? rec.tools.length : 0 };
  if (!rec.connected && rec.reason) out.reason = rec.reason;
  if (!rec.connected && !rec.reason) out.reason = 'not connected';
  // CW-13: the vetting record (who / when / why / which tools / pin), any drift,
  // tools the record does NOT cover, and which mapped env vars the parent did
  // not have — NAMES only, so the status route stays secret-free. `reason` is
  // redacted + scrubbed at connect time; scrubbed again here as a belt.
  if (out.reason) out.reason = session.scrub(out.reason);
  const v = vettingOf(rec);
  if (v) {
    out.vettedReadOnly = { by: v.by, date: v.date, why: v.why, toolNames: v.toolNames.slice(), pinned: !!v.sha256 };
    if (rec.connected) {
      const unvetted = rec.tools.map((t) => t.name).filter((n) => !v.toolNames.includes(n));
      if (unvetted.length) out.unvettedTools = unvetted;
    }
  }
  if (rec.vettingDrift) out.vettingDrift = rec.vettingDrift;
  if (rec.pinNote) out.pinNote = rec.pinNote;
  if (Array.isArray(rec.configWarnings) && rec.configWarnings.length) out.configWarnings = rec.configWarnings.slice();
  if (Array.isArray(rec.envMissing) && rec.envMissing.length) out.envMissing = rec.envMissing.slice();
  return out;
}

function status() {
  ensureLoaded();
  return {
    configured: servers.size > 0,
    servers: [...servers.values()].map(snapshot),
  };
}

// ≥1 server connected with ≥1 tool — the exact gate for the capability's
// available:true. Sync so capabilities.resolveAvailable can read it.
function anyToolsConnected() {
  ensureLoaded();
  for (const rec of servers.values()) if (rec.connected && rec.tools.length) return true;
  return false;
}

// Test-only: reset the in-memory registry so a test can re-declare servers.
function _reset() {
  for (const rec of servers.values()) { if (rec.client) { try { rec.client.close(); } catch (e) { /* ignore */ } } }
  servers.clear();
  loaded = false;
}

module.exports = {
  configured, connectAll, connectOne, status, anyToolsConnected,
  // CW-13 (tests): the config affordances, exposed so they can be pinned.
  _cw13: { expandVars, vettingOf, childEnv, classifyTool, makeRedactor, checkVettingPin, pinHash, pinTarget, scrubThenRedact, CHILD_ENV_BASE },
  rosterEntries, gather, callTool, classifyTool, isMcpId, parseToolId,
  _reset,
};
