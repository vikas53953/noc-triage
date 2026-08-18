// pcap.js — netclaw-pull A6: a native, zero-dependency packet-capture analyzer.
//
// PLAIN WORDS: hand it a real .pcap file (the classic libpcap format Wireshark/
// tcpdump write) and it reads the actual packets and reports the facts a NOC
// engineer wants when triage bottoms out at "is the traffic even arriving?":
// how many packets, over what span, who the top talkers are, the protocol mix,
// how many TCP resets/SYNs/FINs, and a heuristic count of likely retransmits.
// Every number is counted from the REAL bytes in the file — nothing is invented.
//
// HONESTY (the whole point — mirrors sources/teams.js / servicenow-client.js):
//   • No capture / empty input            → { ok:false, note:"no capture provided" }
//   • File missing / unreadable           → { ok:false, note:"capture unreadable ..." }
//   • pcapng (the newer format)           → { ok:false, note:"unsupported format (pcapng not yet supported)" }
//   • Anything that isn't a libpcap file  → { ok:false, note:"unrecognized capture format ..." }
//   • A TRUNCATED / garbage-tailed file   → parsed as far as the bytes allow, the
//                                            truncation recorded in `errors`, and
//                                            NEVER a fabricated packet past the data.
//   We would rather return an honest "no capture" than a made-up summary.
//
// SAFETY / SIZE:
//   • Input is capped at PCAP_MAX_BYTES (default 25 MB) — a hostile/huge file is
//     rejected BEFORE it is read, so it can never OOM the Node process.
//   • The parse is bounded and iterative: a per-packet walk over one Buffer (no
//     per-packet slices kept), a hard packet cap (PCAP_MAX_PACKETS), and capped
//     bookkeeping maps (talkers, flows) so a crafted file with millions of unique
//     endpoints cannot grow memory without bound. A malformed length can never
//     push the cursor backwards or past the end — the loop always makes progress
//     or stops with an honest error.
//
// SECRETS: a pcap can carry payloads with credentials. This analyzer surfaces
//   METADATA ONLY (counts, IPs, ports, flags) — it NEVER dumps a raw payload.
//   As belt-and-braces, every string it does surface (note/errors) is run through
//   the shared session scrubber so nothing credential-shaped can ride along.

const fs = require('fs');
let session;
try { session = require('./session-log'); } catch (e) { session = null; }

// Scrub any surfaced string through the shared session scrubber when available,
// so a credential-shaped token can never leave this module even in a note/error.
function scrub(s) {
  if (s == null) return s;
  try { if (session && session.scrub) return session.scrub(String(s)); } catch (e) { /* fall through */ }
  return String(s);
}

// ── Tunables (env-overridable, all bounded) ─────────────────────────────────
function maxBytes() {
  const v = Number(process.env.PCAP_MAX_BYTES);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 25 * 1024 * 1024; // 25 MB
}
function maxPackets() {
  const v = Number(process.env.PCAP_MAX_PACKETS);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 500000;
}
const MAX_TALKERS_TRACKED = 50000; // distinct IPs we keep books on
const MAX_FLOWS_TRACKED = 200000;  // distinct TCP flows for the retransmit heuristic
const TOP_TALKERS = 10;

// libpcap global-header magic numbers (see pcap-savefile(5)).
const MAGIC = {
  0xa1b2c3d4: { be: false, nano: false }, // standard, host-order little
  0xd4c3b2a1: { be: true, nano: false },  // byte-swapped → big-endian file
  0xa1b23c4d: { be: false, nano: true },  // nanosecond, little
  0x4d3cb2a1: { be: true, nano: true },   // nanosecond, big
};
const PCAPNG_MAGIC = 0x0a0d0d0a; // Section Header Block → pcapng, not supported here.

// Link-layer types we understand enough to find the IP header.
const LINKTYPE_ETHERNET = 1;
const LINKTYPE_RAW = 101;      // raw IP (no L2)
const LINKTYPE_RAW_ALT1 = 12;  // some stacks use 12 for raw IP
const LINKTYPE_LINUX_SLL = 113;

const ETH_P_IP = 0x0800;
const ETH_P_IPV6 = 0x86dd;
const ETH_P_ARP = 0x0806;
const ETH_P_VLAN = 0x8100;
const ETH_P_QINQ = 0x88a8;

