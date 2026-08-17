// Smoke test for the direct SSH runner. Runs REAL SSH round-trips through the
// Node client path (ssh-runner.js -> ssh_sidecar.py) — never the Python script
// directly, so it proves the whole chain. Reads creds only from .env.local.
//
//   node sources/ssh-runner.smoke.js
//
// It NEVER fabricates: an unreachable box or bad password prints the honest
// failure and kind. Once current DevNet reservation creds are in .env.local,
// `show version` returns real device output here.
//
// It also asserts the things a review proved were wrong before:
//   A. guardrail PARITY between Node and Python (drift must fail, not sit quiet)
//   B. every registry credential is scrubbed (not a hand-picked subset)
//   C. the sidecar is not handed the parent's secrets
require('./env');
const { spawnSync } = require('child_process');
const path = require('path');
const ssh = require('./ssh-runner');
const guardrails = require('./guardrails');

let failures = 0;
function check(name, pass, detail) {
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
  if (!pass) failures++;
}

async function show(title, deviceKey, command) {
  const r = await ssh.runShow(deviceKey, command);
  console.log(`\n== ${title} ==`);
  console.log(`device=${deviceKey} command=${JSON.stringify(command)} ok=${r.ok} kind=${r.kind || '-'} engine=${r.engine || '-'} elapsed=${r.elapsed || '-'}s`);
  if (r.ok) console.log(r.text.split(/\r?\n/).slice(0, 16).join('\n'));
  else console.log('error:', r.error);
  return r;
}

// ── A. Guardrail parity: ask Python for its rules, compare to Node's ─────────
function parityCheck() {
  console.log('\n== A. guardrail parity (Node vs Python) ==');
  const python = ssh.resolvePython();
  if (!python) return check('sidecar reachable', false, 'no venv python');

  const out = spawnSync(python, [path.join(__dirname, 'ssh_sidecar.py'), '--selftest'], { encoding: 'utf8' });
  let py;
  try {
    py = JSON.parse(out.stdout.trim().split(/\r?\n/).pop());
  } catch (e) {
    return check('sidecar --selftest returned JSON', false, out.stderr.slice(0, 200));
  }

  check('READ_VERBS identical',
    JSON.stringify(py.read_verbs) === JSON.stringify(guardrails.READ_VERBS),
    `python=${py.read_verbs.join(',')} node=${guardrails.READ_VERBS.join(',')}`);

  const nodeChain = ';&|><`$\n\r'.split('').sort();
  check('CHAIN_CHARS identical',
    JSON.stringify(py.chain_chars) === JSON.stringify(nodeChain));

  check('printable-ASCII range identical',
    py.printable_ascii[0] === 0x20 && py.printable_ascii[1] === 0x7e);

  // The real parity test: every probe must get the SAME allow/deny verdict from
  // both layers. This is what fails if someone tightens one side only.
  let mismatches = 0;
  for (const [probe, pyReason] of Object.entries(py.verdicts)) {
    const pyAllowed = pyReason === null;
    const nodeAllowed = guardrails.checkCommand(probe).allowed;
    if (pyAllowed !== nodeAllowed) {
      mismatches++;
      console.log(`      drift on ${JSON.stringify(probe)}: node=${nodeAllowed} python=${pyAllowed}`);
    }
  }
  check(`all ${Object.keys(py.verdicts).length} probes agree across both layers`, mismatches === 0);

  // And the control characters the review found must actually be refused.
  const controls = {
    NUL: '\x00', SOH: '\x01', BACKSPACE: '\x08', VTAB: '\x0b',
    FORMFEED: '\x0c', ESC: '\x1b', NEL: '\x85',
    'U+2028': '\u2028', 'U+2029': '\u2029',
  };
  for (const [label, ch] of Object.entries(controls)) {
    const probe = `show ver${ch}sion`;
    const nodeBlocked = !guardrails.checkCommand(probe).allowed;
    const pyBlocked = py.verdicts[probe] ? true : (py.verdicts[probe] === null ? false : null);
    check(`${label} blocked in Node${pyBlocked === null ? '' : ' + Python'}`,
      nodeBlocked && pyBlocked !== false);
  }
}

