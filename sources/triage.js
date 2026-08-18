// Triage engine — the NOC incident bridge.
//
// Jarvis (L4 / Principal Engineer) opens a bridge for an incoming P1/P2/P3.
// Tier engineers investigate from their own front with REAL live reads through
// the same hardened adapters the rest of the app uses. Nothing here invents a
// number. If a live read fails mid-bridge, that front's evidence card goes
// `suspect` with the real error string — never a faked clean.
//
// This module owns ONLY the triage flow. It reuses:
//   sources/catalyst-center.js, sources/aci.js, sources/sdwan.js  (live reads)
//   the same honesty rules the live-agents layer enforces.
//
// Front -> source mapping (contract docs/triage-contract.md):
//   campus     -> Catalyst Center (inventory, health)
//   fabric     -> ACI (leaf/spine, faults)
//   wan        -> SD-WAN vManage (devices, alarms)
//   incidents  -> Catalyst issues + ACI faults (combined)
//   firewall / loadbalancer / security -> BLIND (no source wired up)
const catalyst = require('./catalyst-center');
const aci = require('./aci');
const sdwan = require('./sdwan');
const session = require('./session-log');
const approvals = require('./approvals');
const artifacts = require('./artifacts');
const jarvis = require('./jarvis');
const baseline = require('./baseline-store');
const configStore = require('./config-store');
const incidentStore = require('./incident-store');
const alerts = require('./alerts');
const notifier = require('./notifier');
const correlation = require('./correlation');   // Wave 4 — deterministic cross-domain co-occurrence

// The host app injects broadcast + status plumbing here so this module stays
// free of server internals — the same seam live-agents.js uses.
let ctx = null;
function init(hostCtx) { ctx = hostCtx; }

// ── Store ───────────────────────────────────────────────────────────────────
const triages = new Map();      // id -> triage record
let seq = 0;
const newId = () => `trg-${Date.now().toString(36)}-${(++seq).toString(36)}`;

// ── The fronts, in board order ──────────────────────────────────────────────
const LIVE_FRONTS = ['campus', 'fabric', 'wan', 'incidents'];

// Not-connected fronts. Named, never invented. These are the agents with no
// backend (Firewall-Pro, LoadBal-Pro, Sentinel) surfaced as blind spots — they
// never post on the bridge, they only appear here.
const BLIND_SPOTS = [
  { front: 'firewall',     reason: 'no firewall source (Cisco Secure Firewall / FMC) wired up' },
  { front: 'loadbalancer', reason: 'F5 load balancer — no Cisco DevNet sandbox to read' },
  { front: 'security',     reason: 'no CVE / threat feed connected' },
];
const BLIND_FRONTS = BLIND_SPOTS.map((b) => b.front);

const FRONTS = [...LIVE_FRONTS, ...BLIND_FRONTS];

// ── Tier roster (only CONNECTED engineers ever appear here) ─────────────────
// L4 Jarvis always runs the bridge and posts the verdict, at every severity.
const ROSTER = {
  L1: ['monitor-eye'],
  L2: ['netops', 'incident-handler'],
  L3: ['router-expert', 'config-keeper'],
  L4: ['jarvis'],
};

// Severity decides which tiers are staffed. L4 is present at every severity
// (it still posts the verdict), so P3 = L1+L2+L4 with L3 left off.
function tiersFor(severity) {
  if (severity === 'P1' || severity === 'P2') return ['L1', 'L2', 'L3', 'L4'];
  return ['L1', 'L2', 'L4']; // P3
}

// ── Severity changes BEHAVIOUR, not just a label (gap 3) ─────────────────────
// P1 = sweep fronts in PARALLEL with aggressive per-read timeouts, hit the
// in-scope/impacted front FIRST. P3 = a leisurely sequential full walk with
// relaxed timeouts. P2 sits in between. The picker returns the real knobs the
// bridge uses — parallelism, per-read timeout, and inter-post pacing — so the two
// severities genuinely read differently, they don't just print a different word.
function cadenceFor(severity) {
  if (severity === 'P1') {
    return { parallel: true, readTimeoutMs: 15000, step: 120,
      label: 'P1 cadence — fronts swept in PARALLEL, aggressive 15s per-read timeout, in-scope front first' };
  }
  if (severity === 'P2') {
    return { parallel: false, readTimeoutMs: 30000, step: 250,
      label: 'P2 cadence — sequential sweep, moderate 30s per-read timeout' };
  }
  return { parallel: false, readTimeoutMs: 60000, step: 500,
    label: 'P3 cadence — leisurely sequential full walk, relaxed 60s per-read timeout' };
}

// How many in-scope switches Config-Keeper diffs per run (gap 5). Bounded so a
// slow Command Runner cannot stall the whole bridge; honest note when it caps.
const CONFIG_MAX = Number(process.env.TRIAGE_CONFIG_MAX || 4);
// Config reads go through Catalyst Center Command Runner, which is inherently slow
// (submit → poll → fetch). They get their OWN generous timeout, independent of the
// severity cadence, so a P1's aggressive front-read budget never guillotines a
// legitimately slow config read.
const CONFIG_READ_TIMEOUT_MS = Number(process.env.TRIAGE_CONFIG_TIMEOUT_MS || 120000);

// ── SLA targets per severity (one config constant, easy to change) ───────────
// Time-to-verdict budget per severity. The UI counts down against sla.targetMs
// locally; the bridge computes the real breach on close from the verdict time.
// P1 tight, P3 relaxed — change these numbers to re-tune every SLA at once.
const SLA_TARGET_MS = {
  P1: 15 * 60 * 1000, // 15 minutes
  P2: 30 * 60 * 1000, // 30 minutes
  P3: 60 * 60 * 1000, // 60 minutes
};
function slaTargetFor(severity) {
  return SLA_TARGET_MS[String(severity || '').toUpperCase()] || SLA_TARGET_MS.P3;
}

// Accept only our real id shapes — a defensive path-safety guard so a weird or
// path-y id can never be used as a lookup key. trg-… (internal) or the
// operator-facing INC-YYYYMMDD-NNN. resolveTriage is an in-memory Map lookup
// (it never touches the filesystem), but we still reject a malformed id early.
function idLooksValid(id) {
  return /^(trg-[a-z0-9._-]+|INC-\d{8}-\d+)$/i.test(String(id || ''));
}

// Resolve a promise, or a { __timeout:true } sentinel if it outruns `ms`. Never
// rejects — a thrown reader surfaces as { __error }. This is the mechanism that
// makes a P1 front read give up early instead of blocking the parallel sweep.
function withTimeout(promise, ms) {
  if (!ms || ms <= 0) return Promise.resolve(promise);
  return new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; resolve({ __timeout: true, __ms: ms }); } }, ms);
    Promise.resolve(promise).then(
      (v) => { if (!done) { done = true; clearTimeout(t); resolve(v); } },
      (e) => { if (!done) { done = true; clearTimeout(t); resolve({ __error: e }); } });
  });
}

// Order fronts so the in-scope/impacted ones come FIRST (gap 1 + gap 3). Out-of-
// scope fronts are still read (honesty — we never silently skip a front), just
// later; the verdict is what de-emphasises them ("campus not dwelt on").
function orderFronts(fronts, sym) {
  if (!sym || !Array.isArray(sym.scope) || !sym.scope.length) return fronts.slice();
  const inScope = fronts.filter((f) => sym.scope.includes(f));
  const rest = fronts.filter((f) => !sym.scope.includes(f));
  return [...inScope, ...rest];
}

// ── The network-subject gate (honesty fix) ──────────────────────────────────
// "@Incident-Handler triage my landlord problem" used to match on the
// dictionary overlap of "triage"/"problem". A triage must name a REAL network
// subject — something one of our live sources could actually see — or it is
// refused out loud and NO bridge is started. This is the same "answer the
// question that was actually asked" rule the capability layer enforces.
const NETWORK_SUBJECT = /\b(network|net|device|devices|switch|switches|router|routers|routing|route|fabric|aci|apic|leaf|leaves|spine|spines|nexus|n9k|tenant|epg|vrf|bridge[\s-]?domain|bd|contract|bgp|ospf|isis|mpls|eigrp|wan|sd-?wan|vmanage|overlay|vedge|vedges|controller|campus|catalyst|dnac|interface|interfaces|link|links|port|ports|trunk|vlan|health|reachab|unreachable|latency|packet|jitter|alarm|alarms|alert|alerts|issue|issues|fault|faults|incident|outage|circuit|uplink|downlink|core|access|distribution|spanning[\s-]?tree|stp|firewall|acl|vpn|tunnel|ipsec|load[\s-]?bal|f5|vip|pool|cpu|memory|snmp|syslog|throughput|bandwidth|dhcp|dns|arp|mac|gateway|subnet|ip\b|software|firmware|version|inventory|topology|node|nodes)\b/i;

function isNetworkSubject(text) {
  return NETWORK_SUBJECT.test(String(text || ''));
}