// ── Public entry point ──────────────────────────────────────────────────────
// analyze(input) where input is a Buffer OR a filesystem path string.
// Always resolves to a plain object; NEVER throws, NEVER fabricates.
function analyze(input, opts = {}) {
  try {
    let buf = null;

    if (Buffer.isBuffer(input)) {
      buf = input;
    } else if (typeof input === 'string' && input.trim()) {
      // A path. Size-check via stat BEFORE reading a single byte.
      let st;
      try { st = fs.statSync(input); }
      catch (e) { return honest('capture unreadable — no file at that path'); }
      if (!st.isFile()) return honest('capture unreadable — not a file');
      if (st.size > maxBytes()) return oversize(st.size);
      try { buf = fs.readFileSync(input); }
      catch (e) { return honest('capture unreadable — ' + (e && e.code || 'read error')); }
    } else {
      return honest('no capture provided');
    }

    if (!buf || buf.length === 0) return honest('no capture provided');
    if (buf.length > maxBytes()) return oversize(buf.length);

    return parse(buf, opts);
  } catch (e) {
    // A parser bug must still be honest, never a crash or a fake summary.
    return honest('could not analyze the capture — ' + scrub(e && e.message || 'internal error'));
  }
}

// ── Honest envelopes ────────────────────────────────────────────────────────
function honest(note) {
  return { ok: false, note: scrub(note) };
}
function oversize(size) {
  const cap = maxBytes();
  return {
    ok: false,
    note: scrub(`capture too large — ${bytesH(size)} exceeds the ${bytesH(cap)} limit `
      + `(raise PCAP_MAX_BYTES to analyze a bigger file)`),
  };
}

