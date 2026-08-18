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
// reads the same as every card. tz is the operator's IANA zone (carried on the
// record); when the bridge was opened without one, clock() honestly shows UTC
// only rather than guessing the server's zone.
//
// DATE LAW (class fix): a date is only ever printed in the SAME timezone as the
// time it sits next to. The old code prefixed the UTC date to a line whose first
// clock is LOCAL — so for an operator in Asia/Kolkata any moment between 18:30 and
// 24:00 UTC printed yesterday's date beside today's local time. Now the local half
// carries the local date and, when the two zones are on different calendar days,
// the UTC half carries its own date too:
//   19:00Z, Asia/Kolkata → "2026-08-19 00:30 local · 2026-08-18 19:00 UTC"
//   same-day             → "2026-08-18 10:03 local · 04:33 UTC"  (unchanged)
//   no tz                → "2026-08-18 04:33 UTC"                (unchanged)
function ymdUTC(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
function ymdInTz(ms, tz) {
  try {
    // en-CA formats as YYYY-MM-DD, the same shape as the UTC date above.
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(ms));
  } catch (e) { return null; } // unknown zone → caller falls back to UTC
}
function tsDoc(iso, tz) {
  if (!iso) return '(unknown)';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return String(iso);
  const utcDate = ymdUTC(ms);
  const time = correlation.clock(ms, tz || null);      // shared dual-clock formatter
  const localDate = tz ? ymdInTz(ms, tz) : null;
  // No usable local half (no tz, or clock() fell back to UTC-only) → UTC date + UTC time.
  if (!localDate || !time.includes('local')) return `${utcDate} ${time}`;
  if (localDate === utcDate) return `${localDate} ${time}`;
  // The two zones are on different calendar days — date each half in its OWN zone.
  return `${localDate} ${time.replace('· ', `· ${utcDate} `)}`;
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
// The only strings that are real FRONT keys. The parsed symptom scope can also carry
// SITE names ("DC1") and other nouns; those are not fronts and must never widen or
// pollute a front set (they would silently match nothing, or worse, everything).
const KNOWN_FRONTS = new Set(Object.keys(FRONT_LABEL));
function onlyFronts(list) {
  return (Array.isArray(list) ? list : []).filter((f) => KNOWN_FRONTS.has(f));
}

// ── In-window vs already-there, from the SAME numbers the engine judged on ────
// Every doc statement about "what broke during this incident" must rest on the real
// structured split the readers produced: `age` (fault timestamps vs the incident
// window) or `groups` (alarm clusters, chronic vs new). Returns null when a card
// carries no structured split at all — the caller then says what it knows and never
// guesses. Never derived by reading words out of the detail string.
function windowEvidence(e) {
  if (!e) return null;
  const age = e.age;
  if (age && (Number.isFinite(age.inWindow) || Number.isFinite(age.older))) {
    return { newCount: age.inWindow || 0, oldCount: age.older || 0, unit: 'fault' };
  }
  const g = e.groups;
  if (g && (Number.isFinite(g.newCount) || Number.isFinite(g.chronicCount))) {
    const newCount = g.newCount || 0;
    const total = Number.isFinite(g.total) ? g.total : newCount + (g.chronicCount || 0);
    return { newCount, oldCount: Math.max(0, total - newCount), unit: 'alarm' };
  }
  return null;
}
function plural(n, word) { return `${n} ${word}${n === 1 ? '' : 's'}`; }

// A front's own words for a leadership reader: the real counts, with the jargon
// alarm-type dump ("— top 3: license-not-synced (83, chronic); …") cut off. The raw
// string is kept VERBATIM in the engineer doc and record.json — this trim only
// applies to the plain-words document. Used only where no structured split exists.
function plainDetail(e) {
  const s = String((e && e.detail) || '').replace(/\s*—\s*top \d+:.*$/i, '').trim();
  return s || 'no further detail was recorded';
}

// ── CLASS RULE (leadership doc must not contradict itself) ────────────────────
// "What broke" is derived from the SAME committed verdict object the headline uses,
// and a front may only be called a live problem when its own card shows something
// NEW inside the incident window. A front the verdict listed as active but whose
// real numbers are all chronic/pre-window noise (licence and certificate alarms that
// have been standing for months) is moved into the already-broken-before bucket — it
// is never headlined as what broke here. Three honest buckets:
//   broke   — real NEW faults/alarms inside the incident window (this is the only
//             bucket the doc may call "a live problem that started during this").
//   chronic — faults that all pre-date the window (already broken before).
//   unknown — the card carries no timing split at all (no time anchor on the
//             incident, or a reader with no per-item timestamps): faults are real
//             and current, but we cannot say WHEN they started, and we say so.
// Returns null for a legacy record with no window-aware verdict at all.
function brokeSplit(rec) {
  const v = rec.verdict || null;
  if (!v || !Array.isArray(v.activeInWindow)) return null;
  const evByFront = {};
  (rec.evidenceFinal || []).forEach((e) => { evByFront[e.front] = e; });
  const broke = [];
  const chronic = [];
  const unknown = [];
  v.activeInWindow.forEach((f) => {
    const w = windowEvidence(evByFront[f]);
    if (!w) unknown.push(f);
    else if (w.newCount <= 0) chronic.push(f);
    else broke.push(f);
  });
  (Array.isArray(v.preExisting) ? v.preExisting : []).forEach((f) => {
    if (!broke.includes(f) && !chronic.includes(f) && !unknown.includes(f)) chronic.push(f);
  });
  return { broke, chronic, unknown, evByFront };
}

// One bullet for a front that genuinely broke during the incident — plain words,
// real counts, no alarm-type dump.
function brokeLine(e, front) {
  const label = frontLabel(e ? e.front : front);
  const w = windowEvidence(e);
  // No timing split available — report the finding and say plainly that we cannot
  // tell when it started, rather than implying it started with this incident.
  if (!w) return `- **${label}** — ${plainDetail(e)} (the system we read does not record when these started, so we cannot say whether they began with this incident).`;
  let s = `- **${label}** — ${plural(w.newCount, `new ${w.unit}`)} appeared during this incident`;
  if (w.oldCount) s += `; ${plural(w.oldCount, w.unit)} here were already there before it began`;
  return `${s}.`;
}

// One bullet for a front that was already broken BEFORE the incident.
function chronicLine(e, front) {
  const label = frontLabel(e ? e.front : front);
  const w = windowEvidence(e);
  if (!w) return `- **${label}** — ${plainDetail(e)} (already there before this incident began).`;
  return `- **${label}** — ${plural(w.oldCount, `long-standing ${w.unit}`)} that pre-date this incident; nothing new appeared here during it.`;
}

// One honest, plain-words line about what this bridge actually managed to check.
// Real counts and plain area names only — no verdict jargon, no alarm strings.
function plainStatusLine(rec) {
  const c = classifyFronts(rec);
  const split = brokeSplit(rec);
  const names = (arr) => arr.map((x) => frontLabel(typeof x === 'string' ? x : x.front)).join(', ');
  const checked = c.degraded.length + c.clean.length + c.suspect.length;
  const parts = [`We checked ${plural(checked, 'connected area')}`];
  if (c.clean.length) parts.push(`${c.clean.length} read healthy (${names(c.clean)})`);
  if (split) {
    if (split.broke.length) parts.push(`${split.broke.length} showed something new during the incident (${names(split.broke)})`);
    if (split.unknown.length) parts.push(`${split.unknown.length} showed faults we cannot date (${names(split.unknown)})`);
    if (split.chronic.length) parts.push(`${split.chronic.length} carried faults that were already there beforehand (${names(split.chronic)})`);
  } else if (c.degraded.length) {
    parts.push(`${c.degraded.length} showed faults (${names(c.degraded)})`);
  }
  if (c.suspect.length) parts.push(`${c.suspect.length} could not be read this time (${names(c.suspect)})`);
  if (c.blind.length) parts.push(`${plural(c.blind.length, 'area')} have no monitoring connected at all (${names(c.blind)})`);
  return `${parts.join('; ')}.`;
}

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

  // Final evidence per front, in board order. `age` / `groups` / `count` are the
  // REAL structured split the readers produced (faults inside the incident window vs
  // older; alarm clusters chronic vs new). They are carried onto the record so the
  // docs can say "2 new alarms appeared during this incident" from the same numbers
  // the engine judged on, instead of re-reading words out of the detail string.
  const slim = (e) => ({
    front: e.front, state: e.state, detail: e.detail, source: e.source || null, ts: e.ts || null,
    age: e.age || null, groups: e.groups || null, count: e.count != null ? e.count : null,
  });
  const evidenceFinal = fronts
    .map((f) => t.evidence && t.evidence[f])
    .filter(Boolean)
    .map(slim);

  // Full evidence transition history (each real read, in order). Falls back to
  // the final states if history was not captured.
  const evidenceHistory = (t.evidenceHistory && t.evidenceHistory.length
    ? t.evidenceHistory
    : evidenceFinal
  ).map(slim);

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

// ── CLASS RULE: the ticket's Affected CIs FOLLOW THE COMMITTED VERDICT ────────
// The old rule unioned incident scope + activeInWindow + suspect, which on a real
// WAN incident (scope ["wan"], every front active in a full estate sweep) removed
// nothing — ACI tenants like True_Test still landed on a WAN ticket. The rule now:
//
//   PRIMARY   = fronts the verdict CONFIRMED broken inside the incident window
//               (chronic-only fronts excluded — same split "What broke" uses) AND
//               that sit in this incident's own scope. If the incident's scope names
//               no confirmed front, PRIMARY falls back to the confirmed in-window
//               fronts: they are the cause candidates and are genuinely in scope.
//   SECONDARY = fronts left UNREAD this pass (suspect) — possible but unconfirmed.
//               We KEEP their CIs (they must be verified, not silently dropped) and
//               LABEL them secondary/unverified so nobody actions them as confirmed.
//   OUT       = everything else: clean fronts, pre-existing/chronic-only fronts, and
//               in-window fronts outside this incident's scope.
//
// Only real front keys count — the parsed scope can carry site names ("DC1").
// Returns null only for a legacy record with no window-aware signal at all.
function implicatedFronts(rec) {
  const v = rec.verdict || null;
  if (!v) return null;
  const hasSignal = Array.isArray(v.activeInWindow)
    || (v.window && Array.isArray(v.window.scope));
  if (!hasSignal) return null; // legacy record — no scope/window split to trust

  const split = brokeSplit(rec);
  // "Confirmed" = the verdict's in-window fronts MINUS the ones whose real numbers
  // are pure chronic noise. A front we simply cannot date stays in (it is a genuine
  // live fault; only proven-pre-existing noise is dropped).
  const confirmed = split ? split.broke.concat(split.unknown) : onlyFronts(v.activeInWindow);
  const scope = onlyFronts(v.window && v.window.scope);
  const inScope = confirmed.filter((f) => scope.includes(f));
  const primary = new Set(inScope.length ? inScope : confirmed);
  const secondary = new Set(onlyFronts(v.suspect).filter((f) => !primary.has(f)));
  return { primary, secondary };
}

// Scope the raw affected-CI list (harvested from EVERY readable front) down to the
// CIs the verdict actually implicated, tagging each survivor primary or secondary.
// Legacy records (no window-aware split) pass through unchanged.
//
// When the verdict implicated NOTHING we do NOT fall back to the full harvested list
// — that was the widest possible scope on the weakest possible evidence. Only CIs
// that carry no front at all survive (they cannot be proven out of scope), and the
// ticket says plainly that nothing could be tied to this incident.
function scopeAffectedCIs(rec) {
  const all = rec.affectedCIs || [];
  const f = implicatedFronts(rec);
  if (!f) return all.map((x) => ({ ...x, scopeRank: 'primary', scopeWhy: null }));
  return all
    .filter((x) => !x.front || f.primary.has(x.front) || f.secondary.has(x.front))
    .map((x) => {
      if (!x.front) return { ...x, scopeRank: 'secondary', scopeWhy: 'no front recorded for this item — kept because it cannot be proven out of scope' };
      if (f.primary.has(x.front)) return { ...x, scopeRank: 'primary', scopeWhy: null };
      return { ...x, scopeRank: 'secondary', scopeWhy: 'front was unread this pass — unconfirmed, verify before acting' };
    });
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

  // B-scope — the affected CIs on the ticket follow the COMMITTED VERDICT (see the
  // class rule on implicatedFronts above): confirmed in-window fronts inside this
  // incident's scope are primary; unread fronts ride along clearly marked secondary;
  // everything else is off the ticket. `scope`/`scopeNote` are additive fields — the
  // existing ci/class/front shape the UI reads is unchanged.
  const affectedCIs = scopeAffectedCIs(rec).map((x) => ({
    ci: x.ci, class: x.type, front: x.front,
    scope: x.scopeRank || 'primary', scopeNote: x.scopeWhy || null,
  }));

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
  if (sn.affectedCIs.length) {
    sn.affectedCIs.forEach((c) => L.push(
      `- ${c.ci} (${c.class}, ${c.front})${c.scope === 'secondary' ? ` — SECONDARY / unconfirmed: ${c.scopeNote || 'not confirmed as part of this incident'}` : ''}`));
  } else {
    // Honest minimal list: the verdict tied no front to this incident, so nothing is
    // claimed. The full estate inventory stays in the record — deliberately NOT here.
    L.push('- None could be tied to this incident by the verdict (see findings). The wider estate inventory this sweep saw is in the incident record and is deliberately not on this ticket.');
  }
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
  } else {
    // CLASS RULE (no hypothesis): say so in plain words, then give an honest one-line
    // status of what was actually checked. This NEVER falls back to the raw verdict
    // string — that string is an alarm scrape ("254 active alarms — top 3:
    // license-not-synced (83, chronic)…"), exactly what this document exists to keep
    // out of a leadership summary. The raw verdict stays verbatim in the engineer doc
    // and record.json for the people who read it.
    L.push('**No cause has been committed.** The investigation did not settle on a cause for this incident.');
    L.push('');
    L.push(`${plainStatusLine(rec)} Nothing we could read points conclusively at a single cause, so no root cause is being claimed.`);
  }
  L.push('');

  // ── What broke vs. what was already broken ────────────────────────────────────
  // CLASS RULE: this section is derived from the SAME committed verdict the headline
  // uses, through brokeSplit() — a front the verdict called active but whose real
  // numbers are all chronic/pre-window noise is moved to the already-broken-before
  // bucket, never presented as this incident's live problem. Every line is plain
  // words + real counts; the raw alarm-type dump never appears here.
  const split = brokeSplit(rec);
  L.push('## What broke');
  const unknownBlock = () => {
    if (!split.unknown.length) return;
    L.push('');
    L.push('These areas are showing faults too, but the systems we read do not record when they started, so we cannot say whether they began with this incident:');
    split.unknown.forEach((f) => L.push(brokeLine(split.evByFront[f], f)));
  };
  const chronicBlock = () => {
    if (!split.chronic.length) return;
    L.push('');
    L.push('These areas also carry faults, but they were already broken before this incident began — they are not what broke here:');
    split.chronic.forEach((f) => L.push(chronicLine(split.evByFront[f], f)));
  };
  if (split) {
    if (split.broke.length) {
      L.push(`A live problem that started during this incident was found on ${plural(split.broke.length, 'area')}:`);
      split.broke.forEach((f) => L.push(brokeLine(split.evByFront[f], f)));
      unknownBlock();
      chronicBlock();
    } else if (split.unknown.length) {
      L.push(`Faults are showing on ${plural(split.unknown.length, 'area')}. The systems we read do not record when they started, so we cannot say whether they began with this incident:`);
      split.unknown.forEach((f) => L.push(brokeLine(split.evByFront[f], f)));
      chronicBlock();
    } else if (split.chronic.length) {
      L.push('Nothing new broke during this incident on anything we can see. These areas carry faults, but they were already there before it began — they are not the cause:');
      split.chronic.forEach((f) => L.push(chronicLine(split.evByFront[f], f)));
    } else if (c.suspect.length && !c.clean.length) {
      L.push('We could not get a clear reading — the systems we needed to check did not respond (see "What we could not see"). We are not calling this either broken or fine.');
    } else {
      L.push('No live fault was found on any system we can see. Every connected area we checked came back healthy — the most likely cause above sits in an area we cannot directly read.');
    }
  } else if (c.degraded.length) {
    // Legacy fallback (record predates the in-window split).
    L.push(`We found a live problem on ${plural(c.degraded.length, 'area')}:`);
    c.degraded.forEach((e) => L.push(brokeLine(e)));
  } else if (c.suspect.length && !c.clean.length) {
    L.push('We could not get a clear reading — the systems we needed to check did not respond (see "What we could not see"). We are not calling this either broken or fine.');
  } else {
    L.push('No live fault was found on any system we can see. Every connected area we checked came back healthy.');
  }
  L.push('');

  // Who/what it hit — composed HERE in plain words from the same committed verdict
  // fields (never the engine's raw impact sentence, which names fronts by their
  // internal keys — "fabric, wan, incidents" — and mixes in window jargon). The raw
  // engine sentence is unchanged in record.json and on the verdict card.
  L.push('## Who or what it affected');
  const labelsOf = (arr) => arr.map((x) => frontLabel(typeof x === 'string' ? x : x.front)).join(', ');
  if (split) {
    if (split.broke.length) L.push(`The areas hit by a live problem during this incident: ${labelsOf(split.broke)}.`);
    else if (!split.unknown.length) L.push('No live, in-incident problem was confirmed on any area we can see, so no impact can be attributed from our own readings.');
    if (split.unknown.length) L.push(`Also showing faults, though we cannot tell whether they started with this incident: ${labelsOf(split.unknown)}.`);
    if (c.clean.length) L.push(`Checked and healthy: ${labelsOf(c.clean)}.`);
    if (c.suspect.length) L.push(`Could not be read this time, so impact there is unknown: ${labelsOf(c.suspect)}.`);
  } else if (c.degraded.length) {
    L.push(`The affected areas were: ${labelsOf(c.degraded)}. The other checked areas were healthy.`);
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

  // Current status — plain words, composed here. The engine's raw verdict sentence
  // is jargon (alarm type names, fault counts, front keys) and belongs in the
  // engineer doc, which prints it verbatim; leadership gets the same facts in words.
  L.push('## Where it stands now');
  const closedWord = rec.status === 'closed'
    ? 'The bridge is closed.'
    : 'The bridge is still open.';
  if (hyp && hyp.hypothesis) {
    L.push(`${closedWord} We have a leading cause (above). ${confidenceLine(hyp.confidence)}`);
  } else {
    L.push(`${closedWord} No cause has been committed, so this incident is unresolved as far as our own readings go.`);
  }
  L.push(plainStatusLine(rec));
  const openWork = [];
  if (c.suspect.length) openWork.push(`confirm the areas we could not read (${labelsOf(c.suspect)})`);
  if (c.blind.length) openWork.push(`check the areas with no monitoring connected (${labelsOf(c.blind)}) directly`);
  if (nextChecks.length || (hyp && hyp.ifThen)) openWork.push('work the recommended next steps above');
  if (openWork.length) L.push(`Outstanding: ${openWork.join('; ')}.`);
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
