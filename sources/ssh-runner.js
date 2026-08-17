// SSH runner — direct read-only CLI to DIRECTLY-REACHABLE devices.
//
// This is the SSH half of "read-only against real kit". It exists ALONGSIDE the
// Catalyst Center Command Runner path (sources/catalyst-center.js), not instead
// of it. The device registry below makes the routing explicit per device:
//
//   transport: 'ssh'             → reachable over SSH from this host; runs here.
//   transport: 'command-runner'  → private behind Catalyst Center (e.g. the DNAC
//                                  sandbox switches sw1-sw4, 10.10.20.x). Those
//                                  are NOT SSH-reachable from this machine and
//                                  STAY on the Command Runner path. This module
//                                  refuses them out loud rather than pretending.
//
// The Node side owns the guardrail (sources/guardrails.js) and applies it BEFORE
// spawning Python — a write never reaches the sidecar. Credentials live only in
// env (.env.local); they are handed to the sidecar on stdin (never argv, never
// logged) and this module logs command + lengths, never secret values.
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { checkCommand } = require('./guardrails');
// Reuse the config-line secret redactor config-store already applies to running
// configs, so a config pulled over SSH is redacted exactly like one pulled via
// Command Runner — one rulebook, not two that can drift.
const { scrubConfig } = require('./config-store');

const REPO_ROOT = path.resolve(__dirname, '..');
const SIDECAR = path.join(__dirname, 'ssh_sidecar.py');

// Node-side ceilings. The sidecar truncates device output at its own cap; these
// are the belt-and-braces limits on what this process is willing to hold.
const MAX_STDOUT_BYTES = 2 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;

// The watchdog must be a small margin over the SSH timeout the sidecar was
// given, not a flat +45s. With the old floor a caller asking for a 2s timeout
// waited 47s — long enough to wreck the SLA clocks this app exists to keep.
const WATCHDOG_MARGIN_MS = 8000;

// Cap concurrent sidecar processes. Each dial is a Python interpreter plus an
// SSH session; an unbounded fan-out (a P1 running every front in parallel)
// would spawn as many as the queue holds.
const MAX_CONCURRENT = Number(process.env.SSH_MAX_CONCURRENT || 4);
let inFlight = 0;
const waiting = [];

function acquireSlot() {
  if (inFlight < MAX_CONCURRENT) { inFlight++; return Promise.resolve(); }
  return new Promise((resolve) => waiting.push(resolve));
}

function releaseSlot() {
  const next = waiting.shift();
  if (next) next();
  else inFlight--;
}

