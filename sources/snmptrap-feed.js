// A4 — native SNMP-trap live feed.
//
// A NATIVE Node UDP listener (dgram) with a SMALL, self-contained BER/ASN.1
// decoder — NO pysnmp, no external server — that accepts SNMPv1 and SNMPv2c
// trap datagrams from real network kit and pulls out enough to be evidence:
// source, trap OID, varbinds, and (for v1) the agent uptime timestamp.
//
// Honesty laws (HANDOFF):
//   • OFF unless explicitly enabled. Not enabled → nothing binds, status says
//     "not receiving / not configured", the store stays empty. Nothing faked.
//   • A malformed / undecodable datagram is DROPPED (counted malformed), never
//     turned into a phantom event.
//   • The SNMP community string is a shared secret — it is NEVER stored or sent.
//     Only the trap OID, varbinds and source survive, and the store scrubs those.
//   • v3 traps need USM keys we do not hold; we record the source + "v3 (opaque)"
//     honestly rather than pretending to have decoded them.
const dgram = require('dgram');
const liveEvents = require('./live-events');

const DEFAULT_PORT = 1620; // not 162, so it never needs root/admin to bind

function envFlag(v) {
  if (v == null) return null;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(s)) return true;
  if (['0', 'false', 'no', 'off', 'disabled', ''].includes(s)) return false;
  return null;
}

function isEnabled() {
  const flag = envFlag(process.env.SNMPTRAP_ENABLED);
  if (flag === false) return false;
  if (flag === true) return true;
  return Boolean(process.env.SNMPTRAP_PORT);
}

function configuredPort() {
  const n = Number(process.env.SNMPTRAP_PORT);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : DEFAULT_PORT;
}

const BIND = process.env.SNMPTRAP_BIND || '127.0.0.1';

// ── Well-known OIDs / trap names (data, not logic) ───────────────────────────
const SNMP_TRAP_OID = '1.3.6.1.6.3.1.1.4.1.0'; // snmpTrapOID.0 (v2c)
const SYS_UPTIME_OID = '1.3.6.1.2.1.1.3.0';    // sysUpTime.0
const GENERIC_TRAPS = ['coldStart', 'warmStart', 'linkDown', 'linkUp', 'authenticationFailure', 'egpNeighborLoss'];
const STANDARD_TRAPS = {
  '1.3.6.1.6.3.1.1.5.1': 'coldStart',
  '1.3.6.1.6.3.1.1.5.2': 'warmStart',
  '1.3.6.1.6.3.1.1.5.3': 'linkDown',
  '1.3.6.1.6.3.1.1.5.4': 'linkUp',
  '1.3.6.1.6.3.1.1.5.5': 'authenticationFailure',
  '1.3.6.1.6.3.1.1.5.6': 'egpNeighborLoss',
};

// ── Minimal BER/ASN.1 decoder ────────────────────────────────────────────────
// Just enough of BER to walk an SNMP message. Any structural surprise throws,
// and the caller turns a throw into a dropped/malformed packet — never a guess.
function readLen(buf, pos) {
  let len = buf[pos]; pos += 1;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4) throw new Error('bad length');
    len = 0;
    for (let i = 0; i < n; i += 1) { len = (len << 8) | buf[pos]; pos += 1; }
  }
  return { len, pos };
}

// Decode one TLV at pos → { tag, start, end, valStart, valEnd, next }.
function readTLV(buf, pos) {
  if (pos >= buf.length) throw new Error('truncated');
  const tag = buf[pos];
  const l = readLen(buf, pos + 1);
  const valStart = l.pos;
  const valEnd = valStart + l.len;
  if (valEnd > buf.length) throw new Error('length past end');
  return { tag, valStart, valEnd, next: valEnd };
}

function decodeInteger(buf, s, e) {
  let v = 0;
  for (let i = s; i < e; i += 1) v = v * 256 + buf[i];
  return v;
}

function decodeOid(buf, s, e) {
  if (e <= s) return '';
  const parts = [];
  const first = buf[s];
  parts.push(Math.floor(first / 40));
  parts.push(first % 40);
  let val = 0;
  for (let i = s + 1; i < e; i += 1) {
    const b = buf[i];
    val = (val << 7) | (b & 0x7f);
    if (!(b & 0x80)) { parts.push(val); val = 0; }
  }
  return parts.join('.');
}

function decodeValue(buf, tag, s, e) {
  switch (tag) {
    case 0x02: // INTEGER
    case 0x41: // Counter32
    case 0x42: // Gauge32/Unsigned32
    case 0x43: // TimeTicks
    case 0x46: // Counter64
      return String(decodeInteger(buf, s, e));
    case 0x04: // OCTET STRING — printable if it is, else hex
      return octetToString(buf, s, e);
    case 0x05: // NULL
      return '';
    case 0x06: // OID
      return decodeOid(buf, s, e);
    case 0x40: // IpAddress
      return Array.from(buf.slice(s, e)).join('.');
    default:
      return octetToString(buf, s, e);
  }
}

