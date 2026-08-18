// pcap.test.js — netclaw-pull A6. DETERMINISTIC: no Claude key, no network.
//
// It CRAFTS a known libpcap file byte-by-byte (Ethernet/IPv4 TCP+UDP+ICMP
// packets with chosen IPs, flags and a duplicated segment) and proves the native
// analyzer reports EXACTLY what was crafted — packetCount, top talkers, protocol
// mix, TCP flags, the retransmit heuristic. Then it proves every honest path:
// no capture, garbage, truncated (no crash / no fake packets), oversize rejected,
// pcapng unsupported, and that a credential-shaped payload is NEVER surfaced.

const fs = require('fs');
const os = require('os');
const path = require('path');

// Throwaway workspace BEFORE session-log (via pcap.js) touches it.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'a6-pcap-'));
process.env.SQUAD_ROOT = TMP;

const pcap = require('./pcap');

let passed = 0, failed = 0;
function ok(name, cond) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}`); }
}

// ── Byte builders for a classic libpcap (.pcap) file ────────────────────────
function pcapGlobalHeader({ linktype = 1 } = {}) {
  const b = Buffer.alloc(24);
  b.writeUInt32LE(0xa1b2c3d4, 0); // magic (little-endian, microsecond)
  b.writeUInt16LE(2, 4);          // version major
  b.writeUInt16LE(4, 6);          // version minor
  b.writeInt32LE(0, 8);           // thiszone
  b.writeUInt32LE(0, 12);         // sigfigs
  b.writeUInt32LE(65535, 16);     // snaplen
  b.writeUInt32LE(linktype, 20);  // network (1 = Ethernet)
  return b;
}
function recordHeader(tsSec, tsUsec, data) {
  const h = Buffer.alloc(16);
  h.writeUInt32LE(tsSec, 0);
  h.writeUInt32LE(tsUsec, 4);
  h.writeUInt32LE(data.length, 8);  // incl_len
  h.writeUInt32LE(data.length, 12); // orig_len
  return Buffer.concat([h, data]);
}
function eth(payload) {
  const h = Buffer.alloc(14);
  Buffer.from([0x02, 0, 0, 0, 0, 0x02]).copy(h, 0);  // dst MAC
  Buffer.from([0x02, 0, 0, 0, 0, 0x01]).copy(h, 6);  // src MAC
  h.writeUInt16BE(0x0800, 12);                        // ethertype IPv4
  return Buffer.concat([h, payload]);
}
function ipv4(proto, src, dst, l4) {
  const h = Buffer.alloc(20);
  h[0] = 0x45;                              // version 4, IHL 5
  h.writeUInt16BE(20 + l4.length, 2);       // total length
  h[8] = 64;                                // ttl
  h[9] = proto;                             // protocol
  src.split('.').forEach((o, i) => (h[12 + i] = Number(o)));
  dst.split('.').forEach((o, i) => (h[16 + i] = Number(o)));
  return Buffer.concat([h, l4]);
}
function tcp(sport, dport, seq, flags, payload = Buffer.alloc(0)) {
  const h = Buffer.alloc(20);
  h.writeUInt16BE(sport, 0);
  h.writeUInt16BE(dport, 2);
  h.writeUInt32BE(seq, 4);
  h.writeUInt32BE(0, 8);            // ack
  h[12] = 0x50;                     // data offset 5 (20 bytes), no options
  h[13] = flags;                    // flags byte
  h.writeUInt16BE(0xffff, 14);      // window
  return Buffer.concat([h, payload]);
}
function udp(sport, dport, payload) {
  const h = Buffer.alloc(8);
  h.writeUInt16BE(sport, 0);
  h.writeUInt16BE(dport, 2);
  h.writeUInt16BE(8 + payload.length, 4);
  return Buffer.concat([h, payload]);
}
function icmp() {
  const h = Buffer.alloc(8);
  h[0] = 8; // echo request
  return h;
}

// TCP flag bits.
const SYN = 0x02, RST = 0x04, FIN = 0x01, ACK = 0x10, PSH = 0x08;

// ── Build the known capture ─────────────────────────────────────────────────
// 5 TCP + 1 UDP + 1 ICMP = 7 packets. IPs 10.0.0.1 <-> 10.0.0.2 dominate.
const A = '10.0.0.1', B = '10.0.0.2', C = '10.0.0.3', D = '10.0.0.4';
const getReq = Buffer.from('GET / HTTP/1.0\r\n\r\n');
// A credential-shaped payload — must NEVER appear in the analyzer output.
const secretPayload = Buffer.from('user login password=SuperSecret123 token=abcd1234efgh');

const packets = [
  // 1: SYN A->B
  recordHeader(1000, 0, eth(ipv4(6, A, B, tcp(12345, 80, 1000, SYN)))),
  // 2: SYN+ACK B->A
  recordHeader(1000, 1000, eth(ipv4(6, B, A, tcp(80, 12345, 5000, SYN | ACK)))),
  // 3: data A->B (seq 2000, GET request)
  recordHeader(1000, 2000, eth(ipv4(6, A, B, tcp(12345, 80, 2000, PSH | ACK, getReq)))),
  // 4: EXACT duplicate of 3 → one likely retransmit
  recordHeader(1000, 3000, eth(ipv4(6, A, B, tcp(12345, 80, 2000, PSH | ACK, getReq)))),
  // 5: RST B->A
  recordHeader(1000, 4000, eth(ipv4(6, B, A, tcp(80, 12345, 5001, RST | ACK)))),
  // 6: UDP C->D carrying a credential-shaped payload (DNS-ish port)
  recordHeader(1000, 5000, eth(ipv4(17, C, D, udp(53000, 53, secretPayload)))),
  // 7: ICMP echo A->B
  recordHeader(1000, 6000, eth(ipv4(1, A, B, icmp()))),
];
const known = Buffer.concat([pcapGlobalHeader(), ...packets]);

console.log('\nA6 — native pcap analyzer (deterministic, crafted-capture proof):\n');

// ── 1. The crafted capture parses to EXACTLY what we built ──────────────────
const r = pcap.analyze(known);
ok('crafted: ok:true', r.ok === true);
ok('crafted: packetCount === 7', r.packetCount === 7);
ok('crafted: protocols tcp === 5', r.protocols.tcp === 5);
ok('crafted: protocols udp === 1', r.protocols.udp === 1);
ok('crafted: protocols icmp === 1', r.protocols.icmp === 1);
ok('crafted: protocols other === 0', r.protocols.other === 0);
ok('crafted: tcpFlags syn === 2', r.tcpFlags.syn === 2);
ok('crafted: tcpFlags rst === 1', r.tcpFlags.rst === 1);
ok('crafted: tcpFlags fin === 0', r.tcpFlags.fin === 0);
ok('crafted: retransmitsHeuristic === 1 (the duplicated segment)', r.retransmitsHeuristic === 1);
ok('crafted: linkType Ethernet', r.linkType === 'Ethernet');
ok('crafted: timespan seconds ~0.006', Math.abs(r.timespan.seconds - 0.006) < 1e-6);
ok('crafted: timespan has ISO start/end', typeof r.timespan.start === 'string' && typeof r.timespan.end === 'string');

// Top talkers: 10.0.0.1 and 10.0.0.2 are the busiest endpoints (5 of 7 packets).
const talkerIps = r.topTalkers.map((t) => t.ip);
ok('crafted: 10.0.0.1 is a top talker', talkerIps.includes(A));
ok('crafted: 10.0.0.2 is a top talker', talkerIps.includes(B));
ok('crafted: top talker leads by bytes', r.topTalkers[0].bytes >= r.topTalkers[r.topTalkers.length - 1].bytes);
ok('crafted: a talker records real packet counts', r.topTalkers[0].packets > 0);
ok('crafted: no parse errors on a clean file', Array.isArray(r.errors) && r.errors.length === 0);

// ── 2. SECRETS: the credential-shaped payload is NEVER surfaced ─────────────
const dump = JSON.stringify(r);
ok('secrets: "SuperSecret123" NOT in output', !dump.includes('SuperSecret123'));
ok('secrets: "password=" value NOT surfaced', !/password=SuperSecret/i.test(dump));
ok('secrets: token value NOT surfaced', !dump.includes('abcd1234efgh'));
ok('secrets: no raw GET payload surfaced', !dump.includes('GET /'));

// ── 3. HONEST: no capture provided ──────────────────────────────────────────
for (const [label, input] of [['null', null], ['undefined', undefined], ['empty string', ''], ['empty buffer', Buffer.alloc(0)]]) {
  const h = pcap.analyze(input);
  ok(`no-capture (${label}): ok:false + "no capture provided"`, h.ok === false && /no capture provided/i.test(h.note));
}

// ── 4. HONEST: garbage / not a pcap ─────────────────────────────────────────
const garbage = Buffer.from('this is definitely not a packet capture file at all, just text.');
const g = pcap.analyze(garbage);
ok('garbage: ok:false (honest)', g.ok === false);
ok('garbage: unrecognized-format note', /unrecognized capture format/i.test(g.note));
ok('garbage: no fake packetCount', g.packetCount === undefined);

const randomBinary = Buffer.alloc(200);
for (let i = 0; i < randomBinary.length; i++) randomBinary[i] = (i * 37 + 11) & 0xff;
const rb = pcap.analyze(randomBinary);
ok('random-binary: honest ok:false, no crash', rb.ok === false && typeof rb.note === 'string');

// ── 5. HONEST: truncated file (valid header, chopped mid-record) ────────────
const truncated = known.slice(0, known.length - 10); // cut into the last packet
const t = pcap.analyze(truncated);
ok('truncated: ok:true (parsed as far as possible)', t.ok === true);
ok('truncated: counted only COMPLETE packets (6, not 7)', t.packetCount === 6);
ok('truncated: records a truncation caveat', t.errors.some((e) => /truncat/i.test(e)));

// Chopped inside the global header → honest, no crash, no fake packets.
const tinyTrunc = known.slice(0, 18);
const tt = pcap.analyze(tinyTrunc);
ok('header-truncated: honest ok:false, no crash', tt.ok === false && typeof tt.note === 'string');

// ── 6. HONEST: pcapng unsupported ───────────────────────────────────────────
const pcapng = Buffer.alloc(32);
pcapng.writeUInt32BE(0x0a0d0d0a, 0);        // SHB block type
pcapng.writeUInt32LE(0x1a2b3c4d, 8);        // byte-order magic
const png = pcap.analyze(pcapng);
ok('pcapng: ok:false + honest "not yet supported"', png.ok === false && /pcapng not yet supported/i.test(png.note));

// ── 7. SAFETY: oversize rejected BEFORE parse ───────────────────────────────
process.env.PCAP_MAX_BYTES = '1024'; // 1 KB cap for this assertion
const big = Buffer.concat([pcapGlobalHeader(), Buffer.alloc(4096)]); // ~4 KB > 1 KB
const ov = pcap.analyze(big);
ok('oversize: ok:false + "too large"', ov.ok === false && /too large/i.test(ov.note));
ok('oversize: never a fabricated summary', ov.packetCount === undefined);
delete process.env.PCAP_MAX_BYTES;

// ── 8. PATH input + file-not-found + oversize-on-disk ───────────────────────
const onDisk = path.join(TMP, 'known.pcap');
fs.writeFileSync(onDisk, known);
const rp = pcap.analyze(onDisk);
ok('path input: reads a file from disk, ok:true', rp.ok === true && rp.packetCount === 7);

const missing = pcap.analyze(path.join(TMP, 'does-not-exist.pcap'));
ok('missing file: honest ok:false "unreadable"', missing.ok === false && /unreadable/i.test(missing.note));

process.env.PCAP_MAX_BYTES = '10'; // smaller than the file on disk
const ovDisk = pcap.analyze(onDisk);
ok('oversize on disk: rejected by stat before read', ovDisk.ok === false && /too large/i.test(ovDisk.note));
delete process.env.PCAP_MAX_BYTES;

// ── 9. SAFETY: a hostile record length must not crash or hang ───────────────
const hostile = Buffer.concat([
  pcapGlobalHeader(),
  (() => { const h = Buffer.alloc(16); h.writeUInt32LE(1, 0); h.writeUInt32LE(0, 4);
    h.writeUInt32LE(0xffffffff, 8); h.writeUInt32LE(0xffffffff, 12); return h; })(),
]);
const hz = pcap.analyze(hostile);
ok('hostile length: honest, no crash, no fake packets', hz.ok === true && hz.packetCount === 0 && hz.errors.length > 0);

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