// ── Intake understanding (CLASS 3 fix) ───────────────────────────────────────
// Real incidents arrive in plain words: "branch 3 users report slow internet
// since 2pm", "users can't reach the file server", "voice calls breaking up",
// "finance can't reach payroll from Pune", "sw3 users report slowness". The old
// gate (isNetworkSubject) demanded a hardcoded network keyword and HARD-REJECTED
// (422) every one of these — while the SAME sentence was understood perfectly in
// Jarvis chat. That is the console contradicting itself, and exactly the
// keyword-gating the "no static bindings — intent first" law forbids.
//
// Intake now refuses ONLY genuinely empty or garbage input. Any real operator
// complaint is accepted and opens a bridge; the bridge does an honest sweep of
// every connected front and ranks the blind spots (deriveScope / rankBlindSpots),
// so an unmappable or out-of-scope report is answered honestly ("if impact is
// real it sits in a blind spot") — never fabricated, never bounced.
//
// A token is "wordish" if it has a vowel and no run of 5+ consonants (a keysmash
// like "asdfghjkl" is not). Input with at least one wordish token — i.e. the
// shape of a real sentence — is a real report. Input with none is garbage UNLESS
// it names a device id / IP (a lone "sw3" or "10.10.20.99" is a real subject).
function isWordish(w) {
  const s = String(w).toLowerCase().replace(/[^a-z]/g, '');
  if (s.length < 2) return false;
  if (!/[aeiouy]/.test(s)) return false;        // a real word carries a vowel
  if (/[^aeiouy]{5,}/.test(s)) return false;    // 5+ consonants in a row → keysmash
  return true;
}
// ── Is the intake subject network-shaped at all? (fail-closed intake) ────────
// The garbage test below only catches keysmash and empty input. Anything with a
// vowel in it sailed through — "lunch is cold today" opened a real INC, ran a
// full estate sweep and paged L3/L4. That is the console inventing a network
// problem out of small talk.
//
// The old NETWORK_SUBJECT gate was too NARROW (it bounced "voice calls breaking
// up"), so the fix is not to bring it back — it is to widen what counts as
// network-shaped and to ASK instead of hard-rejecting. A subject qualifies when
// it names any ONE of: a device or IP, a network noun (NETWORK_SUBJECT), a site
// or the people at one, a service people use, or a symptom. Only when NOTHING in
// the sentence is recognisable do we ask which site, device or service it is
// about — we never answer, and we never open a bridge on a guess.
const SITE_WORDS = /\b(site|sites|branch|branches|office|offices|building|buildings|floor|floors|campus|region|regional|datacent(?:re|er)|data\s?cent(?:re|er)|dc|hq|headquarters|plant|factory|warehouse|store|stores|lab|remote|home\s?worker|user|users|staff|employee|employees|customer|customers|department|finance|payroll|hr|sales|support|reception|desk|floorwalker|tenant)\b/i;
const SERVICE_WORDS = /\b(internet|intranet|wifi|wi-?fi|wireless|voice|voip|telephony|phone|phones|call|calls|calling|video|conference|conferencing|teams|zoom|webex|email|e-?mail|mail|exchange|outlook|vpn|server|servers|fileshare|file\s?share|share|drive|printer|printers|printing|app|apps|application|applications|portal|website|web\s?site|web|sharepoint|erp|sap|crm|database|db|citrix|rdp|sso|login|log\s?in|sign\s?in|authentication|auth|backup|backups|storage|nas|cloud|saas|o365|office\s?365|salesforce|streaming|browsing|download|downloads|upload|uploads|service|services)\b/i;
const SYMPTOM_WORDS = /\b(slow|slowness|slowly|sluggish|lag|laggy|lagging|delay|delayed|delays|drop|drops|dropping|dropped|dropout|dropouts|down|outage|offline|off-?line|unreachable|unreachhable|unavailable|inaccessible|timeout|timeouts|timing\s?out|time\s?out|disconnect|disconnects|disconnected|disconnecting|flap|flaps|flapping|error|errors|erroring|fail|fails|failing|failed|failure|failures|broken|break|breaks|breaking|freeze|freezes|freezing|frozen|stuck|hang|hangs|hanging|degraded|degradation|intermittent|intermittently|choppy|garbled|robotic|buffering|spinning|crash|crashes|crashing|unstable|unusable|glitch|glitches|complain|complaining|complaints|blackhole|black\s?hole|loss|lossy|no\s?access|cannot\s?(?:reach|connect|access|get|log)|can'?t\s?(?:reach|connect|access|get|log)|cant\s?(?:reach|connect|access|get|log)|unable\s?to|not\s?working|doesn'?t\s?work|does\s?not\s?work|won'?t\s?(?:connect|load|open)|reset\s?itself|rebooted|restarted)\b/i;

// A bare device id ("sw3", "core-rtr1") or an IPv4 address is a real subject on
// its own — the same rule the garbage test already uses, named once here.
function namesDeviceOrIp(text) {
  const t = String(text || '');
  if (/\b\d{1,3}(?:\.\d{1,3}){3}\b/.test(t)) return true;
  return t.split(/\s+/).some((w) => /\d/.test(w) && /[a-z]/i.test(w) && /^[a-z][a-z0-9._-]*$/i.test(w));
}

function namesNetworkSubject(text) {
  const t = String(text || '');
  return isNetworkSubject(t)
    || namesDeviceOrIp(t)
    || SITE_WORDS.test(t)
    || SERVICE_WORDS.test(t)
    || SYMPTOM_WORDS.test(t);
}

function looksLikeGarbage(text) {
  const t = String(text || '').trim();
  if (!t) return true;
  const tokens = t.split(/\s+/);
  if (tokens.some(isWordish)) return false;     // a real word present → a real report
  // No real word. A bare device id ("sw3") or IP is still a real subject.
  const deviceish = tokens.some((w) => /\d/.test(w) && /[a-z]/i.test(w))
    || /\b\d{1,3}(?:\.\d{1,3}){3}\b/.test(t);
  return !deviceish;
}

// ── Dedupe / correlation to an OPEN incident (Wave 3) ────────────────────────
// When a new triage opens we surface — but NEVER auto-merge — the OPEN incidents
// it plausibly overlaps with, so an operator sees "possibly related to INC-X
// (both hit the wan front)" instead of opening a duplicate blind. The overlap is
// REAL: it comes from the fronts each incident actually names. Empty when there
// is no genuine shared scope.
//
// `symptom.scope` (the LLM's parsed front list) is only available AFTER the async
// bridge starts, so at open time we derive scope DETERMINISTICALLY from the
// description keywords + any originating alert front — no LLM, works with credits
// exhausted. Each keyword set maps a front to the words that name it.
const FRONT_KEYWORDS = {
  campus: /\b(campus|catalyst|dnac|catalyst[\s-]?center|access\s?switch|distribution|edge\s?switch)\b/i,
  fabric: /\b(fabric|aci|apic|nexus|n9k|leaf|leaves|spine|spines|tenant|epg|bridge[\s-]?domain|data[\s-]?center|datacenter)\b/i,
  wan: /\b(wan|sd-?wan|vmanage|viptela|vedge|v-edge|cedge|overlay|bfd|tunnel|ipsec|branch\s?site|hub)\b/i,
  incidents: /\b(incident|incidents|outage)\b/i,
  firewall: /\b(firewall|fmc|asa|ftd)\b/i,
  loadbalancer: /\b(load[\s-]?balancer|f5|ltm|vip|pool)\b/i,
  security: /\b(cve|threat|ids|ips|vulnerab)\b/i,
};

// Best-effort, synchronous scope for a triage: the fronts its description names,
// plus any front carried on an originating alert. A subset of FRONTS; may be
// empty (the description named no front keyword — then it correlates to nothing).
function deriveScope(triage) {
  const found = new Set();
  const text = String(triage.description || '');
  for (const front of Object.keys(FRONT_KEYWORDS)) {
    if (FRONT_KEYWORDS[front].test(text)) found.add(front);
  }
  // A parsed symptom scope, if one already landed, only ADDS real fronts.
  if (triage.symptom && Array.isArray(triage.symptom.scope)) {
    triage.symptom.scope.forEach((f) => found.add(f));
  }
  // An alert's derived front is a real, first-class scope signal.
  if (triage.alert && triage.alert.front) found.add(triage.alert.front);
  return [...found];
}

// Compute relatedTo for a freshly-opened triage: the OPEN triages whose scope
// overlaps this one's. We DO NOT auto-merge — we only name the possible relation
// and WHY. Real overlap only; empty when none. Excludes the triage itself and
// its own re-triage lineage (same incidentId). One entry per related incidentId
// (the most recent open run of it), newest first.
function computeRelatedTo(triage) {
  const myScope = deriveScope(triage);
  if (!myScope.length) return [];
  const myScopeSet = new Set(myScope);
  const byIncident = new Map(); // incidentId -> { incidentId, why, openedAt }
  for (const other of triages.values()) {
    if (other.id === triage.id) continue;
    if (other.status === 'closed') continue;                 // OPEN incidents only
    if (other.incidentId && other.incidentId === triage.incidentId) continue; // same lineage
    const shared = deriveScope(other).filter((f) => myScopeSet.has(f));
    if (!shared.length) continue;
    const key = other.incidentId || other.id;
    const why = `both hit the ${shared.join(' & ')} front${shared.length > 1 ? 's' : ''}`;
    const prior = byIncident.get(key);
    if (!prior || other.openedAt > prior.openedAt) {
      byIncident.set(key, { incidentId: key, why, openedAt: other.openedAt });
    }
  }
  return [...byIncident.values()]
    .sort((a, b) => (a.openedAt < b.openedAt ? 1 : -1))
    .map((r) => ({ incidentId: r.incidentId, why: r.why }));
}

// ── Small helpers ───────────────────────────────────────────────────────────
const now = () => new Date().toISOString();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// Pace between posts so the WS stream reads like a live bridge, not a data dump.
// Kept short; the live reads themselves are the real time cost.
const STEP = Number(process.env.TRIAGE_STEP_MS || 350);

function agentInfo(id) {
  const a = (ctx.agents && ctx.agents[id]) || {};
  return { name: a.name || id, icon: a.icon || '🤖' };
}

// Every triage event goes out through here. We stamp `type` and `triageId`
// INTO the payload as well as onto the envelope, so a client reading either
// msg.type or msg.data.type — and either msg.triageId or msg.data.triageId —
// sees the same contract shape. Redundant on purpose: it removes any seam
// ambiguity with the UI that is built in parallel to the same contract.
function emit(type, triageId, payload) {
  const body = { type, triageId, ...payload, ts: (payload && payload.ts) || now() };
  ctx.broadcast(type, body);
  return body;
}

function setStatus(id, status, label) {
  if (ctx.updateAgentStatus) ctx.updateAgentStatus(id, status, label);
}
function log(line) {
  if (ctx.appendToActivityLog) ctx.appendToActivityLog(`[${now()}] ${line}\n`);
}

// Fire an on-call notifier event for a triage, fire-and-forget. Maps the real
// triage fields into the compact notifier shape. NEVER awaited on the bridge
// hot path and can never throw here — the notifier is a no-op when no webhook is
// configured and swallows its own failures. A `.catch` is belt-and-braces.
function notifyOncall(event, triage, extra = {}) {
  try {
    const scope = (triage.symptom && Array.isArray(triage.symptom.scope) && triage.symptom.scope.length)
      ? triage.symptom.scope : deriveScope(triage);
    const p = notifier.notify(event, {
      incidentId: triage.incidentId,
      triageId: triage.id,
      severity: triage.severity,
      title: triage.title,
      front: (triage.alert && triage.alert.front) || (scope && scope[0]) || null,
      origin: triage.source || 'operator',
      ...extra,
    });
    if (p && typeof p.catch === 'function') p.catch(() => { /* logged inside notifier */ });
  } catch (e) {
    // Telemetry must never break a bridge.
    log(`[Triage ${triage.id}] notifier error (ignored) — ${e && e.message}`);
  }
}

// ── Live front readers ──────────────────────────────────────────────────────
// Each returns { state, detail, source } with numbers read seconds earlier.
// On any failure it returns state:"suspect" carrying the REAL error message —
// this is the honesty rule and it is the whole point of the app.

// Each reader now takes the parsed symptom (sym) so it can filter evidence to the
// incident WINDOW and lead with real structure (alarm groups, in-window fault
// counts). Every reader also returns a `count` — the one number the baseline store
// tracks for that front's delta (gap 2). A filtered-out fault is never dropped
// silently: it is COUNTED and CALLED OUT as pre-existing.

// Human window label for the notes, e.g. "the 14:00 window".
function windowLabel(sym) {
  if (!sym || !sym.timeAnchor) return 'the recent window';
  const d = new Date(sym.timeAnchor);
  // Prefer the operator's local time (e.g. "the 14:00 Asia/Kolkata window") so the label
  // reads as the wall-clock the operator meant, not a UTC-shifted hour. Fall back to UTC.
  const tz = sym.operatorTz;
  if (tz) {
    try {
      const dtf = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' });
      const map = {};
      for (const p of dtf.formatToParts(d)) map[p.type] = p.value;
      return `the ${map.hour}:${map.minute} ${tz} window`;
    } catch (e) { /* fall through to UTC */ }
  }
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `the ${hh}:${mm} UTC window`;
}

async function readCampus(sym) {
  const source = catalyst.label;
  try {
    const devices = await catalyst.getDevices();
    const health = await catalyst.getHealth().catch(() => null);
    const up = devices.filter((d) => d.reachability === 'Reachable').length;
    const down = devices.length - up;
    const detail =
      `${up}/${devices.length} reachable` +
      (health && health.score != null ? `, health ${health.score}` : '') +
      (down ? `, ${down} not reachable` : '');
    return { state: down > 0 ? 'degraded' : 'clean', detail, source, devices, health, count: down };
  } catch (err) {
    return { state: 'suspect', detail: shortErr('Catalyst Center', err), source };
  }
}

async function readFabric(sym) {
  const source = aci.label;
  try {
    const nodes = await aci.getFabricNodes();
    const health = await aci.getFabricHealth().catch(() => ({ score: null }));
    const faults = await aci.getFaults(['critical', 'major']).catch(() => []);
    const crit = faults.filter((f) => f.severity === 'critical').length;
    const major = faults.length - crit;

    // Window filter (gap 1): split faults into raised-in-window vs pre-existing.
    let age = null; let windowNote = '';
    if (sym && sym.timeAnchorMs) {
      age = aci.countByAge(faults, sym.timeAnchorMs);
      if (faults.length && age.inWindow === 0) {
        windowNote = ` — all ${faults.length} PRE-DATE ${windowLabel(sym)} (pre-existing, not the cause)`;
      } else if (age.inWindow) {
        windowNote = ` — ${age.inWindow} raised inside ${windowLabel(sym)}, ${age.older} pre-existing`;
      }
    }
    const detail =
      `${nodes.length} nodes` +
      (health.score != null ? `, health ${health.score}` : '') +
      `, ${crit} crit / ${major} major faults${windowNote}`;
    // A fault present -> the card shows degraded (amber) so it is visible; whether
    // it is BLAMED is decided in L4 from `age` (in-window vs pre-existing). We keep
    // the card colour honest and let the verdict carry the window judgement.
    const state = (crit > 0 || major > 0) ? 'degraded' : 'clean';
    return { state, detail, source, nodes, health, faults, age, count: faults.length };
  } catch (err) {
    return { state: 'suspect', detail: shortErr('APIC', err), source };
  }
}

async function readWan(sym) {
  const source = sdwan.label;
  try {
    const devices = await sdwan.getDevices();
    // Real per-alarm objects so we can CLUSTER (gap 4) instead of leading with a
    // raw count. clusterAlarms marks chronic (pre-window) vs new per group.
    const alarms = await sdwan.getAlarms().catch(() => []);
    const sinceTs = (sym && sym.timeAnchorMs) || undefined;
    const groups = sdwan.clusterAlarms(alarms, { sinceTs, by: ['type'], topN: 3 });
    const total = groups.total;
    const top3 = groups.groups.slice(0, 3).map((g) => {
      const tag = g.chronic ? 'chronic' : (g.newCount ? `${g.newCount} new` : 'new');
      return `${g.type || g.key} (${g.count}, ${tag})`;
    }).join('; ');
    const detail =
      `${devices.length} devices, ${total} active alarms` +
      (total ? ` — top 3: ${top3}` : '') +
      (sinceTs ? `, ${groups.newCount} new since ${windowLabel(sym)}` : '');
    // Alarms present -> amber; whether they are chronic noise or a NEW spike is in
    // `groups` and drives the verdict, not the card colour.
    const state = total > 0 ? 'degraded' : 'clean';
    return { state, detail, source, devices, alarms, groups, count: total };
  } catch (err) {
    return { state: 'suspect', detail: shortErr('vManage', err), source };
  }
}

async function readIncidents(sym) {
  const source = `${catalyst.label} + ${aci.label}`;
  try {
    const issues = await catalyst.getIssues();
    let faults = [];
    let faultNote = '';
    let age = null;
    try {
      faults = await aci.getFaults(['critical', 'major']);
      if (sym && sym.timeAnchorMs) {
        age = aci.countByAge(faults, sym.timeAnchorMs);
        faultNote = age.inWindow
          ? ` (${age.inWindow} of the faults inside ${windowLabel(sym)})`
          : (faults.length ? ` (all faults pre-date ${windowLabel(sym)})` : '');
      }
    } catch (e) {
      faultNote = ` (ACI faults unread: ${e.message})`;
    }
    const detail = `${issues.length} Catalyst issues, ${faults.length} ACI faults${faultNote}`;
    const state = (issues.length || faults.length) ? 'degraded' : 'clean';
    return { state, detail, source, issues, faults, age, count: issues.length + faults.length };
  } catch (err) {
    return { state: 'suspect', detail: shortErr('Catalyst Center', err), source };
  }
}

function shortErr(what, err) {
  const msg = err && err.message ? err.message : String(err || 'unknown error');
  return `${what} read failed: ${msg}`;
}

const READERS = {
  campus: readCampus,
  fabric: readFabric,
  wan: readWan,
  incidents: readIncidents,
};

// Plain-words source label per front, for the approval record's "target".
const FRONT_SOURCE = {
  campus: catalyst.label,
  fabric: aci.label,
  wan: sdwan.label,
  incidents: `${catalyst.label} + ${aci.label}`,
};

// Run one front's live read THROUGH the permission gate, tagged for the CLI log.
// In auto mode it auto-approves and logs; in ask mode it PAUSES for a decision.
// A denied read touches no wire and returns an honest "denied" evidence card —
// never a fabricated clean result. Returns { state, detail, source, ... }.
async function gatedFrontRead(triage, { front, agentId, agentName, label, reason, sym, cadence }) {
  const source = FRONT_SOURCE[front] || null;
  const triageId = triage.id;
  const g = await approvals.gate(
    { agentId, agentName, command: `read ${front} front`, target: source, triageId, front, reason },
    // share:FALSE here (issue 8): the underlying HTTP hops no longer each emit an
    // identical command_share row — we emit ONE consolidated check below instead.
    () => session.runWithContext(
      { triageId, agentId, agentName, front, label, share: false, tier: 'triage',
        purpose: `read the ${front} front`,
        reasoning: reason || `triage read of the ${front} front` },
      () => runReaderWithTimeout(front, sym, cadence)));
  let result;
  if (g.denied) {
    result = { state: 'suspect', source, denied: true,
      detail: 'Operator denied this read — nothing was run, and nothing was invented.' };
  } else {
    result = g.result;
    attachDelta(triage, front, result);
  }
  shareFrontCheck(triage, front, agentId, result, nextAttempt(triage, front));
  return result;
}

// Run one front's reader with the severity cadence's per-read timeout. A timeout
// or a thrown reader both become an honest 'suspect' card — never a faked clean.
async function runReaderWithTimeout(front, sym, cadence) {
  const readFn = READERS[front];
  const source = FRONT_SOURCE[front] || null;
  if (!readFn) return { state: 'suspect', source, detail: `no live reader for ${front}` };
  const ms = cadence ? cadence.readTimeoutMs : 0;
  const r = await withTimeout(Promise.resolve().then(() => readFn(sym)), ms);
  if (r && r.__timeout) {
    return { state: 'suspect', source,
      detail: `read exceeded the ${r.__ms}ms per-read budget — treating ${front} as unread rather than blocking the sweep.` };
  }
  if (r && r.__error) return { state: 'suspect', source, detail: shortErr(front, r.__error) };
  return r;
}

// Investigate a front from INSIDE a withAgent turn (L2/L3). The turn is already
// gated by withAgent, so this does NOT gate again (no double approval prompt). It
// runs the reader with the cadence timeout, attaches the delta, and emits ONE
// consolidated check (issue 8). Returns the enriched result for the caller to
// post as evidence + narrate.
async function investigateFront(triage, front, agentId, sym, cadence) {
  const result = await runReaderWithTimeout(front, sym, cadence);
  attachDelta(triage, front, result);
  shareFrontCheck(triage, front, agentId, result, nextAttempt(triage, front));
  return result;
}

// ── Posting: a triage_message (narration) + the matching triage_evidence ────
function post(triage, { agent, tier, round, text }) {
  const info = agentInfo(agent);
  const msg = emit('triage_message', triage.id, {
    agent, agentName: info.name, agentIcon: info.icon,
    tier, severity: triage.severity, round, text,
  });
  triage.messages.push(msg);
  return msg;
}

function postEvidence(triage, front, result) {
  const { state, detail, source } = result;
  // Slim, render-ready extras added to the card (additive — the FE ignores fields
  // it doesn't know). delta drives "220 (baseline 218, +2)"; groups is the top-3
  // alarm clusters; age is in-window vs pre-existing fault counts.
  const delta = result.delta || null;
  const groups = result.groups
    ? { total: result.groups.total, newCount: result.groups.newCount, chronicCount: result.groups.chronicCount,
        top: (result.groups.groups || []).slice(0, 3).map((g) => ({
          key: g.type || g.key, count: g.count, chronic: !!g.chronic, newCount: g.newCount || 0, severity: g.severity || null })) }
    : null;
  const age = result.age || null;
  const count = (result.count != null) ? result.count : null;
  const card = emit('triage_evidence', triage.id, {
    front, state, detail, source: source || null, delta, groups, age, count,
  });
  triage.evidence[front] = { front, state, detail, source: source || null, ts: card.ts, delta, groups, age, count };
  // Keep the FULL raw read result in memory (never persisted — it can carry raw
  // faults/alarms/devices) so the re-triage diff (issue 11) and the affected-CI
  // list can compare real item identities run-to-run, not just slim card fields.
  if (!triage.reads) triage.reads = {};
  triage.reads[front] = result;
  recordEvidenceHistory(triage, front, state, detail, source, card.ts);
  return card;
}

// Attach the per-front baseline DELTA (gap 2) to a read result, and record the
// new count — but compute the delta ONCE per front per bridge and reuse it, so
// later reads of the same front in the same bridge don't collapse the delta to 0
// by recording over their own baseline mid-run.
function attachDelta(triage, front, result) {
  if (!result || result.count == null) return result;
  if (!triage.frontDelta) triage.frontDelta = {};
  if (triage.frontDelta[front] === undefined) {
    triage.frontDelta[front] = baseline.delta(front, result.count) || null;
    baseline.record(front, result.count);
  }
  result.delta = triage.frontDelta[front];
  return result;
}

// Build the one-block raw text for a front's command_share (issue 8): the real
// numbers, the window split, the delta and the top alarm groups — derived only
// from the real read.
function buildFrontRaw(front, result) {
  const lines = [`front: ${front}`, `state: ${result.state}`, `detail: ${result.detail}`];
  if (result.count != null) lines.push(`count: ${result.count}`);
  if (result.delta && result.delta.baseline != null) {
    lines.push(`baseline: ${result.delta.baseline}  (delta ${result.delta.delta >= 0 ? '+' : ''}${result.delta.delta} since ${result.delta.since || 'last sweep'})`);
  } else if (result.delta && result.delta.firstSweep) {
    lines.push('baseline: none yet (first sweep — recorded now)');
  }
  if (result.age) lines.push(`in-window faults: ${result.age.inWindow}  ·  pre-existing: ${result.age.older}`);
  if (result.groups && result.groups.groups) {
    lines.push('top alarm groups:');
    result.groups.groups.slice(0, 3).forEach((g) =>
      lines.push(`  - ${g.type || g.key}: ${g.count} (${g.chronic ? 'chronic' : (g.newCount ? g.newCount + ' new' : 'new')})`));
  }
  return lines.join('\n');
}

// Emit EXACTLY ONE command_share per front read (issue 8 fix, at the source).
// The old path let every HTTP hop under a share:true context emit its own
// identical "check — read the X front" row (3-4 per read). Now the front reads run
// under share:FALSE (so no per-hop rows) and this emits a single consolidated
// check, carrying an attempt count in the data — the UI shows "×N" on a retry
// instead of stacking identical rows.
function shareFrontCheck(triage, front, agentId, result, attempt) {
  const info = agentInfo(agentId);
  const src = result.source || FRONT_SOURCE[front] || null;
  session.emitCommandShare({
    agent: agentId, agentName: info.name, tier: 'triage',
    purpose: `read the ${front} front` + (attempt > 1 ? ` ×${attempt}` : ''),
    command: `read ${front} front${src ? ' — ' + src : ''}`,
    raw: buildFrontRaw(front, result),
    reasoning: `Triage ${triage.id}: one real read of the ${front} front` + (attempt > 1 ? ` (attempt ${attempt})` : '') + '.',
    conclusion: result.state === 'suspect'
      ? `unread/suspect — ${result.detail}`
      : `${front}: ${result.detail}`,
    ok: result.state !== 'suspect',
    triageId: triage.id,
    attempts: attempt,
  });
}

// Bump and return the attempt counter for a front (drives the ×N in the UI).
function nextAttempt(triage, front) {
  if (!triage.attempts) triage.attempts = {};
  triage.attempts[front] = (triage.attempts[front] || 0) + 1;
  return triage.attempts[front];
}

// Append one evidence transition to the per-triage history. The real detail/error
// is kept verbatim — a suspect read is recorded as suspect, never rewritten clean.
function recordEvidenceHistory(triage, front, state, detail, source, ts) {
  if (!triage.evidenceHistory) triage.evidenceHistory = [];
  triage.evidenceHistory.push({ front, state, detail, source: source || null, ts: ts || now() });
}

function progress(triage, tier, status) {
  const ev = emit('triage_progress', triage.id, { tier, status });
  triage.progress[tier] = status;
  return ev;
}

// ── Per-triage bridge membership ─────────────────────────────────────────────
// The agents a triage puts on the bridge ARE its staffed roster — nothing else
// is ever flipped active during its run. Membership is therefore per-triage, so
// one triage closing can only ever idle its OWN agents, never those another
// still-open triage is using. This is the fix for "stuck on bridge": the old
// finally idled the whole global roster on any close.
function bridgeAgentsOf(triage) {
  return (triage.staffed || []).map((s) => s.agent);
}

// Is this agent still on the bridge of some OTHER triage that has not closed?
// If so we must not idle it just because THIS triage finished.
function agentHeldByOpenBridge(agentId, exceptTriageId) {
  for (const t of triages.values()) {
    if (t.id === exceptTriageId) continue;
    if (t.status !== 'closed' && bridgeAgentsOf(t).includes(agentId)) return true;
  }
  return false;
}

// ── The bridge ──────────────────────────────────────────────────────────────
async function runBridge(triage) {
  const staffedTiers = tiersFor(triage.severity);
  const cadence = cadenceFor(triage.severity);
  triage.cadence = cadence;
  try {
    // ── Parse the SYMPTOM first (gap 1) — real reasoning about the complaint's
    // time window + scope, so every read below can filter to the incident. ──
    const sym = await jarvis.extractSymptom(triage.description, triage.operatorTz).catch(() => null)
      || { timeAnchor: null, timeAnchorMs: null, scope: null, rawSymptom: triage.description, note: 'symptom parse unavailable', source: 'none' };
    sym.severity = triage.severity;
    // HARD GUARD (gap 1): a computed window start must be ≤ now. A future anchor would
    // put nothing in-window and mislabel everything "pre-existing" — clamp it back to now
    // and say so out loud. A window start in the future must never happen.
    const nowMs = Date.now();
    if (sym.timeAnchorMs && sym.timeAnchorMs > nowMs) {
      sym.timeAnchorFuture = sym.timeAnchor;
      sym.timeAnchorMs = nowMs;
      sym.timeAnchor = new Date(nowMs).toISOString();
      sym.note = (sym.note ? sym.note + ' ' : '') +
        `The parsed window start was in the FUTURE (${sym.timeAnchorFuture}) — clamped back to now so nothing is mislabelled.`;
    }
    triage.symptom = sym;
    // Rank the blind spots by relevance to THIS symptom (gap 6).
    triage.rankedBlindSpots = jarvis.rankBlindSpots(BLIND_SPOTS, sym.rawSymptom || triage.description);
    emit('triage_symptom', triage.id, {
      timeAnchor: sym.timeAnchor, scope: sym.scope, rawSymptom: sym.rawSymptom,
      note: sym.note, source: sym.source, cadence: cadence.label,
      rankedBlindSpots: triage.rankedBlindSpots,
    });
    // Re-emit the blind cards now weighted (high-risk flagged) — additive fields.
    triage.rankedBlindSpots.forEach((b) =>
      emit('triage_evidence', triage.id, { front: b.front, state: 'blind', detail: b.reason, source: null, risk: b.risk, why: b.why }));

    // ROUND 1 — L1 opener: acknowledge, symptom-aware sweep across every live
    // front (parallel + in-scope-first at P1), then the escalation call.
    await runL1(triage, staffedTiers, sym, cadence);

    // ROUND 1 — L2 investigation: campus + incidents, device-level.
    if (staffedTiers.includes('L2')) await runL2(triage, sym, cadence);

    // ROUND 1 — L3 SME device-deep: fabric + wan + campus software + config diff.
    if (staffedTiers.includes('L3')) await runL3(triage, sym, cadence);

    // ROUND 2 — L4 correlation + committed hypothesis, then close.
    await runL4(triage, sym);
  } catch (err) {
    // A bridge must never take the server down. Record it, close honestly.
    log(`[Triage ${triage.id}] bridge error — ${err.message}`);
    triage.status = 'closed';
    emit('triage_closed', triage.id, {});
  } finally {
    // Idle only the agents on THIS triage's bridge, and only when no other
    // still-open triage is holding them. Precise, per-triage — a concurrent
    // triage's agents are never touched, so nobody is left "stuck on bridge".
    bridgeAgentsOf(triage).forEach((id) => {
      if (!agentHeldByOpenBridge(id, triage.id)) setStatus(id, 'idle', 'Bridge concluded');
    });

    // Persist the COMPLETE real record + auto-written docs, exactly once, the
    // moment the bridge closes. This is the raw "what actually happened" — the
    // timeline, every command + raw output, the evidence transition history, the
    // operator posts and the verdict — plus an SLT and an engineer document
    // derived only from that real record. A write failure is logged, never fatal.
    if (!triage.persisted) {
      triage.persisted = true;
      try {
        const out = artifacts.writeForTriage(triage);
        if (out) log(`[Triage ${triage.id}] artifacts + docs written (${(out.files || []).join(', ')}) to ${out.dir}`);
        else log(`[Triage ${triage.id}] artifact write returned nothing — path refused or empty record`);
      } catch (e) {
        log(`[Triage ${triage.id}] artifact write failed — ${e.message}`);
      }
    }
  }
}

async function runL1(triage, staffedTiers, sym, cadence) {
  const agent = 'monitor-eye';
  progress(triage, 'L1', 'active');
  setStatus(agent, 'active', `Triage ${triage.id} — L1 sweep`);

  const symLine =
    (sym.timeAnchor ? `window: since ${sym.timeAnchor}` : 'no time anchor — recent default') +
    (sym.scope ? `; in scope: ${sym.scope.join(', ')}` : '; no explicit scope') +
    ` (${sym.source === 'claude' ? 'reasoned' : sym.source === 'heuristic' ? 'keyword-parsed' : 'defaulted'})`;
  post(triage, {
    agent, tier: 'L1', round: 1,
    text: `Acknowledged — ${triage.severity} triage open: "${triage.title}". ` +
      `${cadence.label}. Symptom read — ${symLine}. Sweeping the connected fronts now.`,
  });
  await wait(cadence.step);

  // Order the sweep so the in-scope/impacted fronts go FIRST (gap 1 + gap 3).
  const order = orderFronts(LIVE_FRONTS, sym);

  const runOne = async (front) => {
    const r = await gatedFrontRead(triage, {
      front, agentId: 'monitor-eye', agentName: agentInfo('monitor-eye').name,
      label: `Triage ${triage.id} — L1 sweep`, reason: `L1 basic sweep of the ${front} front`,
      sym, cadence,
    });
    postEvidence(triage, front, r);
    post(triage, {
      agent, tier: 'L1', round: 1,
      text: `Sweep — ${front}${sym.scope && sym.scope.includes(front) ? ' (in scope)' : ''}: ` +
        `${r.state === 'suspect' ? '⚠️ ' : ''}${r.detail} [${r.source}]` +
        (r.delta && r.delta.baseline != null ? ` · ${r.count} (baseline ${r.delta.baseline}, ${r.delta.delta >= 0 ? '+' : ''}${r.delta.delta})` : ''),
    });
  };

  if (cadence.parallel) {
    // P1: fire every front at once — the aggressive per-read timeout bounds each,
    // so the whole sweep finishes in ~one slow read, not the sum of four.
    post(triage, { agent, tier: 'L1', round: 1, text: '⚡ P1 — sweeping all fronts in parallel (impacted front first).' });
    await Promise.all(order.map(runOne));
  } else {
    // P2/P3: sequential full walk, paced by the cadence step.
    for (const front of order) { await runOne(front); await wait(cadence.step); }
  }

  const call = escalationCall(triage.severity, staffedTiers);
  post(triage, { agent, tier: 'L1', round: 1, text: call });
  progress(triage, 'L1', 'done');
  setStatus(agent, 'idle', 'L1 sweep delivered');
  await wait(cadence.step);
}

function escalationCall(severity, staffedTiers) {
  if (severity === 'P1') {
    return `📣 Escalation call: this is a P1 — pulling all tiers onto the bridge, ` +
      `L2 investigation, L3 SMEs device-deep, and L4 Principal Engineer to correlate and rule.`;
  }
  if (severity === 'P2') {
    return `📣 Escalation call: P2 — L2 investigation plus L3 SMEs device-deep; ` +
      `L4 Principal Engineer will correlate and post the verdict.`;
  }
  return `📣 Escalation call: P3 — L2 investigation is enough here; no L3 SME callout. ` +
    `L4 Principal Engineer will still correlate and post the verdict.`;
}

async function runL2(triage, sym, cadence) {
  progress(triage, 'L2', 'active');

  // NetOps -> campus, live inventory + health.
  await withAgent('netops', triage, async (agent) => {
    const r = await investigateFront(triage, 'campus', 'netops', sym, cadence);
    postEvidence(triage, 'campus', r);
    post(triage, {
      agent, tier: 'L2', round: 1,
      text: r.state === 'suspect'
        ? `Campus investigation blocked — ${r.detail}. I am not going to guess what the estate looks like.`
        : `Campus front: ${r.detail}. Live from ${r.source}` +
          (r.devices ? ` — ${r.devices.map((d) => d.hostname).join(', ')}.` : '.'),
    });
  });

  // Incident-Handler -> incidents, Catalyst issues + ACI faults combined.
  await withAgent('incident-handler', triage, async (agent) => {
    const r = await investigateFront(triage, 'incidents', 'incident-handler', sym, cadence);
    postEvidence(triage, 'incidents', r);
    let text;
    if (r.state === 'suspect') {
      text = `Incident front unread — ${r.detail}. Nothing invented.`;
    } else {
      const topIssues = (r.issues || []).slice(0, 3).map((i) => `${i.priority} ${i.name}`).join('; ');
      const topFaults = (r.faults || []).slice(0, 2).map((f) => `F${f.code} ${f.severity}`).join('; ');
      text = `Incidents front: ${r.detail}.` +
        (topIssues ? ` Issues: ${topIssues}.` : '') +
        (topFaults ? ` Fabric faults: ${topFaults}.` : '');
    }
    post(triage, { agent, tier: 'L2', round: 1, text });
  });

  progress(triage, 'L2', 'done');
  await wait(cadence.step);
}

async function runL3(triage, sym, cadence) {
  progress(triage, 'L3', 'active');

  // Router-Expert -> fabric (ACI) and wan (SD-WAN), the two SME fronts. WAN now
  // LEADS with the top-3 alarm groups (gap 4), fabric with the in-window split.
  await withAgent('router-expert', triage, async (agent) => {
    const f = await investigateFront(triage, 'fabric', 'router-expert', sym, cadence);
    postEvidence(triage, 'fabric', f);
    post(triage, {
      agent, tier: 'L3', round: 1,
      text: f.state === 'suspect'
        ? `Fabric read failed — ${f.detail}. No fabric claim from me without a read.`
        : `Fabric (ACI) device-deep: ${f.detail}. Live from ${f.source}` +
          (f.nodes ? ` — ${f.nodes.map((n) => `${n.name}/${n.role}`).join(', ')}.` : '.'),
    });
    await wait(cadence.step);

    const w = await investigateFront(triage, 'wan', 'router-expert', sym, cadence);
    postEvidence(triage, 'wan', w);
    post(triage, {
      agent, tier: 'L3', round: 1,
      text: w.state === 'suspect'
        ? `WAN overlay read failed — ${w.detail}. Not vouching for the overlay blind.`
        : `WAN (SD-WAN): ${w.detail}. Live from ${w.source}.`,
    });
  });

  // Config-Keeper -> the REAL change front (gap 5). For the in-scope reachable
  // switches: read running-config live, DIFF against the last snapshot BEFORE
  // saving the new one, and emit a real change finding — "no config change on
  // sw1–sw4 in the window" (rules out a cause class) or "sw2 changed at <when> —
  // inside the window". Then snapshot. Never a drift claim without a real diff.
  await withAgent('config-keeper', triage, async (agent) => {
    const r = await readCampus(sym);
    if (r.state === 'suspect') {
      post(triage, {
        agent, tier: 'L3', round: 1,
        text: `Config read blocked — ${r.detail}. I hold no offline baseline to fall back on, so nothing to show.`,
      });
      triage.configFindings = [{ device: null, changed: false, note: `campus unreadable — ${r.detail}` }];
      return;
    }
    const reachable = (r.devices || []).filter((d) => d.reachability === 'Reachable' && d.id);
    // In-scope first, then bounded so a slow Command Runner cannot stall the bridge.
    const targets = reachable.slice(0, CONFIG_MAX);
    if (!targets.length) {
      post(triage, { agent, tier: 'L3', round: 1, text: 'No reachable campus switch to read a running-config from — no config finding this pass.' });
      triage.configFindings = [];
      return;
    }
    post(triage, {
      agent, tier: 'L3', round: 1,
      text: `Reading running-config live from ${targets.map((d) => d.hostname).join(', ')} via Command Runner, then diffing against the last snapshot… (this can take a minute per switch)`,
    });

    const findings = await Promise.all(targets.map((d) => diffOneDevice(triage, d, sym)));
    triage.configFindings = findings;

    const changed = findings.filter((x) => x.changed);
    const inWindowChanged = changed.filter((x) => x.inWindow);
    let summary;
    if (inWindowChanged.length) {
      summary = `⚠️ Config CHANGE inside ${windowLabel(sym)}: ` +
        inWindowChanged.map((x) => `${x.device} at ${x.when} (${x.summary})`).join('; ') +
        `. That lands in the incident window — a strong candidate cause.`;
    } else if (changed.length) {
      summary = `Config changes found, but all PRE-DATE ${windowLabel(sym)}: ` +
        changed.map((x) => `${x.device} at ${x.when}`).join('; ') + `. Not the trigger for this incident.`;
    } else {
      const named = findings.filter((x) => !x.error).map((x) => x.device);
      const firsts = findings.filter((x) => x.firstSnapshot).map((x) => x.device);
      summary = firsts.length && firsts.length === findings.length
        ? `First config snapshot taken for ${named.join(', ')} — no prior to diff against yet, so no drift claim (honest). The next triage will diff against this.`
        : `No config change on ${named.join(', ') || 'the checked switches'} in the window — that rules out a config-change cause class for the campus front.`;
    }
    const errs = findings.filter((x) => x.error);
    if (errs.length) summary += ` (${errs.map((x) => `${x.device || 'device'}: ${x.error}`).join('; ')})`;

    post(triage, { agent, tier: 'L3', round: 1, text: `Config-Keeper: ${summary}` });
    // A dedicated one-block command_share so the config check reads as one row.
    session.emitCommandShare({
      agent: 'config-keeper', agentName: agentInfo('config-keeper').name, tier: 'L3',
      purpose: 'diff running-config vs last snapshot',
      command: 'show running-config (per in-scope switch) → config-store.diff',
      raw: findings.map((x) => `${x.device || 'device'}: ${x.error ? 'ERROR ' + x.error : (x.firstSnapshot ? 'first snapshot (no prior)' : (x.changed ? `CHANGED at ${x.when}${x.inWindow ? ' [in window]' : ' [pre-window]'} — ${x.summary}` : `no change since ${x.when || 'last snapshot'}`))}`).join('\n'),
      reasoning: `Triage ${triage.id}: real running-config diff for change correlation (gap 5). Diff runs BEFORE the new snapshot is saved.`,
      conclusion: summary,
      ok: !errs.length,
      triageId: triage.id,
    });
  });

  progress(triage, 'L3', 'done');
  await wait(cadence.step);
}

// Read one device's running-config, diff vs its last snapshot (BEFORE saving the
// new one), then snapshot. Returns an honest finding object; never throws.
async function diffOneDevice(triage, device, sym) {
  const hostname = device.hostname || device.id;
  try {
    const cfg = await withTimeout(
      Promise.resolve().then(() => catalyst.getRunningConfig(device.id)),
      CONFIG_READ_TIMEOUT_MS);
    if (cfg && cfg.__timeout) return { device: hostname, changed: false, error: `config read exceeded ${CONFIG_READ_TIMEOUT_MS}ms — treated as unread` };
    if (!cfg || !cfg.ok) return { device: hostname, changed: false, error: (cfg && cfg.error) || 'unreadable' };

    // DIFF against the last snapshot FIRST (compare to the previous run)…
    const d = configStore.diff(hostname, cfg.text);
    // …then save the new snapshot for the next run.
    configStore.snapshot(hostname, cfg.text);

    if (d.firstSnapshot) return { device: hostname, changed: false, firstSnapshot: true, when: null };
    if (!d.changed) return { device: hostname, changed: false, when: d.when || null };
    const whenMs = d.when ? Date.parse(d.when) : NaN;
    const inWindow = sym && sym.timeAnchorMs && !Number.isNaN(whenMs) ? whenMs >= sym.timeAnchorMs : false;
    return { device: hostname, changed: true, when: d.when || null, summary: d.summary || 'config changed', inWindow, added: d.added, removed: d.removed };
  } catch (e) {
    return { device: hostname, changed: false, error: (e && e.message) || 'error' };
  }
}

async function runL4(triage, sym) {
  const agent = 'jarvis';
  progress(triage, 'L4', 'active');
  setStatus(agent, 'active', `Triage ${triage.id} — L4 correlation`);
  await wait(triage.cadence ? triage.cadence.step : STEP);

  const ev = triage.evidence;
  const degraded = LIVE_FRONTS.filter((f) => ev[f] && ev[f].state === 'degraded');
  const suspect = LIVE_FRONTS.filter((f) => ev[f] && ev[f].state === 'suspect');
  const clean = LIVE_FRONTS.filter((f) => ev[f] && ev[f].state === 'clean');

  // Window-aware split of the degraded fronts (gap 1): which carry IN-WINDOW
  // evidence (a candidate cause) vs only pre-existing/chronic noise (called out,
  // never blamed).
  const active = degraded.filter((f) => frontIsActive(ev[f]));
  const preExisting = degraded.filter((f) => !frontIsActive(ev[f]));

  // Honest rule-built verdict — the fallback if Jarvis has no key / declines.
  let verdict;
  if (active.length) {
    verdict = `Live evidence in ${windowLabel(sym)} points at ${active.join(', ')}. ` +
      active.map((f) => `${f}: ${ev[f].detail}`).join(' | ') +
      (preExisting.length ? `. Pre-existing (not the cause): ${preExisting.join(', ')}.` : '') +
      (suspect.length ? ` Unread (treat as blind): ${suspect.join(', ')}.` : '');
  } else if (preExisting.length) {
    verdict = `Nothing NEW inside ${windowLabel(sym)} on the connected estate. ${preExisting.join(', ')} carry faults/alarms, but they PRE-DATE the window (pre-existing, not the trigger). ` +
      `If impact is real, it sits in a blind spot below.`;
  } else if (suspect.length && !degraded.length) {
    verdict = `Cannot fully rule: ${suspect.length} front(s) could not be read (${suspect.join(', ')}). The fronts that did answer look clean.`;
  } else {
    verdict = `No live evidence of an active fault in ${windowLabel(sym)}. Every connected front read clean: ${clean.join(', ') || 'none'}. If the reporter still sees impact, it sits in a blind spot below.`;
  }

  const impact = buildImpact(triage, active, preExisting, suspect, clean, sym);
  const nextChecks = buildNextChecks(triage, ev, active, suspect);
  const ranked = triage.rankedBlindSpots && triage.rankedBlindSpots.length ? triage.rankedBlindSpots : jarvis.rankBlindSpots(BLIND_SPOTS, (sym && sym.rawSymptom) || triage.description);

  // ── Wave 4 — cross-domain correlation (deterministic) ──────────────────────
  // Computed from the REAL timestamps on this bridge's live reads + config diffs.
  // Runs with or without an API key. It is computed BEFORE the hypothesis so the
  // hypothesis reasons over the same measured co-occurrence the operator sees.
  const corr = correlation.correlate(triage, sym);

  // ── Committed hypothesis (gap 7) — strictly from the real findings ──
  post(triage, { agent, tier: 'L4', round: 2, text: '🧠 Correlating the collected findings into a committed hypothesis…' });
  const findingsBlock = buildFindingsBlock(triage, ev, active, preExisting, suspect, clean, ranked, sym, corr);
  const hypo = await jarvis.synthesizeTriageVerdict({
    title: triage.title, severity: triage.severity, symptom: sym, findingsBlock,
  }).catch(() => null);

  // When a key is live Jarvis only NARRATES the finding this pass already made —
  // it can never create, move or erase one.
  if (corr && corr.topCandidate) {
    const narration = await jarvis.narrateCorrelation({
      topCandidate: corr.topCandidate,
      cluster: (corr.clusters || [])[0] || null,
      symptom: sym,
    }).catch(() => null);
    // Applied through the module so the narration is secret-scrubbed exactly like
    // the deterministic sentence — and so it can only ever replace the SENTENCE,
    // never the finding (fronts / ts / clusters / note).
    correlation.applyNarration(corr, narration);
    post(triage, {
      agent, tier: 'L4', round: 2,
      // Dual clock (operator tz · UTC), the same convention as every other card.
      text: `🔗 Cross-domain correlation — ${corr.topCandidate.fronts.join(' + ')} all started ~` +
        `${correlation.clock(Date.parse(corr.topCandidate.ts), sym && sym.operatorTz)}: ` +
        `${corr.topCandidate.summary}`,
    });
  } else if (corr) {
    post(triage, { agent, tier: 'L4', round: 2, text: `🔎 Cross-domain correlation — ${corr.note}` });
  }
  triage.correlation = corr;

  const verdictPayload = {
    verdict, impact, nextChecks,
    correlation: corr,            // Wave 4 — {clusters, topCandidate, note} (pinned contract)
    // Window-aware front split (real, computed above) — carried so downstream
    // consumers (ServiceNow state B2, SLT "what broke" B11) can tell an in-window
    // cause from pre-existing noise without re-deriving or over-counting.
    activeInWindow: active,       // fronts confirmed broken IN the incident window (cause candidates)
    preExisting,                  // degraded fronts that PRE-DATE the window (called out, never blamed)
    suspect,                      // fronts that could not be read this pass
    clean,                        // fronts that read clean
    blindSpots: ranked,           // ranked/weighted (gap 6)
    hypothesis: hypo || null,     // committed ranked hypothesis + if/then + confidence (gap 7)
    window: sym ? { timeAnchor: sym.timeAnchor, scope: sym.scope, source: sym.source } : null,
    configFindings: triage.configFindings || [],
  };
  const v = emit('triage_verdict', triage.id, verdictPayload);
  triage.verdict = { ...verdictPayload, ts: v.ts };
  // On-call notifier (Wave 3): a verdict landed. Fire-and-forget — the notifier
  // is an HONEST no-op when no webhook is set and can never block or crash the
  // bridge (failures are logged inside it, never thrown here).
  notifyOncall('verdict', triage, {
    summary: `Verdict on ${triage.incidentId} (${triage.severity}) — ${triage.title}`,
    detail: { impact: verdictPayload.impact, hypothesis: hypo ? hypo.hypothesis : null },
  });
  // MTTR stop-clock (issue 11): the verdict is "resolution" — stamp the moment
  // Jarvis commits so the record's MTTR is opened→verdict, a real elapsed time.
  triage.verdictAt = v.ts;
  // Real affected CIs (issue 11 / ServiceNow) — the actual devices/tenants behind
  // the degraded or unread fronts, pulled from the live read results in memory.
  triage.affectedCIs = collectAffectedCIs(triage);

  if (hypo) {
    const rankedTxt = (hypo.ranked || []).map((r) => `${r.cause} (${r.likelihood})`).join(' · ');
    post(triage, {
      agent, tier: 'L4', round: 2,
      text: `L4 / Principal Engineer — committed hypothesis:\n` +
        `• Most likely: ${hypo.hypothesis}\n` +
        (rankedTxt ? `• Ranked: ${rankedTxt}\n` : '') +
        `• Next check: ${hypo.ifThen}\n` +
        `• Confidence: ${hypo.confidence} — ${hypo.why}`,
    });
  } else {
    post(triage, {
      agent, tier: 'L4', round: 2,
      text: `L4 / Principal Engineer verdict (no reasoning key — honest rule-based read): ${verdict}`,
    });
  }
  // Always flag the high-risk blind spot for this symptom (gap 6).
  const high = ranked.filter((b) => b.risk === 'high');
  if (high.length) {
    post(triage, {
      agent, tier: 'L4', round: 2,
      text: `⚠️ Blind-spot priority for this symptom: ${high.map((b) => b.front).join(', ')} — ${high[0].why}`,
    });
  }
  await wait(triage.cadence ? triage.cadence.step : STEP);

  triage.status = 'closed';
  triage.closedAt = now();
  // Wave 1 — settle the SLA breach (from the verdict time) and the lifecycle
  // roll-up now, before the record is persisted in runBridge's finally.
  finalizeSla(triage);
  triage.lifecycle = buildLifecycle(triage);
  // On-call notifier (Wave 3): page on a REAL SLA breach — breached is computed
  // from real timestamps (time-to-verdict vs the per-severity target). Only fires
  // when the incident actually blew its SLA; honest no-op when no webhook is set.
  if (triage.sla && triage.sla.breached === true) {
    notifyOncall('sla_breach', triage, {
      summary: `SLA BREACH — ${triage.incidentId} (${triage.severity}) "${triage.title}" missed its ${Math.round(triage.sla.targetMs / 60000)}m target`,
      detail: { targetMs: triage.sla.targetMs, breachAt: triage.sla.breachAt, timeToVerdict: triage.lifecycle && triage.lifecycle.timeToVerdictHuman },
    });
  }
  emit('triage_closed', triage.id, {
    incidentId: triage.incidentId || null, mttr: mttrOf(triage),
    sla: triage.sla, lifecycle: triage.lifecycle,
  });
  progress(triage, 'L4', 'done');
  // Human-facing activity line: label the elapsed value "Time to verdict" — it is
  // opened→verdict (time to diagnose), not full MTTR. The mttr payload/field stays.
  log(`[Triage ${triage.id}] closed — ${triage.severity} "${triage.title}" — Time to verdict ${mttrOf(triage).mttrHuman}`);
}

// Is this front's evidence ACTIVE inside the incident window, or only pre-existing?
// campus has no per-item timestamp, so a degraded campus (unreachable device) is
// treated as active. fabric/incidents use the fault age split; wan uses the alarm
// group new-count. When there is no time anchor at all, degraded == active.
function frontIsActive(card) {
  if (!card || card.state !== 'degraded') return false;
  if (card.age) return card.age.inWindow > 0;
  if (card.groups) return (card.groups.newCount || 0) > 0;
  return true; // campus / no-anchor: a degraded card is active
}

function buildImpact(triage, active, preExisting, suspect, clean, sym) {
  if (active.length) {
    return `Confirmed live impact IN ${windowLabel(sym)} on: ${active.join(', ')}. ` +
      (preExisting.length ? `${preExisting.join(', ')} carry pre-existing faults/alarms (not the cause). ` : '') +
      `${clean.length} front(s) read clean (${clean.join(', ') || 'none'})` +
      (suspect.length ? `; ${suspect.length} unread (${suspect.join(', ')})` : '') + '.';
  }
  if (preExisting.length) {
    return `No NEW impact in ${windowLabel(sym)}. ${preExisting.join(', ')} have pre-existing faults/alarms only — pre-dating the window, so not the trigger.`;
  }
  if (suspect.length) {
    return `No confirmed impact, but ${suspect.join(', ')} could not be read — impact there is unknown, not clear.`;
  }
  return `No live impact found on any connected front in ${windowLabel(sym)}. Blind spots below are outside what this bridge can see.`;
}

// The findings block the hypothesis call reasons over — REAL numbers only, laid
// out so Jarvis can commit without inventing anything.
function buildFindingsBlock(triage, ev, active, preExisting, suspect, clean, ranked, sym, corr) {
  const L = [];
  L.push(`SYMPTOM: ${sym && sym.rawSymptom ? sym.rawSymptom : triage.description}`);
  L.push(`WINDOW: ${sym && sym.timeAnchor ? `since ${sym.timeAnchor}` : 'no explicit anchor — recent default'}` +
    ` (${sym ? sym.source : 'none'})`);
  L.push(`SCOPE: ${sym && sym.scope ? sym.scope.join(', ') : 'not scoped'}`);
  L.push('');
  L.push('FRONTS:');
  for (const f of LIVE_FRONTS) {
    const c = ev[f];
    if (!c) continue;
    let line = `- ${f} [${c.state}]: ${c.detail}`;
    if (c.delta && c.delta.baseline != null) line += ` | delta: ${c.count} vs baseline ${c.delta.baseline} (${c.delta.delta >= 0 ? '+' : ''}${c.delta.delta})`;
    else if (c.delta && c.delta.firstSweep) line += ` | delta: first sweep, no baseline yet`;
    if (c.age) line += ` | faults in-window: ${c.age.inWindow}, pre-existing: ${c.age.older}`;
    if (c.groups && c.groups.top) line += ` | alarm groups: ${c.groups.top.map((g) => `${g.key} ${g.count}${g.chronic ? ' chronic' : g.newCount ? ` ${g.newCount} new` : ''}`).join('; ')}`;
    L.push(line);
  }
  L.push('');
  L.push(`ACTIVE-IN-WINDOW: ${active.join(', ') || 'none'}`);
  L.push(`PRE-EXISTING (not the cause): ${preExisting.join(', ') || 'none'}`);
  L.push(`UNREAD/SUSPECT: ${suspect.join(', ') || 'none'}`);
  L.push(`CLEAN: ${clean.join(', ') || 'none'}`);
  L.push('');
  L.push('CONFIG CORRELATION:');
  (triage.configFindings || []).forEach((x) => {
    L.push(`- ${x.device || 'device'}: ${x.error ? 'error ' + x.error : (x.firstSnapshot ? 'first snapshot (no prior to diff)' : (x.changed ? `CHANGED at ${x.when}${x.inWindow ? ' [IN WINDOW]' : ' [pre-window]'}` : `no change since ${x.when || 'last snapshot'}`))}`);
  });
  if (!(triage.configFindings || []).length) L.push('- no config diff collected this pass');
  L.push('');
  // Wave 4 — the measured cross-domain co-occurrence (deterministic, already
  // computed). Given to the hypothesis as a FINDING, never as a suggestion to
  // invent a link: when there is no correlation the honest note is passed instead.
  L.push('CROSS-DOMAIN CORRELATION (measured from real event timestamps):');
  if (corr && corr.topCandidate) {
    L.push(`- CORRELATED: ${corr.topCandidate.fronts.join(' + ')} all started ~${corr.topCandidate.ts}`);
    L.push(`  ${corr.topCandidate.summary}`);
    ((corr.clusters || [])[0] || { events: [] }).events.forEach((e) =>
      L.push(`  · ${e.front} | ${e.type} | ${e.ts} | ${e.detail}`));
  } else {
    L.push(`- ${(corr && corr.note) || 'correlation pass did not run'}`);
  }
  L.push('');
  L.push('BLIND SPOTS (ranked by relevance to this symptom):');
  (ranked || []).forEach((b) => L.push(`- ${b.front} [${b.risk}-risk]: ${b.reason}`));
  return L.join('\n');
}

function buildNextChecks(triage, ev, degraded, suspect) {
  const checks = [];
  if (degraded.includes('campus')) checks.push('Walk the unreachable/at-risk campus devices named on the campus card.');
  if (degraded.includes('fabric')) checks.push('Open the ACI critical/major faults on the fabric card and trace the affected tenant.');
  if (degraded.includes('wan')) checks.push('Review the active SD-WAN alarms in vManage against the WAN card.');
  if (degraded.includes('incidents')) checks.push('Correlate the open Catalyst issues with the fabric faults for a common root cause.');
  for (const f of suspect) checks.push(`Re-run the ${f} read — it failed this pass: ${ev[f] ? ev[f].detail : 'source unreachable'}.`);
  if (!checks.length) {
    checks.push('Confirm the reporter’s symptom against a blind-spot front (firewall / load balancer / security) — the connected estate is clean.');
  }
  checks.push('For firewall, load balancer and CVE exposure: no source is wired up — check those systems directly.');
  return checks;
}

// Run one agent's turn: flip to active, do the work, flip back to idle. A throw
// inside is turned into a suspect note by the readers, so this rarely fails —
// but if it does, the bridge keeps going.
async function withAgent(agentId, triage, worker) {
  setStatus(agentId, 'active', `Triage ${triage.id}`);
  try {
    // The whole turn's live reads pass the permission gate. In auto mode this
    // auto-approves and logs; in ask mode it PAUSES for a decision. A denied turn
    // runs no read (no wire call) and posts an honest "denied" bridge note — the
    // engineer never fabricates a finding.
    const g = await approvals.gate(
      { agentId, agentName: agentInfo(agentId).name,
        command: `${agentInfo(agentId).name} bridge read`, target: 'live fronts',
        triageId: triage.id, reason: `bridge investigation turn on triage ${triage.id}` },
      () => session.runWithContext(
        // Tag every wire call this turn makes with the triage + agent, so the
        // CLI/session view can replay exactly what each engineer read on the bridge.
        // share:FALSE (issue 8): the turn's helpers emit ONE consolidated check per
        // front instead of one row per underlying HTTP hop.
        { triageId: triage.id, agentId, agentName: agentInfo(agentId).name, label: `Triage ${triage.id}`,
          share: false,
          tier: (triage.staffed.find((s) => s.agent === agentId) || {}).tier || 'triage',
          purpose: `bridge investigation on triage ${triage.id}`,
          reasoning: `bridge investigation turn on triage ${triage.id}` },
        () => worker(agentId)));
    if (g.denied) {
      post(triage, {
        agent: agentId, tier: (triage.staffed.find((s) => s.agent === agentId) || {}).tier || 'L2', round: 1,
        text: '🛑 Operator denied this read — I ran nothing and will not invent a finding. Approve it in the approval panel to let me read for real.',
      });
    }
  } catch (err) {
    log(`[Triage ${triage.id}] ${agentId} turn error — ${err.message}`);
  }
  setStatus(agentId, 'idle', 'Bridge finding delivered');
  await wait(STEP);
}

// ── MTTR clock (issue 11) ────────────────────────────────────────────────────
// The mean-time-to-resolve stop-clock. openedAt is the start; the verdict is
// "resolution", so the FINAL mttr is opened→verdict (falling back to close if the
// bridge ended with no verdict). While the bridge is open, `elapsedMs` is a live
// running value (now − opened) the UI can tick every second. Everything here is
// derived from the triage's REAL timestamps — never fabricated.
function humanizeMs(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'unknown';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60), rem = s % 60;
  if (m < 60) return `${m}m${rem ? ` ${rem}s` : ''}`;
  const h = Math.floor(m / 60), remM = m % 60;
  return `${h}h${remM ? ` ${remM}m` : ''}`;
}

