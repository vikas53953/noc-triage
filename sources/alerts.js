// Alert-driven ingestion (Wave 2).
//
// An inlet that turns a REAL inbound monitoring alert (vManage / Catalyst /
// SNMP / Splunk-style) into a normalized shape, maps its severity onto our
// P1/P2/P3 scale, and derives a triage description + front DETERMINISTICALLY —
// no LLM. Anthropic credits may be exhausted; alert→triage must still work end
// to end from plain string handling alone.
//
// Honesty rules kept: a malformed payload is refused (never opens a phantom
// triage); an alert that names nothing real (no front, no device, a message
// that names no network subject) is refused too — the same nonsense-triage
// guard the operator path enforces. A real alert naming a device or a front
// opens a real triage.
//
// This module owns ONLY the alert shape + mapping. It does NOT open triages —
// triage.js calls in with the normalized alert. It reuses session-log's secret
// scrubber so the stored raw payload can never carry a credential.
const session = require('./session-log');

// ── Severity mapping (documented, deterministic) ─────────────────────────────
// Alert severity strings vary by vendor. We map the common vocabularies onto our
// three triage severities. The mapping is DATA (easy to read + change), not code
// scattered through branches. Anything we don't recognise falls to P3 (the
// safe, least-aggressive default) and the fallback is called out on the record.
//
//   P1  ← critical / crit / sev1 / severity-1 / emergency / fatal / down / p1
//   P2  ← major / high / sev2 / severity-2 / error / err / p2
//   P3  ← minor / warning / warn / low / info / informational / sev3 / notice / p3
const SEVERITY_MAP = {
  // → P1
  critical: 'P1', crit: 'P1', sev1: 'P1', 'severity-1': 'P1', severity1: 'P1',
  emergency: 'P1', fatal: 'P1', down: 'P1', p1: 'P1', '1': 'P1',
  // → P2
  major: 'P2', high: 'P2', sev2: 'P2', 'severity-2': 'P2', severity2: 'P2',
  error: 'P2', err: 'P2', p2: 'P2', '2': 'P2',
  // → P3
  minor: 'P3', warning: 'P3', warn: 'P3', low: 'P3', info: 'P3',
  informational: 'P3', notice: 'P3', sev3: 'P3', 'severity-3': 'P3',
  severity3: 'P3', p3: 'P3', '3': 'P3',
};
const DEFAULT_SEVERITY = 'P3';

// Map a raw alert severity onto P1/P2/P3. Returns { severity, mapped, note }:
// `mapped` is true when the vendor string was recognised, false when we fell
// back to the default (surfaced honestly on the record).
function mapSeverity(raw) {
  const key = String(raw == null ? '' : raw).trim().toLowerCase();
  const hit = SEVERITY_MAP[key];
  if (hit) return { severity: hit, mapped: true, note: null };
  return {
    severity: DEFAULT_SEVERITY, mapped: false,
    note: `alert severity "${raw}" is not a recognised level — defaulted to ${DEFAULT_SEVERITY}`,
  };
}

// ── Front derivation (deterministic) ─────────────────────────────────────────
// Resolve which triage front an alert belongs to, from an explicit `front`
// field, then the `source`/vendor, then keywords in the message. Live fronts:
// campus (Catalyst), fabric (ACI), wan (SD-WAN), incidents. Blind fronts
// (firewall / loadbalancer / security) are still valid subjects — a real alert
// about them opens a triage that names the blind spot honestly. null = the
// alert named no front we recognise (the caller then leans on device/message).
const FRONT_ALIASES = {
  campus: 'campus', catalyst: 'campus', 'catalyst-center': 'campus', dnac: 'campus',
  'catalyst center': 'campus', switch: 'campus', access: 'campus',
  fabric: 'fabric', aci: 'fabric', apic: 'fabric', 'data-center': 'fabric',
  datacenter: 'fabric', nexus: 'fabric',
  wan: 'wan', 'sd-wan': 'wan', sdwan: 'wan', vmanage: 'wan', viptela: 'wan',
  vedge: 'wan', 'v-edge': 'wan', overlay: 'wan', cedge: 'wan',
  incidents: 'incidents', incident: 'incidents',
  firewall: 'firewall', fmc: 'firewall', asa: 'firewall', ftd: 'firewall',
  loadbalancer: 'loadbalancer', 'load-balancer': 'loadbalancer', f5: 'loadbalancer',
  ltm: 'loadbalancer', vip: 'loadbalancer',
  security: 'security', cve: 'security', threat: 'security', ids: 'security', ips: 'security',
};
const LIVE_FRONTS = ['campus', 'fabric', 'wan', 'incidents'];
const BLIND_FRONTS = ['firewall', 'loadbalancer', 'security'];
const KNOWN_FRONTS = [...LIVE_FRONTS, ...BLIND_FRONTS];