// ── The real parse ──────────────────────────────────────────────────────────
function parse(buf, opts) {
  if (buf.length < 24) {
    // Too short even for a global header. If it starts like pcapng, say so.
    if (buf.length >= 4 && buf.readUInt32BE(0) === PCAPNG_MAGIC) {
      return honest('unsupported format (pcapng not yet supported)');
    }
    return honest('unrecognized capture format (file is shorter than a libpcap header)');
  }

  // Magic decides endianness + timestamp resolution. Read raw both ways to match.
  const magicLE = buf.readUInt32LE(0);
  const magicBE = buf.readUInt32BE(0);

  if (magicBE === PCAPNG_MAGIC || magicLE === PCAPNG_MAGIC) {
    return honest('unsupported format (pcapng not yet supported)');
  }

  let fmt = MAGIC[magicLE] || MAGIC[magicBE];
  if (!fmt) {
    return honest('unrecognized capture format (not a libpcap .pcap file)');
  }
  const be = fmt.be;
  const u32 = (off) => (be ? buf.readUInt32BE(off) : buf.readUInt32LE(off));
  const u16 = (off) => (be ? buf.readUInt16BE(off) : buf.readUInt16LE(off));

  const snaplen = u32(16);
  const linktype = u32(20);

  const errors = [];
  const supportedLink = (linktype === LINKTYPE_ETHERNET || linktype === LINKTYPE_RAW
    || linktype === LINKTYPE_RAW_ALT1 || linktype === LINKTYPE_LINUX_SLL);
  if (!supportedLink) {
    errors.push(`link-layer type ${linktype} is not decoded — packet counts and timing are still real, `
      + `but per-IP/protocol/flag detail needs Ethernet/raw-IP/Linux-cooked framing`);
  }

  // Accumulators — all bounded.
  const talkers = new Map();     // ip -> { bytes, packets }
  const protocols = { tcp: 0, udp: 0, icmp: 0, other: 0 };
  const tcpFlags = { syn: 0, rst: 0, fin: 0, ack: 0, psh: 0 };
  const flows = new Map();       // flowKey -> Set of "seq:len" payload signatures
  let retransmits = 0;
  let talkersFull = false, flowsFull = false;

  let packetCount = 0;
  let tsFirst = null, tsLast = null;
  let capturedBytes = 0;
  const PKT_CAP = maxPackets();

  let off = 24; // start after the global header
  const end = buf.length;

  while (off + 16 <= end) {
    if (packetCount >= PKT_CAP) {
      errors.push(`stopped at the ${PKT_CAP}-packet safety cap — the file has more; `
        + `raise PCAP_MAX_PACKETS to read further`);
      break;
    }
    const tsSec = u32(off);
    const tsFrac = u32(off + 4);
    const inclLen = u32(off + 8); // bytes actually stored for this packet
    // origLen = u32(off + 12) — the on-wire length; we report captured bytes.
    const recStart = off + 16;

    // A malformed inclLen must never let us read past the buffer or loop forever.
    if (inclLen > (snaplen && snaplen < 0x40000000 ? Math.max(snaplen, 0x40000) : 0x40000) + 0x40000
        && inclLen > end - recStart) {
      errors.push('record length is implausible — capture looks corrupt past this point; stopped here');
      break;
    }
    if (recStart + inclLen > end) {
      errors.push(`capture is truncated — the last record claims ${inclLen} bytes but only `
        + `${end - recStart} remain; counted the ${packetCount} complete packets only`);
      break;
    }

    // A real, complete packet.
    packetCount++;
    capturedBytes += inclLen;
    const tsFloat = tsSec + (fmt.nano ? tsFrac / 1e9 : tsFrac / 1e6);
    if (tsFirst === null || tsFloat < tsFirst) tsFirst = tsFloat;
    if (tsLast === null || tsFloat > tsLast) tsLast = tsFloat;

    // Decode just enough L2/L3/L4 to surface facts. Bounds-checked throughout;
    // a short/odd frame is skipped for detail, never crashes the walk.
    if (supportedLink) {
      decodePacket(buf, recStart, inclLen, linktype, {
        talkers, protocols, tcpFlags, flows,
        addRetransmit: () => { retransmits++; },
        talkersFull: () => talkersFull,
        setTalkersFull: () => { talkersFull = true; },
        flowsFull: () => flowsFull,
        setFlowsFull: () => { flowsFull = true; },
      });
    }

    off = recStart + inclLen; // always forward progress
  }

  if (talkersFull) errors.push(`talker table hit its ${MAX_TALKERS_TRACKED} cap — top talkers are still real, `
    + `but the long tail past the cap was not tracked`);
  if (flowsFull) errors.push(`flow table hit its ${MAX_FLOWS_TRACKED} cap — the retransmit heuristic stopped `
    + `tracking new flows past that point`);

  // Shape the top talkers.
  const topTalkers = [...talkers.entries()]
    .map(([ip, v]) => ({ ip, bytes: v.bytes, packets: v.packets }))
    .sort((a, b) => b.bytes - a.bytes || b.packets - a.packets)
    .slice(0, TOP_TALKERS);

  const span = (tsFirst !== null && tsLast !== null)
    ? { start: isoOrNull(tsFirst), end: isoOrNull(tsLast), seconds: Math.max(0, +(tsLast - tsFirst).toFixed(6)) }
    : { start: null, end: null, seconds: 0 };

  const result = {
    ok: true,
    packetCount,
    capturedBytes,
    timespan: span,
    linkType: linkName(linktype),
    topTalkers,
    protocols,
    tcpFlags,
    retransmitsHeuristic: retransmits,
    errors: errors.map(scrub),
    note: scrub(summaryNote(packetCount, span, topTalkers, protocols, tcpFlags, retransmits, errors)),
  };
  return result;
}

