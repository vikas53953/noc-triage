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

async function readCampus() {
  const source = catalyst.label;
  try {
    const devices = await catalyst.getDevices();
    const health = await catalyst.getHealth().catch(() => null);
    const up = devices.filter((d) => d.reachability === 'Reachable').length;
    const down = devices.length - up;
    const detail =
      `${up}/${devices.length} reachable` +
      (health && health.score != null ? `, health ${health.score}` : '');
    return { state: down > 0 ? 'degraded' : 'clean', detail, source, devices, health };
  } catch (err) {
    return { state: 'suspect', detail: shortErr('Catalyst Center', err), source };
  }
}

async function readFabric() {
  const source = aci.label;
  try {
    const nodes = await aci.getFabricNodes();
    const health = await aci.getFabricHealth().catch(() => ({ score: null }));
    const faults = await aci.getFaults(['critical', 'major']).catch(() => []);
    const crit = faults.filter((f) => f.severity === 'critical').length;
    const major = faults.length - crit;
    const detail =
      `${nodes.length} nodes` +
      (health.score != null ? `, health ${health.score}` : '') +
      `, ${crit} crit / ${major} major faults`;
    const state = crit > 0 || major > 0 ? 'degraded' : 'clean';
    return { state, detail, source, nodes, health, faults };
  } catch (err) {
    return { state: 'suspect', detail: shortErr('APIC', err), source };
  }
}

async function readWan() {
  const source = sdwan.label;
  try {
    const devices = await sdwan.getDevices();
    const alarms = await sdwan.getAlarmCount().catch(() => ({ active: null }));
    const active = alarms.active;
    const detail = `${devices.length} devices, ${active == null ? 'n/a' : active} active alarms`;
    const state = Number(active) > 0 ? 'degraded' : 'clean';
    return { state, detail, source, devices, alarms };
  } catch (err) {
    return { state: 'suspect', detail: shortErr('vManage', err), source };
  }
}