function normKey(s) { return String(s == null ? '' : s).trim().toLowerCase(); }

function deriveFront(explicitFront, source, message) {
  // 1) an explicit front field wins.
  const ef = normKey(explicitFront);
  if (FRONT_ALIASES[ef]) return FRONT_ALIASES[ef];
  if (KNOWN_FRONTS.includes(ef)) return ef;
  // 2) the vendor/source string.
  const src = normKey(source);
  if (FRONT_ALIASES[src]) return FRONT_ALIASES[src];
  for (const alias of Object.keys(FRONT_ALIASES)) {
    if (src && src.includes(alias)) return FRONT_ALIASES[alias];
  }
  // 3) keywords in the message.
  const msg = normKey(message);
  for (const alias of Object.keys(FRONT_ALIASES)) {
    const re = new RegExp(`\\b${alias.replace(/[-/]/g, '[-/ ]?')}\\b`, 'i');
    if (msg && re.test(msg)) return FRONT_ALIASES[alias];
  }
  return null;
}

// ── Secret-scrub a raw payload ───────────────────────────────────────────────
// Round-trips the payload through the shared scrubber so any token-shaped field
// is redacted before the raw is stored on the record or streamed to the browser.
// Falls back to a scrubbed string if the payload can't be re-parsed as JSON.
function scrubRaw(payload) {
  try {
    return JSON.parse(session.scrub(JSON.stringify(payload)));
  } catch (e) {
    return { note: 'raw payload not JSON-serialisable', text: session.scrub(String(payload)).slice(0, 2000) };
  }
}

// ── Normalize an inbound alert ───────────────────────────────────────────────
// Accepts the loose vendor payload and returns either:
//   { ok:true, alert, triageSeverity, description, front, severityNote }
//   { ok:false, error:'malformed'|'nonsense', reason }
//
// alert = { source, type, severity, device, front, message, receivedAt, raw }
//   severity = the ORIGINAL alert level string (e.g. "critical"); the mapped
//   triage severity is returned separately as triageSeverity.
//
// A malformed payload (not an object, or carrying no message/type/device to act
// on) is refused as 'malformed'. A structurally-fine alert that still names
// nothing real — no known front, no device, and a message that names no network
// subject — is refused as 'nonsense' (the same guard the operator path applies).
function normalize(payload, opts = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, error: 'malformed', reason: 'Alert payload must be a JSON object with at least a message and a severity.' };
  }

  const clean = (v, cap = 500) => {
    if (v == null) return '';
    return String(v).replace(/\s+/g, ' ').trim().slice(0, cap);
  };

  const source = clean(payload.source, 120);
  const type = clean(payload.type, 120);
  const rawSeverity = clean(payload.severity, 60);
  const device = clean(payload.device, 200);
  const explicitFront = clean(payload.front, 60);
  const message = clean(payload.message, 800);

  // Structurally malformed: nothing actionable at all — no message, no type, and
  // no device. We refuse rather than open a phantom triage over an empty body.
  if (!message && !type && !device) {
    return { ok: false, error: 'malformed', reason: 'Alert names nothing to act on — needs at least a message, a type or a device.' };
  }

  // Timestamp: accept the vendor ts if it parses, else stamp receipt time.
  let receivedAt = new Date().toISOString();
  if (payload.ts != null) {
    const t = Date.parse(payload.ts);
    if (!Number.isNaN(t)) receivedAt = new Date(t).toISOString();
  }

  const front = deriveFront(explicitFront, source, message);
  const sev = mapSeverity(rawSeverity);

  // The nonsense-triage guard: a real alert must name SOMETHING this NOC can see —
  // a known front, a device, or a message that names a network subject. If it
  // names none of those, refuse it honestly (422) — no phantom triage.
  const namesNetworkSubject = triageNamesSubject(message, device, front);
  if (!front && !device && !namesNetworkSubject) {
    return {
      ok: false, error: 'nonsense',
      reason: 'That alert names nothing this NOC can see — no known front, no device, and a message that names no network subject. No triage opened, nothing read.',
    };
  }

  const alert = {
    source: source || 'unknown-source',
    type: type || null,
    severity: rawSeverity || null,   // ORIGINAL alert level (e.g. "critical")
    device: device || null,
    front: front || null,
    message: message || (type ? `${type} on ${device || 'device'}` : `alert on ${device || 'device'}`),
    receivedAt,
    sample: !!opts.sample,           // clearly-labelled test alert, never mistaken for a real inbound
    raw: scrubRaw(payload),          // original payload, secret-scrubbed
  };

  return {
    ok: true,
    alert,
    triageSeverity: sev.severity,
    severityNote: sev.note,          // null unless we fell back to the default
    front,
    description: deriveDescription(alert, front),
  };
}

