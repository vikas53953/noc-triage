# CW-8 pinned contract — MCP connector for Jarvis (netclaw A1)

Give Jarvis a generic MCP client so it can call external MCP tool servers as delegation targets — behind
the permission gate, read-only initially, audited, honest-if-no-servers. This is the unlock for pulling
NetClaw's tools. It builds + proves against a STUB MCP server; it does NOT auto-wire any real network MCP
server (that's a later, security-vetted step).

## Owns
sources/mcp-client.js (new — the client), a small MCP registry/config, wiring in sources/jarvis.js so an
MCP tool is a delegation target, MCP routes + capabilities in server.js (block adjacent to CW-7's), audit.
No public/* required for CW-8 (a status surface can come later); a tiny honest status route is enough.

## Config & honesty
- MCP servers are declared in config (env or a JSON file), each: {name, transport: 'stdio'|'http', command/url,
  enabled}. NONE declared → the capability is OFF, Jarvis has no MCP tools, nothing fabricated.
- On start (or lazily), the client connects to each ENABLED server, lists its tools, and exposes them to the
  planner as callable tools namespaced by server (e.g. `mcp:catc:get_devices`).
- Honest: a server that won't connect / errors → that server's tools are unavailable with a clear reason;
  never a fake tool or fake result. If MCP is unconfigured, capabilities says so.

## Client (mcp-client.js)
- Speaks the Model Context Protocol (JSON-RPC): initialize, tools/list, tools/call. Support stdio transport
  (spawn a server process) and/or http. Use a minimal implementation or the official SDK IF it's pure-Node
  and vetted — but prefer a small self-contained client to avoid a heavy dep (state your choice + why).
- Timeouts + honest errors (server down / tool error / bad args) — never a fabricated tool result.
- Secrets: any server creds live in config/env only, never logged/returned (log tool names + arg keys, never
  secret values). Scrub from everything persisted.

## Safety (the important part)
- EVERY MCP tool call goes through the SAME permission gate as a device read (deny mode → the call does NOT
  run, zero external calls; reuse approvals.gate, do NOT duplicate/bypass it).
- READ-ONLY posture for CW-8: only tools the server advertises as read-only/safe are auto-callable; anything
  that looks like a write/mutation is treated like a device write — refused unless explicitly gated/approved
  (mirror the change-engine approve-first posture). A tool's declared danger is honored; when unknown, treat
  as write (fail safe).
- Intent-first: Jarvis's planner DECIDES to call an MCP tool from reasoning over the task — NOT a keyword
  table. The engine only exposes the tools + routes the call + gates/audits.
- Audit every MCP call {who, server, tool, argKeys, result-status}.

## Routes
- GET /api/copilot/mcp/status → { configured, servers:[{name, connected, toolCount, reason?}] } (no secrets).
- (optional) POST /api/copilot/mcp/reconnect (operator-named) → re-list tools; honest result.
- capabilities: an `external-tools` (mcp) ability — available:true only when ≥1 server is connected with
  tools; else available:false + reason "no MCP tools connected — configure a server"; engineBuilt:true always.

## Verify (deterministic; live-LLM tool-choice pending credits)
Ship a trivial STUB MCP server (stdio, a couple read-only tools like echo/ping, in the test harness) and prove:
no servers configured → capability off, status configured:false, Jarvis has no MCP tools, nothing fabricated;
stub configured → client connects, lists its tools, a tools/call returns the real stub result; deny mode →
the call does NOT run (zero external calls); a write-flagged stub tool → refused/gated (not auto-run); a
server that fails to connect → honest unavailable + reason, no fake tool; secrets never logged; every call
audited. Full suite green + new mcp tests. Jarvis actually CHOOSING an MCP tool is the live-LLM test (credits).
