#!/usr/bin/env node
// mcp-stub-server.js — a trivial, self-contained MCP server over stdio, shipped in
// the TEST HARNESS so CW-8's mechanics are provable deterministically WITHOUT a
// real network MCP server and WITHOUT an API key.
//
// It speaks the same newline-delimited JSON-RPC the real client does and advertises
// three tools:
//   - echo  (read-only)  : returns the message it was given — proves a real result.
//   - ping  (read-only)  : returns a canned "pong <target>" — a second safe tool.
//   - set_mtu (WRITE)    : annotated readOnlyHint:false + destructiveHint:true, so
//                          the connector must refuse to auto-run it (read-only posture).
//
// It NEVER reaches a network. Every answer is computed locally from the request, so
// the test asserts the connector returns the REAL stub output, never a fabrication.

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
    name: 'echo',
    description: 'Echo back the given message (read-only).',
    inputSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
    annotations: { readOnlyHint: true, destructiveHint: false, title: 'Echo' },
  },
  {
    name: 'ping',
    description: 'Return pong for a target (read-only).',
    inputSchema: { type: 'object', properties: { target: { type: 'string' } } },
    annotations: { readOnlyHint: true, destructiveHint: false, title: 'Ping' },
  },
  {
    name: 'set_mtu',
    description: 'Set the MTU on an interface (MUTATION — changes device state).',
    inputSchema: { type: 'object', properties: { iface: { type: 'string' }, mtu: { type: 'number' } }, required: ['iface', 'mtu'] },
    annotations: { readOnlyHint: false, destructiveHint: true, title: 'Set MTU' },
  },
];

function handle(line) {
  let msg;
  try { msg = JSON.parse(line); } catch (e) { return; }
  const { id, method, params } = msg;

  if (method === 'initialize') {
    return reply(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'mcp-stub', version: '0.0.1' },
    });
  }
  if (method === 'notifications/initialized') return; // notification, no reply
  if (method === 'tools/list') {
    return reply(id, { tools: TOOLS });
  }
  if (method === 'tools/call') {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    if (name === 'echo') {
      return reply(id, { content: [{ type: 'text', text: `echo: ${String(args.message == null ? '' : args.message)}` }], isError: false });
    }
    if (name === 'ping') {
      return reply(id, { content: [{ type: 'text', text: `pong ${String(args.target == null ? 'localhost' : args.target)}` }], isError: false });
    }
    if (name === 'set_mtu') {
      // If the connector ever let this run (it must not, unless approved), the
      // real effect is visible in the output — never a silent no-op.
      return reply(id, { content: [{ type: 'text', text: `MTU on ${args.iface} set to ${args.mtu} (WRITE performed)` }], isError: false });
    }
    return reply(id, { content: [{ type: 'text', text: `unknown tool "${name}"` }], isError: true });
  }
  if (id != null) return replyError(id, -32601, `method not found: ${method}`);
}
