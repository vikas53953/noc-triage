#!/usr/bin/env node
// mcp-noannot-server.js — a stdio MCP stub that declares NO tool annotations,
// shipped in the TEST HARNESS for CW-13. Real servers built on FastMCP (NetClaw's
// catc-mcp among them) advertise their tools with `annotations: null`, so the
// connector's fail-safe posture would refuse every one of them as an unknown
// write. CW-13 lets the OPERATOR put a vetting record on such a server; this
// stub is how that rule is proven deterministically, with no network and no key.
//
// Tools:
//   - lookup (no annotations) : returns the query and the env var the parent
//                               mapped in (proves envFrom reached the child) —
//                               NEVER the parent's whole environment.
//   - wipe   (declares itself destructive) : must stay refused even on a vetted
//                               server — the server's own word wins.

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (line) handle(line);
  }
});

function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function replyError(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

const TOOLS = [
  {
    name: 'lookup',
    description: 'Look something up (a read — but this server declares no annotations).',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
    annotations: null,
  },
  {
    name: 'wipe',
    description: 'A declared destructive tool.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: false, destructiveHint: true, title: 'Wipe' },
  },
];

function handle(line) {
  let msg;
  try { msg = JSON.parse(line); } catch (e) { return; }
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return reply(id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'noannot-stub', version: '0.0.1' } });
  }
  if (method === 'notifications/initialized') return;
  if (method === 'tools/list') return reply(id, { tools: TOOLS });
  if (method === 'tools/call') {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    if (name === 'lookup') {
      const mapped = process.env.STUB_MAPPED_SECRET !== undefined ? 'present' : 'absent';
      const literal = process.env.STUB_LITERAL || '';
      // Did the PARENT's secrets leak in? (names only — never the values)
      const leaked = ['ANTHROPIC_API_KEY', 'CW13_PARENT_SECRET', 'CW13_PARENT_CANARY'].filter((k) => k in process.env).join(',') || 'none';
      const big = args.big ? 'X'.repeat(Number(args.big) || 0) : '';
      return reply(id, { content: [{ type: 'text', text: `lookup:${args.query || ''} mapped=${mapped} literal=${literal} leaked=${leaked} path=${process.env.PATH ? 'yes' : 'no'}${big}` }], isError: false });
    }
    if (name === 'wipe') {
      return reply(id, { content: [{ type: 'text', text: 'WIPED — this must never be reachable without approval' }], isError: false });
    }
    return replyError(id, -32602, `unknown tool ${name}`);
  }
  if (id !== undefined) return replyError(id, -32601, `unknown method ${method}`);
}