function octetToString(buf, s, e) {
  const slice = buf.slice(s, e);
  // Printable ASCII → text; otherwise hex (so binary can never break the store).
  let printable = true;
  for (const b of slice) { if (b !== 0x09 && b !== 0x0a && b !== 0x0d && (b < 0x20 || b > 0x7e)) { printable = false; break; } }
  return printable ? slice.toString('utf8') : slice.toString('hex');
}

// Parse a SEQUENCE OF VarBind → [{ oid, value }].
function decodeVarbinds(buf, s, e) {
  const out = [];
  let pos = s;
  while (pos < e) {
    const vb = readTLV(buf, pos);           // VarBind SEQUENCE
    if (vb.tag !== 0x30) break;
    const nameTlv = readTLV(buf, vb.valStart);
    const valTlv = readTLV(buf, nameTlv.next);
    out.push({
      oid: decodeOid(buf, nameTlv.valStart, nameTlv.valEnd),
      value: decodeValue(buf, valTlv.tag, valTlv.valStart, valTlv.valEnd),
      type: valTlv.tag,
    });
    pos = vb.next;
  }
  return out;
}

// ── Parse a raw trap datagram → normalized event (or null if malformed) ──────
// Self-contained: any BER surprise (truncated length, tag past end) is caught
// and returned as null — a malformed packet is dropped, never thrown, never a
// fabricated event.
function parseTrap(data, sourceIp) {
  try {
    return parseTrapInner(data, sourceIp);
  } catch (e) {
    return null;
  }
}

function parseTrapInner(data, sourceIp) {
  if (!Buffer.isBuffer(data)) data = Buffer.from(data);
  if (data.length < 2 || data[0] !== 0x30) return null; // must be a SEQUENCE

  const msg = readTLV(data, 0);
  if (msg.tag !== 0x30) return null;

  // version INTEGER
  const verTlv = readTLV(data, msg.valStart);
  if (verTlv.tag !== 0x02) return null;
  const version = decodeInteger(data, verTlv.valStart, verTlv.valEnd); // 0=v1, 1=v2c, 3=v3

  if (version === 3) {
    // We hold no USM keys — record it honestly rather than fake a decode.
    return {
      source: 'trap', device: sourceIp, severity: null,
      trapOid: 'snmpv3', trapName: 'SNMPv3 trap (opaque — USM keys not held)',
      varbinds: null, ts: null,
      text: `SNMPv3 trap from ${sourceIp} — encrypted/authenticated, not decoded (no USM config)`,
      raw: `snmpv3 trap, ${data.length} bytes`,
    };
  }

  // community OCTET STRING — READ past it but NEVER keep it (shared secret).
  const commTlv = readTLV(data, verTlv.next);
  if (commTlv.tag !== 0x04) return null;

  // PDU
  const pdu = readTLV(data, commTlv.next);

  if (pdu.tag === 0xa4) return parseV1(data, pdu, sourceIp);       // Trap-PDU (v1)
  if (pdu.tag === 0xa7 || pdu.tag === 0xa6) return parseV2(data, pdu, sourceIp); // v2 Trap / Inform
  return null; // not a trap PDU we handle
}

function parseV1(buf, pdu, sourceIp) {
  let pos = pdu.valStart;
  const ent = readTLV(buf, pos); pos = ent.next;             // enterprise OID
  const enterprise = decodeOid(buf, ent.valStart, ent.valEnd);
  const agent = readTLV(buf, pos); pos = agent.next;         // agent-addr IpAddress
  const agentAddr = agent.tag === 0x40 ? Array.from(buf.slice(agent.valStart, agent.valEnd)).join('.') : null;
  const genTlv = readTLV(buf, pos); pos = genTlv.next;       // generic-trap
  const generic = decodeInteger(buf, genTlv.valStart, genTlv.valEnd);
  const specTlv = readTLV(buf, pos); pos = specTlv.next;     // specific-trap
  const specific = decodeInteger(buf, specTlv.valStart, specTlv.valEnd);
  const upTlv = readTLV(buf, pos); pos = upTlv.next;         // time-stamp TimeTicks
  const uptime = decodeInteger(buf, upTlv.valStart, upTlv.valEnd);
  const vbTlv = readTLV(buf, pos);                            // varbinds SEQUENCE
  const varbinds = vbTlv.tag === 0x30 ? decodeVarbinds(buf, vbTlv.valStart, vbTlv.valEnd) : [];

  let trapOid; let trapName = null;
  if (generic < 6) {
    trapOid = `1.3.6.1.6.3.1.1.5.${generic + 1}`;
    trapName = GENERIC_TRAPS[generic] || null;
  } else {
    trapOid = `${enterprise}.0.${specific}`;
  }

  return {
    source: 'trap',
    device: agentAddr || sourceIp,
    severity: null, // SNMP traps carry no syslog severity — honest null
    trapOid,
    trapName,
    varbinds: varbinds.map((v) => ({ oid: v.oid, name: STANDARD_TRAPS[v.oid] || null, value: v.value })),
    ts: null, // v1 uptime is device-relative ticks, not wall time — do not fake a date
    text: buildText('v1', trapName, trapOid, varbinds, agentAddr || sourceIp),
    raw: `SNMPv1 trap oid=${trapOid} generic=${generic} specific=${specific} uptimeTicks=${uptime} varbinds=${varbinds.length}`,
  };
}