// ── Per-packet decode: find the IP header, then L4, and book the facts ──────
// Ethertype/IP fields are ALWAYS big-endian on the wire regardless of the pcap
// file's byte order — network byte order. So we read them big-endian here, not
// with the file-endian reader. Every read is bounds-checked against `limit`.
function decodePacket(buf, start, len, linktype, acc) {
  const limit = start + len;
  let p = start;
  let ethertype = null;

  if (linktype === LINKTYPE_ETHERNET) {
    if (p + 14 > limit) return; // too short for an Ethernet header
    ethertype = buf.readUInt16BE(p + 12);
    p += 14;
    // Walk VLAN tags (802.1Q / QinQ), each 4 bytes, then the real ethertype.
    let guard = 0;
    while ((ethertype === ETH_P_VLAN || ethertype === ETH_P_QINQ) && guard < 4) {
      if (p + 4 > limit) return;
      ethertype = buf.readUInt16BE(p + 2);
      p += 4;
      guard++;
    }
  } else if (linktype === LINKTYPE_LINUX_SLL) {
    if (p + 16 > limit) return;
    ethertype = buf.readUInt16BE(p + 14);
    p += 16;
  } else if (linktype === LINKTYPE_RAW || linktype === LINKTYPE_RAW_ALT1) {
    // Raw IP: no L2. Peek the IP version nibble to set a pseudo-ethertype.
    if (p + 1 > limit) return;
    const ver = (buf[p] >> 4) & 0x0f;
    ethertype = ver === 4 ? ETH_P_IP : (ver === 6 ? ETH_P_IPV6 : null);
  }

  if (ethertype === ETH_P_ARP) { acc.protocols.other++; return; }
  if (ethertype === ETH_P_IPV6) { decodeIPv6(buf, p, limit, acc); return; }
  if (ethertype !== ETH_P_IP) { acc.protocols.other++; return; }

  // ── IPv4 ──
  if (p + 20 > limit) { acc.protocols.other++; return; }
  const vihl = buf[p];
  if (((vihl >> 4) & 0x0f) !== 4) { acc.protocols.other++; return; }
  const ihl = (vihl & 0x0f) * 4;
  if (ihl < 20 || p + ihl > limit) { acc.protocols.other++; return; }
  const totalLen = buf.readUInt16BE(p + 2);
  const proto = buf[p + 9];
  const srcIp = ip4(buf, p + 12);
  const dstIp = ip4(buf, p + 16);

  // Bytes credited to a talker = the IP total length when sane, else the frame
  // slice we actually have. Both endpoints of the packet get credited (endpoint
  // view: bytes in + out), which is the standard "top talkers" reading.
  const bytes = (totalLen >= ihl && totalLen <= len) ? totalLen : (limit - p);
  bookTalker(acc, srcIp, bytes);
  bookTalker(acc, dstIp, bytes);

  const l4 = p + ihl;
  // Only the first fragment (offset 0) carries an L4 header; later fragments do
  // not, so we count them at L3 and skip L4 decode.
  const fragOff = buf.readUInt16BE(p + 6) & 0x1fff;

  if (proto === 6) { // TCP
    acc.protocols.tcp++;
    if (fragOff === 0) decodeTCP(buf, l4, limit, srcIp, dstIp, acc);
  } else if (proto === 17) { // UDP
    acc.protocols.udp++;
  } else if (proto === 1) { // ICMP
    acc.protocols.icmp++;
  } else {
    acc.protocols.other++;
  }
}

function decodeIPv6(buf, p, limit, acc) {
  // Minimal IPv6: count protocol, credit talkers by payload length. We do not
  // chase extension headers for flags (kept honest + simple); TCP/UDP/ICMPv6
  // next-header is read directly, good enough for the protocol mix.
  if (p + 40 > limit) { acc.protocols.other++; return; }
  const payloadLen = buf.readUInt16BE(p + 4);
  const nextHdr = buf[p + 6];
  const srcIp = ip6(buf, p + 8);
  const dstIp = ip6(buf, p + 24);
  const bytes = 40 + (payloadLen && payloadLen + 40 <= (limit - p) + 40 ? payloadLen : Math.max(0, (limit - p) - 40));
  bookTalker(acc, srcIp, bytes);
  bookTalker(acc, dstIp, bytes);
  if (nextHdr === 6) { acc.protocols.tcp++; decodeTCP(buf, p + 40, limit, srcIp, dstIp, acc); }
  else if (nextHdr === 17) acc.protocols.udp++;
  else if (nextHdr === 58) acc.protocols.icmp++; // ICMPv6
  else acc.protocols.other++;
}

function decodeTCP(buf, l4, limit, srcIp, dstIp, acc) {
  if (l4 + 20 > limit) return; // too short for a TCP header
  const sport = buf.readUInt16BE(l4);
  const dport = buf.readUInt16BE(l4 + 2);
  const seq = buf.readUInt32BE(l4 + 4);
  const dataOff = ((buf[l4 + 12] >> 4) & 0x0f) * 4;
  const flags = buf[l4 + 13];
  if (flags & 0x02) acc.tcpFlags.syn++;
  if (flags & 0x04) acc.tcpFlags.rst++;
  if (flags & 0x01) acc.tcpFlags.fin++;
  if (flags & 0x10) acc.tcpFlags.ack++;
  if (flags & 0x08) acc.tcpFlags.psh++;

  // Retransmit heuristic: within a flow (src:sport→dst:dport), a data segment
  // whose (seq,payloadLen) signature we have already seen is a likely
  // retransmit. Real data only — SYN/FIN take a phantom byte in TCP but we skip
  // zero-payload control segments so keepalives/pure-ACKs don't inflate the count.
  const hdrEnd = l4 + (dataOff >= 20 ? dataOff : 20);
  const payloadLen = Math.max(0, limit - hdrEnd);
  if (payloadLen === 0) return;

  const key = `${srcIp}:${sport}>${dstIp}:${dport}`;
  let sigs = acc.flows.get(key);
  if (!sigs) {
    if (acc.flowsFull()) return; // heuristic paused; still honest (no fake count)
    sigs = new Set();
    acc.flows.set(key, sigs);
    if (acc.flows.size >= MAX_FLOWS_TRACKED) acc.setFlowsFull();
  }
  const sig = `${seq}:${payloadLen}`;
  if (sigs.has(sig)) acc.addRetransmit();
  else if (sigs.size < 4096) sigs.add(sig); // bound per-flow memory too
}