function mttrOf(triage) {
  const openedMs = triage.openedAt ? Date.parse(triage.openedAt) : NaN;
  const verdictMs = triage.verdictAt ? Date.parse(triage.verdictAt) : NaN;
  const closedMs = triage.closedAt ? Date.parse(triage.closedAt) : NaN;
  const running = triage.status !== 'closed';
  // Stop point: the verdict if we have one, else close, else "still running".
  const stopMs = Number.isFinite(verdictMs) ? verdictMs : (Number.isFinite(closedMs) ? closedMs : NaN);
  const elapsedMs = Number.isFinite(openedMs) ? ((Number.isFinite(stopMs) ? stopMs : Date.now()) - openedMs) : null;
  const mttrMs = (!running && Number.isFinite(openedMs) && Number.isFinite(stopMs)) ? stopMs - openedMs : null;
  return {
    openedAt: triage.openedAt || null,
    verdictAt: triage.verdictAt || null,
    closedAt: triage.closedAt || null,
    running,
    elapsedMs: elapsedMs != null ? Math.max(0, elapsedMs) : null,
    mttrMs: mttrMs != null ? Math.max(0, mttrMs) : null,
    mttrHuman: mttrMs != null ? humanizeMs(mttrMs) : (running ? 'running' : 'unknown'),
  };
}

