// artifacts.js — Phase D: per-triage ARTIFACTS + auto-written DOCUMENTATION.
//
// PURPOSE: when a triage runs and closes, persist a COMPLETE, REAL record of what
// actually happened to disk (under the workspace, squad/triages/<id>/), and from
// that same real record auto-write TWO documents:
//   - slt.md       — leadership / SLT, plain words, no jargon.
//   - engineer.md  — the technical writeup an engineer would read.
//
// HONESTY: nothing here is invented. Every number, command, raw output, error and
// verdict comes from the live triage object + the real recorded wire session
// (sources/session-log.js). If a front was suspect or blind, the docs say so with
// the REAL error string — a failed read is never rewritten as a success. If the
// bridge closed with no verdict, the docs summarise from the real evidence and say
// the verdict is missing — they never invent a root cause.
//
// SECRETS: credential VALUES never reach a written file. The session recorder
// already scrubs raw bodies; as belt-and-braces every string written here also
// passes through scrub(), which redacts (a) any token/username/password-shaped
// field and (b) the literal credential VALUES pulled from the environment. Lengths
// and hostnames are fine; the login identity and secret half never are.
//
// PATH SAFETY: every file this module reads or writes is resolved through the
// workspace layer's safeJoin (the Tier-1 guard). A caller-supplied triage id that
// tries to climb out of the triages folder (``..%2f..``) resolves to null and is
// refused — the same guard the file browser uses.

const path = require('path');
const fs = require('fs');
const { SQUAD_ROOT, safeJoin, safeWrite } = require('../workspace');
const session = require('./session-log');
const correlation = require('./correlation');

// ── Dual-clock timestamps (issue: docs must not show raw UTC-only ISO) ────────
// The whole app renders times as "13:35 local · 08:05 UTC" (the operator's zone
// first, then UTC). Reuse the ONE shared formatter (correlation.clock) so a doc
// reads the same as every card. A doc can span calendar days, so we prefix the
// UTC date (the same UTC anchor the incident-id date uses) and let the shared
// helper add the dual time. tz is the operator's IANA zone (carried on the
// record); when the bridge was opened without one, clock() honestly shows UTC
// only rather than guessing the server's zone.
function tsDoc(iso, tz) {
  if (!iso) return '(unknown)';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return String(iso);
  const d = new Date(ms);
  const datePart = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  return `${datePart} ${correlation.clock(ms, tz || null)}`;
}

const TRIAGES_DIRNAME = 'triages';
function triagesRoot() { return path.join(SQUAD_ROOT, TRIAGES_DIRNAME); }

// ── Secret scrubbing ─────────────────────────────────────────────────────────
// Belt-and-braces over the session recorder's own scrub. Two passes:
//   1. token/username/password-shaped JSON or key=value fields → «redacted».
//   2. the literal credential VALUES from the environment, wherever they appear.
// Only the adapter credential vars (DNAC/ACI/SDWAN + ANTHROPIC) and anything that
// ends in PASS/PASSWORD/TOKEN/SECRET are treated as secret — never host names,
// never Windows USERNAME/USERPROFILE.
function credentialValues() {
  const out = [];
  for (const [k, v] of Object.entries(process.env)) {
    if (!v || String(v).length < 3) continue;
    if (/^(DNAC|ACI|SDWAN|ANTHROPIC)_(USER|PASS|PASSWORD|TOKEN|KEY|SECRET|COOKIE)/i.test(k)
        || /(PASSWORD|SECRET|TOKEN)$/i.test(k)) {
      out.push(String(v));
    }
  }
  return out;
}

function scrub(text) {
  if (text == null) return '';
  let s = String(text);
  s = s.replace(
    /("?(?:token|Token|apic[-_]?cookie|password|pwd|pass|username|userName|user[-_]?name)"?\s*[:=]\s*")([^"]{3,})(")/gi,
    (m, a, _v, c) => a + '«redacted»' + c);
  for (const v of credentialValues()) {
    if (v) s = s.split(v).join('«redacted»');
  }
  return s;
}

