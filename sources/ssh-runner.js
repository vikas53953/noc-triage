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

const REPO_ROOT = path.resolve(__dirname, '..');
const SIDECAR = path.join(__dirname, 'ssh_sidecar.py');

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

function scrub(s) {
  // Never let a stray credential ride out in an error string.
  const parts = [process.env.SSH_IOSXE_PASS, process.env.SSH_NXOS_PASS].filter(Boolean);
  let out = String(s || '');
  for (const p of parts) out = out.split(p).join('****');
  return out;
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

    const child = spawn(python, [SIDECAR], { cwd: REPO_ROOT });
    const timer = setTimeout(() => {
      try { child.kill(); } catch (e) { /* ignore */ }
      finish({ ok: false, error: 'SSH sidecar timed out', kind: 'unreachable' });
    }, timeoutMs);

    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
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
  };
  const timeoutMs = (payload.timeout + 45) * 1000;

  const res = await callSidecar(payload, timeoutMs);
  if (res.ok) {
    return { ok: true, device: deviceKey, command: verdict.command, text: res.output, engine: res.engine, elapsed: res.elapsed };
  }
  return { ok: false, device: deviceKey, command: verdict.command, error: scrub(res.error), kind: res.kind || 'error' };
}

module.exports = {
  id: 'ssh-runner',
  label: 'Direct SSH runner',
  REGISTRY,
  getDevice,
  listSshDevices,
  runShow,
};