// ── SLA breach + lifecycle roll-up (wave 1) ──────────────────────────────────
// On close, settle the SLA from REAL timestamps: breachAt is openedAt+targetMs
// (the deadline), and breached is true only when the time to VERDICT (the moment
// Jarvis committed a ruling) exceeded the target. Falls back to closedAt if the
// bridge closed with no verdict. Never fabricated — a missing timestamp → null.
function finalizeSla(triage) {
  if (!triage.sla) triage.sla = { targetMs: slaTargetFor(triage.severity), openedAt: triage.openedAt };
  const openedMs = triage.openedAt ? Date.parse(triage.openedAt) : NaN;
  const targetMs = triage.sla.targetMs;
  triage.sla.breachAt = Number.isFinite(openedMs) ? new Date(openedMs + targetMs).toISOString() : null;
  const verdictMs = triage.verdictAt ? Date.parse(triage.verdictAt) : NaN;
  const closedMs = triage.closedAt ? Date.parse(triage.closedAt) : NaN;
  const stopMs = Number.isFinite(verdictMs) ? verdictMs : closedMs;
  triage.sla.breached = (Number.isFinite(openedMs) && Number.isFinite(stopMs))
    ? (stopMs - openedMs) > targetMs
    : null;
  return triage.sla;
}

// The post-incident lifecycle roll-up: the four real timestamps plus the three
// human elapsed strings — MTTA (acknowledge time), Time to verdict (open→verdict,
// unchanged wording), and Total (open→close). A stage that never happened (no
// acknowledge, no verdict) is labelled honestly, never zeroed.
function buildLifecycle(triage) {
  const openedMs = triage.openedAt ? Date.parse(triage.openedAt) : NaN;
  const ackMs = triage.ackAt ? Date.parse(triage.ackAt) : NaN;
  const verdictMs = triage.verdictAt ? Date.parse(triage.verdictAt) : NaN;
  const closedMs = triage.closedAt ? Date.parse(triage.closedAt) : NaN;
  const span = (a, b) => (Number.isFinite(a) && Number.isFinite(b) ? humanizeMs(b - a) : null);
  return {
    openedAt: triage.openedAt || null,
    ackAt: triage.ackAt || null,
    verdictAt: triage.verdictAt || null,
    closedAt: triage.closedAt || null,
    mttaHuman: span(openedMs, ackMs) || 'not acknowledged',
    timeToVerdictHuman: span(openedMs, verdictMs) || 'unknown',
    totalHuman: span(openedMs, closedMs) || 'unknown',
  };
}