// ── Small helpers ─────────────────────────────────────────────────────────────
function durationHuman(openedAt, closedAt) {
  if (!openedAt || !closedAt) return 'unknown';
  const ms = new Date(closedAt).getTime() - new Date(openedAt).getTime();
  if (!isFinite(ms) || ms < 0) return 'unknown';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} second${s === 1 ? '' : 's'}`;
  const m = Math.floor(s / 60), rem = s % 60;
  return `${m} minute${m === 1 ? '' : 's'}${rem ? ` ${rem}s` : ''}`;
}

// MTTR (issue 11): opened → verdict is the resolution time; fall back to close if
// the bridge ended with no verdict. Derived purely from the record's real
// timestamps — never fabricated.
function mttrFrom(openedAt, verdictAt, closedAt) {
  const openedMs = openedAt ? Date.parse(openedAt) : NaN;
  const stop = verdictAt || closedAt;
  const stopMs = stop ? Date.parse(stop) : NaN;
  const mttrMs = (Number.isFinite(openedMs) && Number.isFinite(stopMs) && stopMs >= openedMs) ? stopMs - openedMs : null;
  return {
    openedAt: openedAt || null,
    verdictAt: verdictAt || null,
    closedAt: closedAt || null,
    mttrMs,
    mttrHuman: mttrMs != null ? durationHuman(openedAt, stop) : 'unknown',
  };
}

const STATE_WORDS = {
  clean: 'read clean (no live fault found)',
  degraded: 'degraded — a live fault was found',
  suspect: 'could not be read (source down / denied)',
  blind: 'blind spot — no source is wired up',
  waiting: 'never returned a read',
};
function stateWord(state) { return STATE_WORDS[state] || String(state || 'unknown'); }

// Plain-words front labels for the leadership doc.
const FRONT_LABEL = {
  campus: 'Campus network (office/site switches)',
  fabric: 'Data-centre fabric',
  wan: 'Wide-area / internet edge',
  incidents: 'Open incidents & faults',
  firewall: 'Firewall',
  loadbalancer: 'Load balancer',
  security: 'Security / CVE exposure',
};
function frontLabel(f) { return FRONT_LABEL[f] || f; }

// ── Lifecycle roll-up + SLA lines (wave 1) — shared by every doc ──────────────
// Renders the post-incident roll-up: the four real timestamps, the three human
// elapsed strings (MTTA = acknowledge time; Time to verdict = open→verdict,
// wording unchanged; Total = open→close), plus the per-severity SLA target and
// whether it was breached. Every value traces to a real timestamp; a stage that
// never happened is labelled honestly, never zeroed. Returns markdown lines.
function slaHuman(sla) {
  if (!sla || sla.targetMs == null) return 'not set';
  const mins = Math.round(sla.targetMs / 60000);
  return `${mins} minute${mins === 1 ? '' : 's'} (time to verdict)`;
}
function lifecycleLines(rec) {
  const L = [];
  const lc = rec.lifecycle || null;
  const tz = rec.operatorTz || null;
  L.push('## Incident lifecycle (acknowledge → verdict → close)');
  if (lc) {
    L.push(`- **Opened:** ${lc.openedAt ? tsDoc(lc.openedAt, tz) : '(unknown)'}`);
    L.push(`- **Acknowledged (MTTA — time to acknowledge):** ${lc.mttaHuman}${lc.ackAt ? ` (at ${tsDoc(lc.ackAt, tz)})` : ''}`);
    L.push(`- **Time to verdict (open→verdict):** ${lc.timeToVerdictHuman}${lc.verdictAt ? ` (at ${tsDoc(lc.verdictAt, tz)})` : ''}`);
    L.push(`- **Total (open→close):** ${lc.totalHuman}${lc.closedAt ? ` (closed ${tsDoc(lc.closedAt, tz)})` : ''}`);
  } else {
    // Older record with no roll-up — fall back to the timestamps we do have.
    L.push(`- **Opened:** ${rec.openedAt ? tsDoc(rec.openedAt, tz) : '(unknown)'}`);
    L.push(`- **Acknowledged (MTTA):** ${rec.ackAt ? `at ${tsDoc(rec.ackAt, tz)}` : 'not acknowledged'}`);
    L.push(`- **Time to verdict (open→verdict):** ${rec.mttr ? rec.mttr.mttrHuman : 'unknown'}`);
    L.push(`- **Total (open→close):** ${rec.durationHuman || 'unknown'}`);
  }
  if (rec.sla) {
    const breach = rec.sla.breached === true ? '⚠️ BREACHED'
      : rec.sla.breached === false ? 'within SLA'
      : 'not determined';
    L.push(`- **SLA target:** ${slaHuman(rec.sla)} — **${breach}**${rec.sla.breachAt ? ` (deadline ${tsDoc(rec.sla.breachAt, tz)})` : ''}`);
  }
  return L;
}
// Bridge roles line for a doc — omitted entirely when the operator set none.
function rolesLines(rec) {
  const r = rec.roles || {};
  const set = [];
  if (r.commander) set.push(`Incident commander: ${r.commander}`);
  if (r.scribe) set.push(`Scribe: ${r.scribe}`);
  if (r.owner) set.push(`Current owner: ${r.owner}`);
  if (Array.isArray(r.joiners) && r.joiners.length) set.push(`Joined the bridge: ${r.joiners.join(', ')}`);
  if (!set.length) return [];
  const L = ['## Bridge roles'];
  set.forEach((s) => L.push(`- ${s}`));
  return L;
}

// ── Build the complete record from the REAL triage + session data ─────────────
function buildRecord(triage) {
  const t = triage || {};
  const fronts = t.fronts || [];

  // Final evidence per front, in board order.
  const evidenceFinal = fronts
    .map((f) => t.evidence && t.evidence[f])
    .filter(Boolean)
    .map((e) => ({ front: e.front, state: e.state, detail: e.detail, source: e.source || null, ts: e.ts || null }));

  // Full evidence transition history (each real read, in order). Falls back to
  // the final states if history was not captured.
  const evidenceHistory = (t.evidenceHistory && t.evidenceHistory.length
    ? t.evidenceHistory
    : evidenceFinal
  ).map((e) => ({ front: e.front, state: e.state, detail: e.detail, source: e.source || null, ts: e.ts || null }));

  // The REAL recorded wire session for this triage — the CLI/command log.
  const sess = session.query({ triageId: t.id, limit: 600 });
  const commandLog = sess.map((r) => ({
    ts: r.ts,
    agent: r.agentName || r.agentId || 'system',
    agentId: r.agentId || null,
    front: r.front || null,
    source: r.sourceLabel || r.source || null,
    host: r.host || null,
    login: r.login || null,
    command: r.command || '',
    kind: r.kind || 'read',
    ok: !!r.ok,
    status: r.status != null ? r.status : null,
    error: r.error || null,
    durationMs: r.durationMs != null ? r.durationMs : null,
    raw: r.raw || '',
    interpretation: r.interpretation || '',
  }));

  // Operator posts (bridge context the human added). Marked operator:true.
  const operatorPosts = (t.messages || [])
    .filter((m) => m.operator || m.agent === 'operator')
    .map((m) => ({ ts: m.ts, agentName: m.agentName || 'Operator (You)', text: m.text }));

  // Timeline: every bridge post + every evidence transition + the verdict +
  // open/close, merged and sorted by time. This is the "what actually happened".
  const timeline = [];
  timeline.push({ ts: t.openedAt, kind: 'opened',
    text: `${t.severity} triage opened: "${t.title}"` });
  (t.messages || []).forEach((m) => {
    timeline.push({
      ts: m.ts,
      kind: m.operator ? 'operator' : 'message',
      agent: m.agentName || m.agent || 'agent',
      tier: m.tier || null,
      round: m.round || null,
      text: m.text || '',
    });
  });
  evidenceHistory.forEach((e) => {
    timeline.push({ ts: e.ts, kind: 'evidence', front: e.front, state: e.state,
      text: `${frontLabel(e.front)} → ${e.state}: ${e.detail || ''}`, source: e.source });
  });
  if (t.verdict) {
    timeline.push({ ts: t.verdict.ts, kind: 'verdict', text: t.verdict.verdict });
  }
  if (t.closedAt) timeline.push({ ts: t.closedAt, kind: 'closed', text: 'Bridge concluded — engineers returned to idle.' });
  timeline.sort((a, b) => {
    const ta = a.ts ? new Date(a.ts).getTime() : 0;
    const tb = b.ts ? new Date(b.ts).getTime() : 0;
    return ta - tb;
  });

  const mttr = mttrFrom(t.openedAt, t.verdictAt, t.closedAt);

  const record = {
    id: t.id,
    incidentId: t.incidentId || null,        // issue 11 — stable operator-facing id
    reTriageOf: t.reTriageOf || null,         // set when this run is a re-triage
    // ── Wave 2: alert-driven ingestion — how the triage was opened + the alert ──
    source: t.source || 'operator',           // 'operator' | 'alert'
    alert: t.alert || null,                    // originating alert (secret-scrubbed raw), null on operator path
    severity: t.severity,
    title: t.title,
    description: t.description,
    status: t.status,
    operatorTz: t.operatorTz || null,         // IANA tz for dual-clock doc times
    openedAt: t.openedAt,
    closedAt: t.closedAt || null,
    verdictAt: t.verdictAt || null,
    mttr,                                     // issue 11 — final MTTR (opened→verdict)
    // ── Wave 1: bridge roles, acknowledge/MTTA, SLA clock + lifecycle roll-up ──
    roles: t.roles || { commander: '', scribe: '', joiners: [], owner: '' },
    ackAt: t.ackAt || null,                   // operator acknowledge time (ISO)
    mttaMs: t.mttaMs != null ? t.mttaMs : null, // mean time to acknowledge
    sla: t.sla || null,                       // { targetMs, breachAt, breached }
    lifecycle: t.lifecycle || null,           // open→ack→verdict→close roll-up
    affectedCIs: t.affectedCIs || [],         // real devices/tenants (ServiceNow)
    reTriageDelta: t.reTriageDelta || null,   // real delta vs the prior run, if any
    durationHuman: durationHuman(t.openedAt, t.closedAt),
    staffed: t.staffed || [],
    blindSpots: t.blindSpots || [],
    fronts,
    verdict: t.verdict || null,
    evidenceFinal,
    evidenceHistory,
    operatorPosts,
    commandLog,
    timeline,
    generatedAt: new Date().toISOString(),
    // Honest provenance note baked into the record.
    provenance: 'Every field above is drawn from the live triage record and the real recorded wire session. No value is invented. Failed or blind reads are kept as-is.',
  };

  // ITSM / ServiceNow export (issue 11) — a structured, ServiceNow-ready object +
  // a copy-ready text form, derived ONLY from the real record above. Baked into the
  // record so the GET endpoint and the persisted servicenow.md share one source.
  record.serviceNow = buildServiceNow(record);
  record.serviceNowText = renderServiceNowText(record, record.serviceNow);
  return record;
}

// ── ITSM / ServiceNow export ──────────────────────────────────────────────────
// Map an internal severity (P1/P2/P3) to ServiceNow impact/urgency (1-3). Real
// mapping, no invention: P1 = highest.
function snImpactUrgency(severity) {
  const map = {
    P1: { severity: 'P1', impact: '1 - High', urgency: '1 - High', priority: '1 - Critical' },
    P2: { severity: 'P2', impact: '2 - Medium', urgency: '2 - Medium', priority: '2 - High' },
    P3: { severity: 'P3', impact: '3 - Low', urgency: '3 - Low', priority: '3 - Moderate' },
  };
  return map[severity] || { severity: severity || 'unknown', impact: '3 - Low', urgency: '3 - Low', priority: '3 - Moderate' };
}

// B2 — ServiceNow State, derived from the REAL confidence + blind-spot data (never
// a blind closed→Resolved map). A closed bridge is only "Resolved" when the verdict
// committed a real IN-WINDOW root cause with medium/high confidence and does NOT
// hinge on an unverified blind spot or an unread front. When the committed cause
// rests on a blind spot / is unverified / is low-confidence, it is still open work:
// "On Hold" when we are explicitly blocked on an unread or high-risk-blind lead we
// must go verify, else "In Progress".
function snowState(rec) {
  if (rec.status !== 'closed') return 'In Progress';

  const v = rec.verdict || null;
  const hyp = v && v.hypothesis;
  const confidence = hyp && hyp.confidence ? String(hyp.confidence).toLowerCase() : null;

  // A real, in-scope root cause = at least one front confirmed active IN the
  // incident window. Pre-existing degradations and blind spots do NOT count.
  // Fall back to any degraded front only for older records that predate the
  // activeInWindow field (never available → be conservative).
  const active = v && Array.isArray(v.activeInWindow) ? v.activeInWindow : null;
  const suspect = (v && Array.isArray(v.suspect)) ? v.suspect : [];
  const confirmedCause = active ? active.length > 0 : classifyFronts(rec).degraded.length > 0;

  // Ranked blind spots (with per-symptom risk) live on the verdict; the record's
  // top-level blindSpots is the static roster without risk.
  const rankedBlind = (v && Array.isArray(v.blindSpots) && v.blindSpots) || rec.blindSpots || [];
  const highRiskBlind = rankedBlind.some((b) => String(b.risk || '').toLowerCase() === 'high');
  const committed = !!(v && (hyp ? hyp.hypothesis : v.verdict));

  if (committed && confirmedCause && confidence && confidence !== 'low'
      && !highRiskBlind && suspect.length === 0) {
    return 'Resolved';
  }
  if (highRiskBlind || suspect.length) return 'On Hold';
  return 'In Progress';
}

// The reason a closed bridge is NOT marked Resolved — plain, honest, for ITSM work
// notes. Empty string when the state IS Resolved.
function snowOpenReason(rec, state) {
  if (state === 'Resolved') return '';
  const v = rec.verdict || null;
  const hyp = v && v.hypothesis;
  const confidence = hyp && hyp.confidence ? String(hyp.confidence).toLowerCase() : null;
  const active = v && Array.isArray(v.activeInWindow) ? v.activeInWindow : null;
  const suspect = (v && Array.isArray(v.suspect)) ? v.suspect : [];
  const rankedBlind = (v && Array.isArray(v.blindSpots) && v.blindSpots) || rec.blindSpots || [];
  const highBlind = rankedBlind.filter((b) => String(b.risk || '').toLowerCase() === 'high').map((b) => b.front);

  const reasons = [];
  if (!confidence) reasons.push('no committed confidence on the root cause');
  else if (confidence === 'low') reasons.push('confidence in the committed root cause is LOW');
  if (highBlind.length) reasons.push(`the leading cause rests on an unverified blind spot (${highBlind.join(', ')}) — no source is wired to confirm it`);
  if (suspect.length) reasons.push(`front(s) unread this pass and must be verified: ${suspect.join(', ')}`);
  if (active && active.length === 0) reasons.push('no front was confirmed broken inside the incident window');
  return `NOT RESOLVED — ${reasons.join('; ') || 'root cause not confirmed'}. Verify before closing.`;
}

// The set of fronts the verdict actually implicated — this incident's own scope
// (the fronts the operator's symptom was IN), plus the in-window active fronts
// (cause candidates) and any front left unread this pass (suspect). The incident
// SCOPE is the key signal: a WAN incident is scoped to ["wan"], so the fabric/ACI
// tenants that a full estate sweep also happens to see are out of scope and must
// not land on the WAN ticket. Returns null when the verdict carries no window-aware
// signal at all (legacy record) OR when none of these yield a single front — the
// caller then keeps the full CI list rather than invent (or empty) a scope.
function implicatedFronts(rec) {
  const v = rec.verdict || null;
  if (!v) return null;
  const hasSignal = Array.isArray(v.activeInWindow)
    || (v.window && Array.isArray(v.window.scope));
  if (!hasSignal) return null; // legacy record — no scope/window split to trust
  const s = new Set();
  if (v.window && Array.isArray(v.window.scope)) v.window.scope.forEach((f) => s.add(f));
  (Array.isArray(v.activeInWindow) ? v.activeInWindow : []).forEach((f) => s.add(f));
  (Array.isArray(v.suspect) ? v.suspect : []).forEach((f) => s.add(f));
  if (!s.size) return null; // no basis to scope → don't silently drop real CIs
  return s;
}

// Scope the raw affected-CI list (harvested from every readable front) down to the
// CIs whose front the verdict implicated. Legacy records (no split) pass through
// unchanged. A CI with no `front` is kept (it cannot be proven out of scope).
function scopeAffectedCIs(rec) {
  const all = rec.affectedCIs || [];
  const fronts = implicatedFronts(rec);
  if (!fronts) return all;
  return all.filter((x) => !x.front || fronts.has(x.front));
}

// Build the structured ServiceNow-ready object from the REAL record. Every field
// traces to real triage data; nothing is a placeholder. Secrets never appear here
// (the whole record is scrub()'d on write, and CIs are device/tenant names only).
function buildServiceNow(rec) {
  const iu = snImpactUrgency(rec.severity);
  const c = classifyFronts(rec);

  const findings = [];
  (rec.evidenceFinal || []).forEach((e) => {
    findings.push({ front: e.front, state: e.state, detail: e.detail || '', source: e.source || null });
  });

  // B-scope — the affected CIs on the ticket must be the fronts the VERDICT
  // actually implicated, not every tenant/device seen on any front this pass.
  // collectAffectedCIs() harvests a CI from EVERY front it could read (campus,
  // fabric/ACI tenants, wan, incidents), so a WAN incident whose verdict never
  // implicated the fabric would still carry ACI tenants (True_Test/PROD) as
  // "affected" — wrong scope. Restrict to the fronts the engine tied to this
  // incident: the in-window active fronts (the cause candidates) plus any front
  // left unread this pass (suspect — genuinely still in scope, must be verified).
  // Pre-existing and clean fronts are explicitly OUT of scope for the CI list.
  // Legacy records with no window-aware split (no activeInWindow field) keep the
  // full list rather than dropping real data.
  const affectedCIs = scopeAffectedCIs(rec).map((x) => ({ ci: x.ci, class: x.type, front: x.front }));

  const nextSteps = (rec.verdict && rec.verdict.nextChecks) || [];
  const hypothesis = rec.verdict && rec.verdict.hypothesis
    ? {
        mostLikely: rec.verdict.hypothesis.hypothesis || null,
        ranked: rec.verdict.hypothesis.ranked || [],
        nextCheck: rec.verdict.hypothesis.ifThen || null,
        confidence: rec.verdict.hypothesis.confidence || null,
        why: rec.verdict.hypothesis.why || null,
      }
    : null;

  const shortDescription =
    `${rec.severity} ${rec.incidentId ? rec.incidentId + ' — ' : ''}${rec.title}`;

  // B2 — honest State + work notes. When not Resolved, lead the work notes with
  // WHY it is still open plus the ranked next-checks so ITSM sees the open work.
  const state = snowState(rec);
  const openReason = snowOpenReason(rec, state);
  const workNotes = openReason
    ? `${openReason}\nNext checks: ${(nextSteps || []).length ? nextSteps.join(' | ') : 'see verdict/hypothesis'}\n\n${rec.provenance}`
    : rec.provenance;

  return {
    incidentId: rec.incidentId || null,
    internalId: rec.id,
    reTriageOf: rec.reTriageOf || null,
    shortDescription,
    severity: iu.severity,
    impact: iu.impact,
    urgency: iu.urgency,
    priority: iu.priority,
    category: 'Network',
    state,
    openedAt: rec.openedAt || null,
    closedAt: rec.closedAt || null,
    mttr: rec.mttr ? { mttrMs: rec.mttr.mttrMs, mttrHuman: rec.mttr.mttrHuman, verdictAt: rec.mttr.verdictAt } : null,
    affectedCIs,
    affectedFronts: {
      degraded: c.degraded.map((e) => e.front),
      unread: c.suspect.map((e) => e.front),
      clean: c.clean.map((e) => e.front),
      blindSpots: (rec.blindSpots || []).map((b) => b.front),
    },
    findings,
    verdict: (rec.verdict && rec.verdict.verdict) || null,
    hypothesis,
    nextSteps,
    workNotes,
  };
}

// A copy-ready text/markdown form of the ServiceNow export — the operator pastes
// this straight into the ticket. Same real data, human-readable.
function renderServiceNowText(rec, sn) {
  const L = [];
  L.push(`# ServiceNow incident — ${sn.incidentId || rec.id}`);
  L.push('');
  L.push(`- **Short description:** ${sn.shortDescription}`);
  L.push(`- **Category:** ${sn.category}`);
  L.push(`- **Severity:** ${sn.severity}   **Impact:** ${sn.impact}   **Urgency:** ${sn.urgency}   **Priority:** ${sn.priority}`);
  L.push(`- **State:** ${sn.state}`);
  L.push(`- **Opened:** ${sn.openedAt ? tsDoc(sn.openedAt, rec.operatorTz) : '(unknown)'}`);
  L.push(`- **Closed:** ${sn.closedAt ? tsDoc(sn.closedAt, rec.operatorTz) : '(still open)'}`);
  // Human label is "Time to verdict (open→verdict)" — what we actually measure is
  // opened→verdict (time to diagnose), NOT full MTTR (which would include fix+
  // verify). Relabelled to avoid an argument on a live bridge call. The JSON
  // field name (sn.mttr / mttrHuman) is kept stable so the UI/record don't break.
  L.push(`- **Time to verdict (open→verdict):** ${sn.mttr ? sn.mttr.mttrHuman : 'unknown'}${sn.mttr && sn.mttr.verdictAt ? ` (verdict at ${tsDoc(sn.mttr.verdictAt, rec.operatorTz)})` : ''}`);
  if (sn.reTriageOf) L.push(`- **Re-triage of:** ${sn.reTriageOf}`);
  L.push('');
  // Bridge roles + lifecycle roll-up (wave 1) — real timestamps + SLA breach.
  const snRoles = rolesLines(rec);
  if (snRoles.length) { snRoles.forEach((x) => L.push(x)); L.push(''); }
  lifecycleLines(rec).forEach((x) => L.push(x));
  L.push('');
  L.push('## Affected CIs');
  if (sn.affectedCIs.length) sn.affectedCIs.forEach((c) => L.push(`- ${c.ci} (${c.class}, ${c.front})`));
  else L.push('- None nameable from the connected estate this run (see findings).');
  L.push('');
  L.push('## Findings');
  sn.findings.forEach((f) => L.push(`- **${f.front}** [${f.state}]: ${f.detail}${f.source ? ` — ${f.source}` : ''}`));
  L.push('');
  L.push('## Verdict / hypothesis');
  if (sn.hypothesis) {
    L.push(`- **Most likely:** ${sn.hypothesis.mostLikely || '(none)'}`);
    if ((sn.hypothesis.ranked || []).length) L.push(`- **Ranked:** ${sn.hypothesis.ranked.map((r) => `${r.cause} (${r.likelihood})`).join(' · ')}`);
    if (sn.hypothesis.nextCheck) L.push(`- **Next check:** ${sn.hypothesis.nextCheck}`);
    L.push(`- **Confidence:** ${sn.hypothesis.confidence || 'n/a'}${sn.hypothesis.why ? ` — ${sn.hypothesis.why}` : ''}`);
  } else {
    L.push(`- ${sn.verdict || 'No formal verdict was recorded.'}`);
  }
  L.push('');
  L.push('## Next steps');
  if (sn.nextSteps.length) sn.nextSteps.forEach((s) => L.push(`- ${s}`));
  else L.push('- No next-steps recorded.');
  L.push('');
  // B2 — when the state is not Resolved, spell out WHY in the work notes so ITSM
  // never reads a P1 as done while the root cause is unconfirmed.
  if (sn.state !== 'Resolved') {
    L.push('## Work notes');
    L.push(sn.workNotes);
    L.push('');
  }
  L.push('---');
  L.push('*Generated from the real triage record. Every field traces to a live reading; credential values are redacted.*');
  return L.join('\n');
}