// The nonsense guard (alert side). We can't reuse triage.isNetworkSubject here
// without a circular require, so this mirrors its intent: a message naming any
// network subject, OR a device, OR a resolved front, counts as real.
const NETWORK_SUBJECT = /\b(network|net|device|devices|switch|switches|router|routers|routing|route|fabric|aci|apic|leaf|leaves|spine|spines|nexus|n9k|tenant|epg|vrf|bridge[\s-]?domain|bd|contract|bgp|ospf|isis|mpls|eigrp|wan|sd-?wan|vmanage|vedge|overlay|controller|campus|catalyst|dnac|interface|interfaces|link|links|port|ports|trunk|vlan|health|reachab|unreachable|latency|packet|jitter|alarm|alarms|alert|alerts|issue|issues|fault|faults|incident|outage|circuit|uplink|downlink|core|access|distribution|spanning[\s-]?tree|stp|firewall|acl|vpn|tunnel|ipsec|bfd|load[\s-]?bal|f5|vip|pool|cpu|memory|snmp|syslog|throughput|bandwidth|dhcp|dns|arp|mac|gateway|subnet|software|firmware|version|inventory|topology|node|nodes|flap|flapping|threshold|utilization|utilisation)\b/i;

function triageNamesSubject(message, device, front) {
  if (front) return true;
  if (device) return true;
  return NETWORK_SUBJECT.test(String(message || ''));
}

// Build the triage description deterministically from the real alert fields.
// It leads with the front/source and the alert type, names the device, and
// carries the raw message — so the symptom parser (heuristic fallback when the
// LLM is offline) can scope it, and so it always names a real network subject.
function deriveDescription(alert, front) {
  const area = front || alert.source || 'network';
  const bits = [];
  bits.push(`${area} alert${alert.type ? ` (${alert.type})` : ''}`);
  if (alert.message) bits.push(`— ${alert.message}`);
  if (alert.device) bits.push(`on ${alert.device}`);
  bits.push(`[inbound ${alert.source}${alert.severity ? `, ${alert.severity}` : ''}]`);
  return bits.join(' ').replace(/\s+/g, ' ').trim();
}

// ── A realistic, clearly-labelled SAMPLE alert (DEV helper) ──────────────────
// Posted by /api/alerts/sample so an operator can watch the alert→triage flow
// end to end without a real inbound. It opens a REAL triage (there is no fake
// path) — it is just marked sample:true so it is never mistaken for production.
function sampleAlert() {
  return {
    severity: 'critical',
    source: 'vManage',
    type: 'Control-Connection-Down',
    device: 'vEdge-DC1-01',
    front: 'wan',
    message: 'BFD sessions down to DC1 hub — WAN overlay tunnels flapping, branch sites losing reachability',
    ts: new Date().toISOString(),
    sample: true,
  };
}

module.exports = {
  SEVERITY_MAP,
  DEFAULT_SEVERITY,
  mapSeverity,
  deriveFront,
  normalize,
  deriveDescription,
  sampleAlert,
  LIVE_FRONTS,
  BLIND_FRONTS,
};