// ── Bridge roles (wave 1) ─────────────────────────────────────────────────────
// Set any provided role fields on the triage (operator-entered strings — no auth
// yet), then broadcast the whole roles object. Accepts trg-… or INC-… ids.
function setRoles(idOrIncident, rolesInput) {
  if (!idLooksValid(idOrIncident)) return { error: 'not_found', reason: 'No such triage.' };
  const t = resolveTriage(idOrIncident);
  if (!t) return { error: 'not_found', reason: 'No such triage.' };
  const r = rolesInput || {};
  const clean = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!t.roles) t.roles = { commander: '', scribe: '', joiners: [], owner: '' };
  if (r.commander !== undefined) t.roles.commander = clean(r.commander);
  if (r.scribe !== undefined) t.roles.scribe = clean(r.scribe);
  if (r.owner !== undefined) t.roles.owner = clean(r.owner);
  if (r.joiners !== undefined) {
    const arr = Array.isArray(r.joiners) ? r.joiners : String(r.joiners).split(',');
    t.roles.joiners = arr.map(clean).filter(Boolean).slice(0, 50);
  }
  emit('triage_roles', t.id, { roles: t.roles });
  log(`[Triage ${t.id}] roles set — commander:${t.roles.commander || '—'} · scribe:${t.roles.scribe || '—'} · ` +
    `owner:${t.roles.owner || '—'} · joiners:${t.roles.joiners.join('/') || '—'}`);
  return { ok: true, triageId: t.id, roles: t.roles };
}