// ── Derived views used by both docs ───────────────────────────────────────────
function classifyFronts(rec) {
  const ev = rec.evidenceFinal || [];
  return {
    degraded: ev.filter((e) => e.state === 'degraded'),
    suspect: ev.filter((e) => e.state === 'suspect'),
    clean: ev.filter((e) => e.state === 'clean'),
    blind: ev.filter((e) => e.state === 'blind'),
    other: ev.filter((e) => !['degraded', 'suspect', 'clean', 'blind'].includes(e.state)),
  };
}

// Confidence, in one plain executive sentence — no jargon.
function confidenceLine(confidence) {
  const c = String(confidence || '').toLowerCase();
  if (c === 'high') return 'We are confident in this finding.';
  if (c === 'medium') return 'We have moderate confidence in this finding — worth confirming, but it is our leading answer.';
  if (c === 'low') return 'Confidence is low — this is our best current read, not a confirmed cause. Treat it as unconfirmed until the checks below are done.';
  return 'No confidence level was recorded for this finding — treat it as unconfirmed.';
}

// ── SLT / leadership document (plain words, no jargon) ────────────────────────
// LAW (Class 10): this doc is generated FROM the committed verdict object — the
// SAME hypothesis / confidence / next-steps / blind-spots the engineer doc and the
// UI verdict card use — NOT a separate alarm scrape. The leadership headline must
// agree with the engine's own conclusion. A chronic/pre-existing alarm the engine
// ruled OUT as the cause is never headlined as "what broke".
function renderSltDoc(rec) {
  const c = classifyFronts(rec);
  const v = rec.verdict || null;
  const hyp = v && v.hypothesis ? v.hypothesis : null;   // committed hypothesis
  const tz = rec.operatorTz || null;
  const L = [];
  L.push(`# Incident summary — ${rec.severity} — for leadership`);
  L.push('');
  L.push(`*Plain-words summary. Auto-written from the engine's committed conclusion on ${tsDoc(rec.generatedAt, tz)}.*`);
  L.push('');
  L.push(`**What was reported:** ${rec.description || rec.title}`);
  L.push('');

  // ── What we found — the engine's OWN conclusion, led by the committed
  // hypothesis so this doc can never contradict the verdict card or the engineer
  // writeup. Falls back to the plain verdict sentence, then to an honest "no
  // ruling" — never to an alarm headline.
  L.push('## What we found');
  if (hyp && hyp.hypothesis) {
    L.push(`**Most likely cause:** ${hyp.hypothesis}`);
    L.push('');
    L.push(confidenceLine(hyp.confidence));
    if (hyp.why) L.push(`Why we think so: ${hyp.why}`);
    if (Array.isArray(hyp.ranked) && hyp.ranked.length > 1) {
      L.push('');
      L.push('Other possibilities we weighed, in order:');
      hyp.ranked.forEach((r) => L.push(`- ${r.cause} (${r.likelihood})`));
    }
  } else if (v && v.verdict) {
    L.push(v.verdict);
  } else {
    L.push('The bridge closed without a formal ruling. Based on the real readings, treat any area we could not see as unconfirmed — no root cause is being claimed.');
  }
  L.push('');

  // ── What broke vs. what was already broken — kept ONLY as context under the
  // conclusion, framed to AGREE with it. Anything pre-existing/chronic is named
  // as "already broken before this incident, not the cause" so it can never be
  // mistaken for the headline. Driven off the verdict's real in-window split.
  const activeFronts = v && Array.isArray(v.activeInWindow) ? v.activeInWindow : null;
  const preExistingFronts = v && Array.isArray(v.preExisting) ? v.preExisting : null;
  const evByFront = {};
  (rec.evidenceFinal || []).forEach((e) => { evByFront[e.front] = e; });
  const detailOf = (f) => (evByFront[f] ? evByFront[f].detail : '');
  L.push('## What broke');
  if (activeFronts) {
    if (activeFronts.length) {
      L.push(`A live problem that started during this incident was found on ${activeFronts.length} area(s):`);
      activeFronts.forEach((f) => L.push(`- **${frontLabel(f)}** — ${detailOf(f)}`));
      if ((preExistingFronts || []).length) {
        L.push('');
        L.push(`For context, ${preExistingFronts.map(frontLabel).join(', ')} already had faults before this incident began — pre-existing, and not what broke here.`);
      }
    } else if ((preExistingFronts || []).length) {
      L.push(`Nothing new broke during this incident. ${preExistingFronts.map(frontLabel).join(', ')} already had faults before it began (pre-existing) — they are not the cause.`);
    } else if (c.suspect.length && !c.clean.length) {
      L.push('We could not get a clear reading — the systems we needed to check did not respond (see "What we could not see"). We are not calling this either broken or fine.');
    } else {
      L.push('No live fault was found on any system we can see. Every connected area we checked came back healthy — the most likely cause above sits in an area we cannot directly read.');
    }
  } else if (c.degraded.length) {
    // Legacy fallback (record predates the in-window split).
    L.push(`We found a live problem on ${c.degraded.length} area(s):`);
    c.degraded.forEach((e) => L.push(`- **${frontLabel(e.front)}** — ${e.detail}`));
  } else if (c.suspect.length && !c.clean.length) {
    L.push('We could not get a clear reading — the systems we needed to check did not respond (see "What we could not see"). We are not calling this either broken or fine.');
  } else {
    L.push('No live fault was found on any system we can see. Every connected area we checked came back healthy.');
  }
  L.push('');

  // Who/what it hit
  L.push('## Who or what it affected');
  if (v && v.impact) {
    L.push(v.impact);
  } else if (c.degraded.length) {
    L.push(`The affected areas were: ${c.degraded.map((e) => frontLabel(e.front)).join(', ')}. The other checked areas were healthy.`);
  } else {
    L.push('No customer- or user-facing impact was confirmed on the systems we can see.');
  }
  L.push('');

  // ── Recommended next steps — straight from the committed verdict's next-checks
  // (and the one disambiguating if/then), so leadership sees the same actions the
  // engineers are told to take. Never invented here.
  L.push('## Recommended next steps');
  const nextChecks = (v && Array.isArray(v.nextChecks)) ? v.nextChecks : [];
  if (nextChecks.length) {
    nextChecks.forEach((s) => L.push(`- ${s}`));
  }
  if (hyp && hyp.ifThen) L.push(`- Fastest way to confirm: ${hyp.ifThen}`);
  if (!nextChecks.length && !(hyp && hyp.ifThen)) {
    L.push('- No specific next steps were recorded. Confirm the most likely cause above before closing.');
  }
  L.push('');

  // How long
  L.push('## How long it took');
  L.push(`The bridge was open for **${rec.durationHuman}** (opened ${tsDoc(rec.openedAt, tz)}${rec.closedAt ? `, closed ${tsDoc(rec.closedAt, tz)}` : ', still open'}).`);
  L.push('');

  // Bridge roles + lifecycle roll-up (wave 1).
  const sltRoles = rolesLines(rec);
  if (sltRoles.length) { sltRoles.forEach((x) => L.push(x)); L.push(''); }
  lifecycleLines(rec).forEach((x) => L.push(x));
  L.push('');

  // What was done
  L.push('## What the team did');
  L.push(`A tiered squad worked the incident and made **${(rec.commandLog || []).length} live check(s)** against the network — no guesses, only real readings.`);
  const staffedNames = (rec.staffed || []).map((s) => s.agent).join(', ');
  if (staffedNames) L.push(`Engineers on the bridge: ${staffedNames}.`);
  if ((rec.operatorPosts || []).length) {
    L.push('');
    L.push('The on-call operator added context during the bridge:');
    rec.operatorPosts.forEach((p) => L.push(`- "${p.text}"`));
  }
  L.push('');

  // What we could not see (honesty) — including the ranked blind spots the verdict
  // flagged, so the "most likely cause" that sits in a blind spot is traceable.
  const rankedBlind = (v && Array.isArray(v.blindSpots) && v.blindSpots) || rec.blindSpots || [];
  if (c.suspect.length || c.blind.length || rankedBlind.length) {
    L.push('## What we could not see');
    c.suspect.forEach((e) => L.push(`- **${frontLabel(e.front)}** — we tried to check this but the read did not succeed: ${e.detail}`));
    c.blind.forEach((e) => L.push(`- **${frontLabel(e.front)}** — no system is connected for this, so it was outside what this bridge could check: ${e.detail}`));
    rankedBlind.forEach((b) => {
      if (c.suspect.some((e) => e.front === b.front) || c.blind.some((e) => e.front === b.front)) return;
      L.push(`- **${frontLabel(b.front)}**${b.risk ? ` (${b.risk} risk)` : ''} — no system is connected for this: ${b.reason || b.why || 'outside what this bridge could check'}`);
    });
    L.push('');
  }

  // Current status
  L.push('## Where it stands now');
  if (v && v.verdict) {
    L.push(v.verdict);
  } else {
    L.push('The bridge closed without a formal ruling. Based on the real readings above, this is the current picture; treat any area we could not see as unconfirmed.');
  }
  L.push('');
  L.push('---');
  L.push("*This summary is generated automatically from the engine's committed conclusion — the same hypothesis, confidence and next steps the engineers see. Every statement traces back to a real live reading; nothing here is estimated or invented.*");
  return L.join('\n');
}

