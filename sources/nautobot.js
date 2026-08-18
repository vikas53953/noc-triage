// nautobot.js — A8 Nautobot source-of-truth (SoT) reconciliation.
//
// PURPOSE: read the INTENDED state of a device from Nautobot (the "source of
// truth" — what the records SAY the network should be) and compare it against
// our LIVE read of the ACTUAL device (from sources/catalyst-center.js), so an
// operator can answer "is the network what the records say it is?". The output
// is an honest list of DIFFERENCES (unexpected VLAN, wrong IP, missing/extra
// interface, changed description) with a plain verdict: in-sync / drift / unknown.
//
// TRUTH MODEL (the whole point — never blurred):
//   • Nautobot is the INTENDED source of truth (what SHOULD be).
//   • Our live device read is the ACTUAL (what IS).
//   • reconcile() SURFACES the differences between the two. It NEVER silently
//     picks one side as correct, never invents a field, never fabricates a value.
//     A field only becomes a difference when BOTH sides gave a real, comparable
//     value and they disagree. A missing value on either side is reported as a
//     presence gap, not guessed.
//
// HONESTY — mirrors sources/servicenow-client.js + sources/teams.js:
//   • Config is env NAUTOBOT_URL + NAUTOBOT_TOKEN. If EITHER is unset/blank this
//     is an HONEST no-op: connected() is false, reconcile() does NOTHING and
//     returns verdict:'unknown' with the plain reason "Nautobot not connected —
//     set NAUTOBOT_URL + NAUTOBOT_TOKEN". We NEVER fabricate an in-sync/drift
//     verdict when we could not actually read Nautobot.
//   • On an HTTP error (401/403/timeout/5xx/non-JSON) reconcile() returns an
//     honest, secret-scrubbed verdict:'unknown' with the real reason — never a
//     fake in-sync and never a made-up difference.
//   • The token is a SECRET. It rides ONLY in the "Authorization: Token …" header
//     on the wire. It is NEVER logged, NEVER returned by any function, NEVER
//     persisted. status() exposes only a `connected` boolean + a non-secret
//     last-reconcile summary. Error strings are scrubbed and URL-stripped as a
//     final guard. The Nautobot host is a private detail and never leaves here.

const http = require('http');
const https = require('https');
const { URL } = require('url');
const session = require('./session-log');

const DEFAULT_TIMEOUT = 15000;

// The last reconcile summary — for GET /api/copilot/nautobot/status. Carries only
// non-secret fields (ts, device, verdict, differenceCount). NEVER the token,
// NEVER the host. Null until a real reconcile has run.
let lastReconcile = null;

// ── Config, read fresh each call so a late-set env is honoured without a restart ──
// Returns { base, token } or null when EITHER is missing/blank. `base` is a
// normalised origin: NAUTOBOT_URL may be a bare host ("nautobot.example.com") —
// assumed HTTPS — or a full URL (used verbatim, which is how the deterministic
// test points the client at a local http catcher).
function creds() {
  const rawUrl = process.env.NAUTOBOT_URL;
  const token = process.env.NAUTOBOT_TOKEN;
  if (!rawUrl || !String(rawUrl).trim()) return null;
  if (!token || !String(token).trim()) return null;

  let raw = String(rawUrl).trim();
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
  let base;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    base = u;
  } catch (e) {
    return null; // a bad URL value is "not connected", never a throw
  }
  return { base, token: String(token) };
}

// Is a real Nautobot URL + token configured? The ONLY config fact any API may
// expose. Cheap and side-effect-free.
function connected() {
  return !!creds();
}

// Public status for GET /api/copilot/nautobot/status. connected boolean + the
// last-reconcile summary. NO host, NO token — the secret never leaves this module.
function status() {
  return { connected: connected(), lastReconcile };
}

// The plain-words reason used everywhere the client is not connected. One string
// so the desk, the verdict note and the capability reason all say the same thing.
const NOT_CONNECTED_NOTE =
  'Nautobot not connected — set NAUTOBOT_URL + NAUTOBOT_TOKEN in .env.local. '
  + 'Until then I read no source of truth and invent no verdict (never a fake in-sync/drift).';