// ── Acknowledge / MTTA (wave 1) ───────────────────────────────────────────────
// Stamp ackAt ONCE (idempotent) and compute the mean-time-to-acknowledge from the
// real openedAt. Broadcast triage_ack. A second call returns the existing stamp
// unchanged. Accepts trg-… or INC-… ids.
function acknowledge(idOrIncident) {
  if (!idLooksValid(idOrIncident)) return { error: 'not_found', reason: 'No such triage.' };
  const t = resolveTriage(idOrIncident);
  if (!t) return { error: 'not_found', reason: 'No such triage.' };
  if (t.ackAt) {
    return { ok: true, triageId: t.id, ackAt: t.ackAt, mttaMs: t.mttaMs, already: true };
  }
  t.ackAt = now();
  const openedMs = t.openedAt ? Date.parse(t.openedAt) : NaN;
  const ackMs = Date.parse(t.ackAt);
  t.mttaMs = (Number.isFinite(openedMs) && Number.isFinite(ackMs)) ? Math.max(0, ackMs - openedMs) : null;
  emit('triage_ack', t.id, { ackAt: t.ackAt, mttaMs: t.mttaMs });
  log(`[Triage ${t.id}] acknowledged — MTTA ${t.mttaMs != null ? humanizeMs(t.mttaMs) : 'unknown'}`);
  return { ok: true, triageId: t.id, ackAt: t.ackAt, mttaMs: t.mttaMs };
}

// ── Real affected CIs (issue 11 / ServiceNow) ────────────────────────────────
// Pull the ACTUAL configuration items — device hostnames, ACI tenants/nodes, WAN
// devices — behind the degraded/unread fronts, straight from the live read
// results held in memory. Nothing invented: a front we could not read contributes
// no CI (it is listed as unread instead). Deduped, capped so a noisy estate does
// not produce an unbounded list.
function collectAffectedCIs(triage) {
  const out = [];
  const seen = new Set();
  const add = (ci, type, front) => {
    const key = `${type}:${ci}`;
    if (!ci || seen.has(key)) return;
    seen.add(key);
    out.push({ ci: String(ci), type, front });
  };
  const reads = triage.reads || {};
  const ev = triage.evidence || {};
  // campus — unreachable devices are the affected CIs.
  const campus = reads.campus;
  if (campus && Array.isArray(campus.devices)) {
    campus.devices.filter((d) => d && d.reachability && d.reachability !== 'Reachable')
      .forEach((d) => add(d.hostname || d.id, 'device', 'campus'));
  }
  // fabric — tenants/nodes carrying critical/major faults (in-window first).
  // B3: the fault's `node` field is a BARE fabric id (e.g. "101") and `tenant`
  // is "unknown" for infra faults that carry no tenant. Emitting those raw would
  // give ServiceNow junk CIs ("101", "1", "unknown"). Resolve the bare node id to
  // its REAL device name from the fabric inventory (getFabricNodes → {id,name}),
  // and only emit a tenant CI when the fault actually named a real tenant.
  const fabric = reads.fabric;
  if (fabric && Array.isArray(fabric.faults)) {
    // Real node-id → device-name map from the live fabric inventory.
    const nodeNameById = new Map();
    (fabric.nodes || []).forEach((n) => {
      if (n && n.id != null && n.name) nodeNameById.set(String(n.id), String(n.name));
    });
    fabric.faults.slice(0, 12).forEach((f) => {
      // Tenant CI only when the source truly gave a tenant name — infra faults
      // return 'unknown' (no tenant in the DN); never emit that as a CI.
      if (f && f.tenant && f.tenant !== 'unknown') add(f.tenant, 'tenant', 'fabric');
      // Node CI: keep the real device name intact. Resolve the bare id to the
      // inventory name (e.g. "LF-101"); if the id isn't in inventory, keep a
      // readable "node-<id>" rather than a bare split digit — never just "101".
      if (f && f.node != null && f.node !== '') {
        const id = String(f.node);
        add(nodeNameById.get(id) || `node-${id}`, 'node', 'fabric');
      }
    });
  }
  // wan — devices/hosts named on the active alarms.
  const wan = reads.wan;
  if (wan && Array.isArray(wan.alarms)) {
    wan.alarms.slice(0, 20).forEach((a) => {
      const dev = a && (a.device || a.host);
      if (dev) add(dev, 'device', 'wan');
      if (a && a.site) add(a.site, 'site', 'wan');
    });
  }
  // incidents — devices named on open Catalyst issues.
  const inc = reads.incidents;
  if (inc && Array.isArray(inc.issues)) {
    inc.issues.slice(0, 12).forEach((i) => {
      const dev = i && (i.deviceName || i.device || i.entity);
      if (dev) add(dev, 'device', 'incidents');
    });
  }
  // Honesty: if a degraded front yielded no nameable CI, record the front itself
  // as the affected area rather than dropping it silently.
  LIVE_FRONTS.forEach((f) => {
    if (ev[f] && ev[f].state === 'degraded' && !out.some((c) => c.front === f)) {
      add(f, 'front', f);
    }
  });
  return out.slice(0, 40);
}

// ── Re-triage & diff (issue 11) ──────────────────────────────────────────────
// Re-run the SAME triage (same severity, same description → same symptom window +
// scope), link the new run to the SAME incident id, then diff the fresh verdict
// against the previous run: fronts improved/worsened, faults & alarms new/cleared,
// config changes in the window, and whether the hypothesis moved. A real re-run
// and a real diff — when nothing moved it says so with the real numbers and the
// real time, it never fabricates a "nothing changed".

// Snapshot the comparable facts of a run, from the live triage OR a persisted
// record — so a re-triage can diff even against a run from before a restart.
function runSnapshot(source) {
  // Live triage object path.
  if (source && source.evidence && source.reads !== undefined) {
    const fronts = {};
    LIVE_FRONTS.forEach((f) => {
      const c = source.evidence[f];
      if (c) fronts[f] = { state: c.state, count: c.count != null ? c.count : null };
    });
    return {
      triageId: source.id,
      verdictAt: source.verdictAt || (source.verdict && source.verdict.ts) || source.closedAt || null,
      fronts,
      faultCodes: faultCodesOf(source.reads && source.reads.fabric),
      incidentFaultCodes: faultCodesOf(source.reads && source.reads.incidents),
      wanTotal: (source.reads && source.reads.wan && source.reads.wan.count != null) ? source.reads.wan.count : null,
      hypothesis: hypoTextOf(source.verdict),
    };
  }
  // Persisted record path (post-restart) — coarser: states + counts only, no raw
  // fault identities (the record never stores them), so fault-level new/cleared is
  // honestly reported as unavailable.
  const rec = source || {};
  const fronts = {};
  (rec.evidenceFinal || []).forEach((e) => {
    if (LIVE_FRONTS.includes(e.front)) fronts[e.front] = { state: e.state, count: e.count != null ? e.count : null };
  });
  return {
    triageId: rec.id,
    verdictAt: (rec.mttr && rec.mttr.verdictAt) || rec.closedAt || null,
    fronts,
    faultCodes: null,           // not recoverable from the slim record
    incidentFaultCodes: null,
    wanTotal: (fronts.wan && fronts.wan.count != null) ? fronts.wan.count : null,
    hypothesis: (rec.verdict && (rec.verdict.hypothesis ? rec.verdict.hypothesis.hypothesis : null))
      || (rec.verdict && rec.verdict.verdict) || null,
  };
}

function faultCodesOf(read) {
  if (!read || !Array.isArray(read.faults)) return null;
  return read.faults.map((f) => (f && (f.code != null ? String(f.code) : null))).filter(Boolean);
}

function hypoTextOf(verdict) {
  if (!verdict) return null;
  if (verdict.hypothesis && verdict.hypothesis.hypothesis) return verdict.hypothesis.hypothesis;
  return verdict.verdict || null;
}

// Diff two run snapshots into a real delta. `prev` may have null fault-code sets
// (a restored record) — the diff then honestly says fault identities are
// unavailable rather than inventing new/cleared.
function diffRuns(prev, next) {
  const frontDeltas = [];
  LIVE_FRONTS.forEach((f) => {
    const a = prev.fronts[f], b = next.fronts[f];
    if (!a && !b) return;
    const before = a ? a.state : 'unknown';
    const after = b ? b.state : 'unknown';
    const rank = { clean: 0, waiting: 1, blind: 1, degraded: 2, suspect: 3, unknown: 1 };
    let direction = 'unchanged';
    if (before !== after) direction = (rank[after] ?? 1) < (rank[before] ?? 1) ? 'improved' : 'worsened';
    const beforeCount = a && a.count != null ? a.count : null;
    const afterCount = b && b.count != null ? b.count : null;
    const countDelta = (beforeCount != null && afterCount != null) ? afterCount - beforeCount : null;
    frontDeltas.push({ front: f, before, after, direction, beforeCount, afterCount, countDelta });
  });

  const faultDiff = diffCodes(prev.faultCodes, next.faultCodes);
  const wanDelta = (prev.wanTotal != null && next.wanTotal != null) ? next.wanTotal - prev.wanTotal : null;

  const configChanges = (next.configFindings || []).filter((x) => x && x.changed)
    .map((x) => ({ device: x.device, when: x.when, inWindow: !!x.inWindow, summary: x.summary || 'config changed' }));

  const hypothesisChanged = !!(prev.hypothesis && next.hypothesis && prev.hypothesis.trim() !== next.hypothesis.trim())
    || (!prev.hypothesis !== !next.hypothesis);

  // A re-triage is "material" only when a HARD NUMBER moved — a front changed
  // state, a fault was raised/cleared, WAN alarms shifted, or a config changed.
  // A hypothesis re-word alone (Jarvis composing a fresh sentence over the SAME
  // findings) is honest but is NOT a material change: counting it would flag a
  // completely static estate as "changed" every re-run, which contradicts the
  // spec's "foreground hard numbers, hypothesis-reword is secondary". It is still
  // reported (hypothesisChanged is returned and shown), just not as the trigger.
  const hardChange = frontDeltas.some((d) => d.direction !== 'unchanged')
    || (faultDiff && (faultDiff.new.length || faultDiff.cleared.length))
    || (wanDelta != null && wanDelta !== 0)
    || configChanges.length > 0;
  const material = hardChange;

  return { frontDeltas, faultDiff, wanDelta, configChanges, hypothesisChanged, hardChange, material };
}