// Resolve the venv Python created for the sidecar. Override with SSH_PYTHON.
function resolvePython() {
  if (process.env.SSH_PYTHON) return process.env.SSH_PYTHON;
  const candidates = [
    path.join(REPO_ROOT, '.venv', 'Scripts', 'python.exe'), // Windows venv
    path.join(REPO_ROOT, '.venv', 'bin', 'python3'),        // POSIX venv
    path.join(REPO_ROOT, '.venv', 'bin', 'python'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

// ── Device registry ─────────────────────────────────────────────────────────
// Each entry declares HOW a device is reached. SSH devices pull host/user/pass
// from env so no credential is ever baked into this (public) source. The DNAC
// switches are listed too, explicitly on the command-runner path, so the
// routing decision is data, not a scattered if-statement.
const REGISTRY = {
  // Directly-reachable always-on DevNet sandbox — the primary SSH target.
  'iosxe-always-on': {
    label: 'DevNet always-on IOS-XE (public sandbox)',
    transport: 'ssh',
    platform: 'iosxe',
    host: () => process.env.SSH_IOSXE_HOST,
    port: () => Number(process.env.SSH_IOSXE_PORT || 22),
    username: () => process.env.SSH_IOSXE_USER,
    password: () => process.env.SSH_IOSXE_PASS,
  },
  // Second directly-reachable always-on sandbox (Nexus / NX-OS). Optional — set
  // SSH_NXOS_* to enable. Kept so the SSH path is not a single-box special case.
  'nxos-always-on': {
    label: 'DevNet always-on NX-OS (public sandbox)',
    transport: 'ssh',
    platform: 'nxos',
    host: () => process.env.SSH_NXOS_HOST,
    port: () => Number(process.env.SSH_NXOS_PORT || 22),
    username: () => process.env.SSH_NXOS_USER,
    password: () => process.env.SSH_NXOS_PASS,
  },
  // Third directly-reachable always-on sandbox (IOS XR). Optional — set
  // SSH_IOSXR_* to enable. Note its SSH port is 8181, not 22.
  'iosxr-always-on': {
    label: 'DevNet always-on IOS-XR (public sandbox)',
    transport: 'ssh',
    platform: 'iosxr',
    host: () => process.env.SSH_IOSXR_HOST,
    port: () => Number(process.env.SSH_IOSXR_PORT || 22),
    username: () => process.env.SSH_IOSXR_USER,
    password: () => process.env.SSH_IOSXR_PASS,
  },
  // DNAC sandbox switches — NOT SSH-reachable from here (private, 10.10.20.x
  // behind Catalyst Center). Declared so the routing is explicit: these stay on
  // the Command Runner path. runShow() refuses them with that instruction.
  sw1: { label: 'DNAC sw1', transport: 'command-runner', mgmtIp: '10.10.20.175' },
  sw2: { label: 'DNAC sw2', transport: 'command-runner', mgmtIp: '10.10.20.176' },
  sw3: { label: 'DNAC sw3', transport: 'command-runner', mgmtIp: '10.10.20.177' },
  sw4: { label: 'DNAC sw4', transport: 'command-runner', mgmtIp: '10.10.20.178' },
};

function getDevice(key) {
  return REGISTRY[key] || null;
}

// Which devices can this SSH path actually serve right now (transport ssh AND
// their env creds are set)? Used by callers/UI to know what is wired.
function listSshDevices() {
  return Object.entries(REGISTRY)
    .filter(([, d]) => d.transport === 'ssh')
    .map(([key, d]) => ({
      key,
      label: d.label,
      platform: d.platform,
      host: d.host() || null,
      configured: Boolean(d.host() && d.username() && d.password()),
    }));
}

// ── Secret scrubbing ────────────────────────────────────────────────────────
// Derived from the REGISTRY, never a hand-typed list. The previous version
// named two passwords while the registry declared three devices, so the third
// device's password went out in cleartext on the error path — and straight into
// chat, the activity log and chat-store persistence. A hand-list is guaranteed
// to fall behind the registry the day a fourth device is added; deriving it
// means every declared credential is covered automatically.
const REDACTED = '«redacted»';
// Values shorter than this are skipped: replacing them mangles unrelated text
// ("s****awn ... ****ython.exe") and, worse, the mangling reveals the secret's
// length. A credential that short is not protectable by scrubbing anyway.
const MIN_SCRUBBABLE = 6;

function secretValues() {
  const out = new Set();
  for (const device of Object.values(REGISTRY)) {
    if (device.transport !== 'ssh') continue;
    // Passwords AND usernames — a username is a credential half.
    for (const get of [device.password, device.username]) {
      if (typeof get !== 'function') continue;
      const v = get();
      if (v && String(v).length >= MIN_SCRUBBABLE) out.add(String(v));
    }
  }
  return out;
}

// Replace each secret by EXACT value match with a fixed-width token. The token
// is constant, so it leaks no length information.
function scrub(s) {
  let out = String(s || '');
  // Longest first, so a password that contains another value is redacted whole.
  const values = [...secretValues()].sort((a, b) => b.length - a.length);
  for (const v of values) out = out.split(v).join(REDACTED);
  return out;
}

// Minimal env for the sidecar. It needs an interpreter environment and nothing
// else — every credential it uses arrives on stdin. Handing it the parent's
// whole env would put ANTHROPIC_API_KEY and the DNAC/ACI/SDWAN credentials
// inside a process that dials an external host, for no reason at all. This is
// an allowlist, so a secret added to .env.local later is excluded by default.
function childEnvForSidecar() {
  const env = {
    PATH: process.env.PATH,
    SYSTEMROOT: process.env.SYSTEMROOT,   // Windows: sockets fail without it
    SystemRoot: process.env.SystemRoot,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE, // locates ~/.ssh/known_hosts
    PYTHONIOENCODING: 'utf-8',
    PYTHONUNBUFFERED: '1',
  };
  for (const k of Object.keys(env)) {
    if (env[k] === undefined) delete env[k];
  }
  return env;
}

// Spawn the sidecar once, feed the request on stdin, parse the one-line JSON.
function callSidecar(payload, timeoutMs) {
  return new Promise((resolve) => {
    const python = resolvePython();
    if (!python) {
      return resolve({ ok: false, error: 'SSH sidecar Python venv not found — create .venv and pip install scrapli netmiko (see .env.example)', kind: 'error' });
    }
    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (obj) => { if (!done) { done = true; resolve(obj); } };

    const child = spawn(python, [SIDECAR], { cwd: REPO_ROOT, env: childEnvForSidecar() });
    const timer = setTimeout(() => {
      try { child.kill(); } catch (e) { /* ignore */ }
      finish({ ok: false, error: 'SSH sidecar timed out', kind: 'unreachable' });
    }, timeoutMs);

    // Cap what we accumulate. The sidecar already truncates device output, but
    // Node must not be willing to grow an unbounded string on a runaway child.
    child.stdout.on('data', (d) => {
      if (stdout.length < MAX_STDOUT_BYTES) stdout += d;
      else if (!done) {
        try { child.kill(); } catch (e) { /* ignore */ }
        finish({ ok: false, error: 'SSH sidecar produced more output than the cap allows', kind: 'error' });
      }
    });
    child.stderr.on('data', (d) => {
      if (stderr.length < MAX_STDERR_BYTES) stderr += d;
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      finish({ ok: false, error: `SSH sidecar failed to start: ${e.message}`, kind: 'error' });
    });
    child.on('close', () => {
      clearTimeout(timer);
      const line = stdout.trim().split(/\r?\n/).filter(Boolean).pop() || '';
      try {
        finish(JSON.parse(line));
      } catch (e) {
        finish({ ok: false, error: scrub(`SSH sidecar gave no readable output. ${stderr}`).trim(), kind: 'error' });
      }
    });

    // Credentials go on stdin, NOT argv (argv is visible in process listings).
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

// Run a read-only command against a registry device over SSH.
// Returns, matching the Command Runner path's buckets:
//   { ok:true,  device, command, text, engine, elapsed }
//   { ok:false, device, command, error, kind }   — never throws, never fabricates.
async function runShow(deviceKey, command, opts = {}) {
  const device = getDevice(deviceKey);
  if (!device) {
    return { ok: false, device: deviceKey, command, error: `unknown device "${deviceKey}"`, kind: 'error' };
  }

  // Explicit routing: SSH runner only serves SSH-transport devices.
  if (device.transport !== 'ssh') {
    return {
      ok: false, device: deviceKey, command, kind: 'routing',
      error: `${device.label} is not SSH-reachable from here — it stays on the Catalyst Center Command Runner path (transport: ${device.transport}).`,
    };
  }

  // Guardrail FIRST, before any process is spawned or wire is touched.
  const verdict = checkCommand(command);
  if (!verdict.allowed) {
    return { ok: false, device: deviceKey, command, error: verdict.reason, kind: 'blocked' };
  }

  const host = device.host();
  const username = device.username();
  const password = device.password();
  if (!host || !username || !password) {
    return {
      ok: false, device: deviceKey, command, kind: 'not-connected',
      error: `${device.label} not connected — SSH creds for "${deviceKey}" are not set in .env.local.`,
    };
  }

  const payload = {
    host, port: device.port(), username, password,
    platform: device.platform, command: verdict.command,
    timeout: Number(opts.timeout || process.env.SSH_TIMEOUT || 30),
    // Host-key policy. Default 'auto': strict once a host is pinned in
    // known_hosts, permissive on first contact so a throwaway public sandbox
    // still works. Set SSH_STRICT_KEY=1 the moment a REAL device credential
    // goes into .env.local — without it an on-path impostor harvests the
    // password on the first dial.
    strict_key: opts.strictKey || process.env.SSH_STRICT_KEY || 'auto',
    known_hosts: opts.knownHosts || process.env.SSH_KNOWN_HOSTS || null,
    max_output_bytes: Number(opts.maxOutputBytes || process.env.SSH_MAX_OUTPUT_BYTES || 1024 * 1024),
  };
  const timeoutMs = payload.timeout * 1000 + WATCHDOG_MARGIN_MS;

  await acquireSlot();
  let res;
  try {
    res = await callSidecar(payload, timeoutMs);
  } finally {
    releaseSlot();
  }

  if (res.ok) {
    // Device output is scrubbed too, not just the error path. "show
    // running-config" and "more nvram:startup-config" are allowed reads that
    // return enable secrets, SNMP communities and pre-shared keys, and this
    // text goes on to chat, the activity log and chat-store persistence.
    // scrubConfig is the redactor config-store already uses for exactly this,
    // so both paths redact identically rather than inventing a second rulebook.
    const text = scrub(scrubConfig(res.output || ''));
    return {
      ok: true, device: deviceKey, command: verdict.command, text,
      truncated: Boolean(res.truncated), strictKey: Boolean(res.strictKey),
      engine: res.engine, elapsed: res.elapsed,
    };
  }
  return { ok: false, device: deviceKey, command: verdict.command, error: scrub(res.error), kind: res.kind || 'error' };
}

// Spawn the sidecar interpreter with EXACTLY the env callSidecar uses and ask
// it what it can see. Used by the smoke test to prove from the outside that no
// parent secret (ANTHROPIC_API_KEY, DNAC/ACI/SDWAN creds) reaches the child.
function probeChildEnv() {
  return new Promise((resolve) => {
    const python = resolvePython();
    if (!python) return resolve({});
    const child = spawn(python, ['-c', 'import os,json;print(json.dumps(dict(os.environ)))'],
      { cwd: REPO_ROOT, env: childEnvForSidecar() });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', () => resolve({}));
    child.on('close', () => {
      try { resolve(JSON.parse(out.trim().split(/\r?\n/).pop())); } catch (e) { resolve({}); }
    });
  });
}

module.exports = {
  id: 'ssh-runner',
  label: 'Direct SSH runner',
  REGISTRY,
  getDevice,
  listSshDevices,
  runShow,
  // Exported for the smoke test / reuse — not part of the calling surface.
  scrub,
  resolvePython,
  probeChildEnv,
};
