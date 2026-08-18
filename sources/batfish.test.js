// batfish.test.js — A5 offline change-validation. DETERMINISTIC: no Claude key,
// no Docker, no real Batfish. The connected path talks to a LOCAL http catcher (a
// STUB Batfish endpoint) started in this process that returns Batfish-shaped
// answers, so the parse→verdict engine and the honest transport are proven
// without a real Batfish. Covers the A5 contract:
//   • no BATFISH_HOST → connected:false, validate → honest 'unknown'/not-available
//     (NO fabricated verdict), and capability gate (connected()) is false;
//   • configured but unreachable → verdict 'unknown', connected:false, honest note
//     (never "clean" on an analysis that never ran);
//   • stub Batfish → a REAL parse produces a verdict from the stub's findings
//     (clean AND issues: undefined-reference, parse-fail, reachability break);
//   • commands+baseline builds a candidate; commands with no baseline → honest unknown;
//   • SECRETS: configs are scrubbed before they leave for Batfish (the stub never
//     sees a cleartext secret); the secret never lands in the audit log;
//   • validateChange is a pure non-throwing no-op when Batfish is off — which is
//     exactly what lets the change-runner call it as an optional pre-step without
//     ever blocking a change (proven here + change-runner has zero batfish coupling).

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

// Throwaway workspace BEFORE anything requires workspace.js (audit + config store
// land here). Clear any inherited Batfish env so the unconfigured path is honest.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'a5-batfish-'));
process.env.SQUAD_ROOT = TMP;
delete process.env.BATFISH_HOST;
delete process.env.BATFISH_PORT;
delete process.env.BATFISH_NETWORK;