// ── B. Every registry credential is scrubbed ────────────────────────────────
function scrubCheck() {
  console.log('\n== B. scrub covers every registry credential ==');
  // Pull the actual declared secrets straight from the registry, the same way
  // scrub() now does, and confirm each is redacted out of a sample string.
  const secrets = [];
  for (const [key, dev] of Object.entries(ssh.REGISTRY)) {
    if (dev.transport !== 'ssh') continue;
    const p = dev.password && dev.password();
    if (p) secrets.push([key, p]);
  }
  for (const [key, secret] of secrets) {
    const sample = `sidecar error for ${key}: {"password":"${secret}"}`;
    const scrubbed = ssh.scrub(sample);
    check(`${key} password redacted`, !scrubbed.includes(secret), scrubbed.slice(0, 90));
  }
  // Fixed token: no length leak.
  const long = ssh.scrub(`x${'A'.repeat(40)}x`);
  check('scrub does not mangle unrelated text', long === `x${'A'.repeat(40)}x`);
}

// ── C. The sidecar must not inherit the parent's secrets ────────────────────
async function envCheck() {
  console.log('\n== C. sidecar env is minimal (no ANTHROPIC_API_KEY / DNAC creds) ==');
  const python = ssh.resolvePython();
  if (!python) return check('sidecar reachable', false, 'no venv python');
  // Ask the sidecar's interpreter what env it can see when spawned the way
  // callSidecar spawns it. Same env construction, proven from the outside.
  const seen = await ssh.probeChildEnv();
  check('ANTHROPIC_API_KEY absent', !('ANTHROPIC_API_KEY' in seen), `keys=${Object.keys(seen).length}`);
  check('DNAC_PASS absent', !('DNAC_PASS' in seen));
  check('SSH_IOSXE_PASS absent', !('SSH_IOSXE_PASS' in seen));
}

(async () => {
  console.log('SSH devices this host can serve (transport: ssh, creds set):');
  console.log(JSON.stringify(ssh.listSshDevices(), null, 2));

  parityCheck();
  scrubCheck();
  await envCheck();

  // 1. Real read over SSH. Needs current creds in .env.local.
  await show('real show version — IOS-XE always-on', 'iosxe-always-on', 'show version');
  await show('real show version — NX-OS always-on', 'nxos-always-on', 'show version');
  await show('real show version — IOS-XR always-on', 'iosxr-always-on', 'show version');

  // 2. Writes refused by the guardrail BEFORE the wire.
  await show('refused config command', 'iosxe-always-on', 'configure terminal');
  await show('refused control char (VTAB)', 'iosxe-always-on', 'show ver\x0bsion; configure terminal');

  // 3. Honest unreachable — a host that does not resolve. Dummy creds are set
  //    so this leg actually DIALS: with creds unset the not-connected check
  //    short-circuits before the host is ever used and the leg passes vacuously,
  //    which is exactly what it did before.
  process.env.SSH_IOSXE_HOST = 'no-such-host.invalid.example';
  process.env.SSH_IOSXE_USER = process.env.SSH_IOSXE_USER || 'dummy-user';
  process.env.SSH_IOSXE_PASS = process.env.SSH_IOSXE_PASS || 'dummy-pass-value';
  const dead = await show('honest unreachable (bogus host, really dialled)', 'iosxe-always-on', 'show version');
  check('bogus host actually dialled (not short-circuited)',
    dead.kind === 'unreachable' || dead.kind === 'dns', `kind=${dead.kind}`);

  // 4. Routing: a DNAC switch is not SSH-reachable — stays on Command Runner.
  await show('routing refusal — DNAC switch', 'sw1', 'show version');

  console.log(`\n${failures === 0 ? 'ALL ASSERTIONS PASSED' : failures + ' ASSERTION(S) FAILED'}`);
  process.exit(failures === 0 ? 0 : 1);
})();