// ── Engineer / technical document ─────────────────────────────────────────────
function renderEngineerDoc(rec) {
  const c = classifyFronts(rec);
  const tz = rec.operatorTz || null;
  const L = [];
  L.push(`# ${rec.severity} triage — engineer writeup — ${rec.id}`);
  L.push('');
  L.push(`*Auto-written from the real triage record + recorded wire session on ${tsDoc(rec.generatedAt, tz)}. Nothing below is fabricated.*`);
  L.push('');
  if (rec.incidentId) L.push(`- **Incident ID:** ${rec.incidentId}${rec.reTriageOf ? ` (re-triage of ${rec.reTriageOf})` : ''}`);
  L.push(`- **Title:** ${rec.title}`);
  L.push(`- **Reported:** ${rec.description || '(none)'}`);
  L.push(`- **Opened:** ${tsDoc(rec.openedAt, tz)}`);
  L.push(`- **Closed:** ${rec.closedAt ? tsDoc(rec.closedAt, tz) : '(still open)'}`);
  L.push(`- **Duration:** ${rec.durationHuman}`);
  // "Time to verdict" — opened→verdict is time-to-diagnose, not full MTTR. Human
  // label relabelled; the rec.mttr JSON field name stays stable for the UI/record.
  if (rec.mttr) L.push(`- **Time to verdict (open→verdict):** ${rec.mttr.mttrHuman}`);
  L.push(`- **Staffed:** ${(rec.staffed || []).map((s) => `${s.agent} (${s.tier})`).join(', ') || '(none)'}`);
  L.push('');

  // Bridge roles + lifecycle roll-up (wave 1).
  const engRoles = rolesLines(rec);
  if (engRoles.length) { engRoles.forEach((x) => L.push(x)); L.push(''); }
  lifecycleLines(rec).forEach((x) => L.push(x));
  L.push('');

  // Findings per front
  L.push('## Findings per front');
  (rec.evidenceFinal || []).forEach((e) => {
    L.push(`### ${e.front} — ${e.state}`);
    L.push(`- State: **${e.state}** (${stateWord(e.state)})`);
    L.push(`- Detail: ${e.detail || '(none)'}`);
    if (e.source) L.push(`- Source: ${e.source}`);
    L.push('');
  });

  // Evidence transition history
  L.push('## Evidence-board transition history');
  L.push('Each row is a real read, in order:');
  L.push('');
  L.push('| time | front | state | detail | source |');
  L.push('| --- | --- | --- | --- | --- |');
  (rec.evidenceHistory || []).forEach((e) => {
    const cell = (x) => String(x == null ? '' : x).replace(/\|/g, '\\|').replace(/\n/g, ' ');
    L.push(`| ${cell(e.ts ? tsDoc(e.ts, tz) : '')} | ${cell(e.front)} | ${cell(e.state)} | ${cell(e.detail)} | ${cell(e.source)} |`);
  });
  L.push('');

  // Command log — real commands + raw output
  L.push('## CLI / command log (real commands + raw output)');
  if (!(rec.commandLog || []).length) {
    L.push('No wire calls were recorded for this triage.');
  } else {
    rec.commandLog.forEach((r, i) => {
      L.push(`### ${i + 1}. ${r.command}`);
      L.push(`- Agent: ${r.agent}${r.front ? ` · front ${r.front}` : ''}`);
      L.push(`- Source: ${r.source || '(unknown)'}${r.host ? ` (${r.host})` : ''}`);
      L.push(`- Result: ${r.ok ? 'OK' : 'FAILED'}${r.status != null ? ` · HTTP ${r.status}` : ''}${r.error ? ` · ${r.error}` : ''}${r.durationMs != null ? ` · ${r.durationMs}ms` : ''}`);
      L.push('');
      L.push('```');
      L.push(String(r.raw || '(no body)'));
      L.push('```');
      L.push(`**Read:** ${r.interpretation || '(no interpretation)'}`);
      L.push('');
    });
  }

  // Root-cause reasoning
  L.push('## Root-cause reasoning');
  if (rec.verdict && rec.verdict.verdict) {
    L.push(rec.verdict.verdict);
    if (c.degraded.length) {
      L.push('');
      L.push('Correlation from the live evidence:');
      c.degraded.forEach((e) => L.push(`- ${e.front}: ${e.detail} [${e.source || 'source'}]`));
    }
    if (c.suspect.length) {
      L.push('');
      L.push(`Unread this pass (treat as blind, not clean): ${c.suspect.map((e) => `${e.front} (${e.detail})`).join('; ')}.`);
    }
  } else {
    L.push('No L4 verdict was recorded (the bridge closed early, or the LLM verdict layer is not yet active). Summarising from the real evidence only:');
    if (c.degraded.length) L.push(`- Live fault(s) on: ${c.degraded.map((e) => e.front).join(', ')}.`);
    if (c.suspect.length) L.push(`- Could not read: ${c.suspect.map((e) => e.front).join(', ')} — impact there is unknown, not clear.`);
    if (c.clean.length) L.push(`- Read clean: ${c.clean.map((e) => e.front).join(', ')}.`);
    L.push('- No root cause is asserted beyond what the readings above show.');
  }
  L.push('');

  // Follow-up actions
  L.push('## Follow-up actions');
  const checks = (rec.verdict && rec.verdict.nextChecks) || [];
  if (checks.length) checks.forEach((c2) => L.push(`- ${c2}`));
  else L.push('- No next-checks were recorded for this triage.');
  L.push('');

  // Blind spots
  if ((rec.blindSpots || []).length) {
    L.push('## Blind spots (no source wired up)');
    rec.blindSpots.forEach((b) => L.push(`- **${b.front}** — ${b.reason}`));
    L.push('');
  }

  L.push('---');
  L.push('*Generated from the incident record. Every command, raw block and error above is the real recorded wire session. Credential values are redacted; hostnames are not.*');
  return L.join('\n');
}

