// incident-read.js — a READ-ONLY window onto THIS console's OWN incidents, for
// Jarvis chat (QA Class 9).
//
// THE DEFECT THIS CLOSES: the chat brain (jarvis.js) and the triage brain
// (triage.js) were siloed. Asked about INC-20260817-013 — an incident THIS app
// minted, sitting in /api/incidents with a full verdict — Jarvis said "I have no
// record… it's not wired into me." This module is the wire: it turns the triage
// engine's live state into (a) a compact grounding summary the chat planner can
// reason over, and (b) the full record of one named incident on demand.
//
// HONESTY LAWS (HANDOFF): everything here is REAL live state read straight from
// triage.js — nothing is fabricated. An incident id that does not exist resolves
// to null, and the caller says so plainly; it never invents an incident.
//
// It reads triage.js ONLY through its already-exported surface (listIncidents,
// getTriage) — triage.js is not modified. resolveTriage() is not exported, so an
// INC-…/trg-… id is resolved here via the listIncidents id map (INC id → the most
// recent run's trg id), matching triage.resolveTriage's "latest run wins" rule.

// LAZY + INJECTABLE ENGINE. triage.js pulls in the whole source layer, and
// live-agents.js now reads this module — resolving triage at require time would
// braid the two load orders together for no benefit. It is resolved on first use
// instead. `_setEngine` exists ONLY so the unit tests can drive this surface from
// a known set of incidents; nothing in the app calls it.
let engineOverride = null;
let engineCache = null;
function triageEngine() {
  if (engineOverride) return engineOverride;
  if (!engineCache) engineCache = require('./triage');
  return engineCache;
}
function _setEngine(mod) { engineOverride = mod || null; }

// Defensive readers: a source that is mid-boot (or a test double missing a
// method) must yield "no incidents", never a crash on the chat path.
function listIncidentsSafe() {
  try {
    const rows = triageEngine().listIncidents();
    return Array.isArray(rows) ? rows : [];
  } catch (e) { return []; }
}
function getTriageSafe(id) {
  try { return triageEngine().getTriage(id) || null; }
  catch (e) { return null; }
}
const triage = { listIncidents: listIncidentsSafe, getTriage: getTriageSafe };

// ── id resolution (INC-… or trg-…), case-insensitive ────────────────────────
// The desk surfaces the INC id prominently; an operator may type either id, in
// any case. Resolve to the internal trg id triage.getTriage expects.
function resolveTriageId(idOrIncident) {
  const key = String(idOrIncident || '').trim().toLowerCase();
  if (!key) return null;
  const rows = triage.listIncidents();
  // Direct trg id.
  const direct = rows.find((r) => String(r.triageId || '').toLowerCase() === key);
  if (direct) return direct.triageId;
  // INC id → the most recently opened run of that incident (matches resolveTriage).
  const matches = rows.filter((r) => String(r.incidentId || '').toLowerCase() === key);
  if (!matches.length) return null;
  matches.sort((a, b) => (String(a.openedAt) < String(b.openedAt) ? 1 : -1));
  return matches[0].triageId;
}

// Pull the one-line verdict headline (the committed hypothesis, else the honest
// rule-based verdict string) out of a full triage record. null when no verdict yet.
function verdictHeadlineOf(full) {
  const v = full && full.verdict;
  if (!v) return null;
  if (v.hypothesis && v.hypothesis.hypothesis) return String(v.hypothesis.hypothesis);
  if (typeof v.verdict === 'string' && v.verdict.trim()) return String(v.verdict).trim();
  return null;
}

function confidenceOf(full) {
  const v = full && full.verdict;
  return v && v.hypothesis && v.hypothesis.confidence ? String(v.hypothesis.confidence) : null;
}

// ── (a) compact grounding summary ───────────────────────────────────────────
// One compact row per incident (urgent-first, as listIncidents already sorts):
// id, severity, status, title, owner, source, verdict headline, confidence, roles.
// This is the live map the chat planner reasons over so it KNOWS what exists.
function summary(limit = 12) {
  const rows = triage.listIncidents();
  const capped = Number.isFinite(limit) && limit > 0 ? rows.slice(0, limit) : rows;
  return capped.map((r) => {
    const full = triage.getTriage(r.triageId);
    const roles = (full && full.roles) || null;
    return {
      incidentId: r.incidentId,
      triageId: r.triageId,
      severity: r.severity,
      status: r.status,
      title: r.title,
      owner: r.owner || (roles && roles.owner) || null,
      source: r.source || 'operator',
      openedAt: r.openedAt,
      slaBreached: r.sla ? r.sla.breached : null,
      verdictHeadline: verdictHeadlineOf(full),
      confidence: confidenceOf(full),
      roles,
    };
  });
}

// ── (b) full record of ONE incident on demand ──────────────────────────────
// The complete, honest picture for a summary / handover / "who's on it" answer:
// severity, status, timeline, roles, and the committed verdict (hypothesis,
// ranked causes, next check, confidence, why, correlation). null when the id is
// unknown — the caller then says "no such incident", never invents one.
function record(idOrIncident) {
  const tid = resolveTriageId(idOrIncident);
  if (!tid) return null;
  const full = triage.getTriage(tid);
  if (!full) return null;
  const v = full.verdict || null;
  const hypo = v && v.hypothesis ? v.hypothesis : null;
  return {
    incidentId: full.incidentId,
    triageId: full.triageId,
    severity: full.severity,
    status: full.status,
    title: full.title,
    description: full.description,
    source: full.source || 'operator',
    openedAt: full.openedAt,
    closedAt: full.closedAt || null,
    mttr: full.mttr || null,
    roles: full.roles || { commander: '', scribe: '', joiners: [], owner: '' },
    ackAt: full.ackAt || null,
    symptom: full.symptom || null,
    verdict: v ? {
      headline: verdictHeadlineOf(full),
      impact: v.impact || null,
      hypothesis: hypo ? hypo.hypothesis : null,
      ranked: hypo && Array.isArray(hypo.ranked) ? hypo.ranked : [],
      ifThen: hypo ? hypo.ifThen : null,
      confidence: hypo ? hypo.confidence : null,
      why: hypo ? hypo.why : null,
      nextChecks: v.nextChecks || null,
    } : null,
    correlation: full.correlation || (v && v.correlation) || null,
  };
}

