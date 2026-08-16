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
  // Render in UTC so the label matches the ISO anchor the symptom parse produced
  // (e.g. "2pm" -> 14:00Z -> "the 14:00 UTC window"), not a locale-shifted time.
  const d = new Date(sym.timeAnchor);
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
    const sym = await jarvis.extractSymptom(triage.description).catch(() => null)
      || { timeAnchor: null, timeAnchorMs: null, scope: null, rawSymptom: triage.description, note: 'symptom parse unavailable', source: 'none' };
    sym.severity = triage.severity;
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

  // ── Committed hypothesis (gap 7) — strictly from the real findings ──
  post(triage, { agent, tier: 'L4', round: 2, text: '🧠 Correlating the collected findings into a committed hypothesis…' });
  const findingsBlock = buildFindingsBlock(triage, ev, active, preExisting, suspect, clean, ranked, sym);
  const hypo = await jarvis.synthesizeTriageVerdict({
    title: triage.title, severity: triage.severity, symptom: sym, findingsBlock,
  }).catch(() => null);

  const verdictPayload = {
    verdict, impact, nextChecks,
    blindSpots: ranked,           // ranked/weighted (gap 6)
    hypothesis: hypo || null,     // committed ranked hypothesis + if/then + confidence (gap 7)
    window: sym ? { timeAnchor: sym.timeAnchor, scope: sym.scope, source: sym.source } : null,
    configFindings: triage.configFindings || [],
  };
  const v = emit('triage_verdict', triage.id, verdictPayload);
  triage.verdict = { ...verdictPayload, ts: v.ts };

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
  emit('triage_closed', triage.id, {});
  progress(triage, 'L4', 'done');
  log(`[Triage ${triage.id}] closed — ${triage.severity} "${triage.title}"`);
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
function buildFindingsBlock(triage, ev, active, preExisting, suspect, clean, ranked, sym) {
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

// ── Public entry points ─────────────────────────────────────────────────────

// Start a triage. Returns { triageId } on success, or { refused, reason } if
// the description names no real network subject (the landlord-problem fix).
function startTriage(severity, description) {
  const sev = String(severity || '').toUpperCase();
  if (!['P1', 'P2', 'P3'].includes(sev)) {
    return { refused: true, reason: `Severity must be P1, P2 or P3 — got "${severity}".` };
  }
  const desc = String(description || '').trim();
  if (!desc) {
    return { refused: true, reason: 'A triage needs a description of the network problem.' };
  }
  if (!isNetworkSubject(desc)) {
    // Honest refusal — no bridge, no live reads, nothing sent to any device.
    return {
      refused: true,
      reason:
        `That does not name anything this NOC can see. A triage has to be about the network ` +
        `it is wired to — Catalyst Center campus, the ACI fabric or the SD-WAN overlay. ` +
        `I have opened no bridge and read nothing. Re-file it naming a real device, front or symptom.`,
    };
  }

  const id = newId();
  const staffedTiers = tiersFor(sev);
  const staffed = [];
  for (const tier of staffedTiers) {
    for (const agent of ROSTER[tier]) staffed.push({ agent, tier });
  }

  const triage = {
    id,
    severity: sev,
    title: titleFrom(desc),
    description: desc,
    status: 'open',
    openedAt: now(),
    closedAt: null,
    staffed,
    blindSpots: BLIND_SPOTS,
    fronts: FRONTS,
    progress: { L1: 'pending', L2: 'pending', L3: 'pending', L4: 'pending' },
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
  };
  triages.set(id, triage);

  // Board renders in front order; every live front starts "waiting", every
  // blind front starts "blind" (hatched grey, no data source).
  FRONTS.forEach((front) => {
    const initial = BLIND_FRONTS.includes(front)
      ? { front, state: 'blind', detail: blindReason(front), source: null, ts: now() }
      : { front, state: 'waiting', detail: 'awaiting first read', source: null, ts: now() };
    triage.evidence[front] = initial;
    recordEvidenceHistory(triage, front, initial.state, initial.detail, initial.source, initial.ts);
  });

  // triage_opened carries the whole board so the UI can render it at once.
  emit('triage_opened', id, {
    severity: sev,
    title: triage.title,
    description: desc,
    openedAt: triage.openedAt,
    staffed,
    blindSpots: BLIND_SPOTS,
    fronts: FRONTS,
  });
  // Blind cards go out immediately — they are known before any read.
  BLIND_FRONTS.forEach((front) =>
    emit('triage_evidence', id, { front, state: 'blind', detail: blindReason(front), source: null }));
  // Initial escalation-strip state.
  ['L1', 'L2', 'L3', 'L4'].forEach((tier) =>
    emit('triage_progress', id, { tier, status: 'pending' }));

  log(`[Triage ${id}] opened — ${sev} "${triage.title}" — staffed ${staffed.map((s) => s.agent).join(', ')}`);

  // Run the bridge in the background. Failures are contained inside runBridge.
  runBridge(triage).catch((err) => log(`[Triage ${id}] unhandled bridge error — ${err.message}`));

  return { triageId: id };
}

function blindReason(front) {
  const b = BLIND_SPOTS.find((x) => x.front === front);
  return b ? b.reason : 'no data source';
}

function titleFrom(desc) {
  const t = desc.replace(/\s+/g, ' ').trim();
  return t.length <= 80 ? t : t.slice(0, 77).replace(/\s+\S*$/, '') + '…';
}

// Full record for reconnect/refresh.
function getTriage(id) {
  const t = triages.get(id);
  if (!t) return null;
  return {
    triageId: t.id,
    severity: t.severity,
    title: t.title,
    description: t.description,
    status: t.status,
    openedAt: t.openedAt,
    closedAt: t.closedAt,
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
  const t = triages.get(triageId);
  if (!t) return { error: 'not_found', reason: 'No such triage.' };
  if (!READERS[front]) {
    return { error: 'not_retryable', reason: `The ${front} front has no live source to re-read (it is a blind spot).` };
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
      severity: t.severity,
      title: t.title,
      status: t.status,
      openedAt: t.openedAt,
    }));
}

module.exports = {
  init,
  startTriage,
  getTriage,
  listTriages,
  postOperatorMessage,
  retryFront,
  isNetworkSubject,
  FRONTS,
  BLIND_SPOTS,
};
