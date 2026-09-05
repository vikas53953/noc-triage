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
const { expandVars, vettingOf, childEnv, classifyTool, makeRedactor, checkVettingPin, pinHash, pinTarget, scrubThenRedact, CHILD_ENV_BASE } = mcp._cw13;
const LEAKY = path.join(__dirname, '..', 'test', 'mcp-leaky-server.js');
const crypto = require('crypto');

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
    const V = { by: 'Vikas', why: 'GET-only catalogue', date: '2026-09-05', toolNames: ['lookup', 'r', 'w', 'd', 'x'] };
    const vetted = { config: { vettedReadOnly: V } };
    const blank = { config: { vettedReadOnly: true } };
    const halfRecord = { config: { vettedReadOnly: { by: 'Vikas', toolNames: ['lookup'] } } };
    const noTools = { config: { vettedReadOnly: { by: 'Vikas', why: 'x' } } };
    ok('no annotations + no vetting → write (fail safe, unchanged CW-8 rule)', classifyTool(noAnn, plain) === 'write');
    ok('no annotations + a real vetting record naming the tool → read', classifyTool(noAnn, vetted) === 'read');
    ok('a blank `vettedReadOnly: true` is NOT a record → still write', classifyTool(noAnn, blank) === 'write' && vettingOf(blank) === null);
    ok('a record without `why` is not a record either', classifyTool(noAnn, halfRecord) === 'write' && vettingOf(halfRecord) === null);
    ok('a record without toolNames is not a record (it must say WHICH tools were vetted — review #3)', classifyTool(noAnn, noTools) === 'write' && vettingOf(noTools) === null);
    ok('a tool the record does NOT name stays a write even on a vetted server', classifyTool({ name: 'catc_apply_template', annotations: null }, vetted) === 'write');
    ok('declared read-only is read, vetted or not', classifyTool(declaredRead, plain) === 'read' && classifyTool(declaredRead, vetted) === 'read');
    ok('a DECLARED write stays a write even on a vetted server (the server\'s word wins)', classifyTool(declaredWrite, vetted) === 'write');
    ok('destructiveHint:true stays a write even with readOnlyHint:true and vetting', classifyTool(destructive, vetted) === 'write');
    // malformed annotations are NOT silence (review #4): anything declared that is not the clean read shape → write
    const malformed = [
      { readOnlyHint: 'true' }, { readOnlyHint: 'false' }, { readOnlyHint: 0 }, { readOnlyHint: null }, { readOnlyHint: 1 },
      { destructiveHint: 1 }, { destructiveHint: 'true' }, { destructiveHint: null }, { destructiveHint: false },
      { readOnlyHint: true, destructiveHint: 1 }, { readOnlyHint: true, destructiveHint: null },
    ];
    const verdicts = malformed.map((a) => classifyTool({ name: 'x', annotations: a }, vetted));
    ok('every malformed annotation shape is a write, vetted or not', verdicts.every((v) => v === 'write') && malformed.every((a) => classifyTool({ name: 'x', annotations: a }, plain) === 'write'), JSON.stringify(verdicts));
    ok('readOnlyHint:true + destructiveHint:false (the clean read shape) is read', classifyTool({ name: 'x', annotations: { readOnlyHint: true, destructiveHint: false } }, plain) === 'read');
    ok('annotations as an array / empty object / string count as ABSENT (vetting fills, else write)',
      classifyTool({ name: 'x', annotations: [] }, plain) === 'write' && classifyTool({ name: 'x', annotations: [] }, vetted) === 'read'
      && classifyTool({ name: 'x', annotations: {} }, vetted) === 'read' && classifyTool({ name: 'x', annotations: 'yes' }, plain) === 'write');
    const v = vettingOf(vetted);
    ok('the record is normalised and bounded', v && v.by === 'Vikas' && v.why === 'GET-only catalogue' && v.date === '2026-09-05' && v.toolNames.length === 5 && v.sha256 === null);
    ok('a huge record is clipped, not rejected', (vettingOf({ config: { vettedReadOnly: { by: 'x'.repeat(500), why: 'y'.repeat(2000), toolNames: ['t'] } } }) || {}).by.length === 120);
    // the pin: a sha256 that no longer matches the file voids the record
    const tmp = path.join(require('os').tmpdir(), `cw13-pin-${process.pid}.py`);
    fs.writeFileSync(tmp, 'print("v1")\n');
    const sha = crypto.createHash('sha256').update(fs.readFileSync(tmp)).digest('hex');
    const pinned = { config: { command: 'python', args: [tmp], vettedReadOnly: Object.assign({}, V, { sha256: sha }) } };
    checkVettingPin(pinned);
    ok('a pinned record whose file matches is honoured', !pinned.vettingDrift && classifyTool(noAnn, pinned) === 'read' && vettingOf(pinned).sha256 === sha);
    fs.writeFileSync(tmp, 'print("v2")  # changed\n');
    checkVettingPin(pinned);
    ok('…and once the file changes, the record is VOID: drift recorded, tool → write', /does not match/.test(pinned.vettingDrift || '') && classifyTool(noAnn, pinned) === 'write' && vettingOf(pinned) === null);
    const gone = { config: { args: ['/nonexistent/server.py'], vettedReadOnly: Object.assign({}, V, { sha256: sha }) } };
    checkVettingPin(gone);
    ok('an unreadable / missing pinned file voids the record honestly', /could not be read|no file to check/.test(gone.vettingDrift || '') && vettingOf(gone) === null);
    // round 2 #4: a malformed sha256 is DRIFT, not "unpinned"
    const bad = { config: { args: [tmp], vettedReadOnly: Object.assign({}, V, { sha256: 'ZZ' }) } };
    fs.writeFileSync(tmp, 'print("v1")\n'); checkVettingPin(bad);
    ok('a malformed sha256 voids the record with an honest reason (never silently unpins)', /sha256 is malformed/.test(bad.vettingDrift || '') && vettingOf(bad) === null, bad.vettingDrift);
    // round 2 #2: CRLF vs LF is not code drift (Git for Windows autocrlf)
    const lf = fs.readFileSync(tmp); const crlf = Buffer.from(lf.toString().replace(/\n/g, '\r\n'));
    ok('the pin hashes LF-normalised bytes: a CRLF checkout of the same file has the SAME hash', pinHash(lf) === pinHash(crlf) && pinHash(lf) !== crypto.createHash('sha256').update(crlf).digest('hex'));
    // round 2 #5: `file` cannot decoy the pin away from the entry point
    const decoy = path.join(require('os').tmpdir(), `cw13-decoy-${process.pid}.txt`); fs.writeFileSync(decoy, 'static decoy\n');
    const dec = { config: { command: 'python', args: [tmp], vettedReadOnly: Object.assign({}, V, { file: decoy, sha256: pinHash(fs.readFileSync(decoy)) }) } };
    checkVettingPin(dec);
    ok('with a real args[0], `file` is ignored (noted) and the ENTRY POINT is what is hashed → a decoy record drifts', /does not match/.test(dec.vettingDrift || '') && /ignored/.test(dec.pinNote || ''), dec.vettingDrift);
    const dec2 = { config: { command: 'python', args: ['-m', 'somemodule'], vettedReadOnly: Object.assign({}, V, { file: tmp, sha256: pinHash(fs.readFileSync(tmp)) }) } };
    checkVettingPin(dec2);
    ok('…while `file` IS the target when args[0] is not a file (python -m module)', !dec2.vettingDrift && pinTarget(dec2).file === tmp);
    try { fs.unlinkSync(decoy); } catch (e) {}
    ok('a record with no sha256 is unpinned (allowed, shown as pinned:false)', (() => { const r = { config: { vettedReadOnly: V } }; checkVettingPin(r); return !r.vettingDrift && vettingOf(r).sha256 === null; })());
    try { fs.unlinkSync(tmp); } catch (e) {}
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
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-canary-never-real-000';
    process.env.CW13_PARENT_CANARY = 'canary-value-not-mapped';
    process.env.CW13_HOST_VALUE = 'https://sandboxdnac.cisco.com'; process.env.CW13_USER_VALUE = 'admin'; process.env.CW13_HOOK = 'https://outlook.example/webhook/AAAA-BBBB';
    const ce = childEnv({ env: { STUB_LITERAL: 'lit-${CW13_TEST_DIR}', STUB_PLAIN: 'true', STUB_HOOK: '${CW13_HOOK}' },
      envFrom: { STUB_MAPPED_SECRET: 'CW13_PARENT_SECRET', STUB_OTHER: 'CW13_PARENT_UNSET', STUB_HOST: 'CW13_HOST_VALUE', STUB_USERNAME: 'CW13_USER_VALUE', STUB_OPTIN: { from: 'CW13_USER_VALUE', secret: true } } });
    ok('envFrom copies the parent value into the child under the child name', ce.env && ce.env.STUB_MAPPED_SECRET === 'hunter2');
    ok('a literal env value is expanded too', ce.env && ce.env.STUB_LITERAL === 'lit-/opt/netclaw');
    ok('an unset parent var is NOT passed and is reported by NAME', !('STUB_OTHER' in ce.env) && ce.missing.join() === 'STUB_OTHER');
    ok('THE BOUNDARY: the child env carries the allowlisted base only — never ANTHROPIC_API_KEY, never the parent var by its own name, never an unmapped parent value (review #1)',
      !('ANTHROPIC_API_KEY' in ce.env) && !('CW13_PARENT_SECRET' in ce.env) && !('CW13_PARENT_CANARY' in ce.env) && !('CW13_HOST_VALUE' in ce.env) && Object.keys(ce.env).every((k) => CHILD_ENV_BASE.includes(k) || /^STUB_/.test(k)));
    ok('…but PATH (and the rest of the base) does come through, so a venv python still runs', ('PATH' in ce.env) === ('PATH' in process.env));
    ok('no config env at all → the base only, never null (the boundary holds for every server)', childEnv({}).env && !('ANTHROPIC_API_KEY' in childEnv({}).env) && childEnv({}).missing.length === 0);
    ok('SECRECY IS BY NAME (round 2 #1): a mapped PASSWORD/SECRET is a secret; a mapped HOST or USERNAME is NOT (evidence the operator must see)',
      ce.injected.includes('hunter2') && !ce.injected.includes('https://sandboxdnac.cisco.com') && ce.env.STUB_HOST === 'https://sandboxdnac.cisco.com' && ce.env.STUB_USERNAME === 'admin', JSON.stringify(ce.injected));
    ok('…the object form { from, secret:true } opts a non-secret-shaped name in', ce.env.STUB_OPTIN === 'admin' && ce.injected.filter((v) => v === 'admin').length === 1);
    ok('a plain literal is not a secret; a literal that EXPANDED from the parent env IS (round 2 #3)', !ce.injected.includes('true') && ce.injected.includes('lit-/opt/netclaw') && ce.injected.includes('https://outlook.example/webhook/AAAA-BBBB'));
    const red = makeRedactor(ce.injected);
    const sample = 'boot: MAPPED=hunter2 "quoted" KEY=sk-ant-test-canary-never-real-000 HOOK=https://outlook.example/webhook/AAAA-BBBB host=https://sandboxdnac.cisco.com fine=hello adminStatus=up "admin"';
    const out = red(sample);
    ok('the redactor wipes the password, the API key, the expanded webhook; keeps the host', !out.includes('hunter2') && !out.includes('sk-ant-test-canary') && !out.includes('AAAA-BBBB') && out.includes('https://sandboxdnac.cisco.com') && /fine=hello/.test(out), out);
    ok('BOUNDARY-AWARE: the opted-in secret "admin" is wiped as a token ("admin") but never inside "adminStatus"', /adminStatus=up/.test(out) && /"\[redacted\]"/.test(out), out);
    ok('a value containing another is wiped whole (longest first)', !makeRedactor(['ab', 'abcdef'])('x abcdef y').includes('cdef'));
    ok('scrub-then-redact keeps the marker intact (no "«redacted»]" mangling)', !/«redacted»\]/.test(scrubThenRedact({ redact: red }, 'PASS=hunter2 and more')) && /redacted/.test(scrubThenRedact({ redact: red }, 'PASS=hunter2 and more')));
    process.env.HTTPS_PROXY = 'http://proxyuser:proxypass@proxy.local:3128';
    const ceP = childEnv({});
    ok('proxy credentials inside an allowlisted proxy URL are redacted too', ceP.injected.includes('proxyuser:proxypass'));
    delete process.env.HTTPS_PROXY;
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
      vettedReadOnly: { by: 'Vikas', date: '2026-09-05', why: 'test stub — read-only by construction', toolNames: ['lookup'] },
      env: { STUB_LITERAL: 'from-${CW13_TEST_DIR}' },
      envFrom: { STUB_MAPPED_SECRET: 'CW13_PARENT_SECRET', STUB_MISSING: 'CW13_PARENT_UNSET' },
      maxTextChars: 300,
    });
    await mcp.connectAll();
    const st = mcp.status();
    ok('status shows the vetting record (who / when / why)', st.servers[0].vettedReadOnly && st.servers[0].vettedReadOnly.by === 'Vikas' && st.servers[0].vettedReadOnly.date === '2026-09-05');
    ok('status reports the missing mapped var by NAME only', Array.isArray(st.servers[0].envMissing) && st.servers[0].envMissing.join() === 'STUB_MISSING');
    ok('…and never a value', !JSON.stringify(st).includes('hunter2'));
    const r = await mcp.callTool({ server: 'noannot', tool: 'lookup', args: { query: 'sw1' } });
    ok('the un-annotated tool now auto-runs as a read (real stub result, not invented)', r.ok === true && /^lookup:sw1 /.test(r.text), JSON.stringify(r));
    ok('the child received the mapped credential (present); the EXPANDED literal reached the child but is redacted from the result text', /mapped=present/.test(r.text) && /literal=\[redacted\]/.test(r.text), r.text);
    ok('the credential VALUE is not in the result (the stub never echoes it)', !r.text.includes('hunter2'));
    ok('LIVE BOUNDARY: the spawned child could NOT see ANTHROPIC_API_KEY, the parent var, or an unmapped canary — and still had PATH', /leaked=none/.test(r.text) && /path=yes/.test(r.text), r.text);
    ok('status shows the vetting record with its tool list and pinned:false, and the declared-write tool as unvetted', st.servers[0].vettedReadOnly.toolNames.join() === 'lookup' && st.servers[0].vettedReadOnly.pinned === false && (st.servers[0].unvettedTools || []).join() === 'wipe');
    const big = await mcp.callTool({ server: 'noannot', tool: 'lookup', args: { query: 'big', big: 2000 } });
    ok('a result over maxTextChars is clipped WITH an honest marker (review #5)', big.ok === true && big.truncated === true && /\[truncated: showing 300 of \d+ characters — the result above is INCOMPLETE/.test(big.text) && big.text.indexOf('[truncated') >= 300);
    const small = await mcp.callTool({ server: 'noannot', tool: 'lookup', args: { query: 'small' } });
    ok('…and a result under the cap carries no marker', small.ok === true && small.truncated === false && !/truncated/.test(small.text));
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
  // 3c. A HOSTILE child that dumps its env to stderr and dies: nothing it saw
  //     is secret (boundary), and nothing it printed reaches status / chat raw.
  {
    process.env.CW13_PARENT_SECRET = 'hunter2';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-canary-never-real-000';
    process.env.MCP_SERVERS = JSON.stringify([{ name: 'leaky', transport: 'stdio', command: process.execPath, args: [LEAKY], enabled: true,
      env: { STUB_LITERAL: 'literal-value-1234' }, envFrom: { STUB_MAPPED_SECRET: 'CW13_PARENT_SECRET' } }]);
    delete process.env.MCP_SERVERS_FILE; mcp._reset();
    await mcp.connectAll();
    const st = mcp.status();
    const sj = JSON.stringify(st);
    ok('the leaky child fails to connect and status says why', st.servers[0].connected === false && /initialize failed|exited/.test(st.servers[0].reason || ''), st.servers[0].reason);
    ok('status carries NEITHER the mapped secret NOR the API key (review #2)', !sj.includes('hunter2') && !sj.includes('sk-ant-test-canary'), sj.slice(0, 300));
    ok('…what it printed is redacted, not merely dropped (the connector\'s [redacted] and/or the scrubber\'s «redacted»)', /(\[redacted\]|«redacted»)/.test(st.servers[0].reason || ''), st.servers[0].reason);
    ok('the child never SAW the API key or the parent name in the first place (boundary — the child reports what it could see)', /parent_key_seen=no/.test(st.servers[0].reason || '') && /parent_name_seen=no/.test(st.servers[0].reason || ''), st.servers[0].reason);
    const g = await mcp.gather('mcp:leaky:anything', 'x');
    ok('the chat-facing finding for a dead server is redacted too', g.stance === 'not-connected' && !g.text.includes('hunter2') && !g.text.includes('sk-ant-test-canary'));
    mcp._reset();
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
      ok('LIVE: the pinned record matches the checkout (no drift), all 10 tools vetted, none unvetted', st.servers[0].vettedReadOnly && st.servers[0].vettedReadOnly.pinned === true && !st.servers[0].vettingDrift && !st.servers[0].unvettedTools, JSON.stringify(st.servers[0]));
      const f = await mcp.callTool({ server: 'netclaw-catc', tool: 'catc_find', args: { query: 'health', limit: 3 } });
      ok('LIVE: catc_find answers from the LOCAL catalogue (no appliance)', f.ok === true && /"outcome": "ok"/.test(f.text) && /LOCAL catalogue/.test(f.text), f.text && f.text.slice(0, 200));
      // real operation names from the catalogue (review #6): api_* names
      const REAL = 'api_countDevicesEnergy';
      const dv = await mcp.callTool({ server: 'netclaw-catc', tool: 'catc_devices', args: { operation: REAL, params: {} } });
      ok('LIVE: a REAL device operation with no appliance configured → outcome not_configured, no data', dv.ok === true && /"outcome": "not_configured"/.test(dv.text) && !/"data"/.test(dv.text), dv.text && dv.text.slice(0, 200));
      const near = await mcp.callTool({ server: 'netclaw-catc', tool: 'catc_describe_operation', args: { operation: REAL } });
      ok('LIVE: describe works for the real operation name (outcome ok, method GET)', near.ok === true && /"outcome": "ok"/.test(near.text) && /"method": "GET"/.test(near.text), near.text && near.text.slice(0, 200));
      const wide = await mcp.callTool({ server: 'netclaw-catc', tool: 'catc_find', args: { query: 'device', limit: 40 } });
      ok('LIVE: a 40-hit catalogue search fits under the example\'s maxTextChars (12000) — no clip', wide.ok === true && wide.truncated === false, String(wide.text.length));
      mcp._reset();
      // a dead appliance → unreachable, honestly, no data, no password anywhere
      process.env.DNAC_HOST = 'https://127.0.0.1:9'; process.env.DNAC_USER = 'u'; process.env.DNAC_PASS = 'p@ss-never-real-1';
      process.env.MCP_SERVERS = JSON.stringify([Object.assign({}, catc, { enabled: true })]);
      mcp._reset(); await mcp.connectAll();
      const st2 = mcp.status();
      ok('LIVE: with DNAC_* set, nothing is reported missing', !st2.servers[0].envMissing);
      const dead = await mcp.callTool({ server: 'netclaw-catc', tool: 'catc_devices', args: { operation: REAL, params: {} } });
      ok('LIVE: a dead appliance → outcome unreachable, no data, "NOT AN EMPTY RESULT"', dead.ok === true && /"outcome": "unreachable"/.test(dead.text) && !/"data"/.test(dead.text) && /NOT AN EMPTY RESULT/.test(dead.text), dead.text && dead.text.slice(0, 200));
      ok('LIVE: the password never appears in the result or status', !dead.text.includes('p@ss-never-real-1') && !JSON.stringify(st2).includes('p@ss-never-real-1'));
      ok('LIVE: the APPLIANCE stamp is the configured host, not [redacted] (round 2 #1)', /"appliance": "https:\/\/127\.0\.0\.1:9"/.test(dead.text) && /Catalyst Center at https:\/\/127\.0\.0\.1:9 could not be reached/.test(dead.text), dead.text && dead.text.slice(0, 300));
      delete process.env.DNAC_HOST; delete process.env.DNAC_USER; delete process.env.DNAC_PASS;
      mcp._reset();
    }
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