// ── Bounded talker bookkeeping ──────────────────────────────────────────────
function bookTalker(acc, ip, bytes) {
  if (!ip) return;
  let e = acc.talkers.get(ip);
  if (!e) {
    if (acc.talkersFull()) return; // table capped; existing talkers still real
    e = { bytes: 0, packets: 0 };
    acc.talkers.set(ip, e);
    if (acc.talkers.size >= MAX_TALKERS_TRACKED) acc.setTalkersFull();
  }
  e.bytes += bytes;
  e.packets += 1;
}

// ── Small formatters ────────────────────────────────────────────────────────
function ip4(buf, off) {
  return `${buf[off]}.${buf[off + 1]}.${buf[off + 2]}.${buf[off + 3]}`;
}
function ip6(buf, off) {
  const parts = [];
  for (let i = 0; i < 16; i += 2) parts.push(buf.readUInt16BE(off + i).toString(16));
  // Light :: compression of the longest zero run.
  return compressV6(parts.join(':'));
}
function compressV6(s) {
  return s.replace(/\b(?:0:){2,}0\b/, '::').replace(/^0::/, '::').replace(/::0$/, '::') || s;
}
function isoOrNull(tsFloat) {
  try {
    if (!Number.isFinite(tsFloat)) return null;
    const ms = tsFloat * 1000;
    if (ms < 0 || ms > 8.64e15) return null; // outside JS Date range → honest null
    return new Date(ms).toISOString();
  } catch (e) { return null; }
}
function bytesH(n) {
  if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
  return n + ' B';
}
function linkName(lt) {
  if (lt === LINKTYPE_ETHERNET) return 'Ethernet';
  if (lt === LINKTYPE_RAW || lt === LINKTYPE_RAW_ALT1) return 'Raw IP';
  if (lt === LINKTYPE_LINUX_SLL) return 'Linux cooked (SLL)';
  return `link-type ${lt}`;
}

function summaryNote(count, span, top, protos, flags, retrans, errors) {
  if (count === 0) {
    return errors.length
      ? `No complete packets could be read — ${errors[0]}.`
      : 'The capture is a valid libpcap file but contains zero packets.';
  }
  const bits = [];
  bits.push(`${count} packet${count === 1 ? '' : 's'} over ${span.seconds}s`);
  const mix = [];
  if (protos.tcp) mix.push(`${protos.tcp} TCP`);
  if (protos.udp) mix.push(`${protos.udp} UDP`);
  if (protos.icmp) mix.push(`${protos.icmp} ICMP`);
  if (protos.other) mix.push(`${protos.other} other`);
  if (mix.length) bits.push(mix.join(' / '));
  if (top.length) bits.push(`top talker ${top[0].ip} (${bytesH(top[0].bytes)})`);
  const flagBits = [];
  if (flags.syn) flagBits.push(`${flags.syn} SYN`);
  if (flags.rst) flagBits.push(`${flags.rst} RST`);
  if (flags.fin) flagBits.push(`${flags.fin} FIN`);
  if (flagBits.length) bits.push(flagBits.join(', '));
  if (retrans) bits.push(`~${retrans} likely retransmit${retrans === 1 ? '' : 's'}`);
  let note = bits.join('; ') + '.';
  if (flags.rst > 0) note += ' TCP resets are present — connections were refused or torn down.';
  if (retrans > 0) note += ' Retransmits suggest loss or congestion on the path.';
  if (errors.length) note += ` (${errors.length} parse caveat${errors.length === 1 ? '' : 's'} — see errors.)`;
  return note;
}

module.exports = { analyze, _internals: { maxBytes, maxPackets } };