// ── Persist everything for one closed triage ──────────────────────────────────
// Called once, when the bridge concludes. Writes record.json + slt.md + engineer.md
// under squad/triages/<id>/, all scrubbed, all through safeWrite (path-safe, never
// fatal). Returns { id, dir, files } or null.
function writeForTriage(triage) {
  if (!triage || !triage.id) return null;
  try {
    const record = buildRecord(triage);
    const dir = safeJoin(triagesRoot(), String(triage.id));
    if (!dir) return null; // id could not be proven inside the triages folder

    const files = [];
    const recPath = safeJoin(dir, 'record.json');
    const sltPath = safeJoin(dir, 'slt.md');
    const engPath = safeJoin(dir, 'engineer.md');
    const snPath = safeJoin(dir, 'servicenow.md');
    if (recPath && safeWrite(recPath, scrub(JSON.stringify(record, null, 2)), `triage record ${triage.id}`)) files.push('record.json');
    if (sltPath && safeWrite(sltPath, scrub(renderSltDoc(record)), `triage SLT doc ${triage.id}`)) files.push('slt.md');
    if (engPath && safeWrite(engPath, scrub(renderEngineerDoc(record)), `triage engineer doc ${triage.id}`)) files.push('engineer.md');
    if (snPath && safeWrite(snPath, scrub(record.serviceNowText || ''), `triage ServiceNow doc ${triage.id}`)) files.push('servicenow.md');

    return { id: triage.id, dir, files };
  } catch (e) {
    console.error(`[Artifacts] write failed for ${triage.id}: ${e && e.message}`);
    return null;
  }
}