// ── Interface-name normalisation ────────────────────────────────────────────
// A real NOC gotcha: Nautobot may store "GigabitEthernet1/0/1" while the live
// device reports "Gi1/0/1" (or vice-versa). Comparing the raw strings would
// invent a phantom "device_only"/"nautobot_only" difference for every interface.
// So both sides are normalised to a canonical long form before matching: the
// short Cisco abbreviations are expanded, case + surrounding space dropped. This
// is intent (same physical port), not fabrication — we never merge two genuinely
// different ports, only two spellings of the same one.
const IFACE_ABBR = [
  [/^gi(?=[\d/])/, 'gigabitethernet'],
  [/^ge(?=[\d/])/, 'gigabitethernet'],
  [/^te(?=[\d/])/, 'tengigabitethernet'],
  [/^tw(?=[\d/])/, 'twentyfivegige'],
  [/^fo(?=[\d/])/, 'fortygigabitethernet'],
  [/^hu(?=[\d/])/, 'hundredgige'],
  [/^fa(?=[\d/])/, 'fastethernet'],
  [/^eth(?=[\d/])/, 'ethernet'],
  [/^et(?=[\d/])/, 'ethernet'],
  [/^po(?=\d)/, 'port-channel'],
  [/^lo(?=\d)/, 'loopback'],
  [/^vl(?=\d)/, 'vlan'],
  [/^tu(?=\d)/, 'tunnel'],
];
function normIface(name) {
  let s = String(name == null ? '' : name).trim().toLowerCase().replace(/\s+/g, '');
  for (const [re, full] of IFACE_ABBR) {
    if (re.test(s)) { s = s.replace(re, full); break; }
  }
  return s;
}

// ── Low-level HTTP(S) GET. Never rejects — resolves { ok, status, body } or ───
// { ok:false, error }. Supports http AND https so the deterministic test can
// point NAUTOBOT_URL at a local http catcher. The Token auth header is built
// HERE and never leaves — it is not logged and the request/response are NOT
// routed through session-log (this module owns all its own telemetry so the host
// never lands in a shared record).
function get(c, pathAndQuery) {
  const u = c.base;
  const lib = u.protocol === 'https:' ? https : http;
  const opts = {
    method: 'GET',
    hostname: u.hostname,
    port: u.port || (u.protocol === 'https:' ? 443 : 80),
    path: (u.pathname === '/' ? '' : u.pathname.replace(/\/$/, '')) + pathAndQuery,
    headers: {
      'Authorization': `Token ${c.token}`,
      'Accept': 'application/json',
    },
    timeout: DEFAULT_TIMEOUT,
  };
  return new Promise((resolve) => {
    let settled = false;
    const settle = (r) => { if (!settled) { settled = true; resolve(r); } };
    const req = lib.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => settle({
        ok: res.statusCode >= 200 && res.statusCode < 300,
        status: res.statusCode,
        body: data,
      }));
    });
    req.on('error', (err) => settle({ ok: false, error: err.code || err.message }));
    req.on('timeout', () => { req.destroy(); settle({ ok: false, error: 'timeout' }); });
    req.end();
  });
}

// GET a JSON endpoint honestly. Returns { ok:true, json } or a typed honest
// failure { ok:false, outcome, error } — 401/403 auth, 404 not_found, else error.
async function getJson(c, pathAndQuery) {
  const res = await get(c, pathAndQuery);
  if (res.ok) {
    try { return { ok: true, json: JSON.parse(res.body || '{}') }; }
    catch (e) { return { ok: false, outcome: 'error', error: 'Nautobot response was not JSON' }; }
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, outcome: 'auth_failed', error: `Nautobot rejected the token (${res.status})` };
  }
  if (res.status === 404) return { ok: false, outcome: 'not_found', error: 'Nautobot has no record for that (404)' };
  return { ok: false, outcome: res.status ? 'error' : 'unreachable', error: scrubErr(res.error || `status ${res.status}`) };
}