function diffCodes(prevCodes, nextCodes) {
  if (!Array.isArray(prevCodes) || !Array.isArray(nextCodes)) {
    return { available: false, new: [], cleared: [],
      note: 'fault-level new/cleared needs both runs in memory; the previous run was restored from its record, which stores counts, not fault ids.' };
  }
  const prevSet = new Set(prevCodes), nextSet = new Set(nextCodes);
  return {
    available: true,
    new: nextCodes.filter((c) => !prevSet.has(c)),
    cleared: prevCodes.filter((c) => !nextSet.has(c)),
  };
}

function summarizeDelta(delta, prev, next) {
  if (!delta.material) {
    const since = prev.verdictAt ? ` since ${prev.verdictAt}` : ' since the last verdict';
    // Honest about the hypothesis: if the numbers held but Jarvis re-worded the
    // hypothesis, say so plainly rather than claiming it "did not move".
    const hypoNote = delta.hypothesisChanged
      ? ' The hypothesis was re-worded, but no hard number moved behind it.'
      : ' The hypothesis did not move.';
    return `No material change${since}: every connected front holds the same state and the same counts, and no faults were raised or cleared.${hypoNote}`;
  }
  const bits = [];
  const moved = delta.frontDeltas.filter((d) => d.direction !== 'unchanged');
  moved.forEach((d) => bits.push(`${d.front} ${d.direction} (${d.before}→${d.after}${d.countDelta != null ? `, count ${d.countDelta >= 0 ? '+' : ''}${d.countDelta}` : ''})`));
  if (delta.faultDiff && delta.faultDiff.available) {
    if (delta.faultDiff.new.length) bits.push(`${delta.faultDiff.new.length} new fault(s): ${delta.faultDiff.new.join(', ')}`);
    if (delta.faultDiff.cleared.length) bits.push(`${delta.faultDiff.cleared.length} cleared fault(s): ${delta.faultDiff.cleared.join(', ')}`);
  }
  if (delta.wanDelta != null && delta.wanDelta !== 0) bits.push(`WAN alarms ${delta.wanDelta >= 0 ? '+' : ''}${delta.wanDelta}`);
  delta.configChanges.forEach((c) => bits.push(`config change on ${c.device} at ${c.when}${c.inWindow ? ' (in window)' : ''}`));
  if (delta.hypothesisChanged) bits.push('hypothesis changed');
  return `Changed since ${prev.verdictAt || 'the last verdict'}: ${bits.join('; ')}.`;
}

// Load the previous run as a snapshot: prefer the live in-memory triage (full
// fidelity, real fault ids), fall back to its persisted record (coarser).
function previousRunSnapshot(id) {
  const live = triages.get(id);
  if (live) return runSnapshot(live);
  const rec = artifacts.getRecord(id);
  if (rec) return runSnapshot(rec);
  return null;
}

// Public: re-run a triage and return the real delta. Awaits the fresh bridge so
// the delta is real (computed from the completed re-run), not a promise of one.
async function retriage(id) {
  const prevSnap = previousRunSnapshot(id);
  if (!prevSnap) return { error: 'not_found', reason: 'No such triage to re-run.' };

  // Pull severity + description from the live triage or the record — the re-run is
  // the SAME triage (same severity, symptom, scope), just at a later moment.
  const live = triages.get(id);
  const rec = live ? null : artifacts.getRecord(id);
  const severity = (live && live.severity) || (rec && rec.severity);
  const description = (live && live.description) || (rec && rec.description);
  const incidentId = (live && live.incidentId) || (rec && rec.incidentId) || null;
  const operatorTz = (live && live.operatorTz) || (rec && rec.operatorTz) || null;
  if (!severity || !description) return { error: 'not_found', reason: 'That triage has no severity/description to re-run.' };

  // Build the new run, carrying the SAME incident id and a link to the run it
  // re-triages. runBridge persists its own record (linked by incidentId).
  const newTriage = buildTriage(severity, description, {
    incidentId, reTriageOf: id, parentIncidentId: incidentId, operatorTz,
  });
  if (newTriage.refused) return { error: 'refused', reason: newTriage.reason };

  emitOpened(newTriage);
  await runBridge(newTriage); // await the REAL re-run to completion

  const nextSnap = runSnapshot(newTriage);
  nextSnap.configFindings = newTriage.configFindings || [];
  const delta = diffRuns({ ...prevSnap, configFindings: [] }, { ...nextSnap });
  const summary = summarizeDelta(delta, prevSnap, nextSnap);

  const payload = {
    incidentId,
    previousTriageId: prevSnap.triageId,
    newTriageId: newTriage.id,
    previousVerdictAt: prevSnap.verdictAt,
    newVerdictAt: nextSnap.verdictAt,
    fronts: delta.frontDeltas,
    faults: delta.faultDiff,
    wanAlarmDelta: delta.wanDelta,
    configChanges: delta.configChanges,
    hypothesisChanged: delta.hypothesisChanged,
    previousHypothesis: prevSnap.hypothesis,
    newHypothesis: nextSnap.hypothesis,
    material: delta.material,
    summary,
  };
  // Stamp the delta onto the new triage so it lands in the persisted record and
  // is available on refresh. Re-persist the record now that the delta exists.
  newTriage.reTriageDelta = payload;
  try { artifacts.writeForTriage(newTriage); } catch (e) { /* never fatal */ }
  emit('triage_retriage_delta', newTriage.id, payload);
  log(`[Triage ${newTriage.id}] re-triage of ${id} (incident ${incidentId}) — ${delta.material ? 'material change' : 'no material change'}`);
  return { ok: true, delta: payload, newTriageId: newTriage.id, incidentId };
}

// ── Public entry points ─────────────────────────────────────────────────────

// Start a triage. Returns { triageId } on success, or { refused, reason } if
// the description names no real network subject (the landlord-problem fix).
function startTriage(severity, description, operatorTz) {
  // The normal operator path — the triage is stamped source:'operator' so the
  // record + UI can tell an operator-opened triage from an alert-opened one.
  const triage = buildTriage(severity, description, { operatorTz, source: 'operator' });
  // `ask` marks the "I need to know which site/device/service" case, so the
  // caller can render a question rather than a rejection.
  if (triage.refused) return { refused: true, ask: Boolean(triage.ask), reason: triage.reason };

  emitOpened(triage);

  // Run the bridge in the background. Failures are contained inside runBridge.
  runBridge(triage).catch((err) => log(`[Triage ${triage.id}] unhandled bridge error — ${err.message}`));

  // relatedTo (Wave 3): OPEN incidents this may overlap — surfaced, never merged.
  return { triageId: triage.id, incidentId: triage.incidentId, relatedTo: triage.relatedTo || [] };
}

// ── Alert-driven ingestion (Wave 2) ──────────────────────────────────────────
// Open a triage AUTO-DERIVED from a real inbound monitoring alert. The alert is
// normalized + severity-mapped + turned into a description DETERMINISTICALLY
// (no LLM — Anthropic credits may be exhausted). A malformed payload or an alert
// that names nothing real is refused here (the caller returns 422), so a bad
// alert never opens a phantom triage. A real alert naming a device/front opens a
// real triage that runs the normal bridge — same reads, same verdict, same
// honesty — just marked source:'alert' with the originating alert attached.
function startTriageFromAlert(payload, opts = {}) {
  const norm = alerts.normalize(payload, opts);
  if (!norm.ok) {
    // 'malformed' = structurally unusable; 'nonsense' = names nothing real.
    return { error: norm.error, reason: norm.reason };
  }

  const triage = buildTriage(norm.triageSeverity, norm.description, {
    source: 'alert',
    alert: norm.alert,
    severityNote: norm.severityNote,
  });
  if (triage.refused) {
    // The derived description still failed the network-subject gate — treat as a
    // nonsense alert (honest 422), never a phantom triage.
    return { error: 'nonsense', reason: triage.reason };
  }

  emitOpened(triage);

  // The extra alert-provenance activity line, on top of the normal "opened" log:
  // "Alert-triggered triage — <source>: <message>".
  if (ctx && ctx.appendToActivityLog) {
    ctx.appendToActivityLog(
      `[${now()}] [Alert] Alert-triggered triage — ${norm.alert.source}: ${norm.alert.message}\n`);
  }

  runBridge(triage).catch((err) => log(`[Triage ${triage.id}] unhandled bridge error — ${err.message}`));

  return {
    triageId: triage.id,
    incidentId: triage.incidentId,
    severity: triage.severity,
    source: 'alert',
    alert: triage.alert,
    severityNote: norm.severityNote || null,
    relatedTo: triage.relatedTo || [],   // Wave 3 — possibly-related OPEN incidents
  };
}

// Re-exported so the server's DEV sample endpoint doesn't need to require the
// alerts module directly — one seam.
function sampleAlert() { return alerts.sampleAlert(); }

// Validate + construct a triage object (and register it), WITHOUT emitting or
// running the bridge. Shared by startTriage and retriage. `opts` carries the
// lifecycle linkage (incidentId to reuse, reTriageOf) so a re-run stays on the
// SAME incident. Returns the triage, or { refused, reason }.
function buildTriage(severity, description, opts = {}) {
  const sev = String(severity || '').toUpperCase();
  if (!['P1', 'P2', 'P3'].includes(sev)) {
    return { refused: true, reason: `Severity must be P1, P2 or P3 — got "${severity}".` };
  }
  const desc = String(description || '').trim();
  if (!desc) {
    return { refused: true, reason: 'A triage needs a description of the network problem.' };
  }
  if (looksLikeGarbage(desc)) {
    // CLASS 3: refuse ONLY genuinely empty/garbage input — never a real operator
    // complaint. No bridge, no live reads, nothing sent to any device.
    return {
      refused: true,
      reason:
        `I could not read a network problem in that. Tell me in plain words what is ` +
        `happening — the site or users affected, the service, and the symptom (e.g. ` +
        `"branch 3 users report slow internet since 2pm", "voice calls breaking up", ` +
        `"sw2 packet loss since 2pm"). I have opened no bridge and read nothing.`,
    };
  }
  if (!namesNetworkSubject(desc)) {
    // AMBIGUITY → ASK. The words are real English but nothing in them names a
    // site, a device, a service or a symptom, so there is no network problem
    // here to work on. Asking is the only honest move: opening a triage would
    // page people and sweep the estate over a sentence nobody meant as a fault.
    return {
      refused: true,
      ask: true,
      reason:
        `Which site, device, or service is this about? I could not find one in ` +
        `"${desc.slice(0, 80)}", so I have opened nothing and read nothing. ` +
        `Tell me the place and what is going wrong — for example "branch 3 users ` +
        `report slow internet since 2pm" or "sw2 dropping packets".`,
    };
  }

  const id = newId();
  const openedAt = now();
  const staffedTiers = tiersFor(sev);
  const staffed = [];
  for (const tier of staffedTiers) {
    for (const agent of ROSTER[tier]) staffed.push({ agent, tier });
  }

  // Incident id (issue 11): a re-triage REUSES the parent's incident id so every
  // run of the same incident shares one operator-facing handle. A fresh triage
  // gets a new INC-YYYYMMDD-NNN, its date derived from THIS run's real openedAt and
  // its sequence a persisted daily counter (survives restart).
  const incidentId = opts.incidentId || incidentStore.assign(openedAt).incidentId;

  const triage = {
    id,
    incidentId,                          // stable human-readable id (issue 11)
    reTriageOf: opts.reTriageOf || null, // set when this run is a re-triage
    operatorTz: opts.operatorTz || null, // IANA tz for reading absolute clock times (gap 1)
    // ── Alert-driven ingestion (wave 2) ──
    // How this triage was opened: 'operator' (a person filed it) or 'alert' (an
    // inbound monitoring alert auto-opened it). `alert` carries the originating
    // alert (secret-scrubbed raw) when source === 'alert', else null.
    source: opts.source === 'alert' ? 'alert' : 'operator',
    alert: opts.alert || null,
    severityNote: opts.severityNote || null, // set when the alert severity was defaulted
    severity: sev,
    title: titleFrom(desc),
    description: desc,
    status: 'open',
    openedAt,
    closedAt: null,
    verdictAt: null,           // MTTR stop-clock, stamped when Jarvis commits
    // ── Bridge roles (wave 1) — operator-entered strings, no auth yet ──
    roles: { commander: '', scribe: '', joiners: [], owner: '' },
    // ── Acknowledge / MTTA (wave 1) — stamped once by the ack action ──
    ackAt: null,               // ISO of the first operator acknowledge
    mttaMs: null,              // ackAt − openedAt (mean time to acknowledge)
    // ── SLA clock (wave 1) — per-severity target; breach computed on close ──
    sla: { targetMs: slaTargetFor(sev), openedAt, breachAt: null, breached: null },
    lifecycle: null,           // open→ack→verdict→close roll-up, built on close
    staffed,
    blindSpots: BLIND_SPOTS,
    fronts: FRONTS,
    // Escalation strip seed (B12): a tier that this severity does not staff starts
    // 'skipped' — a distinct state — NOT 'pending', so the strip never looks stalled
    // waiting on a tier that is never coming (e.g. L3 at P3).
    progress: (() => {
      const p = {};
      ['L1', 'L2', 'L3', 'L4'].forEach((tier) => {
        p[tier] = staffedTiers.includes(tier) ? 'pending' : 'skipped';
      });
      return p;
    })(),
    evidence: {},
    evidenceHistory: [],
    messages: [],
    verdict: null,
    symptom: null,             // filled by extractSymptom at bridge start (gap 1)
    rankedBlindSpots: null,    // filled by rankBlindSpots (gap 6)
    configFindings: [],        // filled by the config diff pass (gap 5)
    cadence: null,             // severity-driven orchestration knobs (gap 3)
    attempts: {},              // per-front read attempt counters (issue 8)
    frontDelta: {},            // per-front baseline delta, computed once (gap 2)
    reads: {},                 // in-memory raw read results (re-triage diff / CIs)
    affectedCIs: [],           // real affected devices/tenants (ServiceNow)
    reTriageDelta: null,       // set on a re-run: the real delta vs the prior run
    relatedTo: [],             // Wave 3 — OPEN incidents this may overlap (never auto-merged)
  };
  triages.set(id, triage);

  // Wave 3 — dedupe/correlation: which OPEN incidents does this plausibly relate
  // to? Computed AFTER the record is registered so the loop can see its peers;
  // self + same lineage are excluded inside computeRelatedTo. Real overlap only.
  triage.relatedTo = computeRelatedTo(triage);

  // Board renders in front order; every live front starts "waiting", every
  // blind front starts "blind" (hatched grey, no data source).
  FRONTS.forEach((front) => {
    const initial = BLIND_FRONTS.includes(front)
      ? { front, state: 'blind', detail: blindReason(front), source: null, ts: now() }
      : { front, state: 'waiting', detail: 'awaiting first read', source: null, ts: now() };
    triage.evidence[front] = initial;
    recordEvidenceHistory(triage, front, initial.state, initial.detail, initial.source, initial.ts);
  });

  return triage;
}