// ── Read side (browsable history) — every path through safeJoin ───────────────
function recordPath(id) { return safeJoin(triagesRoot(), path.join(String(id), 'record.json')); }
// Doc-key → filename. The leadership doc is STORED as slt.md, but "leadership" is
// the intuitive key an operator (or a link) reaches for — accept it as an alias so
// GET …/doc/leadership resolves to the same file instead of 404-ing. 'slt' stays
// valid for the existing UI tab. NOTE: the serving route allow-list lives in
// server.js (owned by another agent this wave); it currently permits slt/engineer/
// servicenow only, so a raw /doc/leadership URL is refused at the route BEFORE it
// reaches here. This alias makes artifacts.getDoc() itself leadership-aware so that,
// once server.js adds 'leadership' to its allow-list (or any internal caller uses
// it), the key resolves correctly. See report for the exact mapping to add.
function docFileFor(which) {
  return (which === 'slt' || which === 'leadership') ? 'slt.md'
    : which === 'engineer' ? 'engineer.md'
    : which === 'servicenow' ? 'servicenow.md' : null;
}
function docPath(id, which) {
  const file = docFileFor(which);
  if (!file) return null;
  return safeJoin(triagesRoot(), path.join(String(id), file));
}

// List the persisted triage records, newest first. Summary only.
function listRecords() {
  const root = triagesRoot();
  let names = [];
  try {
    names = fs.readdirSync(root).filter((n) => {
      try { return fs.statSync(path.join(root, n)).isDirectory(); } catch (e) { return false; }
    });
  } catch (e) { return []; }

  const out = [];
  for (const name of names) {
    const p = safeJoin(root, path.join(name, 'record.json'));
    if (!p || !fs.existsSync(p)) continue;
    try {
      const rec = JSON.parse(fs.readFileSync(p, 'utf8'));
      out.push({
        id: rec.id,
        incidentId: rec.incidentId || null,
        reTriageOf: rec.reTriageOf || null,
        mttr: rec.mttr || null,
        severity: rec.severity,
        title: rec.title,
        status: rec.status,
        openedAt: rec.openedAt,
        closedAt: rec.closedAt || null,
        durationHuman: rec.durationHuman || null,
        commandCount: (rec.commandLog || []).length,
        verdict: rec.verdict ? rec.verdict.verdict : null,
        fronts: (rec.evidenceFinal || []).map((e) => ({ front: e.front, state: e.state })),
      });
    } catch (e) { /* skip an unreadable record rather than fail the whole list */ }
  }
  out.sort((a, b) => (String(a.openedAt) < String(b.openedAt) ? 1 : -1));
  return out;
}

function getRecord(id) {
  const p = recordPath(id);
  if (!p || !fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}

function getDoc(id, which) {
  const p = docPath(id, which);
  if (!p || !fs.existsSync(p)) return null;
  try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; }
}

// The structured ServiceNow-ready export for one triage (issue 11). Returns the
// object baked into the record; for a record written before this field existed it
// rebuilds it from the same real record. Text form travels alongside so a caller
// gets both JSON and copy-ready markdown. Null if there is no such record.
function getServiceNow(id) {
  const rec = getRecord(id);
  if (!rec) return null;
  const object = rec.serviceNow || buildServiceNow(rec);
  const text = rec.serviceNowText || renderServiceNowText(rec, object);
  return { object, text };
}

module.exports = {
  writeForTriage,
  listRecords,
  getRecord,
  getDoc,
  getServiceNow,
  // exported for tests / reuse
  buildRecord,
  renderSltDoc,
  renderEngineerDoc,
  buildServiceNow,
  renderServiceNowText,
  scrub,
  triagesRoot,
};