const enc = encodeURIComponent;

// ── Read a device's INTENDED state from Nautobot (REST API) ─────────────────
// Pulls the device record + its interfaces + the interface IP assignments. Uses
// Nautobot's REST API (dcim/devices, dcim/interfaces, ipam/ip-addresses) with a
// Token, depth=1 so nested names (status/role/vlan) come back resolved. Returns
// { ok:true, intended:{...} } or an honest { ok:false, outcome, error }.
async function getDeviceIntent(c, deviceName) {
  const dev = await getJson(c, `/api/dcim/devices/?name=${enc(deviceName)}&depth=1`);
  if (!dev.ok) return dev;
  const rows = (dev.json && dev.json.results) || [];
  if (!rows.length) {
    return { ok: false, outcome: 'not_in_sot', error: `Nautobot has no device named "${deviceName}" — nothing to reconcile against.` };
  }
  const d = rows[0];

  // Interfaces for this device (by name so we do not depend on the id shape).
  const ifRes = await getJson(c, `/api/dcim/interfaces/?device=${enc(deviceName)}&depth=1&limit=0`);
  if (!ifRes.ok) return ifRes;
  const ifRows = (ifRes.json && ifRes.json.results) || [];

  // IP addresses assigned to this device's interfaces (IPAM). A device with no
  // documented IPs is a real, honest empty — not an error.
  const ipRes = await getJson(c, `/api/ipam/ip-addresses/?device=${enc(deviceName)}&depth=1&limit=0`);
  const ipRows = (ipRes.ok && ipRes.json && ipRes.json.results) || [];
  const ipsByIface = {};
  for (const ip of ipRows) {
    // Nautobot assigns an IP to an interface; the shape varies by version, so
    // read the interface name defensively without inventing anything.
    const ifaceName = ipAssignedInterface(ip);
    if (!ifaceName) continue;
    const key = normIface(ifaceName);
    (ipsByIface[key] = ipsByIface[key] || []).push(String(ip.address || ip.host || '').trim());
  }

  const interfaces = ifRows.map((i) => {
    const key = normIface(i.name);
    // IPs can arrive either nested on the interface OR via the IPAM list above.
    const nestedIps = Array.isArray(i.ip_addresses)
      ? i.ip_addresses.map((x) => String((x && x.address) || x || '').trim()).filter(Boolean)
      : [];
    const ips = dedupe([...(ipsByIface[key] || []), ...nestedIps]);
    return {
      name: i.name,
      norm: key,
      enabled: typeof i.enabled === 'boolean' ? i.enabled : undefined,
      description: i.description != null ? String(i.description) : undefined,
      mtu: i.mtu != null ? Number(i.mtu) : undefined,
      vlan: untaggedVlan(i),
      ips,
    };
  });

  return {
    ok: true,
    intended: {
      name: d.name,
      status: nameOf(d.status),
      role: nameOf(d.role) || nameOf(d.device_role),
      serial: d.serial != null ? String(d.serial).trim() : undefined,
      primaryIp: stripMask(nameOf(d.primary_ip4) || nameOf(d.primary_ip) || addrOf(d.primary_ip4) || addrOf(d.primary_ip)),
      interfaces,
    },
  };
}

// ── Read helpers that never invent a value (undefined when Nautobot didn't say) ─
function nameOf(o) {
  if (o == null) return undefined;
  if (typeof o === 'string') return o;
  if (typeof o === 'object') return o.name != null ? String(o.name) : (o.display != null ? String(o.display) : undefined);
  return undefined;
}
function addrOf(o) {
  if (o && typeof o === 'object' && o.address != null) return String(o.address);
  return undefined;
}
function stripMask(v) {
  if (v == null) return undefined;
  return String(v).replace(/\/\d+$/, '').trim() || undefined;
}
function untaggedVlan(i) {
  const v = i.untagged_vlan;
  if (v == null) return undefined;
  if (typeof v === 'object') return v.vid != null ? Number(v.vid) : (v.name != null ? String(v.name) : undefined);
  return Number(v);
}
function ipAssignedInterface(ip) {
  // Nautobot 2.x: assigned_object.name (+ .device); older: interface.name.
  const ao = ip.assigned_object || ip.interface;
  if (ao && typeof ao === 'object') return ao.name != null ? String(ao.name) : undefined;
  if (Array.isArray(ip.interface_assignments) && ip.interface_assignments[0]) {
    const a = ip.interface_assignments[0].interface;
    if (a && a.name != null) return String(a.name);
  }
  return undefined;
}
function dedupe(arr) { return Array.from(new Set(arr.filter(Boolean))); }

