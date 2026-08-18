// mcp.test.js — CW-8 MCP connector, verified DETERMINISTICALLY against a STUB
// stdio MCP server (test/mcp-stub-server.js). No API key, no network, no real
// device. This proves every mechanic the contract pins:
//   - no servers configured → capability OFF, status configured:false, no MCP
//     tools, nothing fabricated;
//   - stub configured → client connects, lists its tools, a tools/call returns the
//     REAL stub result;
//   - deny mode → the call does NOT run (ZERO external calls; reuses the REAL gate);
//   - a write-flagged tool → refused/gated (not auto-run), and runs only when
//     explicitly approved;
//   - a server that fails to connect → honest unavailable + reason, NO fake tool;
//   - secrets never logged (arg KEYS only, never values);
//   - every call audited.
// Jarvis actually CHOOSING an MCP tool is the live-LLM test (pending credits) — the
// stub is what makes the mechanics testable without it.

const path = require('path');
const mcp = require('./mcp-connector');
const approvals = require('./approvals');
const session = require('./session-log');
const capabilities = require('./capabilities');
const mcpClient = require('./mcp-client');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`); }
}

// Count REAL external tools/call invocations, so "deny → zero external calls" and
// "write tool not auto-run" are proven, not assumed.
let externalCalls = 0;
const origCallTool = mcpClient.McpClient.prototype.callTool;
mcpClient.McpClient.prototype.callTool = function (...args) {
  externalCalls++;
  return origCallTool.apply(this, args);
};

const STUB = path.join(__dirname, '..', 'test', 'mcp-stub-server.js');
function configureStub() {
  process.env.MCP_SERVERS = JSON.stringify([
    { name: 'stub', transport: 'stdio', command: process.execPath, args: [STUB], enabled: true },
  ]);
}

(async () => {
  console.log('\nCW-8 — MCP connector (stub stdio server, deterministic):');

  // ── 1. NO servers configured → capability OFF, honest-if-absent ──────────────
  {
    delete process.env.MCP_SERVERS;
    delete process.env.MCP_SERVERS_FILE;
    mcp._reset();
    const st = mcp.status();
    ok('no servers → status.configured is false', st.configured === false, JSON.stringify(st));
    ok('no servers → status.servers is empty', Array.isArray(st.servers) && st.servers.length === 0);
    ok('no servers → no roster entries (no MCP tools)', mcp.rosterEntries().length === 0);
    ok('no servers → anyToolsConnected is false', mcp.anyToolsConnected() === false);

    const cap = capabilities.get('external-tools');
    ok('capability exists', !!cap, 'external-tools ability missing from the map');
    ok('capability OFF when unconfigured', cap && cap.available === false, cap && JSON.stringify(cap));
    ok('capability carries an honest reason', cap && /no mcp tools connected/i.test(cap.reason || ''), cap && cap.reason);
    ok('capability engineBuilt:true always', cap && cap.engineBuilt === true);

    // Nothing fabricated: gathering an MCP tool id with nothing configured is honest.
    const f = await mcp.gather('mcp:stub:echo', 'echo hi');
    ok('unconfigured gather is honest (no fake tool result)',
      f && f.stance !== 'evidence' && !/echo: hi/.test(f.text), JSON.stringify(f));
  }

  // ── 2. A server that FAILS to connect → honest unavailable + reason, no tool ─
  {
    process.env.MCP_SERVERS = JSON.stringify([
      { name: 'broken', transport: 'stdio', command: process.execPath, args: ['-e', 'process.exit(3)'], enabled: true },
    ]);
    mcp._reset();
    await mcp.connectAll();
    const st = mcp.status();
    const s = st.servers.find((x) => x.name === 'broken');
    ok('failed server → configured:true (it was declared)', st.configured === true);
    ok('failed server → connected:false', s && s.connected === false, JSON.stringify(s));
    ok('failed server → carries a reason', s && typeof s.reason === 'string' && s.reason.length > 0, JSON.stringify(s));
    ok('failed server → toolCount 0', s && s.toolCount === 0);
    ok('failed server → contributes NO roster tools (no fake tool)', mcp.rosterEntries().length === 0);
    ok('failed server → capability still OFF', mcp.anyToolsConnected() === false);
  }

  // ── 3. Stub configured → connect, list tools, real tools/call ────────────────
  {
    configureStub();
    mcp._reset();
    await mcp.connectAll();
    const st = mcp.status();
    const s = st.servers.find((x) => x.name === 'stub');
    ok('stub → configured:true', st.configured === true);
    ok('stub → connected:true', s && s.connected === true, JSON.stringify(s));
    ok('stub → lists all 3 tools', s && s.toolCount === 3, JSON.stringify(s));

    const roster = mcp.rosterEntries();
    const ids = roster.map((r) => r.id);
    ok('stub → echo exposed as delegation target', ids.includes('mcp:stub:echo'), ids.join(', '));
    ok('stub → ping exposed as delegation target', ids.includes('mcp:stub:ping'));
    ok('stub → set_mtu exposed as delegation target', ids.includes('mcp:stub:set_mtu'));
    ok('stub → echo classified read-only', roster.find((r) => r.id === 'mcp:stub:echo').readOnly === true);
    ok('stub → set_mtu classified NOT read-only', roster.find((r) => r.id === 'mcp:stub:set_mtu').readOnly === false);

    approvals.setMode('auto');
    externalCalls = 0;
    const res = await mcp.callTool({ server: 'stub', tool: 'echo', args: { message: 'hi there' }, who: 'tester' });
    ok('read tool auto-runs in auto mode', res.ok === true, JSON.stringify(res));
    ok('tools/call returns the REAL stub result', res.text === 'echo: hi there', JSON.stringify(res));
    ok('read tool made exactly one external call', externalCalls === 1, `externalCalls=${externalCalls}`);

    // Via the Jarvis gather seam (structured args), the finding is real evidence.
    externalCalls = 0;
    const f = await mcp.gather('mcp:stub:ping', 'ping the box', { args: { target: 'sw1' }, who: 'jarvis' });
    ok('gather returns a real evidence finding', f.stance === 'evidence' && /pong sw1/.test(f.text), JSON.stringify(f));
    ok('gather made exactly one external call', externalCalls === 1, `externalCalls=${externalCalls}`);

    // Capability now available.
    const cap = capabilities.get('external-tools');
    ok('capability ON when ≥1 server connected with tools', cap && cap.available === true, JSON.stringify(cap));
  }

  // ── 4. DENY mode → the call does NOT run (zero external calls) ────────────────
  {
    approvals.setMode('deny');
    externalCalls = 0;
    const res = await mcp.callTool({ server: 'stub', tool: 'echo', args: { message: 'should not run' }, who: 'tester' });
    ok('deny mode → call is denied', res.denied === true, JSON.stringify(res));
    ok('deny mode → ZERO external calls', externalCalls === 0, `externalCalls=${externalCalls}`);
    ok('deny mode → no fabricated result', !res.text || !/should not run/.test(res.text), JSON.stringify(res));
    approvals.setMode('auto');
  }

  // ── 5. WRITE-flagged tool → refused (not auto-run); runs only when approved ──
  {
    approvals.setMode('auto');
    externalCalls = 0;
    const res = await mcp.callTool({ server: 'stub', tool: 'set_mtu', args: { iface: 'Gi1/0/1', mtu: 9000 }, who: 'tester' });
    ok('write tool → refused (not auto-run)', res.refused === true && res.kind === 'write', JSON.stringify(res));
    ok('write tool refusal → ZERO external calls', externalCalls === 0, `externalCalls=${externalCalls}`);

    // Explicit approve-first → it runs, through the gate, and really performs it.
    externalCalls = 0;
    const okd = await mcp.callTool({ server: 'stub', tool: 'set_mtu', args: { iface: 'Gi1/0/1', mtu: 9000 }, who: 'tester', approved: true });
    ok('write tool → runs when explicitly approved', okd.ok === true && /WRITE performed/.test(okd.text), JSON.stringify(okd));
    ok('approved write → exactly one external call', externalCalls === 1, `externalCalls=${externalCalls}`);
  }

  // ── 6. Unknown tool / unknown server → honest, no fabrication ─────────────────
  {
    const a = await mcp.callTool({ server: 'stub', tool: 'no_such_tool', args: {}, who: 'tester' });
    ok('unknown tool → refused honestly', a.refused === true && a.kind === 'no-tool', JSON.stringify(a));
    const b = await mcp.callTool({ server: 'ghost', tool: 'echo', args: {}, who: 'tester' });
    ok('unknown server → refused honestly', b.refused === true, JSON.stringify(b));
  }

  // ── 7. Secrets never logged (arg KEYS only, never values) ────────────────────
  {
    approvals.setMode('auto');
    const before = session.auditAll({ limit: 500 }).length;
    await mcp.callTool({ server: 'stub', tool: 'echo', args: { message: 'ok', token: 'SUPERSECRET-TOKEN-XYZ' }, who: 'tester' });
    const entries = session.auditAll({ limit: 500 });
    const mine = entries.slice(before);
    const last = mine[mine.length - 1];
    ok('call is audited', !!last && /mcp tools\/call stub:echo/.test(last.what), JSON.stringify(last));
    ok('audit records arg KEYS', last && /argKeys=\[.*token.*\]/.test(last.what), last && last.what);
    const blob = JSON.stringify(mine);
    ok('audit NEVER contains the secret VALUE', !/SUPERSECRET-TOKEN-XYZ/.test(blob), 'secret leaked into audit');
    ok('audited result status is ok', last && last.result === 'ok', last && last.result);
  }

  // ── 8. Every call audited (refusals + denials too) ───────────────────────────
  {
    const before = session.auditAll({ limit: 500 }).length;
    approvals.setMode('deny');
    await mcp.callTool({ server: 'stub', tool: 'echo', args: {}, who: 'tester' });
    approvals.setMode('auto');
    await mcp.callTool({ server: 'stub', tool: 'set_mtu', args: { iface: 'x', mtu: 1 }, who: 'tester' }); // refused
    const mine = session.auditAll({ limit: 500 }).slice(before);
    ok('a denied call is audited', mine.some((e) => /denied/.test(e.result)), JSON.stringify(mine));
    ok('a refused write is audited', mine.some((e) => /refused \(write\)/.test(e.result)), JSON.stringify(mine));
  }

  // ── 9. BOUNDED BUFFER — a server that floods bytes with NO newline is capped ─
  // and disconnected honestly (bounded memory, no OOM, no fabricated result).
  const FLOOD = path.join(__dirname, '..', 'test', 'mcp-flood-server.js');
  {
    // 9a. Direct client, small cap so the flood trips it fast.
    const c = new mcpClient.McpClient({
      name: 'flood', transport: 'stdio', command: process.execPath, args: [FLOOD],
      maxBufferBytes: 128 * 1024, timeoutMs: 8000,
    });
    let threw = null;
    try { await c.connect(); } catch (e) { threw = e; }
    ok('flood → connect rejects (does not hang)', !!threw, threw && threw.message);
    ok('flood → honest buffer-cap reason', threw && /message buffer/i.test(threw.message), threw && threw.message);
    ok('flood → buffer bounded (released, ≤ cap)', c._buf.length <= 128 * 1024, `buf=${c._buf.length}`);
    ok('flood → client marked not connected', c.connected === false);
    c.close();
  }
  {
    // 9b. Via the connector: status shows that server disconnected + reason, no tool.
    process.env.MCP_SERVERS = JSON.stringify([
      { name: 'flood', transport: 'stdio', command: process.execPath, args: [FLOOD], enabled: true, maxBufferBytes: 128 * 1024, timeoutMs: 8000 },
    ]);
    mcp._reset();
    await mcp.connectAll();
    const s = mcp.status().servers.find((x) => x.name === 'flood');
    ok('flood via connector → connected:false', s && s.connected === false, JSON.stringify(s));
    ok('flood via connector → reason mentions the buffer cap', s && /buffer/i.test(s.reason || ''), JSON.stringify(s));
    ok('flood via connector → NO fake tool', mcp.rosterEntries().length === 0);
    ok('flood via connector → capability OFF', mcp.anyToolsConnected() === false);
  }
  {
    // 9c. The normal stub still connects + returns real results; the safety
    // invariants (deny = zero-call, write refused) still hold after the flood.
    configureStub();
    mcp._reset();
    await mcp.connectAll();
    approvals.setMode('auto');
    const res = await mcp.callTool({ server: 'stub', tool: 'echo', args: { message: 'still-good' }, who: 'tester' });
    ok('normal stub still returns the REAL result after a flood', res.ok === true && res.text === 'echo: still-good', JSON.stringify(res));
    approvals.setMode('deny');
    externalCalls = 0;
    const d = await mcp.callTool({ server: 'stub', tool: 'echo', args: {}, who: 'tester' });
    ok('deny still ZERO external calls after a flood', d.denied === true && externalCalls === 0, `externalCalls=${externalCalls}`);
    approvals.setMode('auto');
    const w = await mcp.callTool({ server: 'stub', tool: 'set_mtu', args: { iface: 'x', mtu: 1 }, who: 'tester' });
    ok('write still refused after a flood', w.refused === true && w.kind === 'write', JSON.stringify(w));
  }

  mcp._reset();
  mcpClient.McpClient.prototype.callTool = origCallTool;
  console.log(`\nCW-8 MCP connector: ${pass} passed, ${fail} failed.`);
  if (fail) process.exit(1);
})().catch((err) => { console.error('test crashed:', err); process.exit(1); });