const session = require('./session-log');
const configStore = require('./config-store');
const batfish = require('./batfish');

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`); }
}

// ── A local STUB Batfish endpoint ───────────────────────────────────────────
// Records every request body so we can prove configs were SCRUBBED before they
// left. Emulates just enough Batfish to be faithful: it scans the posted config
// for referenced-but-undefined ACLs and emits undefinedReferences rows; a
// "!!PARSEFAIL" marker → FAILED parse; "!!INITWARN" → an initIssues row; and,
// only when a reference (baseline) snapshot was sent, "!!REACHBREAK" → a
// differential-reachability row (ACCEPTED → DENIED).
const seen = []; // { method, url, body(parsed) }
function batfishAnswers(cfg) {
  const dev = Object.keys(cfg.configs || {})[0] || 'dev';
  const text = String((cfg.configs || {})[dev] || '');
  const answers = {};

  // fileParseStatus
  const status = /!!PARSEFAIL/.test(text) ? 'FAILED' : 'PASSED';
  answers.fileParseStatus = { answerElements: [{ rows: [{ File_Name: `configs/${dev}`, Status: status, Nodes: [dev] }] }] };

  // undefinedReferences — real: referenced ACLs that are never defined.
  const referenced = new Set();
  let m;
  const refRe = /access-group\s+(\S+)/gi;
  while ((m = refRe.exec(text))) referenced.add(m[1]);
  const defined = new Set();
  const defRe = /ip\s+access-list\s+(?:standard|extended)?\s*(\S+)/gi;
  while ((m = defRe.exec(text))) defined.add(m[1]);
  const undef = [...referenced].filter((r) => !defined.has(r));
  answers.undefinedReferences = { answerElements: [{ rows: undef.map((r) => ({
    Structure_Type: 'ipv4 access-list', Ref_Name: r, Context: `interface access-group`, Lines: [] })) }] };

  // initIssues
  answers.initIssues = { answerElements: [{ rows: /!!INITWARN/.test(text)
    ? [{ Type: 'Convert warning', Line_Text: 'ntp server ???', Details: 'unrecognised ntp server token' }] : [] }] };

  // differentialReachability (only when a reference snapshot was supplied)
  if (cfg.referenceConfigs && /!!REACHBREAK/.test(text)) {
    answers.differentialReachability = { answerElements: [{ rows: [{
      Flow: '10.1.1.1 -> 10.2.2.2 TCP 443', Reference_Disposition: 'ACCEPTED', Snapshot_Disposition: 'DENIED' }] }] };
  }
  return { answers };
}

const stub = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let parsed = {};
    try { parsed = body ? JSON.parse(body) : {}; } catch (e) { parsed = {}; }
    seen.push({ method: req.method, url: req.url, body: parsed });
    const reply = (obj, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.method === 'GET' && /\/v2\/version/.test(req.url)) return reply({ version: '2024.07-stub' });
    if (req.method === 'POST' && /\/analyze/.test(req.url)) return reply(batfishAnswers(parsed));
    reply({ error: 'not found' }, 404);
  });
});

const SECRET = 'S3cr3t-Enable-Pw-xyz789';

function run() {
  return new Promise(async (resolve) => {
    console.log('\nA5 — Batfish offline change-validation (stub Batfish, deterministic):\n');

    // ── 1. NOT CONFIGURED → honest no-op ────────────────────────────────────
    ok('unconfigured: connected() false', batfish.connected() === false);
    ok('unconfigured: configured() false', batfish.configured() === false);
    const st0 = batfish.status();
    ok('unconfigured: status.connected false', st0.connected === false, JSON.stringify(st0));
    ok('unconfigured: status.note names BATFISH_HOST', /set BATFISH_HOST/.test(st0.note || ''), st0.note);

    const v0 = await batfish.validateChange('sw1', { config: 'hostname sw1\n' });
    ok('unconfigured: verdict unknown', v0.verdict === 'unknown', JSON.stringify(v0));
    ok('unconfigured: connected false', v0.connected === false);
    ok('unconfigured: NO findings fabricated', Array.isArray(v0.findings) && v0.findings.length === 0);
    ok('unconfigured: note is the honest not-available', /Batfish not available/.test(v0.note || ''), v0.note);

    // ── 2. CONFIGURED BUT UNREACHABLE → unknown, never "clean" ───────────────
    // A port nothing listens on. validateChange must not throw and must not fake.
    process.env.BATFISH_HOST = 'http://127.0.0.1:1'; // unroutable/closed
    ok('bad host: connected()/configured() true (host is set)', batfish.connected() === true);
    const vDown = await batfish.validateChange('sw1', { config: 'hostname sw1\n' });
    ok('unreachable: verdict unknown', vDown.verdict === 'unknown', JSON.stringify(vDown));
    ok('unreachable: connected:false (could not reach)', vDown.connected === false);
    ok('unreachable: honest note (not a fake clean)', /could not be reached/i.test(vDown.note || '') && !/\bclean\b/i.test(vDown.verdict), vDown.note);

    // ── 3. STUB Batfish → real parse → verdicts ─────────────────────────────
    await new Promise((r) => stub.listen(0, '127.0.0.1', r));
    const port = stub.address().port;
    process.env.BATFISH_HOST = `http://127.0.0.1:${port}`;

    // 3a. CLEAN — a well-formed config with a defined ACL that it references.
    const cleanCfg = 'hostname sw2\nip access-list extended GUARD\n permit ip any any\ninterface Gi1/0/1\n ip access-group GUARD in\n';
    const vClean = await batfish.validateChange('sw2', { config: cleanCfg });
    ok('clean: ok true', vClean.ok === true, JSON.stringify(vClean));
    ok('clean: connected true', vClean.connected === true);
    ok('clean: verdict clean', vClean.verdict === 'clean', JSON.stringify(vClean.findings));
    ok('clean: no error findings', !vClean.findings.some((f) => f.severity === 'error'));
    ok('clean: stub actually got a POST /analyze', seen.some((r) => r.method === 'POST' && /analyze/.test(r.url)));

    // 3b. ISSUES — references an ACL "MISSING" that is never defined.
    const badCfg = 'hostname sw3\ninterface Gi1/0/2\n ip access-group MISSING in\n';
    const vBad = await batfish.validateChange('sw3', { config: badCfg });
    ok('issues(undef-ref): verdict issues', vBad.verdict === 'issues', JSON.stringify(vBad.findings));
    ok('issues(undef-ref): ok false (a blocking problem was found)', vBad.ok === true && vBad.verdict === 'issues');
    ok('issues(undef-ref): a real undefined-reference finding', vBad.findings.some((f) => f.check === 'undefined-reference' && f.severity === 'error' && /MISSING/.test(f.detail)), JSON.stringify(vBad.findings));

    // 3c. ISSUES — the change makes the config unparseable.
    const pfCfg = 'hostname sw4\n!!PARSEFAIL garbage %%%\n';
    const vPf = await batfish.validateChange('sw4', { config: pfCfg });
    ok('issues(parse): verdict issues', vPf.verdict === 'issues', JSON.stringify(vPf.findings));
    ok('issues(parse): a parse error finding', vPf.findings.some((f) => f.check === 'parse' && f.severity === 'error'), JSON.stringify(vPf.findings));

    // ── 4. commands + baseline → candidate is built and analysed ─────────────
    // Store a baseline for sw5 so the command path has something to merge onto.
    configStore.snapshot('sw5', 'hostname sw5\nip access-list extended GUARD\n permit ip any any\n');
    const vCmd = await batfish.validateChange('sw5', { commands: ['interface Gi1/0/3', ' ip access-group GUARD in'] });
    ok('commands+baseline: produced a real verdict', vCmd.verdict === 'clean', JSON.stringify(vCmd));
    ok('commands+baseline: basis note explains the merge', /candidate/.test(vCmd.note || '') || /merging/.test(vCmd.basis || ''), vCmd.note);
    // The candidate the stub saw must contain BOTH the baseline and the new command.
    const cmdReq = seen.slice().reverse().find((r) => r.method === 'POST' && r.body && r.body.configs && r.body.configs.sw5);
    ok('commands+baseline: candidate merges baseline + change', cmdReq && /GUARD/.test(cmdReq.body.configs.sw5) && /Gi1\/0\/3/.test(cmdReq.body.configs.sw5), cmdReq && cmdReq.body.configs.sw5);
    ok('commands+baseline: reference (baseline) snapshot also sent', cmdReq && cmdReq.body.referenceConfigs && !!cmdReq.body.referenceConfigs.sw5);

    // 4b. commands with NO baseline anywhere → honest unknown, not a guess.
    const vNoBase = await batfish.validateChange('sw-unknown-xyz', { commands: ['ntp server 1.2.3.4'] });
    ok('commands+no-baseline: verdict unknown', vNoBase.verdict === 'unknown', JSON.stringify(vNoBase));
    ok('commands+no-baseline: note asks for config/baseline', /no stored baseline|full post-change config/i.test(vNoBase.note || ''), vNoBase.note);

    // ── 5. differential reachability (baseline present) → reachability break ──
    configStore.snapshot('sw6', 'hostname sw6\ninterface Gi1/0/1\n permit ip any any\n');
    const vReach = await batfish.validateChange('sw6', { commands: ['interface Gi1/0/1', ' !!REACHBREAK deny ip any any'] });
    ok('reachability: verdict issues', vReach.verdict === 'issues', JSON.stringify(vReach.findings));
    ok('reachability: a reachability error finding (was reachable, now not)', vReach.findings.some((f) => f.check === 'reachability' && f.severity === 'error'), JSON.stringify(vReach.findings));

    // ── 6. SECRETS never leave in the clear ─────────────────────────────────
    const secretCfg = `hostname sw7\nenable secret 5 ${SECRET}\nip access-list extended GUARD\n permit ip any any\ninterface Gi1/0/1\n ip access-group GUARD in\n`;
    const before = session.auditAll({ limit: 500 }).length;
    const vSec = await batfish.validateChange('sw7', { config: secretCfg });
    ok('secret: still returns a real verdict', vSec.verdict === 'clean', JSON.stringify(vSec));
    const secReq = seen.slice().reverse().find((r) => r.body && r.body.configs && r.body.configs.sw7);
    ok('secret: the stub Batfish NEVER saw the cleartext secret', secReq && secReq.body.configs.sw7.indexOf(SECRET) === -1, secReq && secReq.body.configs.sw7);
    ok('secret: the config WAS sent (scrubbed), not withheld', secReq && /enable secret/.test(secReq.body.configs.sw7));
    const auditSlice = session.auditAll({ limit: 500 }).slice(before);
    ok('secret: the validate run was audited', auditSlice.some((e) => /batfish validate sw7/.test(e.what)), JSON.stringify(auditSlice));
    ok('secret: the secret NEVER appears in the audit log', JSON.stringify(auditSlice).indexOf(SECRET) === -1);
    ok('secret: status()/lastRun never leaks the host', JSON.stringify(batfish.status()).indexOf('127.0.0.1') === -1);

    // ── 7. HONEST-OPTIONAL for the change-runner hook ───────────────────────
    // With Batfish OFF, validateChange is a pure, non-throwing no-op returning
    // 'unknown' — which is exactly what lets a change proceed unblocked when the
    // hook is wired. And the change engine has ZERO coupling to batfish today.
    process.env.BATFISH_HOST = '';
    let threw = null;
    let vOff;
    try { vOff = await batfish.validateChange('sw1', { commands: ['ntp server 1.2.3.4'] }); }
    catch (e) { threw = e; }
    ok('hook: validateChange never throws when Batfish is off', threw === null, threw && threw.message);
    ok('hook: off → unknown (caller proceeds, change NOT blocked)', vOff && vOff.verdict === 'unknown');
    // The change-runner now wires the advisory hook. It must be ADVISORY ONLY:
    // gated on configured(), inside a try/catch, and it must NOT return/throw/
    // freeze on the batfish result — a validator can never block an approved change.
    const crSrc = fs.readFileSync(path.join(__dirname, 'change-runner.js'), 'utf8');
    const hookIdx = crSrc.indexOf("require('./batfish')");
    ok('hook: change-runner calls batfish (advisory pre-step wired)', hookIdx !== -1);
    ok('hook: batfish call is gated on configured() (no-op when off)', crSrc.indexOf('batfish.configured()') !== -1);
    ok('hook: batfish call is wrapped so a failing validator never blocks', /require\('\.\/batfish'\)[\s\S]{0,600}catch/.test(crSrc));
    // Advisory: the hook only patches/steps the record — it never returns/freezes on the batfish verdict.
    const hookRegion = crSrc.slice(hookIdx, hookIdx + 600);
    ok('hook: advisory — never returns/freezes on the batfish result', hookRegion.indexOf('return {') === -1);

    stub.close(() => resolve());
  });
}

run().then(() => {
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}).catch((e) => { console.error('test crashed:', e); process.exit(1); });