// ── Normalise a LIVE device read (from catalyst-center.js) into the ACTUAL shape ─
// Accepts the enveloped/raw shapes catalyst-center returns and reduces them to
// the same field vocabulary getDeviceIntent produces, so the comparison is
// apples-to-apples. Anything the live read did not give stays undefined — never
// guessed.
function normalizeLive(live) {
  if (!live || typeof live !== 'object') return null;
  const dev = live.device || live.detail || live;
  const rawIfaces = live.interfaces
    || (live.interfacesEnvelope && live.interfacesEnvelope.data)
    || [];
  const interfaces = (Array.isArray(rawIfaces) ? rawIfaces : []).map((i) => {
    const admin = i.adminStatus != null ? i.adminStatus : i.admin;
    return {
      name: i.name || i.portName,
      norm: normIface(i.name || i.portName),
      enabled: adminToEnabled(admin),
      description: i.description != null ? String(i.description) : undefined,
      mtu: i.mtu != null ? Number(i.mtu) : undefined,
      vlan: i.vlan != null ? Number(i.vlan) : (i.vlanId != null ? Number(i.vlanId) : undefined),
      ips: dedupe([i.ip, i.ipv4Address, i.ipv4].map((x) => x ? String(x).replace(/\/\d+$/, '').trim() : '')),
    };
  });
  return {
    name: dev.hostname || dev.name,
    role: dev.role,
    serial: dev.serial != null ? String(dev.serial).trim() : undefined,
    primaryIp: dev.ip != null ? stripMask(dev.ip) : (dev.managementIp != null ? stripMask(dev.managementIp) : undefined),
    interfaces,
  };
}
function adminToEnabled(admin) {
  if (admin == null) return undefined;
  if (typeof admin === 'boolean') return admin;
  const s = String(admin).toLowerCase();
  if (/up|enabled|true/.test(s)) return true;
  if (/down|disabled|false|shut/.test(s)) return false;
  return undefined;
}