// ── text renderers (what Jarvis hands its planner / synthesiser) ────────────
function summaryText(limit = 12) {
  const rows = summary(limit);
  if (!rows.length) {
    return 'This console has no incidents on record yet — none have been opened.';
  }
  const lines = rows.map((r) => {
    const bits = [
      r.incidentId || r.triageId,
      r.severity || '?',
      r.status || '?',
    ];
    let line = `- ${bits.join(' | ')} | "${r.title || '(no title)'}"`;
    if (r.owner) line += ` | owner: ${r.owner}`;
    if (r.source && r.source !== 'operator') line += ` | source: ${r.source}`;
    if (r.slaBreached === true) line += ' | SLA: BREACHED';
    if (r.verdictHeadline) {
      line += `\n    verdict: ${r.verdictHeadline}` + (r.confidence ? ` (confidence: ${r.confidence})` : '');
    } else if (r.status !== 'closed') {
      line += '\n    verdict: not committed yet (triage still running)';
    }
    return line;
  });
  return `Incidents on this console (most urgent first):\n${lines.join('\n')}`;
}

// Full record as text, or an HONEST not-found line the synthesiser must relay as-is.
function recordText(idOrIncident) {
  const rec = record(idOrIncident);
  if (!rec) {
    return `NO SUCH INCIDENT: this console has no incident with id "${String(idOrIncident).slice(0, 40)}". ` +
      `Do NOT invent one — tell the operator plainly that there is no record of it.`;
  }
  const L = [];
  L.push(`Incident ${rec.incidentId || rec.triageId} — ${rec.severity} — status: ${rec.status}`);
  L.push(`Title: ${rec.title || '(none)'}`);
  if (rec.description) L.push(`Reported: ${rec.description}`);
  L.push(`Opened: ${rec.openedAt}${rec.closedAt ? ` · Closed: ${rec.closedAt}` : ''}${rec.mttr ? ` · Time to verdict: ${rec.mttr}` : ''}`);
  const roles = rec.roles || {};
  const roleBits = [];
  if (roles.commander) roleBits.push(`commander: ${roles.commander}`);
  if (roles.owner) roleBits.push(`owner: ${roles.owner}`);
  if (roles.scribe) roleBits.push(`scribe: ${roles.scribe}`);
  if (Array.isArray(roles.joiners) && roles.joiners.length) roleBits.push(`joiners: ${roles.joiners.join(', ')}`);
  L.push(`Roles: ${roleBits.length ? roleBits.join(' · ') : 'none assigned yet'}`);
  if (rec.verdict) {
    const v = rec.verdict;
    if (v.hypothesis) L.push(`Committed hypothesis: ${v.hypothesis}`);
    if (v.ranked && v.ranked.length) {
      L.push(`Ranked causes: ${v.ranked.map((r) => `${r.cause} (${r.likelihood})`).join(' · ')}`);
    }
    if (v.ifThen) L.push(`Next check: ${v.ifThen}`);
    if (v.confidence) L.push(`Confidence: ${v.confidence}${v.why ? ` — ${v.why}` : ''}`);
    if (v.impact) L.push(`Impact: ${typeof v.impact === 'string' ? v.impact : JSON.stringify(v.impact)}`);
    if (!v.hypothesis && v.headline) L.push(`Verdict: ${v.headline}`);
  } else {
    L.push('Verdict: not committed yet — this triage has not closed on a hypothesis.');
  }
  if (rec.correlation && rec.correlation.topCandidate && rec.correlation.topCandidate.summary) {
    L.push(`Correlation: ${rec.correlation.topCandidate.summary}`);
  }
  return L.join('\n');
}

// ── id shapes this console mints ───────────────────────────────────────────
// Used to spot an incident id an operator quoted in a sentence. This is IDENTITY
// resolution (like resolving "sw2" to a device), not intent classification: it
// decides WHICH record to look up, never what the operator wanted or what the
// answer is. A quoted id that this console never minted resolves to nothing and
// recordText() says so plainly.
const INCIDENT_ID_TOKEN = /\b(?:INC-\d{8}-\d{3}|trg-[a-z0-9]+(?:-[a-z0-9]+)*)\b/ig;

/**
 * Every incident id quoted in a piece of text, in the order they appear,
 * de-duplicated. Empty array when none is quoted.
 */
function idsMentionedIn(text) {
  const out = [];
  const seen = new Set();
  const s = String(text || '');
  INCIDENT_ID_TOKEN.lastIndex = 0;
  let m;
  while ((m = INCIDENT_ID_TOKEN.exec(s)) !== null) {
    const key = m[0].toLowerCase();
    if (!seen.has(key)) { seen.add(key); out.push(m[0]); }
  }
  return out;
}

/** How many incidents this console holds. 0 is an honest answer, not an error. */
function count() { return listIncidentsSafe().length; }

module.exports = {
  resolveTriageId,
  summary,
  record,
  summaryText,
  recordText,
  idsMentionedIn,
  count,
  _setEngine,
};
