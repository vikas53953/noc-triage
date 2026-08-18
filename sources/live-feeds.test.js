// A4 — native syslog + SNMP-trap live feeds. DETERMINISTIC: no key, no network
// bind, no HTTP. Drives the parsers + the live-events store directly, and does
// ONE real localhost UDP round-trip to prove a datagram becomes a stored event.
//
// Covers the honesty contract: RFC3164/5424 syslog parses; a malformed packet is
// DROPPED (no phantom event); a real v2c trap parses (source, trap OID,
// varbinds); the SNMP community secret is NEVER stored; a secret in a syslog
// message is SCRUBBED in the store; feeds OFF → status "not receiving", store
// empty; the store caps + the time-window getter (the bridge hook) filters.

// Feeds must read as OFF for the honesty test — clear any inherited env first.
delete process.env.SYSLOG_ENABLED; delete process.env.SYSLOG_PORT;
delete process.env.SNMPTRAP_ENABLED; delete process.env.SNMPTRAP_PORT;

const dgram = require('dgram');
const liveEvents = require('./live-events');
const syslog = require('./syslog-feed');
const snmptrap = require('./snmptrap-feed');

let passed = 0, failed = 0;
function ok(name, cond) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}`); }
}

console.log('\nA4 — native syslog + SNMP-trap live feeds:\n');

// ── syslog parser ────────────────────────────────────────────────────────────
liveEvents._reset();

const s3164 = syslog.parseSyslog('<34>Oct 11 22:14:15 mymachine su: failed login for root', '10.0.0.5');
ok('3164 parses severity from PRI 34 → critical', s3164 && s3164.severity === 'critical');
ok('3164 facility from PRI 34 → auth', s3164 && s3164.facility === 'auth');
ok('3164 keeps message text', s3164 && /failed login/.test(s3164.text));
ok('3164 device falls back to source IP', s3164 && s3164.device === '10.0.0.5');

const s5424 = syslog.parseSyslog('<165>1 2026-08-19T14:20:15.000Z sw-core-1 IOS 8710 - - Interface Gi1/0/1 changed state to down', '10.0.0.9');
ok('5424 parses host from payload', s5424 && s5424.device === 'sw-core-1');
ok('5424 severity from PRI 165 → notice', s5424 && s5424.severity === 'notice');
ok('5424 timestamp parsed to epoch-ms', s5424 && typeof s5424.ts === 'number' && s5424.ts === Date.parse('2026-08-19T14:20:15.000Z'));
ok('5424 message carries the interface event', s5424 && /changed state to down/.test(s5424.text));

ok('syslog with no PRI → dropped (null)', syslog.parseSyslog('just some random text', '1.2.3.4') === null);
ok('empty datagram → dropped (null)', syslog.parseSyslog('', '1.2.3.4') === null);
ok('PRI over 191 → dropped (null)', syslog.parseSyslog('<999>anything', '1.2.3.4') === null);

// ── SNMP trap parser (build a real v2c trap with a tiny BER encoder) ─────────
function tlv(tag, val) { return Buffer.concat([Buffer.from([tag]), berLen(val.length), val]); }
function berLen(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  while (n > 0) { bytes.unshift(n & 0xff); n >>= 8; }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
function encInt(n) { // minimal, non-negative
  const bytes = [];
  do { bytes.unshift(n & 0xff); n = Math.floor(n / 256); } while (n > 0);
  if (bytes[0] & 0x80) bytes.unshift(0);
  return tlv(0x02, Buffer.from(bytes));
}
function encOctet(s) { return tlv(0x04, Buffer.from(s, 'utf8')); }
function encOid(oid) {
  const parts = oid.split('.').map(Number);
  const out = [40 * parts[0] + parts[1]];
  for (let i = 2; i < parts.length; i += 1) {
    let v = parts[i]; const stack = [v & 0x7f]; v = Math.floor(v / 128);
    while (v > 0) { stack.unshift((v & 0x7f) | 0x80); v = Math.floor(v / 128); }
    out.push(...stack);
  }
  return tlv(0x06, Buffer.from(out));
}
function encTimeTicks(n) { const i = encInt(n); i[0] = 0x43; return i; }
function vb(oidBuf, valBuf) { return tlv(0x30, Buffer.concat([oidBuf, valBuf])); }

const SYS_UPTIME = '1.3.6.1.2.1.1.3.0';
const TRAP_OID_OID = '1.3.6.1.6.3.1.1.4.1.0';
const LINKDOWN = '1.3.6.1.6.3.1.1.5.3';
const IFINDEX = '1.3.6.1.2.1.2.2.1.1.2';

const varbinds = Buffer.concat([
  vb(encOid(SYS_UPTIME), encTimeTicks(123456)),
  vb(encOid(TRAP_OID_OID), encOid(LINKDOWN)),
  vb(encOid(IFINDEX), encInt(2)),
]);
const pdu = tlv(0xa7, Buffer.concat([encInt(42), encInt(0), encInt(0), tlv(0x30, varbinds)]));
const COMMUNITY_SECRET = 's3cr3t-community';
const trapMsg = tlv(0x30, Buffer.concat([encInt(1), encOctet(COMMUNITY_SECRET), pdu]));

const t = snmptrap.parseTrap(trapMsg, '192.0.2.50');
ok('v2c trap parses', !!t && t.source === 'trap');
ok('v2c trap OID resolved to linkDown', t && t.trapName === 'linkDown' && t.trapOid === LINKDOWN);
ok('v2c trap device is source IP', t && t.device === '192.0.2.50');
ok('v2c trap keeps the ifIndex varbind', t && t.varbinds.some((v) => v.oid === IFINDEX && v.value === '2'));
ok('v2c trap drops sysUpTime/snmpTrapOID from varbinds', t && !t.varbinds.some((v) => v.oid === SYS_UPTIME || v.oid === TRAP_OID_OID));
ok('community secret NEVER appears in parsed trap', t && !JSON.stringify(t).includes(COMMUNITY_SECRET));

ok('non-SEQUENCE datagram → dropped (null)', snmptrap.parseTrap(Buffer.from([0x01, 0x02, 0x03]), '1.2.3.4') === null);
ok('truncated/garbage trap → dropped (null, no throw)', (() => {
  try { return snmptrap.parseTrap(Buffer.from([0x30, 0x82, 0xff, 0xff, 0x00]), '1.2.3.4') === null; }
  catch (e) { return false; }
})());

// ── live-events store: add / window getter / count / cap ─────────────────────
liveEvents._reset();
ok('store starts empty', liveEvents.count() === 0);

const base = Date.now();
liveEvents.add({ source: 'syslog', device: 'sw1', severity: 'error', ts: base - 60000, text: 'old event' });
liveEvents.add({ source: 'syslog', device: 'sw2', severity: 'critical', ts: base - 1000, text: 'recent event' });
liveEvents.add({ source: 'trap', device: '192.0.2.9', severity: null, ts: base - 500, text: 'trap event', trapOid: LINKDOWN });
ok('count reflects three stored', liveEvents.count() === 3);
ok('count by source: syslog=2', liveEvents.count('syslog') === 2);
ok('count by source: trap=1', liveEvents.count('trap') === 1);

const win = liveEvents.getInWindow(base - 5000, null); // last 5s only
ok('getInWindow drops the old event', win.length === 2 && !win.some((e) => e.text === 'old event'));
ok('getInWindow newest-first', win[0].ts >= win[1].ts);
ok('getInWindow source filter works', liveEvents.getInWindow(base - 5000, null, { source: 'trap' }).length === 1);

const malformed = liveEvents.add({ source: 'syslog' }); // no device, no text
ok('store refuses an event with nothing real', malformed === null && liveEvents.count() === 3);

const badSource = liveEvents.add({ source: 'bogus', text: 'x' });
ok('store refuses an unknown source', badSource === null);

// ── secret scrubbing in the store ────────────────────────────────────────────
const secretEvt = liveEvents.add({
  source: 'syslog', device: 'rtr1', severity: 'warning', ts: base,
  text: 'auth attempt password=SuperSecret123 from console',
  raw: '<34>auth attempt password=SuperSecret123',
});
ok('secret in text is scrubbed', secretEvt && secretEvt.text.includes('«redacted»') && !secretEvt.text.includes('SuperSecret123'));
ok('secret in raw is scrubbed', secretEvt && !secretEvt.raw.includes('SuperSecret123'));

// SNMP community in a syslog FREE-TEXT line (the newly-piped untrusted path).
const commEvt = liveEvents.add({
  source: 'syslog', device: 'sw3', severity: 'notice', ts: base,
  text: '%SNMP: community=publicRO from 10.1.1.1',
  raw: '<189>%SNMP-3-AUTHFAIL: community=publicRO from 10.1.1.1',
});
ok('community=<x> scrubbed in text', commEvt && commEvt.text.includes('community=«redacted»') && !commEvt.text.includes('publicRO'));
ok('community=<x> scrubbed in raw', commEvt && !commEvt.raw.includes('publicRO'));
const commEvt2 = liveEvents.add({
  source: 'syslog', device: 'sw4', severity: 'notice', ts: base,
  text: 'config: snmp-server community privateRW RW',
});
ok('IOS "snmp-server community <x>" scrubbed', commEvt2 && !commEvt2.text.includes('privateRW'));
// the bare English word "community" (no snmp prefix, no =) must survive
const plain = require('./session-log').scrub('joined the community channel today');
ok('bare English "community <word>" left intact', plain === 'joined the community channel today');

// cap: push past CAP and confirm the ring never exceeds it
liveEvents._reset();
for (let i = 0; i < liveEvents.CAP + 50; i += 1) {
  liveEvents.add({ source: 'syslog', device: `d${i}`, severity: 'info', ts: base + i, text: `event ${i}` });
}
ok('ring buffer is capped', liveEvents.count() === liveEvents.CAP);
ok('cap keeps the NEWEST events', liveEvents.recent(1)[0].text === `event ${liveEvents.CAP + 49}`);

// ── feeds OFF → honest "not receiving" ───────────────────────────────────────
liveEvents._reset();
const sOff = syslog.status();
ok('syslog OFF: enabled=false', sOff.enabled === false);
ok('syslog OFF: not listening', sOff.listening === false);
ok('syslog OFF: count 0', sOff.count === 0);
ok('syslog OFF: still reports its default target port', sOff.port === syslog.DEFAULT_PORT);
const nOff = snmptrap.status();
ok('snmptrap OFF: enabled=false', nOff.enabled === false);
ok('snmptrap OFF: not listening', nOff.listening === false);
ok('snmptrap OFF: count 0', nOff.count === 0);

// ── ONE real localhost UDP round-trip: datagram → stored event ───────────────
(function udpRoundTrip(done) {
  process.env.SYSLOG_ENABLED = '1';
  process.env.SYSLOG_PORT = '0'; // ephemeral would not round-trip; use a fixed high port
  process.env.SYSLOG_PORT = '25514';
  liveEvents._reset();
  let broadcasts = 0;
  const st = syslog.start({ onEvent: () => { broadcasts += 1; }, log: () => {} });
  // give the socket a tick to bind, then send a real datagram to it
  setTimeout(() => {
    const client = dgram.createSocket('udp4');
    const msg = Buffer.from('<187>Aug 19 14:30:00 core-sw1 %LINK-3-UPDOWN: Interface Gi1/0/24, changed state to down');
    client.send(msg, 25514, '127.0.0.1', () => {
      setTimeout(() => {
        client.close();
        const good = liveEvents.count('syslog') === 1;
        ok('UDP round-trip: datagram became one stored event', good);
        ok('UDP round-trip: onEvent broadcast fired once', broadcasts === 1);
        const ev = liveEvents.recent(1, 'syslog')[0];
        ok('UDP round-trip: severity error (PRI 187)', ev && ev.severity === 'error');
        ok('UDP round-trip: message preserved', ev && /changed state to down/.test(ev.text));
        // malformed packet → dropped, no fake event
        const before = liveEvents.count('syslog');
        const client2 = dgram.createSocket('udp4');
        client2.send(Buffer.from('not-syslog-at-all'), 25514, '127.0.0.1', () => {
          setTimeout(() => {
            client2.close();
            ok('UDP round-trip: malformed datagram dropped (no new event)', liveEvents.count('syslog') === before);
            ok('UDP round-trip: malformed counter incremented', syslog.status().malformed >= 1);
            syslog.stop();
            done();
          }, 120);
        });
      }, 150);
    });
  }, 150);
})(finish);

function finish() {
  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

// Safety net: if the async round-trip hangs, fail loudly rather than hang CI.
setTimeout(() => { console.log('\n  TIMEOUT — UDP round-trip did not complete\n'); process.exit(1); }, 5000).unref();