// ── The comparison — the heart of A8 ────────────────────────────────────────
// Produces a flat list of { field, intended, actual } differences. A field is a
// difference ONLY when both sides gave a real, comparable value and they differ.
// A value present on one side but not the other is a PRESENCE gap (interface only
// in Nautobot, or only on the device) — reported plainly, never guessed away.
function diff(intended, actual) {
  const out = [];
  const cmp = (field, a, b) => {
    if (a === undefined || a === null || a === '') return; // Nautobot didn't say
    if (b === undefined || b === null || b === '') return; // device didn't say
    if (String(a) !== String(b)) out.push({ field, intended: a, actual: b });
  };

  // Device-level fields (only the ones both sources speak the same language on).
  cmp('serial', intended.serial, actual.serial);
  cmp('primary IP', intended.primaryIp, actual.primaryIp);
  cmp('role', intended.role != null ? String(intended.role).toLowerCase() : undefined,
             actual.role != null ? String(actual.role).toLowerCase() : undefined);

  // Interface-level, indexed by the canonical (normalised) name.
  const nbByName = index(intended.interfaces);
  const liveByName = index(actual.interfaces);
  const allNames = dedupe([...Object.keys(nbByName), ...Object.keys(liveByName)]);
  allNames.sort();

  for (const key of allNames) {
    const nb = nbByName[key];
    const lv = liveByName[key];
    if (nb && !lv) {
      out.push({ field: `interface ${nb.name}`, intended: 'present (documented in Nautobot)', actual: 'absent on device' });
      continue;
    }
    if (!nb && lv) {
      out.push({ field: `interface ${lv.name}`, intended: 'not in Nautobot', actual: 'present on device (undocumented)' });
      continue;
    }
    const label = nb.name;
    cmp(`interface ${label}: enabled`, nb.enabled, lv.enabled);
    cmp(`interface ${label}: description`, nb.description, lv.description);
    cmp(`interface ${label}: mtu`, nb.mtu, lv.mtu);
    cmp(`interface ${label}: vlan`, nb.vlan, lv.vlan);
    // IPs: compare as sets; only flag when both sides listed at least one. Both
    // sides are mask-stripped first so "10.0.0.1/32" and "10.0.0.1" — the same
    // address written two ways — are never a phantom difference.
    if (nb.ips && nb.ips.length && lv.ips && lv.ips.length) {
      const bare = (arr) => dedupe(arr.map((x) => String(x).replace(/\/\d+$/, '').trim())).sort();
      const a = bare(nb.ips);
      const b = bare(lv.ips);
      if (a.join(',') !== b.join(',')) {
        out.push({ field: `interface ${label}: IP addresses`, intended: a, actual: b });
      }
    }
  }
  return out;
}
function index(list) {
  const m = {};
  for (const i of (list || [])) if (i && i.norm) m[i.norm] = i;
  return m;
}

// ── reconcile — the one public operation ────────────────────────────────────
// Compares Nautobot's INTENDED state for `device` against the LIVE/ACTUAL read
// and returns the honest verdict. Shape (always these keys):
//   { ok, connected, device, differences:[{field,intended,actual}],
//     verdict:'in-sync'|'drift'|'unknown', note }
//
// `opts.live` lets a caller (or the deterministic test) inject an already-fetched
// ACTUAL device read; when omitted, the live read is pulled from
// sources/catalyst-center.js. Either way Nautobot is the intended side.
//
// verdict:'unknown' is returned — never in-sync/drift — whenever we could NOT
// actually establish both sides: not connected, Nautobot error, device not in
// the SoT, or no live/actual read available. We never fabricate a clean verdict.
async function reconcile(deviceArg, opts = {}) {
  const device = String((deviceArg && deviceArg.device) || deviceArg || '').trim();
  const o = opts || {};
  const unknown = (note, extra) => Object.assign(
    { ok: false, connected: connected(), device, differences: [], verdict: 'unknown', note }, extra || {});

  if (!device) return unknown('No device named — tell me which device to reconcile against Nautobot.');

  const c = creds();
  if (!c) {
    recordReconcile({ device, verdict: 'unknown', differenceCount: 0, connected: false });
    return { ok: false, connected: false, device, differences: [], verdict: 'unknown', note: NOT_CONNECTED_NOTE };
  }

  // 1) Intended state — from Nautobot (the source of truth).
  let intent;
  try {
    intent = await getDeviceIntent(c, device);
  } catch (e) {
    return unknown(`Could not read Nautobot — ${scrubErr((e && e.message) || 'unreachable')}.`);
  }
  if (!intent.ok) {
    if (intent.outcome === 'not_in_sot') return unknown(intent.error);
    if (intent.outcome === 'auth_failed') return unknown(`Nautobot rejected the token — ${scrubErr(intent.error)}. Check NAUTOBOT_TOKEN.`);
    return unknown(`Could not read Nautobot's intended state — ${scrubErr(intent.error || 'unreachable')}.`);
  }
  const intended = intent.intended;

  // 2) Actual state — the live device read. Injected, or pulled from Catalyst Center.
  let actual = o.live !== undefined ? normalizeLive(o.live) : null;
  if (o.live === undefined) {
    const liveRead = await fetchLive(device);
    if (!liveRead.ok) return unknown(`Read the intended state from Nautobot, but the live device read is unavailable — ${liveRead.error}. Cannot judge in-sync vs drift without both sides.`, { intended });
    actual = liveRead.actual;
  }
  if (!actual) return unknown('No live/actual device read to compare against — cannot judge in-sync vs drift without both sides.', { intended });

  // 3) Compare intended vs actual → honest differences + verdict.
  const differences = diff(intended, actual);
  const verdict = differences.length ? 'drift' : 'in-sync';
  const note = verdict === 'in-sync'
    ? `${device} matches Nautobot's source of truth — no drift found across ${countChecked(intended)} intended field(s).`
    : `${device} has drifted from Nautobot's source of truth — ${differences.length} difference(s) between intended and actual.`;

  recordReconcile({ device, verdict, differenceCount: differences.length, connected: true });
  auditReconcile(device, verdict, differences.length);
  return { ok: true, connected: true, device, verdict, differences, note, intended };
}

