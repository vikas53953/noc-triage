// A4 — native syslog live feed.
//
// A NATIVE Node UDP listener (dgram — no Python, no external server) that
// accepts RFC 3164 (BSD) and RFC 5424 syslog datagrams from real network kit,
// parses out host / severity / facility / timestamp / message, and deposits a
// parsed event into the live-events store (+ a broadcast callback for the WS).
//
// Honesty laws (HANDOFF):
//   • OFF unless explicitly enabled. Not enabled → nothing binds, status says
//     "not receiving / not configured", the store stays empty. Nothing faked.
//   • A malformed / undecodable packet is DROPPED (and counted as malformed),
//     never turned into a phantom event.
//   • Secret scrubbing happens in the store before anything is persisted/sent.
//   • Binds to localhost by default (SYSLOG_BIND) — a listener on 0.0.0.0 puts
//     the port on every interface, which the operator must opt into.
const dgram = require('dgram');
const liveEvents = require('./live-events');

// ── Config (env, honest defaults) ────────────────────────────────────────────
// Enabled when SYSLOG_ENABLED is truthy OR a SYSLOG_PORT is set — but an
// explicit SYSLOG_ENABLED=0/false/off wins and keeps it OFF even if a port is
// present. Default port 5514 (not 514) so it never needs root/admin to bind.
const DEFAULT_PORT = 5514;

function envFlag(v) {
  if (v == null) return null;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(s)) return true;
  if (['0', 'false', 'no', 'off', 'disabled', ''].includes(s)) return false;
  return null;
}

function isEnabled() {
  const flag = envFlag(process.env.SYSLOG_ENABLED);
  if (flag === false) return false;
  if (flag === true) return true;
  return Boolean(process.env.SYSLOG_PORT); // a bare port also enables
}

function configuredPort() {
  const n = Number(process.env.SYSLOG_PORT);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : DEFAULT_PORT;
}

const BIND = process.env.SYSLOG_BIND || '127.0.0.1';

// ── RFC severity / facility vocab (the numbers ARE the standard) ─────────────
const SEVERITY_NAMES = [
  'emergency', 'alert', 'critical', 'error', 'warning', 'notice', 'informational', 'debug',
];
const FACILITY_NAMES = [
  'kernel', 'user', 'mail', 'daemon', 'auth', 'syslog', 'lpr', 'news',
  'uucp', 'cron', 'authpriv', 'ftp', 'ntp', 'audit', 'alert', 'clock',
  'local0', 'local1', 'local2', 'local3', 'local4', 'local5', 'local6', 'local7',
];

function decodePri(pri) {
  const facilityNum = pri >> 3;
  const severityNum = pri & 0x07;
  return {
    facilityNum,
    severityNum,
    facility: FACILITY_NAMES[facilityNum] || `facility${facilityNum}`,
    severity: SEVERITY_NAMES[severityNum] || `severity${severityNum}`,
  };
}

// RFC 5424:  <PRI>1 TIMESTAMP HOST APP PROCID MSGID SD MSG
const RE_5424 = /^<(\d{1,3})>1\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\[.*?\]|-)\s*([\s\S]*)$/;
// RFC 3164:  <PRI>MMM DD HH:MM:SS HOST TAG: MSG
const RE_3164 = /^<(\d{1,3})>(?:(\d+):\s+)?(?:\*?([A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}(?:\.\d+)?)\s*:?\s+)?(\S+)?\s*([\s\S]*)$/;
// Bare PRI fallback: <PRI> rest
const RE_PRI = /^<(\d{1,3})>([\s\S]*)$/;

// RFC 3164 timestamps carry no year — anchor to the current year.
function parse3164Ts(str) {
  if (!str) return null;
  const clean = str.replace(/\..*$/, '').trim(); // drop fractional secs
  const ms = Date.parse(`${clean} ${new Date().getUTCFullYear()}`);
  return Number.isNaN(ms) ? null : ms;
}

// Parse a raw syslog datagram → a normalized event object, or null if it does
// not even carry a PRI (then it is not syslog we can trust — dropped). Never
// throws — any surprise returns null so a malformed packet is simply dropped.
function parseSyslog(raw, sourceIp) {
  try {
    return parseSyslogInner(raw, sourceIp);
  } catch (e) {
    return null;
  }
}

