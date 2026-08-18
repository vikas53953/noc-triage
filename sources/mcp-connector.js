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
const { McpClient } = require('./mcp-client');
const approvals = require('./approvals');
const session = require('./session-log');

const NS = 'mcp'; // namespace prefix: mcp:<server>:<tool>

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
  const client = new McpClient({
    name: rec.name,
    transport: 'stdio',
    command: rec.config.command,
    args: rec.config.args || [],
    env: rec.config.env || null,
    cwd: rec.config.cwd || null,
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
    rec.reason = err && err.message ? err.message : String(err);
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
function classifyTool(tool) {
  const a = tool && tool.annotations;
  if (a && a.readOnlyHint === true && a.destructiveHint !== true) return 'read';
  return 'write'; // declared write OR unknown → treat as write (fail safe)
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
  const kind = classifyTool(toolDef);
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
    audit({ server, tool, argKeys, who, result: `error: ${err && err.message ? err.message : err}` });
    return { ok: false, error: session.scrub(String(err && err.message ? err.message : err)), tool, server };
  }

  if (g.denied) {
    audit({ server, tool, argKeys, who, result: g.lockdown ? 'denied (lockdown)' : 'denied' });
    return { denied: true, reason: `The permission gate denied this MCP call — nothing was sent to "${server}". No fabricated result.`, tool, server };
  }

  const r = g.result || {};
  const text = session.scrub(String(r.text || '')).slice(0, 4000);
  audit({ server, tool, argKeys, who, result: r.isError ? 'tool-error' : 'ok' });
  return { ok: true, isError: !!r.isError, text, tool, server };
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
      const kind = classifyTool(t);
      out.push({
        id: `${NS}:${rec.name}:${t.name}`,
        name: `MCP · ${rec.name} · ${t.name}`,
        connected: true,
        sees: [`external MCP tool (${kind}) — ${t.description || t.name}`],
        note: kind === 'read'
          ? 'external read-only MCP tool — auto-callable through the permission gate'
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
  rosterEntries, gather, callTool, classifyTool, isMcpId, parseToolId,
  _reset,
};
