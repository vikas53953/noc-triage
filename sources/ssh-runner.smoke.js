// Smoke test for the direct SSH runner. Runs REAL SSH round-trips through the
// Node client path (ssh-runner.js -> ssh_sidecar.py) — never the Python script
// directly, so it proves the whole chain. Reads creds only from .env.local.
//
//   node sources/ssh-runner.smoke.js
//
// It NEVER fabricates: an unreachable box or bad password prints the honest
// failure and kind. Once you paste current DevNet reservation creds into
// .env.local, `show version` returns real device output here.
require('./env');
const ssh = require('./ssh-runner');

async function show(title, deviceKey, command) {
  const r = await ssh.runShow(deviceKey, command);
  console.log(`\n== ${title} ==`);
  console.log(`device=${deviceKey} command="${command}" ok=${r.ok} kind=${r.kind || '-'} engine=${r.engine || '-'} elapsed=${r.elapsed || '-'}s`);
  if (r.ok) {
    console.log(r.text.split(/\r?\n/).slice(0, 16).join('\n'));
  } else {
    console.log('error:', r.error);
  }
}

(async () => {
  console.log('SSH devices this host can serve (transport: ssh, creds set):');
  console.log(JSON.stringify(ssh.listSshDevices(), null, 2));

  // 1. Real read over SSH. Needs current creds in .env.local.
  await show('real show version — IOS-XE always-on', 'iosxe-always-on', 'show version');
  await show('real show version — NX-OS always-on', 'nxos-always-on', 'show version');
  await show('real show version — IOS-XR always-on', 'iosxr-always-on', 'show version');

  // 2. Write refused by the guardrail BEFORE the wire.
  await show('refused config command', 'iosxe-always-on', 'configure terminal');

  // 3. Honest unreachable — a device whose host does not resolve.
  process.env.SSH_IOSXE_HOST = 'no-such-host.invalid.example';
  await show('honest unreachable (bogus host)', 'iosxe-always-on', 'show version');

  // 4. Routing: a DNAC switch is not SSH-reachable — stays on Command Runner.
  await show('routing refusal — DNAC switch', 'sw1', 'show version');
})();