async function readIncidents() {
  const source = `${catalyst.label} + ${aci.label}`;
  try {
    const issues = await catalyst.getIssues();
    let faults = [];
    let faultNote = '';
    try {
      faults = await aci.getFaults(['critical', 'major']);
    } catch (e) {
      faultNote = ` (ACI faults unread: ${e.message})`;
    }
    const detail = `${issues.length} Catalyst issues, ${faults.length} ACI faults${faultNote}`;
    const state = issues.length || faults.length ? 'degraded' : 'clean';
    return { state, detail, source, issues, faults };
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

function postEvidence(triage, front, { state, detail, source }) {
  const card = emit('triage_evidence', triage.id, { front, state, detail, source: source || null });
  triage.evidence[front] = { front, state, detail, source: source || null, ts: card.ts };
  return card;
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
  try {
    // ROUND 1 — L1 opener: acknowledge, basic sweep across every live front,
    // then the escalation call.
    await runL1(triage, staffedTiers);

    // ROUND 1 — L2 investigation: campus + incidents, device-level.
    if (staffedTiers.includes('L2')) await runL2(triage);

    // ROUND 1 — L3 SME device-deep: fabric + wan + campus software (P1/P2 only).
    if (staffedTiers.includes('L3')) await runL3(triage);

    // ROUND 2 — L4 correlation + verdict, then close.
    await runL4(triage);
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
  }
}

async function runL1(triage, staffedTiers) {
  const agent = 'monitor-eye';
  progress(triage, 'L1', 'active');
  setStatus(agent, 'active', `Triage ${triage.id} — L1 sweep`);

  post(triage, {
    agent, tier: 'L1', round: 1,
    text: `Acknowledged — ${triage.severity} triage open: "${triage.title}". ` +
      `Running a basic live sweep across every connected front before I make the escalation call.`,
  });
  await wait(STEP);

  // Basic sweep: a real reading for EVERY live front so no card is blank even
  // at P3, where no SME (L3) is staffed to go deeper on fabric/wan.
  for (const front of LIVE_FRONTS) {
    const r = await session.runWithContext(
      { triageId: triage.id, agentId: 'monitor-eye', agentName: agentInfo('monitor-eye').name, front, label: `Triage ${triage.id} — L1 sweep` },
      () => READERS[front]());
    postEvidence(triage, front, r);
    post(triage, {
      agent, tier: 'L1', round: 1,
      text: `Sweep — ${front}: ${r.state === 'suspect' ? '⚠️ ' : ''}${r.detail} [${r.source}]`,
    });
    await wait(STEP);
  }

  // Escalation call — driven by severity, stated plainly.
  const call = escalationCall(triage.severity, staffedTiers);
  post(triage, { agent, tier: 'L1', round: 1, text: call });
  progress(triage, 'L1', 'done');
  setStatus(agent, 'idle', 'L1 sweep delivered');
  await wait(STEP);
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

async function runL2(triage) {
  progress(triage, 'L2', 'active');

  // NetOps -> campus, live inventory + health.
  await withAgent('netops', triage, async (agent) => {
    const r = await readCampus();
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
    const r = await readIncidents();
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
  await wait(STEP);
}

async function runL3(triage) {
  progress(triage, 'L3', 'active');

  // Router-Expert -> fabric (ACI) and wan (SD-WAN), the two SME fronts.
  await withAgent('router-expert', triage, async (agent) => {
    const f = await readFabric();
    postEvidence(triage, 'fabric', f);
    post(triage, {
      agent, tier: 'L3', round: 1,
      text: f.state === 'suspect'
        ? `Fabric read failed — ${f.detail}. No fabric claim from me without a read.`
        : `Fabric (ACI) device-deep: ${f.detail}. Live from ${f.source}` +
          (f.nodes ? ` — ${f.nodes.map((n) => `${n.name}/${n.role}`).join(', ')}.` : '.'),
    });
    await wait(STEP);

    const w = await readWan();
    postEvidence(triage, 'wan', w);
    post(triage, {
      agent, tier: 'L3', round: 1,
      text: w.state === 'suspect'
        ? `WAN overlay read failed — ${w.detail}. Not vouching for the overlay blind.`
        : `WAN (SD-WAN) device-deep: ${w.detail}. Live from ${w.source}.`,
    });
  });

  // Config-Keeper -> campus device-deep: running software versions, read live.
  // Honest limit: it holds no golden baseline, so it reports current state only.
  await withAgent('config-keeper', triage, async (agent) => {
    const r = await readCampus();
    if (r.state === 'suspect') {
      postEvidence(triage, 'campus', r);
      post(triage, {
        agent, tier: 'L3', round: 1,
        text: `Config read blocked — ${r.detail}. I hold no offline baseline to fall back on, so nothing to show.`,
      });
      return;
    }
    const versions = (r.devices || [])
      .map((d) => `${d.hostname} ${d.software || 'version n/a'}`)
      .join('; ');
    // Refine the campus card with the device-deep detail, keeping the live state.
    postEvidence(triage, 'campus', {
      state: r.state,
      detail: `${r.detail} · versions read live`,
      source: r.source,
    });
    post(triage, {
      agent, tier: 'L3', round: 1,
      text: `Running software, read live from ${r.source}: ${versions || 'no devices returned'}. ` +
        `I hold no golden baseline or change history, so this is current state only — no drift claim.`,
    });
  });

  progress(triage, 'L3', 'done');
  await wait(STEP);
}

async function runL4(triage) {
  const agent = 'jarvis';
  progress(triage, 'L4', 'active');
  setStatus(agent, 'active', `Triage ${triage.id} — L4 correlation`);
  await wait(STEP);

  const ev = triage.evidence;
  const degraded = LIVE_FRONTS.filter((f) => ev[f] && ev[f].state === 'degraded');
  const suspect = LIVE_FRONTS.filter((f) => ev[f] && ev[f].state === 'suspect');
  const clean = LIVE_FRONTS.filter((f) => ev[f] && ev[f].state === 'clean');

  // Verdict is built ONLY from the collected live evidence — no invented number.
  let verdict;
  if (suspect.length && !degraded.length) {
    verdict = `Cannot fully rule: ${suspect.length} front(s) could not be read (${suspect.join(', ')}). ` +
      `The fronts that did answer look clean, but I will not call an all-clear over a blind front.`;
  } else if (!degraded.length && !suspect.length) {
    verdict = `No live evidence of an active fault. Every connected front read clean: ${clean.join(', ')}. ` +
      `If the reporter still sees impact, it sits in a blind spot below, not on the connected estate.`;
  } else {
    verdict = `Live evidence points at ${degraded.join(', ')}. ` +
      degraded.map((f) => `${f}: ${ev[f].detail}`).join(' | ') +
      (suspect.length ? `. Unread (treat as blind): ${suspect.join(', ')}.` : '.');
  }

  const impact = buildImpact(triage, degraded, suspect, clean);
  const nextChecks = buildNextChecks(triage, ev, degraded, suspect);

  const v = emit('triage_verdict', triage.id, {
    verdict, impact, nextChecks, blindSpots: BLIND_SPOTS,
  });
  triage.verdict = { verdict, impact, nextChecks, blindSpots: BLIND_SPOTS, ts: v.ts };

  post(triage, {
    agent, tier: 'L4', round: 2,
    text: `L4 / Principal Engineer verdict: ${verdict}`,
  });
  await wait(STEP);

  triage.status = 'closed';
  triage.closedAt = now();
  emit('triage_closed', triage.id, {});
  progress(triage, 'L4', 'done');
  log(`[Triage ${triage.id}] closed — ${triage.severity} "${triage.title}"`);
}

function buildImpact(triage, degraded, suspect, clean) {
  if (degraded.length) {
    return `Confirmed live impact on: ${degraded.join(', ')}. ` +
      `${clean.length} front(s) read clean (${clean.join(', ') || 'none'})` +
      (suspect.length ? `; ${suspect.length} unread (${suspect.join(', ')})` : '') + '.';
  }
  if (suspect.length) {
    return `No confirmed impact, but ${suspect.join(', ')} could not be read — impact there is unknown, not clear.`;
  }
  return `No live impact found on any connected front. Blind spots below are outside what this bridge can see.`;
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
    // Tag every wire call this turn makes with the triage + agent, so the
    // CLI/session view can replay exactly what each engineer read on the bridge.
    await session.runWithContext(
      { triageId: triage.id, agentId, agentName: agentInfo(agentId).name, label: `Triage ${triage.id}` },
      () => worker(agentId));
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
    messages: [],
    verdict: null,
  };
  triages.set(id, triage);

  // Board renders in front order; every live front starts "waiting", every
  // blind front starts "blind" (hatched grey, no data source).
  FRONTS.forEach((front) => {
    triage.evidence[front] = BLIND_FRONTS.includes(front)
      ? { front, state: 'blind', detail: blindReason(front), source: null, ts: now() }
      : { front, state: 'waiting', detail: 'awaiting first read', source: null, ts: now() };
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
  const r = await session.runWithContext(
    { triageId: t.id, agentId: owner, agentName: agentInfo(owner).name, front, label: `Manual retry — ${front}` },
    () => READERS[front]());
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