function countChecked(intended) {
  let n = 0;
  if (intended.serial !== undefined) n++;
  if (intended.primaryIp !== undefined) n++;
  if (intended.role !== undefined) n++;
  n += (intended.interfaces || []).length;
  return n;
}

// Pull the LIVE/ACTUAL device read from Catalyst Center (read-only). Resolves the
// device by name → its id → its interfaces. Lazy-required so nautobot.js has no
// hard load-order dependency on the adapter and the honest tests need no DNAC.
// Returns { ok:true, actual } or an honest { ok:false, error } — NEVER a
// fabricated device; an unreachable/unconfigured live source is said plainly.
async function fetchLive(device) {
  let catc;
  try { catc = require('./catalyst-center'); }
  catch (e) { return { ok: false, error: 'the live device adapter is unavailable' }; }
  if (!catc.configured || !catc.configured()) {
    return { ok: false, error: 'Catalyst Center not connected (DNAC_HOST/USER/PASS unset), so there is no live read to compare against' };
  }
  try {
    const devices = await catc.getDevices();
    const match = (devices || []).find((d) => String(d.hostname || '').toLowerCase() === device.toLowerCase());
    if (!match) return { ok: false, error: `Catalyst Center has no device named "${device}" to read live` };
    const ifEnv = await catc.getInterfaces(match.id);
    const interfaces = (ifEnv && ifEnv.ok && Array.isArray(ifEnv.data)) ? ifEnv.data : [];
    return { ok: true, actual: normalizeLive({ device: match, interfaces }) };
  } catch (e) {
    return { ok: false, error: scrubErr((e && e.message) || 'live read failed') };
  }
}

// ── The last-reconcile summary writer (non-secret only) ──────────────────────
function recordReconcile({ device, verdict, differenceCount, connected: conn } = {}) {
  lastReconcile = {
    ts: new Date().toISOString(),
    device: device || null,
    verdict: verdict || 'unknown',
    differenceCount: differenceCount != null ? differenceCount : 0,
    connected: !!conn,
  };
  return lastReconcile;
}

function auditReconcile(device, verdict, count) {
  try {
    session.audit({
      what: 'nautobot reconcile (source-of-truth)',
      device,
      result: `verdict ${verdict}${verdict === 'drift' ? ` — ${count} difference(s)` : ''}`,
    });
  } catch (e) { /* audit must never break a reconcile */ }
}

// ── Secret scrubbing for errors ─────────────────────────────────────────────
// A transport error must never carry the token or a full URL. Run the shared
// scrubber, then strip anything URL-shaped and Token-header-shaped as a final net.
function scrubErr(err) {
  let s = session.scrub(String(err == null ? 'reconcile failed' : err));
  s = s.replace(/https?:\/\/\S+/gi, '«url»');
  s = s.replace(/Token\s+[A-Za-z0-9]+/gi, 'Token «redacted»');
  return s.slice(0, 200);
}

module.exports = {
  connected, status, reconcile, NOT_CONNECTED_NOTE,
  // exposed for tests / the reconcile logic
  _internals: { normIface, normalizeLive, diff, getDeviceIntent, scrubErr, creds },
};
