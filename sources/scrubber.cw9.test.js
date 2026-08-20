// CW-9 — the secret scrubber, table-driven.
//
// This wave is what routes real device config into the chat pane and onto disk,
// so `session-log.scrub` is the one sink that has to be right. Three independent
// review rounds found three different classes of failure here:
//   round 1 — IOS space-separated forms leaked (`password 0 …`, `enable secret 5 …`)
//   round 2 — plaintext shared secrets leaked (`key <secret>` with no type byte)
//   round 3 — two keyword rules RACED: the first one won, and it had neither the
//             syntax-word exclusions nor the prose guard, so a `«redacted»` marker
//             landed on a syntax word while the real key survived beside it, and
//             ordinary `description` / `banner` prose had words eaten out of it.
//
// The fix is structural (ONE ordered pass, ONE exclusion list, ONE free-text
// guard) and this suite is its net. It is deliberately TABLE-DRIVEN: the next
// form anyone finds is one line here and one token in session-log.js.
//
// Three tables:
//   SECRETS   — the secret value must NOT survive, and the marker must be where
//               the secret was (never on a syntax word).
//   SURVIVORS — real evidence that must come through completely unchanged.
//   PROSE     — free text: never touched, even when it contains secret keywords.

const { scrub } = require('./session-log');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`); }
}
function section(t) { console.log(`\n${t}`); }

// ── 1. Secrets: [line, the secret that must disappear, a word that must stay] ──
const SECRETS = [
  // Reviewer round 3 — the five that leaked untouched.
  ['vrrp 10 authentication text VrrpSecret1', 'VrrpSecret1', 'vrrp'],
  ['standby 1 authentication SuperHsrp99', 'SuperHsrp99', 'standby'],
  ['standby 1 authentication text HsrpTextKey', 'HsrpTextKey', 'text'],
  ['wpa-passphrase MyWifiSecret1', 'MyWifiSecret1', 'wpa-passphrase'],
  [' passphrase 0 SuperWifi2026', 'SuperWifi2026', 'passphrase'],
  // Reviewer round 3 — the four FALSE redactions: marker on a syntax word while
  // the real secret survived. The syntax word must stay, the secret must go.
  [' pre-shared-key local LocalPsk99', 'LocalPsk99', 'local'],
  [' pre-shared-key remote RemotePsk88', 'RemotePsk88', 'remote'],
  ['vrrp 1 authentication md5 key-string VrrpMd5Key', 'VrrpMd5Key', 'key-string'],
  ['standby 1 authentication md5 key-string HsrpMd5Key77', 'HsrpMd5Key77', 'key-string'],
  [' security wpa psk set-key ascii 0 WifiPass123', 'WifiPass123', 'set-key'],
  // Reviewer round 2 — the twelve, kept as regression.
  ['tacacs-server host 1.1.1.1 key MyTacKey123', 'MyTacKey123', '1.1.1.1'],
  ['radius-server key SuperRadius99', 'SuperRadius99', 'radius-server'],
  ['snmp-server host 1.1.1.1 version 2c PrivComm99', 'PrivComm99', 'version'],
  ['crypto isakmp key VpnPsk2026 address 2.2.2.2', 'VpnPsk2026', '2.2.2.2'],
  ['tacacs-server key 7 070C285F4D06', '070C285F4D06', 'key'],
  ['username bob secret 9 $14$abcdEFGH', '$14$abcdEFGH', 'bob'],
  ['neighbor 1.1.1.1 password BgpMd5Key', 'BgpMd5Key', 'neighbor'],
  ['neighbor 10.1.1.1 password 7 104D000A0618', '104D000A0618', 'neighbor'],
  ['ppp chap password 7 104D000A0618', '104D000A0618', 'chap'],
  ['ip ftp password FtpPass123', 'FtpPass123', 'ftp'],
  ['snmp-server community S3cretComm RW', 'S3cretComm', 'RW'],
  [' key 0 RadKey0', 'RadKey0', 'key'],
  ['username admin privilege 15 password 0 Cisco123!', 'Cisco123!', 'privilege'],
  // Round 1 + our own additions.
  ['enable secret 5 $1$abcd$xyz', '$1$abcd$xyz', 'secret'],
  ['key-string mysharedkey', 'mysharedkey', 'key-string'],
  ['key 7 04585A150C2E', '04585A150C2E', 'key'],
  ['wpa-psk ascii 0 MyWifiPass', 'MyWifiPass', 'ascii'],
  ['ntp authentication-key 1 md5 NtpKey123', 'NtpKey123', 'md5'],
  ['ip ospf message-digest-key 1 md5 MyOspfKey', 'MyOspfKey', 'md5'],
  ['snmp-server host 1.1.1.1 traps PrivComm99 udp-port 162', 'PrivComm99', 'udp-port'],
  ['snmp-server user U1 G1 v3 auth md5 AuthPass99', 'AuthPass99', 'auth'],
  ['ANTHROPIC_API_KEY=sk-ant-abc123', 'sk-ant-abc123', 'ANTHROPIC_API_KEY'],
  ['DNAC_PASSWORD=Str0ng!', 'Str0ng!', 'DNAC_PASSWORD'],
  ['{"username":"admin","password":"S3cret!"}', 'S3cret!', 'username'],
  ['Authorization: Bearer eyJhbGciOiJIUzI1NiJ9', 'eyJhbGciOiJIUzI1NiJ9', 'Bearer'],
  ['password=SuperSecret123', 'SuperSecret123', 'password'],
  ['snmp-server community publicRO RO', 'publicRO', 'RO'],
  // A secret stated inside prose is still a secret when it LOOKS like one.
  ['the password is Hunter2!', 'Hunter2!', 'password'],
];

// ── 2. Survivors: real evidence, must come back byte-identical ───────────────
const SURVIVORS = [
  'interface GigabitEthernet1/0/3',
  'hostname sw2',
  'ip address 10.1.1.1 255.255.255.0',
  'Cisco IOS XE Software, Version 17.12.01prd9',
  'key chain KC1',
  ' key 1',
  'crypto key generate rsa modulus 2048',
  'crypto key generate rsa general-keys label SSH-KEY modulus 4096',
  'snmp-server enable traps',
  'ntp server 10.0.0.1 key 1',
  ' authentication mode md5',
  ' ip ospf authentication message-digest',
  'uptime is 3 weeks, 2 days',
  // `community` on its own is an English word — only an snmp prefix or a
  // separator makes it the SNMP shared secret (regression: live-feeds suite).
  'joined the community channel today',
  'System returned to ROM by power-on',
  ' switchport mode access',
  ' spanning-tree portfast',
];

// ── 3. Prose: free text is evidence too — never touched ─────────────────────
const PROSE = [
  'description uplink to key customer site B password protected room',
  'remark allow partner password reset traffic to 10.0.0.1',
  'banner motd ^C do not share the password with anyone ^C',
  '! this interface password policy was reviewed',
  'The device reported: enter your password when prompted at the console',
  '# the password policy is documented elsewhere',
];

(async () => {
  console.log('\nCW-9 SCRUBBER — one ordered pass, one exclusion list, one free-text guard:');

  section(`SECRETS — ${SECRETS.length} real forms: the value never survives, the syntax word always does`);
  for (const [line, secret, keep] of SECRETS) {
    const out = scrub(line);
    ok(`redacted: ${line.trim().slice(0, 52)}`, !out.includes(secret), out);
    ok(`  ↳ marker did not eat the syntax word "${keep}"`, out.includes(keep), out);
  }

  section(`SURVIVORS — ${SURVIVORS.length} lines of real evidence, unchanged`);
  for (const line of SURVIVORS) {
    const out = scrub(line);
    ok(`unchanged: ${line.trim().slice(0, 52)}`, out === line, out);
  }

  section(`FREE TEXT — ${PROSE.length} prose lines, never touched even with secret keywords in them`);
  for (const line of PROSE) {
    const out = scrub(line);
    ok(`untouched: ${line.trim().slice(0, 52)}`, out === line, out);
  }

  section('WHOLE-CONFIG behaviour (the shape a running-config actually arrives in)');
  {
    const config = [
      'Building configuration...',
      '!',
      'hostname sw2',
      '!',
      'enable secret 5 $1$abcd$xyzXYZ',
      'username admin privilege 15 password 0 Cisco123!',
      '!',
      'interface GigabitEthernet1/0/3',
      ' description uplink to key customer site B password protected room',
      ' ip address 10.1.1.1 255.255.255.0',
      ' standby 1 authentication text HsrpTextKey',
      '!',
      'tacacs-server host 1.1.1.1 key MyTacKey123',
      'snmp-server community S3cretComm RW',
      'end',
    ].join('\n');
    const out = scrub(config);
    const leaked = ['$1$abcd$xyzXYZ', 'Cisco123!', 'HsrpTextKey', 'MyTacKey123', 'S3cretComm']
      .filter((sec) => out.includes(sec));
    ok('no secret survives the config', leaked.length === 0, leaked.join(', '));
    ok('the description line is untouched', out.includes(' description uplink to key customer site B password protected room'));
    ok('the structure is intact', out.split('\n').length === config.split('\n').length
      && out.includes('hostname sw2') && out.includes('interface GigabitEthernet1/0/3') && out.endsWith('end'));
    ok('the ip address is not mistaken for a secret', out.includes('ip address 10.1.1.1 255.255.255.0'));
  }

  section('SANITY — the scrubber never throws and never invents');
  {
    ok('null passes through', scrub(null) === null);
    ok('undefined passes through', scrub(undefined) === undefined);
    ok('empty string', scrub('') === '');
    ok('a very long line does not throw', typeof scrub('key '.repeat(20000)) === 'string');
    ok('already-redacted text is not double-redacted',
      scrub('key «redacted»') === 'key «redacted»', scrub('key «redacted»'));
    ok('CRLF text keeps its line count',
      scrub('hostname sw2\nkey 0 Secret99\n').split('\n').length === 3);
  }

  console.log(`\nCW-9 scrubber: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
