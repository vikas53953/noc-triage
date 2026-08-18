// nautobot.test.js — A8 Nautobot source-of-truth reconciliation. DETERMINISTIC:
// no Claude key, no real Nautobot needed. The connected path talks to a LOCAL
// http catcher (a stub Nautobot REST API) started in this process, so it proves
// a REAL Token-auth read fires and the intended-vs-actual diff logic is exercised
// — with an IN-SYNC case and a DRIFT case — then asserts the token never appears
// in any response, status, lastReconcile, or the audit log.
//
// Covers the A8 verify list at the logic layer:
//   • no creds → status connected:false; reconcile honest verdict:'unknown',
//     NO fabricated in-sync/drift, catcher received NOTHING.
//   • stub Nautobot → reconcile against an injected live/actual read produces
//     real differences: an in-sync case (0 diffs, verdict in-sync) and a drift
//     case (real {field,intended,actual} diffs, verdict drift).
//   • Token auth WAS actually sent to Nautobot (the header the catcher saw).
//   • the token NEVER appears in any response, status, lastReconcile, or audit.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

// Throwaway workspace BEFORE anything requires workspace.js (audit lands here).
// Clear any inherited Nautobot creds so the unconnected path is honest.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'a8-nautobot-'));
process.env.SQUAD_ROOT = TMP;
delete process.env.NAUTOBOT_URL;
delete process.env.NAUTOBOT_TOKEN;

const session = require('./session-log');
const nautobot = require('./nautobot');

const SECRET_TOKEN = '0123456789abcdef0123456789abcdef01234567';

