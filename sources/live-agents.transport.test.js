// CW-5 — transport-routing checks for the ONE choke point (executeDeviceCli).
//
// The claim under test: which transport a device-CLI command runs over is a
// property of the RESOLVED device, read from the ssh-runner registry — never a
// guess from the command text. SSH-transport devices (the DevNet always-on
// sandboxes) go through ssh-runner; the DNAC switches sw1–sw4 stay on Catalyst
// Center Command Runner. The read-only guardrail + permission gate apply to BOTH
// paths at the same choke point.
//
// Deterministic and offline: with no SSH creds in the environment ssh-runner
// returns an honest "not connected" WITHOUT touching the wire, and the Catalyst
// path is spied so no live sandbox is needed. No LLM.
const live = require('./live-agents');
const catalyst = require('./catalyst-center');
const sshRunner = require('./ssh-runner');
const approvals = require('./approvals');

// Make sure no SSH creds leak in from a real .env.local and change the verdict.
for (const k of Object.keys(process.env)) if (/^SSH_(IOSXE|NXOS|IOSXR)_/.test(k)) delete process.env[k];

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`); }
}

const said = [];
live.init({
  agents: { 'config-keeper': { name: 'Config-Keeper', icon: '🔧' } },
  say: (a, t) => said.push(String(t)),
  updateAgentStatus: () => {},
  appendToActivityLog: () => {},
  addTaskToBoard: () => {}, moveTaskOnBoard: () => {},
  broadcast: () => {},
  writeReport: () => 'report.md',
  conversationId: () => `transport-${Math.random()}`,   // fresh memory each ask
});

// ── spies ────────────────────────────────────────────────────────────────────
const CANNED_INVENTORY = [
  { id: 'sw1-id', hostname: 'sw1', ip: '10.10.20.175', platform: 'C9KV', reachability: 'Reachable', software: '17.12.01prd9' },
];
const CANNED_FILE = [{ commandResponses: { SUCCESS: { 'show version': 'Cisco IOS XE Software, Version 17.12.01prd9' } } }];

const orig = {
  getDevices: catalyst.getDevices,
  runShowCommand: catalyst.runShowCommand,
  sshRunShow: sshRunner.runShow,
};
const calls = { getDevices: 0, runShowCommand: [], sshRunShow: [] };
function installSpies({ sshStub } = {}) {
  calls.getDevices = 0; calls.runShowCommand.length = 0; calls.sshRunShow.length = 0;
  catalyst.getDevices = async () => { calls.getDevices++; return CANNED_INVENTORY; };
  catalyst.runShowCommand = async (ids, cmd) => { calls.runShowCommand.push({ ids, cmd }); return CANNED_FILE; };
  sshRunner.runShow = async (key, cmd, o) => {
    calls.sshRunShow.push({ key, cmd, o });
    return sshStub ? sshStub(key, cmd) : orig.sshRunShow.call(sshRunner, key, cmd, o);
  };
}
function restoreSpies() {
  catalyst.getDevices = orig.getDevices;
  catalyst.runShowCommand = orig.runShowCommand;
  sshRunner.runShow = orig.sshRunShow;
}

async function run(request) {
  said.length = 0;
  await live.handle('config-keeper', request);
  await new Promise((r) => setTimeout(r, 60));
  return said.join('\n');
}

(async () => {
  console.log('\nA — resolveDevice: transport is per-device, from the registry:');
  ok('sw1 is NOT an SSH device (stays Command Runner)', sshRunner.resolveDevice('sw1') === null);
  ok('sw4 is NOT an SSH device', sshRunner.resolveDevice('sw4') === null);
  ok('"iosxe" resolves to the SSH sandbox', (sshRunner.resolveDevice('iosxe') || {}).key === 'iosxe-always-on');
  ok('"nexus" alias resolves to the NX-OS sandbox', (sshRunner.resolveDevice('nexus') || {}).key === 'nxos-always-on');

  console.log('\nB — an SSH-transport device with NO creds → honest auth-needed, zero fabrication, no Command Runner call:');
  installSpies();
  let t = await run('show version on iosxe');
  ok('routed to ssh-runner (runShow called for the sandbox key)',
    calls.sshRunShow.length === 1 && calls.sshRunShow[0].key === 'iosxe-always-on', JSON.stringify(calls.sshRunShow));
  ok('the SSH command was exactly "show version"', (calls.sshRunShow[0] || {}).cmd === 'show version');
  ok('did NOT touch the Command Runner inventory', calls.getDevices === 0, `getDevices calls=${calls.getDevices}`);
  ok('did NOT submit to Command Runner', calls.runShowCommand.length === 0);
  ok('says auth/credentials are needed', /auth needed|credentials are not in \.env\.local|cannot log in/i.test(t), t.slice(0, 200));
  ok('promises NO fabricated result', /did not invent a result|never a made-up|nothing was sent/i.test(t), t.slice(0, 200));
  restoreSpies();

  console.log('\nC — with creds present (stubbed real show) → the ssh-runner path runs and renders SSH output:');
  installSpies({ sshStub: () => ({ ok: true, text: 'Cisco IOS XE Software, Version 17.15.01\nuptime is 4 days', engine: 'scrapli', elapsed: 1.3 }) });
  t = await run('run show version on iosxe');
  ok('ssh-runner.runShow was the path invoked', calls.sshRunShow.length === 1 && calls.sshRunShow[0].key === 'iosxe-always-on');
  ok('Command Runner was NOT used', calls.runShowCommand.length === 0 && calls.getDevices === 0);
  ok('the REAL device output is shown', /17\.15\.01/.test(t), t.slice(0, 200));
  ok('the read is credited to direct SSH', /direct SSH/i.test(t), t.slice(0, 400));
  ok('the result is NOT labelled as run via Command Runner', !/via [^\n]*Command Runner/i.test(t), t.slice(0, 400));
  restoreSpies();

  console.log('\nD — a DNAC switch (sw1) STILL routes to Catalyst Center Command Runner, never SSH:');
  installSpies();
  t = await run('show version on sw1');
  ok('Command Runner submit happened for sw1', calls.runShowCommand.length === 1, JSON.stringify(calls.runShowCommand));
  ok('the SSH path was NOT touched', calls.sshRunShow.length === 0);
  ok('real Command Runner output shown (17.12.01prd9)', /17\.12\.01prd9/.test(t), t.slice(0, 200));
  ok('labelled as Command Runner', /Command Runner/i.test(t));
  restoreSpies();

  console.log('\nE — a WRITE on an SSH device is refused BEFORE any wire (guardrail at the choke point):');
  installSpies({ sshStub: () => { throw new Error('SSH must never be dialled for a write'); } });
  t = await run('reload iosxe');
  ok('refused as a change / read-only', /change to the device/i.test(t) && /read-only/i.test(t), t.slice(0, 200));
  ok('SSH was NEVER dialled for the write', calls.sshRunShow.length === 0);
  ok('Command Runner was NEVER called either', calls.runShowCommand.length === 0 && calls.getDevices === 0);
  restoreSpies();

  console.log('\nF — deny mode = ZERO wire on the SSH path too:');
  installSpies({ sshStub: () => { throw new Error('runShow must not run under deny'); } });
  approvals.setMode('deny');
  t = await run('show version on iosxe');
  ok('the read is reported denied', /denied/i.test(t), t.slice(0, 200));
  ok('ssh-runner was NEVER invoked under deny', calls.sshRunShow.length === 0);
  approvals.setMode('auto');
  restoreSpies();

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
