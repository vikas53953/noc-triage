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

// The sidecar generates its probe set (11 fixed + one per chain char + one per
// control char). Assert a floor explicitly: when a probe silently disappeared,
// the old suite relabelled an assertion instead of failing, so lost coverage
// read as green. Raise this if the generated set legitimately grows.
const MIN_PROBES = 30;

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

  // Compare against the LIVE EXPORTS, never a literal retyped into this test.
  // A previous version compared Python to a hardcoded copy of the chain-char
  // list; dropping ` and $ from guardrails.js left the suite green while
  // `show version $(reboot)` sailed through. Reading the real export is the
  // whole point of the check.
  check('READ_VERBS identical',
    JSON.stringify(py.read_verbs) === JSON.stringify(guardrails.READ_VERBS),
    `python=${py.read_verbs.join(',')} node=${guardrails.READ_VERBS.join(',')}`);

  const nodeChain = [...guardrails.CHAIN_CHAR_LIST].sort();
  check('CHAIN_CHARS identical (vs live guardrails.CHAIN_CHAR_LIST)',
    JSON.stringify(py.chain_chars) === JSON.stringify(nodeChain),
    `python=${JSON.stringify(py.chain_chars)} node=${JSON.stringify(nodeChain)}`);

  check('printable-ASCII range identical (vs live guardrails export)',
    py.printable_ascii[0] === guardrails.PRINTABLE_ASCII_MIN
    && py.printable_ascii[1] === guardrails.PRINTABLE_ASCII_MAX);

  // Every chain char in the LIVE Node list must have a probe on the Python
  // side. Without this, a character present in both lists but untested by any
  // probe has no behavioural coverage at all.
  const probeKeys = Object.keys(py.verdicts);
  const uncovered = guardrails.CHAIN_CHAR_LIST.filter(
    (ch) => !probeKeys.some((p) => p.includes(ch)));
  check('every Node chain char has a probe', uncovered.length === 0,
    uncovered.length ? `uncovered=${JSON.stringify(uncovered)}` : `${guardrails.CHAIN_CHAR_LIST.length} chars covered`);

  // The probe set must not silently shrink. A vanished probe used to relabel
  // an assertion instead of failing it.
  check(`probe count >= ${MIN_PROBES}`, probeKeys.length >= MIN_PROBES,
    `got ${probeKeys.length}`);

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
  check(`all ${probeKeys.length} probes agree across both layers`, mismatches === 0);

  // And the control characters the review found must actually be refused \u2014 in
  // BOTH layers. A missing Python verdict is now a FAILURE, not a silently
  // relabelled "Node only" pass: losing coverage must break the build.
  const controls = {
    NUL: '\x00', SOH: '\x01', BACKSPACE: '\x08', TAB: '\x09', VTAB: '\x0b',
    FORMFEED: '\x0c', ESC: '\x1b', DEL: '\x7f', NEL: '\x85',
    'U+2028': '\u2028', 'U+2029': '\u2029', 'latin-1': '\u00e9',
  };
  for (const [label, ch] of Object.entries(controls)) {
    const probe = `show ver${ch}sion`;
    const nodeBlocked = !guardrails.checkCommand(probe).allowed;
    const hasPyVerdict = Object.prototype.hasOwnProperty.call(py.verdicts, probe);
    const pyBlocked = hasPyVerdict && py.verdicts[probe] !== null;
    check(`${label} blocked in Node + Python`,
      nodeBlocked && hasPyVerdict && pyBlocked,
      hasPyVerdict ? '' : 'NO PYTHON PROBE \u2014 coverage lost');
  }

  // Chain characters must likewise be refused in both layers, driven off the
  // LIVE Node list so a newly added character is covered without editing here.
  for (const ch of guardrails.CHAIN_CHAR_LIST) {
    const probe = `show version${ch}reload`;
    const nodeBlocked = !guardrails.checkCommand(probe).allowed;
    const hasPyVerdict = Object.prototype.hasOwnProperty.call(py.verdicts, probe);
    const pyBlocked = hasPyVerdict && py.verdicts[probe] !== null;
    check(`chain char ${JSON.stringify(ch)} blocked in Node + Python`,
      nodeBlocked && hasPyVerdict && pyBlocked,
      hasPyVerdict ? '' : 'NO PYTHON PROBE \u2014 coverage lost');
  }
}

// ── B. Every registry credential is scrubbed ────────────────────────────────
// These assertions must run on a CLEAN CHECKOUT. The previous version iterated
// the registry's real creds, so with no SSH_* vars set it iterated zero devices
// and quietly asserted nothing — the exact "silently covers nothing" shape as
// the bug it was written to guard. Fixture creds are injected here so the check
// is unconditional; real creds, when present, are tested in addition.
function scrubCheck() {
  console.log('\n== B. credential scrubbing (fixture creds — always runs) ==');

  // Short, deliberately awful defaults. These are the ones value-matching could
  // never protect, and they are the most common real device creds in existence.
  const FIXTURES = [
    ['long password', 'SuperSecretPassw0rd'],
    ['short default "cisco"', 'cisco'],
    ['short default "admin"', 'admin'],
    ['1-char password', 'p'],
  ];

  for (const [label, secret] of FIXTURES) {
    // Structural redaction must catch these whatever their length, in the JSON
    // shape the sidecar request actually takes.
    const json = `SSH sidecar gave no readable output. {"host":"h","username":"${secret}","password":"${secret}","platform":"iosxe"}`;
    const s1 = ssh.scrub(json);
    check(`${label} redacted in JSON fields`, !s1.includes(`"${secret}"`), s1.slice(48, 150));

    // key=value shape too.
    const kv = `connecting with password=${secret} username=${secret}`;
    const s2 = ssh.scrub(kv);
    check(`${label} redacted in key=value`, !s2.includes(`=${secret}`), s2.slice(0, 90));
  }

  // Structural redaction must not eat ordinary prose or unrelated text.
  const plain = `x${'A'.repeat(40)}x`;
  check('scrub does not mangle unrelated text', ssh.scrub(plain) === plain);
  const prose = 'the device rejected the password, check the username spelling';
  check('scrub leaves credential WORDS in prose alone', ssh.scrub(prose) === prose);

  // Additionally — not instead — test whatever real creds are configured.
  let real = 0;
  for (const [key, dev] of Object.entries(ssh.REGISTRY)) {
    if (dev.transport !== 'ssh') continue;
    const p = dev.password && dev.password();
    if (!p) continue;
    real++;
    const sample = `sidecar error for ${key}: {"password":"${p}"}`;
    check(`real cred: ${key} password redacted`, !ssh.scrub(sample).includes(p));
  }
  console.log(`  (real configured devices additionally tested: ${real})`);
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