function parseV2(buf, pdu, sourceIp) {
  let pos = pdu.valStart;
  const reqId = readTLV(buf, pos); pos = reqId.next;   // request-id
  const errS = readTLV(buf, pos); pos = errS.next;     // error-status
  const errI = readTLV(buf, pos); pos = errI.next;     // error-index
  const vbTlv = readTLV(buf, pos);                     // varbindings SEQUENCE
  if (vbTlv.tag !== 0x30) return null;
  const varbinds = decodeVarbinds(buf, vbTlv.valStart, vbTlv.valEnd);

  let trapOid = null; let trapName = null;
  const rest = [];
  for (const vb of varbinds) {
    if (vb.oid === SNMP_TRAP_OID) { trapOid = vb.value; trapName = STANDARD_TRAPS[vb.value] || null; continue; }
    if (vb.oid === SYS_UPTIME_OID) continue; // device uptime ticks, not wall time
    rest.push(vb);
  }
  if (!trapOid) trapOid = 'unknown';
  if (!trapName) trapName = STANDARD_TRAPS[trapOid] || null;

  return {
    source: 'trap',
    device: sourceIp,
    severity: null,
    trapOid,
    trapName,
    varbinds: rest.map((v) => ({ oid: v.oid, name: STANDARD_TRAPS[v.oid] || null, value: v.value })),
    ts: null,
    text: buildText('v2c', trapName, trapOid, rest, sourceIp),
    raw: `SNMPv2c trap oid=${trapOid} varbinds=${varbinds.length}`,
  };
}

function buildText(ver, trapName, trapOid, varbinds, device) {
  const head = `${ver} trap ${trapName || trapOid} from ${device}`;
  const vb = (varbinds || []).slice(0, 6).map((v) => `${v.oid}=${v.value}`).join(', ');
  return vb ? `${head} — ${vb}` : head;
}

// ── Live listener state ──────────────────────────────────────────────────────
let socket = null;
let listening = false;
let bound = { port: null, address: null };
let lastError = null;
const stats = { received: 0, parsed: 0, malformed: 0, lastEventTs: null };
let onEvent = null;

function start(opts = {}) {
  onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : null;
  const log = typeof opts.log === 'function' ? opts.log : () => {};

  if (!isEnabled()) { listening = false; return status(); }
  if (socket) return status();

  const port = configuredPort();
  socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  socket.on('message', (buf, rinfo) => {
    stats.received += 1;
    let evt = null;
    try {
      evt = parseTrap(buf, rinfo && rinfo.address);
    } catch (e) {
      evt = null; // any decode throw = malformed packet, never an event
    }
    if (!evt) {
      stats.malformed += 1;
      log(`[snmptrap] dropped a malformed/undecodable trap from ${rinfo && rinfo.address}`);
      return;
    }
    const stored = liveEvents.add(evt);
    if (!stored) { stats.malformed += 1; return; }
    stats.parsed += 1;
    stats.lastEventTs = stored.ts;
    if (onEvent) { try { onEvent(stored); } catch (e) {} }
  });

  socket.on('error', (err) => {
    lastError = err && err.message ? err.message : String(err);
    listening = false;
    log(`[snmptrap] listener error: ${lastError}`);
    try { socket.close(); } catch (e) {}
    socket = null;
  });

  socket.on('listening', () => {
    const a = socket.address();
    listening = true;
    bound = { port: a.port, address: a.address };
    lastError = null;
    log(`[snmptrap] listening on udp://${a.address}:${a.port}`);
  });

  try {
    socket.bind(port, BIND);
  } catch (err) {
    lastError = err && err.message ? err.message : String(err);
    listening = false;
    socket = null;
  }
  return status();
}

function stop() {
  if (socket) { try { socket.close(); } catch (e) {} socket = null; }
  listening = false;
  bound = { port: null, address: null };
}

function status() {
  return {
    enabled: isEnabled(),
    listening,
    bind: BIND,
    port: listening ? bound.port : configuredPort(),
    count: liveEvents.count('trap'),
    totalReceived: stats.received,
    parsed: stats.parsed,
    malformed: stats.malformed,
    lastEventTs: stats.lastEventTs,
    lastError,
  };
}

module.exports = {
  start,
  stop,
  status,
  isEnabled,
  parseTrap,   // exported for deterministic tests
  decodeOid,
  DEFAULT_PORT,
};
