// mcp.cw13.test.js — CW-13: the first REAL external MCP server (NetClaw's
// catc-mcp) through the CW-8 connector.
//
// Plain words: NetClaw's servers are built on FastMCP and advertise their tools
// with NO annotations. The connector's fail-safe rule says "no annotations →
// treat as a write → refuse". That rule is right for a stranger; it is wrong for
// a server the operator has read, vetted and recorded as read-only by
// construction. CW-13 adds three small config affordances and this suite pins
// every one of them:
//   1. vettedReadOnly {by, why, date} — honoured ONLY with a real record; a tool
//      that declares itself a write stays a write regardless.
//   2. envFrom — a credential reaches the child from the parent's own env, never
//      from the config file; a missing one is reported by NAME only.
//   3. ${VAR} expansion in command / args / cwd.
//   4. LIVE (optional): if a NetClaw checkout + a Python with `mcp` are present,
//      the real catc-mcp server is spawned, lists its 10 tools, answers a local
//      catalogue search, and refuses honestly with no appliance configured. When
//      NetClaw is absent the block SAYS SO and is skipped — never a fake pass.
//
// Deterministic parts use test/mcp-noannot-server.js (no network, no key).

const fs = require('fs');
const path = require('path');
const mcp = require('./mcp-connector');
const approvals = require('./approvals');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`); }
}
const STUB = path.join(__dirname, '..', 'test', 'mcp-noannot-server.js');
const { expandVars, vettingOf, childEnv, classifyTool } = mcp._cw13;

function configure(extra) {
  process.env.MCP_SERVERS = JSON.stringify([
    Object.assign({ name: 'noannot', transport: 'stdio', command: process.execPath, args: [STUB], enabled: true }, extra || {}),
  ]);
  delete process.env.MCP_SERVERS_FILE;
  mcp._reset();
}

(async () => {
  console.log('\nCW-13 — a vetted external MCP server (NetClaw) through the connector:\n');
  approvals.setMode('auto');

  // ── 1. classification: the server's own word wins; vetting only fills silence ──
  {
    const noAnn = { name: 'lookup', annotations: null };
    const declaredRead = { name: 'r', annotations: { readOnlyHint: true } };
    const declaredWrite = { name: 'w', annotations: { readOnlyHint: false } };
    const destructive = { name: 'd', annotations: { readOnlyHint: true, destructiveHint: true } };
    const plain = { config: {} };
    const vetted = { config: { vettedReadOnly: { by: 'Vikas', why: 'GET-only catalogue', date: '2026-09-05' } } };
    const blank = { config: { vettedReadOnly: true } };
    const halfRecord = { config: { vettedReadOnly: { by: 'Vikas' } } };
    ok('no annotations + no vetting → write (fail safe, unchanged CW-8 rule)', classifyTool(noAnn, plain) === 'write');
    ok('no annotations + a real vetting record → read', classifyTool(noAnn, vetted) === 'read');
    ok('a blank `vettedReadOnly: true` is NOT a record → still write', classifyTool(noAnn, blank) === 'write' && vettingOf(blank) === null);
    ok('a record without `why` is not a record either', classifyTool(noAnn, halfRecord) === 'write' && vettingOf(halfRecord) === null);
    ok('declared read-only is read, vetted or not', classifyTool(declaredRead, plain) === 'read' && classifyTool(declaredRead, vetted) === 'read');
    ok('a DECLARED write stays a write even on a vetted server (the server\'s word wins)', classifyTool(declaredWrite, vetted) === 'write');
    ok('destructiveHint:true stays a write even with readOnlyHint:true and vetting', classifyTool(destructive, vetted) === 'write');
    const v = vettingOf(vetted);
    ok('the record is normalised and bounded', v && v.by === 'Vikas' && v.why === 'GET-only catalogue' && v.date === '2026-09-05');
    ok('a huge record is clipped, not rejected', (vettingOf({ config: { vettedReadOnly: { by: 'x'.repeat(500), why: 'y'.repeat(2000) } } }) || {}).by.length === 120);
  }

  // ── 2. ${VAR} expansion + envFrom (secret-safe) ────────────────────────────
  {
    process.env.CW13_TEST_DIR = '/opt/netclaw';
    process.env.CW13_TEST_PY = '/opt/venv/bin/python';
    ok('${VAR} expands from the parent env', expandVars('${CW13_TEST_PY}') === '/opt/venv/bin/python' && expandVars('${CW13_TEST_DIR}/mcp-servers/x.py') === '/opt/netclaw/mcp-servers/x.py');
    ok('an unset ${VAR} is left as written (visible, never silently blank)', expandVars('${CW13_NOPE}/a') === '${CW13_NOPE}/a');
    ok('non-strings pass through', expandVars(null) === null && expandVars(3) === 3);
    process.env.CW13_PARENT_SECRET = 'hunter2';
    delete process.env.CW13_PARENT_UNSET;
    const ce = childEnv({ env: { STUB_LITERAL: 'lit-${CW13_TEST_DIR}' }, envFrom: { STUB_MAPPED_SECRET: 'CW13_PARENT_SECRET', STUB_OTHER: 'CW13_PARENT_UNSET' } });
    ok('envFrom copies the parent value into the child under the child name', ce.env && ce.env.STUB_MAPPED_SECRET === 'hunter2');
    ok('a literal env value is expanded too', ce.env && ce.env.STUB_LITERAL === 'lit-/opt/netclaw');
    ok('an unset parent var is NOT passed and is reported by NAME', !('STUB_OTHER' in ce.env) && ce.missing.join() === 'STUB_OTHER');
    ok('no env at all → null (the client inherits the parent env as before)', childEnv({}).env === null && childEnv({}).missing.length === 0);
  }

  // ── 3. end to end on the no-annotation stub ────────────────────────────────
  // 3a. WITHOUT vetting: every tool refused as an unknown write (CW-8 behaviour).
  {
    configure({});
    await mcp.connectAll();
    const st = mcp.status();
    ok('stub connects and lists 2 tools', st.servers[0].connected === true && st.servers[0].toolCount === 2, JSON.stringify(st));
    ok('…and status carries NO vetting record when none was configured', !('vettedReadOnly' in st.servers[0]));
    const r = await mcp.callTool({ server: 'noannot', tool: 'lookup', args: { query: 'x' } });
    ok('an un-annotated tool on an UNVETTED server is refused as a write', r.refused === true && r.kind === 'write');
    ok('…roster shows it as not read-only', mcp.rosterEntries().find((e) => e.id === 'mcp:noannot:lookup').readOnly === false);
  }
  // 3b. WITH vetting: reads auto-run through the gate; the declared write still refused.
  {
    process.env.CW13_PARENT_SECRET = 'hunter2';
    delete process.env.CW13_PARENT_UNSET;
    configure({
      vettedReadOnly: { by: 'Vikas', date: '2026-09-05', why: 'test stub — read-only by construction' },
      env: { STUB_LITERAL: 'from-${CW13_TEST_DIR}' },
      envFrom: { STUB_MAPPED_SECRET: 'CW13_PARENT_SECRET', STUB_MISSING: 'CW13_PARENT_UNSET' },
    });
    await mcp.connectAll();
    const st = mcp.status();
    ok('status shows the vetting record (who / when / why)', st.servers[0].vettedReadOnly && st.servers[0].vettedReadOnly.by === 'Vikas' && st.servers[0].vettedReadOnly.date === '2026-09-05');
    ok('status reports the missing mapped var by NAME only', Array.isArray(st.servers[0].envMissing) && st.servers[0].envMissing.join() === 'STUB_MISSING');
    ok('…and never a value', !JSON.stringify(st).includes('hunter2'));
    const r = await mcp.callTool({ server: 'noannot', tool: 'lookup', args: { query: 'sw1' } });
    ok('the un-annotated tool now auto-runs as a read (real stub result, not invented)', r.ok === true && /^lookup:sw1 /.test(r.text), JSON.stringify(r));
    ok('the child received the mapped credential (present) and the expanded literal', /mapped=present/.test(r.text) && /literal=from-\/opt\/netclaw/.test(r.text));
    ok('the credential VALUE is not in the result (the stub never echoes it)', !r.text.includes('hunter2'));
    const w = await mcp.callTool({ server: 'noannot', tool: 'wipe', args: {} });
    ok('the DECLARED destructive tool is still refused on the vetted server', w.refused === true && w.kind === 'write');
    const ros = mcp.rosterEntries();
    ok('roster: lookup read-only, wipe not', ros.find((e) => e.id === 'mcp:noannot:lookup').readOnly === true && ros.find((e) => e.id === 'mcp:noannot:wipe').readOnly === false);
    // the gate still owns every call: deny → zero calls
    approvals.setMode('deny');
    const d = await mcp.callTool({ server: 'noannot', tool: 'lookup', args: { query: 'x' } });
    ok('in deny mode the vetted read is still denied by the gate (zero wire)', d.denied === true);
    approvals.setMode('auto');
    const g = await mcp.gather('mcp:noannot:lookup', 'look up {"query":"core-1"}');
    ok('the Jarvis delegation seam returns evidence from the vetted tool', g.stance === 'evidence' && /lookup:core-1/.test(g.text));
  }

  // ── 4. LIVE: the real NetClaw catc-mcp server, when present ────────────────
  {
    const dir = process.env.NETCLAW_DIR || '/home/user/automateyournetwork/netclaw';
    const py = process.env.NETCLAW_PYTHON || '/tmp/claude-0/-home-user-netrok/30fd209a-2715-5ba6-9aa1-39105ad8bb21/scratchpad/catc-venv/bin/python';
    const serverPy = path.join(dir, 'mcp-servers', 'catc-mcp', 'server.py');
    if (!fs.existsSync(serverPy) || !fs.existsSync(py)) {
      console.log(`  skip live NetClaw block — not present here (NETCLAW_DIR=${dir}, NETCLAW_PYTHON=${py}). This is a skip, not a pass.`);
    } else {
      process.env.NETCLAW_DIR = dir; process.env.NETCLAW_PYTHON = py;
      delete process.env.CATALYST_CENTER_HOST;
      const example = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'mcp-servers.example.json'), 'utf8'));
      const catc = example.find((e) => e.name === 'netclaw-catc');
      ok('the committed example config carries the netclaw-catc entry (disabled by default)', catc && catc.enabled === false && catc.vettedReadOnly && catc.vettedReadOnly.by);
      ok('…with credentials mapped by NAME from DNAC_* (every envFrom value is a VAR NAME; no secret-shaped key under env)',
        catc && catc.envFrom && catc.envFrom.CATALYST_CENTER_PASSWORD === 'DNAC_PASS'
        && Object.values(catc.envFrom).every((v) => /^[A-Z_][A-Z0-9_]*$/.test(v))
        && !Object.keys(catc.env || {}).some((k) => /pass|secret|token|key/i.test(k)));
      process.env.MCP_SERVERS = JSON.stringify([Object.assign({}, catc, { enabled: true })]);
      delete process.env.MCP_SERVERS_FILE;
      delete process.env.DNAC_HOST; delete process.env.DNAC_USER; delete process.env.DNAC_PASS;
      mcp._reset();
      await mcp.connectAll();
      const st = mcp.status();
      ok('LIVE: the real catc-mcp server connects through the example config', st.servers[0].connected === true, JSON.stringify(st));
      ok('LIVE: it advertises exactly 10 tools', st.servers[0].toolCount === 10);
      ok('LIVE: with no DNAC_* set, the three mapped credentials are reported missing by name', (st.servers[0].envMissing || []).sort().join() === 'CATALYST_CENTER_HOST,CATALYST_CENTER_PASSWORD,CATALYST_CENTER_USERNAME');
      const ros = mcp.rosterEntries();
      ok('LIVE: all 10 are read-only delegation targets for the planner', ros.length === 10 && ros.every((e) => e.readOnly === true));
      const f = await mcp.callTool({ server: 'netclaw-catc', tool: 'catc_find', args: { query: 'health', limit: 3 } });
      ok('LIVE: catc_find answers from the LOCAL catalogue (no appliance)', f.ok === true && /"outcome": "ok"/.test(f.text) && /LOCAL catalogue/.test(f.text), f.text && f.text.slice(0, 200));
      const dv = await mcp.callTool({ server: 'netclaw-catc', tool: 'catc_devices', args: { operation: 'getDeviceList', params: {} } });
      ok('LIVE: a device read with no appliance configured is REFUSED honestly (not_configured / refused), never data', dv.ok === true && /"outcome": "(not_configured|refused)"/.test(dv.text) && !/"data"/.test(dv.text));
      const near = await mcp.callTool({ server: 'netclaw-catc', tool: 'catc_describe_operation', args: { operation: 'getDeviceCount' } });
      ok('LIVE: describe works for a real operation name', near.ok === true && /"outcome": "ok"/.test(near.text) || /Unknown operation/.test(near.text));
      mcp._reset();
    }
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