function parseSyslogInner(raw, sourceIp) {
  const text = String(raw == null ? '' : raw).replace(/\0+$/, '').trim();
  if (!text) return null;

  // RFC 5424 first (it self-identifies with the "1" version after PRI).
  let m = RE_5424.exec(text);
  if (m) {
    const pri = Number(m[1]);
    if (pri > 191) return null;
    const p = decodePri(pri);
    const tsMs = m[2] && m[2] !== '-' ? Date.parse(m[2].replace('Z', '+00:00')) : NaN;
    const host = m[3] && m[3] !== '-' ? m[3] : sourceIp;
    const app = m[4] && m[4] !== '-' ? m[4] : null;
    const msg = m[8] || '';
    return {
      source: 'syslog',
      device: host,
      severity: p.severity,
      severityNum: p.severityNum,
      facility: p.facility,
      ts: Number.isNaN(tsMs) ? null : tsMs,
      text: [app ? `${app}:` : null, msg].filter(Boolean).join(' ').trim() || msg,
      raw: text,
    };
  }

  // RFC 3164 (BSD) / Cisco-style.
  m = RE_3164.exec(text);
  if (m) {
    const pri = Number(m[1]);
    if (pri > 191) return null;
    const p = decodePri(pri);
    const tsMs = parse3164Ts(m[3]);
    // m[4] is the TAG for classic 3164; for Cisco-style (no host in payload) it
    // is the start of the message — either way the sending IP is the device we
    // can trust, so we anchor device on sourceIp and keep TAG+msg as text.
    const tag = m[4] || '';
    const msg = m[5] || '';
    return {
      source: 'syslog',
      device: sourceIp,
      severity: p.severity,
      severityNum: p.severityNum,
      facility: p.facility,
      ts: tsMs,
      text: [tag, msg].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim(),
      raw: text,
    };
  }

  // Bare <PRI> with an unrecognised body — still real syslog, keep the message.
  m = RE_PRI.exec(text);
  if (m) {
    const pri = Number(m[1]);
    if (pri > 191) return null;
    const p = decodePri(pri);
    return {
      source: 'syslog',
      device: sourceIp,
      severity: p.severity,
      severityNum: p.severityNum,
      facility: p.facility,
      ts: null,
      text: (m[2] || '').trim(),
      raw: text,
    };
  }

  // No PRI at all → not something we can trust as syslog. Dropped.
  return null;
}

// ── Live listener state ──────────────────────────────────────────────────────
let socket = null;
let listening = false;
let bound = { port: null, address: null };
let lastError = null;
const stats = { received: 0, parsed: 0, malformed: 0, lastEventTs: null };
let onEvent = null; // set by start(); called with the STORED event for WS

// Start the listener. No-op (returns a status) when the feed is disabled — the
// honest "not configured" path. Safe to call once at boot.
function start(opts = {}) {
  onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : null;
  const log = typeof opts.log === 'function' ? opts.log : () => {};

  if (!isEnabled()) {
    listening = false;
    return status();
  }
  if (socket) return status(); // already started

  const port = configuredPort();
  socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  socket.on('message', (buf, rinfo) => {
    stats.received += 1;
    let evt = null;
    try {
      evt = parseSyslog(buf.toString('utf8'), rinfo && rinfo.address);
    } catch (e) {
      evt = null; // a throw during parse is a malformed packet, never an event
    }
    if (!evt) {
      stats.malformed += 1;
      log(`[syslog] dropped a malformed/undecodable datagram from ${rinfo && rinfo.address}`);
      return;
    }
    const stored = liveEvents.add(evt);
    if (!stored) { stats.malformed += 1; return; }
    stats.parsed += 1;
    stats.lastEventTs = stored.ts;
    if (onEvent) { try { onEvent(stored); } catch (e) { /* WS must never break ingest */ } }
  });

  socket.on('error', (err) => {
    lastError = err && err.message ? err.message : String(err);
    listening = false;
    log(`[syslog] listener error: ${lastError}`);
    try { socket.close(); } catch (e) {}
    socket = null;
  });

  socket.on('listening', () => {
    const a = socket.address();
    listening = true;
    bound = { port: a.port, address: a.address };
    lastError = null;
    log(`[syslog] listening on udp://${a.address}:${a.port}`);
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

// Status for the /feeds/status route — booleans + counts ONLY, never a secret,
// never the raw packet. `port` reflects the configured target even when off, so
// the operator can see where it WOULD listen.
function status() {
  return {
    enabled: isEnabled(),
    listening,
    bind: BIND,
    port: listening ? bound.port : configuredPort(),
    count: liveEvents.count('syslog'),
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
  parseSyslog,   // exported for deterministic tests
  decodePri,
  DEFAULT_PORT,
};