// Emit the opening board for a triage (triage_opened + blind cards + progress).
function emitOpened(triage) {
  const id = triage.id;
  // triage_opened carries the whole board so the UI can render it at once.
  emit('triage_opened', id, {
    incidentId: triage.incidentId,          // issue 11 — surfaced to the operator
    reTriageOf: triage.reTriageOf || null,
    severity: triage.severity,
    title: triage.title,
    description: triage.description,
    openedAt: triage.openedAt,
    staffed: triage.staffed,
    blindSpots: BLIND_SPOTS,
    fronts: FRONTS,
    // Wave 2 — how the triage was opened + the originating alert (contract for the
    // UI: data.source = 'alert'|'operator'; data.alert = {source,type,severity,
    // device,front,message,receivedAt,(raw)}). null alert on the operator path.
    source: triage.source || 'operator',
    alert: triage.alert || null,
    // Wave 1 — the bridge roles (empty until the operator sets them) and the
    // per-severity SLA target so the UI can count down locally from openedAt.
    roles: triage.roles,
    sla: { targetMs: triage.sla.targetMs, openedAt: triage.sla.openedAt },
    // Wave 3 — possibly-related OPEN incidents (dedupe/correlation), never
    // auto-merged. Contract: data.relatedTo = [{incidentId, why}]; [] when none.
    relatedTo: triage.relatedTo || [],
  });
  // Blind cards go out immediately — they are known before any read.
  BLIND_FRONTS.forEach((front) =>
    emit('triage_evidence', id, { front, state: 'blind', detail: blindReason(front), source: null }));
  // Initial escalation-strip state — emit each tier's real seed (B12): staffed
  // tiers are 'pending', tiers this severity never staffs are 'skipped'.
  ['L1', 'L2', 'L3', 'L4'].forEach((tier) =>
    emit('triage_progress', id, { tier, status: triage.progress[tier] }));

  log(`[Triage ${id}] opened — ${triage.severity} "${triage.title}" — incident ${triage.incidentId}` +
    (triage.reTriageOf ? ` (re-triage of ${triage.reTriageOf})` : '') +
    ` — staffed ${triage.staffed.map((s) => s.agent).join(', ')}`);
}

function blindReason(front) {
  const b = BLIND_SPOTS.find((x) => x.front === front);
  return b ? b.reason : 'no data source';
}

function titleFrom(desc) {
  const t = desc.replace(/\s+/g, ' ').trim();
  return t.length <= 80 ? t : t.slice(0, 77).replace(/\s+\S*$/, '') + '…';
}

// Resolve a triage by its id (trg-…) OR its operator-facing incident id (INC-…). The
// UI surfaces the incident id prominently, so a client may send either — accepting both
// removes a whole class of "No such triage" 404s. On an incident id with more than one
// run (a re-triage), the most recently opened run wins.
function resolveTriage(idOrIncident) {
  const key = String(idOrIncident || '');
  const direct = triages.get(key);
  if (direct) return direct;
  let best = null;
  for (const t of triages.values()) {
    if (t.incidentId === key && (!best || t.openedAt > best.openedAt)) best = t;
  }
  return best;
}

// Full record for reconnect/refresh.
function getTriage(id) {
  const t = triages.get(id);
  if (!t) return null;
  return {
    triageId: t.id,
    incidentId: t.incidentId || null,   // issue 11 — stable operator-facing id
    reTriageOf: t.reTriageOf || null,
    mttr: mttrOf(t),                     // issue 11 — running/final MTTR clock
    reTriageDelta: t.reTriageDelta || null,
    severity: t.severity,
    title: t.title,
    description: t.description,
    status: t.status,
    openedAt: t.openedAt,
    closedAt: t.closedAt,
    // Wave 2 — origin + originating alert, restored on refresh/reconnect.
    source: t.source || 'operator',
    alert: t.alert || null,
    // Wave 1 — roles, acknowledge/MTTA, SLA clock + lifecycle roll-up, so a
    // refresh/reconnect restores them exactly (FE ignores what it doesn't use).
    roles: t.roles || { commander: '', scribe: '', joiners: [], owner: '' },
    ackAt: t.ackAt || null,
    mttaMs: t.mttaMs != null ? t.mttaMs : null,
    sla: t.sla || null,
    lifecycle: t.lifecycle || null,
    staffed: t.staffed,
    blindSpots: t.blindSpots,
    fronts: t.fronts,
    // Escalation strip as an array in tier order — the UI's restore path reads
    // progress as [{tier, status}], not a keyed object.
    progress: ['L1', 'L2', 'L3', 'L4'].map((tier) => ({ tier, status: t.progress[tier] })),
    evidence: t.fronts.map((f) => t.evidence[f]).filter(Boolean),
    messages: t.messages,
    verdict: t.verdict,
    // Wave-2 additive fields for refresh/restore (FE ignores what it doesn't use).
    symptom: t.symptom || null,
    rankedBlindSpots: t.rankedBlindSpots || null,
    configFindings: t.configFindings || [],
    cadence: t.cadence ? t.cadence.label : null,
    // Wave 4 — the correlation pass, also at the top level so the UI's restore
    // fallback (verdict.correlation ?? record.correlation) is live, not dead code.
    correlation: t.correlation || null,
  };
}

// ── Operator posts into an open bridge ───────────────────────────────────────
// During a live triage the operator (the person watching) can post context onto
// the bridge — "ignore sw3, it's in maintenance", or a nudge to an engineer.
// The post is stamped as coming from the OPERATOR (never an agent), streamed on
// the bridge like any other message, and recorded in the triage so it shows up
// again on reconnect via getTriage. It touches ONLY the message stream — no
// evidence card, no agent status — so it cannot corrupt the evidence board.
// (Agents do not yet re-plan around it — that is Phase E.)
function postOperatorMessage(triageId, text) {
  const t = triages.get(triageId);
  if (!t) return { error: 'not_found', reason: 'No such triage.' };
  if (t.status === 'closed') {
    return { error: 'closed', reason: 'That triage has already closed — nothing more can be posted to it.' };
  }
  const clean = String(text || '').trim();
  if (!clean) return { error: 'empty', reason: 'An operator note needs some text.' };

  // Round follows where the bridge currently is, purely for display ordering.
  const round = t.progress && t.progress.L4 === 'done' ? 2 : 1;
  const msg = emit('triage_message', t.id, {
    agent: 'operator',
    agentName: 'Operator (You)',
    agentIcon: '🧑‍💻',
    tier: 'OPS',
    severity: t.severity,
    round,
    text: clean,
    operator: true,      // the UI marks this clearly as the operator, not an engineer
  });
  t.messages.push(msg);
  log(`[Triage ${t.id}] operator note on the bridge — "${clean.slice(0, 80)}"`);
  return { ok: true, message: msg };
}

// ── Retry a down front inside an open triage ────────────────────────────────
// The operator hits "retry" on a suspect/degraded card. We re-run the REAL
// reader for that front right now, re-emit the evidence card (it recolours from
// the fresh read), and return the real outcome. No fake success: if the source
// is still down, the card goes suspect again with the new error string.
async function retryFront(triageId, front) {
  // Accept EITHER the triage id (trg-…) OR the operator-facing incident id (INC-…) —
  // the frontend may hold whichever, and passing the incident id was the real cause of
  // the 404 (issue: per-front retry). Resolve by id first, then by incidentId.
  const t = resolveTriage(triageId);
  if (!t) return { error: 'not_found', reason: 'No such triage.' };
  // Normalise the front key: the contract is the lowercase front key
  // (campus|fabric|wan|incidents). Tolerate case/whitespace so "WAN"/"Fabric" still work.
  front = String(front || '').trim().toLowerCase();
  if (!READERS[front]) {
    if (BLIND_FRONTS.includes(front)) {
      return { error: 'not_retryable', reason: `The ${front} front is a blind spot — no live source to re-read.` };
    }
    return { error: 'not_retryable', reason: `"${front}" is not a live front. Retryable fronts: ${LIVE_FRONTS.join(', ')}.` };
  }
  // Which engineer owns this front (for the session-log tag + the bridge note).
  const owner = { campus: 'netops', fabric: 'router-expert', wan: 'router-expert', incidents: 'incident-handler' }[front] || 'monitor-eye';
  // Re-read with the SAME symptom window + a relaxed cadence — the retry emits ONE
  // check with the incremented attempt count (×N), never a stacked duplicate row.
  const r = await gatedFrontRead(t, {
    front, agentId: owner, agentName: agentInfo(owner).name,
    label: `Manual retry — ${front}`, reason: `operator asked to re-read the ${front} front`,
    sym: t.symptom || { rawSymptom: t.description }, cadence: t.cadence || cadenceFor(t.severity),
  });
  postEvidence(t, front, r);
  post(t, {
    agent: owner, tier: 'OPS', round: t.progress && t.progress.L4 === 'done' ? 2 : 1,
    text: r.state === 'suspect'
      ? `🔁 Retry of the ${front} front — still down: ${r.detail}. Nothing invented.`
      : `🔁 Retry of the ${front} front — back with live data: ${r.detail} [${r.source}].`,
  });
  log(`[Triage ${t.id}] manual retry of ${front} — ${r.state}`);
  return { ok: true, front, result: { state: r.state, detail: r.detail, source: r.source || null } };
}

// Recent list (newest first).
function listTriages() {
  return [...triages.values()]
    .sort((a, b) => (a.openedAt < b.openedAt ? 1 : -1))
    .map((t) => ({
      id: t.id,
      incidentId: t.incidentId || null,
      reTriageOf: t.reTriageOf || null,
      severity: t.severity,
      title: t.title,
      status: t.status,
      openedAt: t.openedAt,
      source: t.source || 'operator',
      alert: t.alert ? { source: t.alert.source, type: t.alert.type, severity: t.alert.severity, front: t.alert.front, device: t.alert.device } : null,
      mttr: mttrOf(t),
    }));
}

// ── Incident queue (Wave 3) ──────────────────────────────────────────────────
// The multi-incident queue view: every open + recent triage as a compact row,
// most-urgent first. Concurrent bridges each already have their own id — this
// just exposes the list cleanly. SLA `breached` is REAL: for a closed incident
// it is the settled value (time-to-verdict vs target); for an OPEN one it is a
// live computation (now past openedAt+target?), never fabricated.
function listIncidents() {
  const rank = { P1: 0, P2: 1, P3: 2 };
  const rows = [...triages.values()].map((t) => {
    const openedMs = t.openedAt ? Date.parse(t.openedAt) : NaN;
    const targetMs = (t.sla && t.sla.targetMs) || slaTargetFor(t.severity);
    let breached;
    if (t.status === 'closed') {
      breached = t.sla ? t.sla.breached : null;   // settled on close from real timestamps
    } else {
      breached = Number.isFinite(openedMs) ? (Date.now() - openedMs) > targetMs : null; // live
    }
    return {
      triageId: t.id,
      incidentId: t.incidentId || null,
      severity: t.severity,
      source: t.source || 'operator',
      status: t.status,
      owner: (t.roles && t.roles.owner) || null,
      title: t.title,
      openedAt: t.openedAt,
      sla: { targetMs, breached },
    };
  });
  // Most-urgent first: open before closed, then breached first, then by severity
  // (P1>P2>P3), then newest opened. A stable, deterministic ordering.
  return rows.sort((a, b) => {
    const ao = a.status === 'closed' ? 1 : 0, bo = b.status === 'closed' ? 1 : 0;
    if (ao !== bo) return ao - bo;
    const ab = a.sla.breached ? 0 : 1, bb = b.sla.breached ? 0 : 1;
    if (ab !== bb) return ab - bb;
    const ar = rank[a.severity] ?? 9, br = rank[b.severity] ?? 9;
    if (ar !== br) return ar - br;
    return a.openedAt < b.openedAt ? 1 : -1;
  });
}

module.exports = {
  init,
  startTriage,
  startTriageFromAlert,
  sampleAlert,
  getTriage,
  listTriages,
  listIncidents,
  postOperatorMessage,
  setRoles,
  acknowledge,
  retryFront,
  retriage,
  isNetworkSubject,
  // The intake gate, exported so it can be tested WITHOUT opening a triage (a
  // real startTriage runs a live bridge against real kit).
  namesNetworkSubject, looksLikeGarbage,
  FRONTS,
  BLIND_SPOTS,
};