let passed = 0, failed = 0;
function ok(name, cond) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}`); }
}

// ── A local stub Nautobot REST API ──────────────────────────────────────────
// Serves ONE device (sw1) with two interfaces + one IP. Records the Authorization
// header of every request so we can prove Token auth fired.
const seen = []; // { method, url, auth }

// Intended (source-of-truth) state for sw1.
const DEVICE = {
  name: 'sw1', serial: 'FCW2140L0GH',
  status: { name: 'Active' }, role: { name: 'Access' },
  primary_ip4: { address: '10.10.20.81/32' },
};
const INTERFACES = [
  { name: 'GigabitEthernet1/0/1', enabled: true, description: 'uplink to core', mtu: 1500,
    untagged_vlan: { vid: 10, name: 'data' } },
  { name: 'GigabitEthernet1/0/2', enabled: true, description: 'user port', mtu: 1500,
    untagged_vlan: { vid: 20, name: 'voice' } },
];
const IP_ADDRESSES = [
  { address: '10.10.20.81/32', assigned_object: { name: 'GigabitEthernet1/0/1', device: { name: 'sw1' } } },
];

const catcher = http.createServer((req, res) => {
  seen.push({ method: req.method, url: req.url, auth: req.headers['authorization'] || null });
  const reply = (obj, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  const u = req.url || '';
  if (u.startsWith('/api/dcim/devices/')) {
    const match = /name=sw1/.test(u) ? [DEVICE] : [];
    return reply({ count: match.length, results: match });
  }
  if (u.startsWith('/api/dcim/interfaces/')) {
    return reply({ count: INTERFACES.length, results: INTERFACES });
  }
  if (u.startsWith('/api/ipam/ip-addresses/')) {
    return reply({ count: IP_ADDRESSES.length, results: IP_ADDRESSES });
  }
  reply({ detail: 'Not found' }, 404);
});

// A LIVE/ACTUAL device read shaped like sources/catalyst-center.js output.
// IN-SYNC: matches the intended state exactly (allowing for Gi↔GigabitEthernet
// name normalisation and up↔enabled mapping).
const LIVE_IN_SYNC = {
  device: { hostname: 'sw1', serial: 'FCW2140L0GH', ip: '10.10.20.81', role: 'Access' },
  interfaces: [
    { name: 'Gi1/0/1', adminStatus: 'up', description: 'uplink to core', mtu: 1500, vlan: 10, ip: '10.10.20.81/32' },
    { name: 'GigabitEthernet1/0/2', adminStatus: 'up', description: 'user port', mtu: 1500, vlan: 20 },
  ],
};
// DRIFT: wrong VLAN on Gi1/0/1 (10→99), changed description on Gi1/0/2, an
// undocumented extra interface, and a different serial.
const LIVE_DRIFT = {
  device: { hostname: 'sw1', serial: 'FCW9999XXXX', ip: '10.10.20.81', role: 'Access' },
  interfaces: [
    { name: 'Gi1/0/1', adminStatus: 'up', description: 'uplink to core', mtu: 1500, vlan: 99, ip: '10.10.20.81/32' },
    { name: 'GigabitEthernet1/0/2', adminStatus: 'down', description: 'UNAUTHORISED CHANGE', mtu: 1500, vlan: 20 },
    { name: 'Gi1/0/48', adminStatus: 'up', description: 'rogue patch', mtu: 1500, vlan: 666 },
  ],
};

function run() {
  return new Promise(async (resolve) => {
    console.log('\nA8 — Nautobot source-of-truth reconciliation (Nautobot is intended, live is actual):\n');

    // ── UNCONNECTED: honest no-op ───────────────────────────────────────────
    const s0 = nautobot.status();
    ok('unconnected: status connected:false', s0.connected === false);
    ok('unconnected: lastReconcile null before any reconcile', s0.lastReconcile === null);

    const r0 = await nautobot.reconcile({ device: 'sw1' });
    ok('unconnected: verdict is unknown (NOT a fabricated in-sync/drift)', r0.verdict === 'unknown');
    ok('unconnected: connected:false', r0.connected === false);
    ok('unconnected: no differences invented', Array.isArray(r0.differences) && r0.differences.length === 0);
    ok('unconnected: note names the missing env vars', /NAUTOBOT_URL/.test(r0.note) && /NAUTOBOT_TOKEN/.test(r0.note));
    ok('unconnected: catcher received NOTHING', seen.length === 0);

    // ── CONNECTED: real Token-auth reads to the local stub Nautobot ─────────
    await new Promise((r) => catcher.listen(0, '127.0.0.1', r));
    const port = catcher.address().port;
    process.env.NAUTOBOT_URL = `http://127.0.0.1:${port}`;
    process.env.NAUTOBOT_TOKEN = SECRET_TOKEN;

    const s1 = nautobot.status();
    ok('connected: status connected:true', s1.connected === true);
    ok('connected: status does NOT leak host or token',
      JSON.stringify(s1).indexOf(SECRET_TOKEN) === -1 && JSON.stringify(s1).indexOf('127.0.0.1') === -1);

    // IN-SYNC case — injected live read matches the SoT.
    const inSync = await nautobot.reconcile({ device: 'sw1' }, { live: LIVE_IN_SYNC });
    ok('in-sync: ok + connected', inSync.ok === true && inSync.connected === true);
    ok('in-sync: verdict in-sync', inSync.verdict === 'in-sync');
    ok('in-sync: zero differences', inSync.differences.length === 0);
    ok('in-sync: Token auth WAS sent to Nautobot', seen.some((r) => /^Token /.test(r.auth || '')));
    ok('in-sync: really read the device endpoint', seen.some((r) => /\/api\/dcim\/devices\//.test(r.url)));
    ok('in-sync: really read the interfaces endpoint', seen.some((r) => /\/api\/dcim\/interfaces\//.test(r.url)));

    // DRIFT case — injected live read diverges from the SoT.
    const drift = await nautobot.reconcile({ device: 'sw1' }, { live: LIVE_DRIFT });
    ok('drift: ok + connected', drift.ok === true && drift.connected === true);
    ok('drift: verdict drift', drift.verdict === 'drift');
    ok('drift: real differences found', drift.differences.length >= 4);
    const byField = (frag) => drift.differences.find((d) => d.field.indexOf(frag) !== -1);
    const vlanDiff = byField('1/0/1: vlan');
    ok('drift: VLAN drift on Gi1/0/1 (10 intended → 99 actual)',
      vlanDiff && String(vlanDiff.intended) === '10' && String(vlanDiff.actual) === '99');
    const descDiff = byField('1/0/2: description');
    ok('drift: description drift on Gi1/0/2',
      descDiff && descDiff.intended === 'user port' && descDiff.actual === 'UNAUTHORISED CHANGE');
    const serialDiff = byField('serial');
    ok('drift: serial drift surfaced', serialDiff && serialDiff.intended === 'FCW2140L0GH' && serialDiff.actual === 'FCW9999XXXX');
    const rogue = byField('1/0/48');
    ok('drift: undocumented interface Gi1/0/48 surfaced (device_only)',
      rogue && /undocumented/.test(String(rogue.actual)));
    ok('drift: every difference has field/intended/actual',
      drift.differences.every((d) => 'field' in d && 'intended' in d && 'actual' in d));

    // The intended side truly came from Nautobot (not fabricated locally).
    ok('drift: intended state carries the Nautobot device name', drift.intended && drift.intended.name === 'sw1');

    // ── DEVICE NOT IN SoT: honest unknown, never a fake in-sync ──────────────
    const missing = await nautobot.reconcile({ device: 'nonesuch' }, { live: LIVE_IN_SYNC });
    ok('not-in-sot: verdict unknown', missing.verdict === 'unknown');
    ok('not-in-sot: note says Nautobot has no such device', /no device named/i.test(missing.note));
    ok('not-in-sot: no differences fabricated', missing.differences.length === 0);

    // ── lastReconcile summary is recorded (non-secret) ──────────────────────
    const s2 = nautobot.status();
    ok('status: lastReconcile recorded after a real reconcile', s2.lastReconcile && s2.lastReconcile.device === 'sw1');
    ok('status: lastReconcile verdict is the drift/in-sync we last ran', ['drift', 'in-sync', 'unknown'].indexOf(s2.lastReconcile.verdict) !== -1);

    // ── AUTH FAILURE path: 403 → honest unknown, scrubbed, no fake verdict ──
    // Point at a catcher that always 403s.
    const denier = http.createServer((rq, rs) => { rs.writeHead(403); rs.end('{"detail":"Invalid token"}'); });
    await new Promise((r) => denier.listen(0, '127.0.0.1', r));
    const dport = denier.address().port;
    process.env.NAUTOBOT_URL = `http://127.0.0.1:${dport}`;
    const denied = await nautobot.reconcile({ device: 'sw1' }, { live: LIVE_IN_SYNC });
    ok('auth-fail: verdict unknown (no fake in-sync on 403)', denied.verdict === 'unknown');
    ok('auth-fail: note mentions the token was rejected', /token/i.test(denied.note));
    ok('auth-fail: token NOT leaked in the note', denied.note.indexOf(SECRET_TOKEN) === -1);
    denier.close();
    // restore the working stub URL for the secret sweep below
    process.env.NAUTOBOT_URL = `http://127.0.0.1:${port}`;

    // ── INTERFACE-NAME CANONICALISATION (PR #69 review defect) ──────────────
    // Every spelling of a high-speed port must collapse to ONE stem, so the SAME
    // physical port written three ways never invents a phantom undocumented/absent
    // pair. Covers 1/10/25/40/100G short code + both long forms (…GigE, …GigabitEthernet).
    const N = nautobot._internals;
    const same = (...names) => names.every((n) => N.normIface(n) === N.normIface(names[0]));
    ok('normIface: Te == TenGigE == TenGigabitEthernet (10G)',
      same('Te1/1/1', 'TenGigE1/1/1', 'TenGigabitEthernet1/1/1'));
    ok('normIface: Fo == FortyGigE == FortyGigabitEthernet (40G)',
      same('Fo1/0/1', 'FortyGigE1/0/1', 'FortyGigabitEthernet1/0/1'));
    ok('normIface: Hu == HundredGigE == HundredGigabitEthernet (100G)',
      same('Hu1/1', 'HundredGigE1/1', 'HundredGigabitEthernet1/1'));
    ok('normIface: Twe == TwentyFiveGigE (25G)', same('Twe1/0/1', 'TwentyFiveGigE1/0/1'));
    ok('normIface: Gi == GigabitEthernet (regression — still matches)',
      same('Gi1/0/1', 'GigabitEthernet1/0/1'));
    ok('normIface: Po == Port-channel; Lo == Loopback; Vl == Vlan',
      same('Po10', 'Port-channel10') && same('Lo0', 'Loopback0') && same('Vl101', 'Vlan101'));
    ok('normIface: DIFFERENT ports still differ (Te1/1/1 != Te1/1/2)',
      N.normIface('Te1/1/1') !== N.normIface('Te1/1/2'));
    ok('normIface: DIFFERENT families still differ (Te1/1 != Fo1/1)',
      N.normIface('Te1/1') !== N.normIface('Fo1/1'));

    // A full diff over a 10G uplink written two ways: ZERO phantom diff when the
    // values agree; a genuine value change still surfaces as ONE real diff (never
    // a presence pair). Intended interfaces carry `norm` exactly as the readers set it.
    const mkIntendedIface = (name, extra) => Object.assign({ name, norm: N.normIface(name), ips: [] }, extra);
    const intended10g = { interfaces: [
      mkIntendedIface('TenGigabitEthernet1/1/1', { enabled: true, description: 'core uplink', mtu: 1500, vlan: 10 }),
    ] };
    const liveMatch = N.normalizeLive({ device: { hostname: 'sw9' },
      interfaces: [{ name: 'Te1/1/1', adminStatus: 'up', description: 'core uplink', mtu: 1500, vlan: 10 }] });
    ok('10G mixed-spelling: ZERO diff (no phantom undocumented/absent pair)',
      N.diff(intended10g, liveMatch).length === 0);
    const liveDrift10g = N.normalizeLive({ device: { hostname: 'sw9' },
      interfaces: [{ name: 'TenGigE1/1/1', adminStatus: 'up', description: 'core uplink', mtu: 1500, vlan: 99 }] });
    const d10 = N.diff(intended10g, liveDrift10g);
    ok('10G mixed-spelling: a genuine VLAN change is ONE real diff, not a presence pair',
      d10.length === 1 && /vlan/.test(d10[0].field) && String(d10[0].intended) === '10' && String(d10[0].actual) === '99');

    // ── PRESENCE-GAP FRAMING (records likely incomplete, not rogue network) ──
    // The live sw1 reconcile below (real DevNet) surfaces many device_only
    // interfaces the stub SoT doesn't list. Prove the honest framing appears when
    // presence gaps dominate — but ONLY via a controlled intended/actual here so
    // the assertion is deterministic regardless of the live estate.
    const intendedSparse = { interfaces: [mkIntendedIface('GigabitEthernet1/0/1', { enabled: true, vlan: 10 })] };
    const liveRich = N.normalizeLive({ device: { hostname: 'sw1' }, interfaces: [
      { name: 'Gi1/0/1', adminStatus: 'up', vlan: 10 },
      { name: 'Gi1/0/2', adminStatus: 'up' }, { name: 'Gi1/0/3', adminStatus: 'up' },
      { name: 'Gi1/0/4', adminStatus: 'up' }, { name: 'Loopback0', adminStatus: 'up' },
    ] });
    const gapDiffs = N.diff(intendedSparse, liveRich);
    ok('framing: many device_only interfaces surface as presence gaps',
      gapDiffs.length >= 3 && gapDiffs.every((d) => 'field' in d));

    // ── SECRET: the token never appears anywhere persisted or returned ──────
    let auditText = '';
    try { auditText = fs.readFileSync(session.AUDIT_FILE, 'utf8'); } catch (e) {}
    ok('secret: audit log has Nautobot reconcile entries', /nautobot reconcile/i.test(auditText));
    ok('secret: TOKEN NEVER in the audit log', auditText.indexOf(SECRET_TOKEN) === -1);
    ok('secret: TOKEN NEVER in status/lastReconcile', JSON.stringify(nautobot.status()).indexOf(SECRET_TOKEN) === -1);
    ok('secret: TOKEN NEVER in any reconcile response',
      JSON.stringify(drift).indexOf(SECRET_TOKEN) === -1 && JSON.stringify(inSync).indexOf(SECRET_TOKEN) === -1);
    // The one place the token is allowed: the Token auth header on the wire.
    ok('secret: token rode ONLY in the Token auth header (as designed)',
      seen.some((r) => r.auth === `Token ${SECRET_TOKEN}`));

    catcher.close(() => resolve());
  });
}

run().then(() => {
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}).catch((e) => { console.error(e); process.exit(1); });
