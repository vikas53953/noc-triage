// correlation.js — Wave 4: deterministic cross-domain correlation (roadmap item 4).
//
// The question this answers: when a WAN alarm, a fabric fault and a config change
// all land within a few minutes of the SAME moment, is that ONE event across three
// fronts, or three separate problems? The answer here is computed from REAL
// timestamps carried on the live read results (ACI fault `created`, vManage alarm
// `entry_time`, Catalyst issue `last_occurence_time`, config-diff `when`) — never
// from a model, never invented. The LLM may LATER narrate a finding this file made
// (see jarvis.narrateCorrelation); it can never create, delete or move one.
//
// Honesty rules this file obeys:
//  - An event with no parseable timestamp is DROPPED from clustering and COUNTED
//    in the note ("campus carries no per-item timestamps") — never given a fake time.
//  - A cluster is only ever a candidate root cause when it co-occurs INSIDE the
//    incident window. Chronic noise that happens to bunch up months ago is reported
//    as chronic, never blamed.
//  - When nothing co-occurs, `topCandidate` is null and `note` says so plainly.
//    "No correlation" is a real, valid answer here.
//
// Output contract (pinned with the Wave 4 UI, PR #37):
//   { clusters: [{ tsStart, tsEnd, fronts, events:[{front,type,ts,detail}], strength }],
//     topCandidate: { ts, fronts, summary } | null,
//     note: string }

const session = require('./session-log');

// How close in time two events must be to count as co-occurring. ~10 minutes per
// the spec; overridable for tuning, floored at 1 minute.
const WINDOW_MS = Math.max(60 * 1000, Number(process.env.CORRELATION_WINDOW_MS) || 10 * 60 * 1000);
// How far back we look for events at all when the symptom carries no time anchor.
const DEFAULT_LOOKBACK_MS = 24 * 60 * 60 * 1000;
// Caps so a 250-alarm chronic estate can't produce an unreadable member list.
const MAX_EVENTS_PER_CLUSTER = 12;
const MAX_CLUSTERS = 5;

const scrub = (s) => {
  try { return session.scrub(String(s)); } catch (e) { return String(s); }
};

// Parse an ISO string or epoch-ms number to epoch-ms, or null when it is not a
// real timestamp. Never guesses.
function toMs(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const n = Number(v);
  if (Number.isFinite(n) && String(v).trim() !== '' && /^\d+$/.test(String(v).trim())) return n;
  const p = Date.parse(v);
  return Number.isNaN(p) ? null : p;
}

const iso = (ms) => new Date(ms).toISOString();
const clip = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s);

// ── Step 1: pull every REAL timestamped event off the live read results ───────
// `reads` is triage.reads — the full in-memory read result per front (never
// persisted; it can carry raw fault/alarm bodies). configFindings are the real
// running-config diffs. Returns { events, undated } where `undated` counts what
// we honestly could not place in time.
function collectEvents(reads = {}, configFindings = []) {
  const events = [];
  const undated = [];

  // fabric — ACI faults. `created` is when the problem was first raised.
  const fabric = reads.fabric;
  if (fabric && Array.isArray(fabric.faults)) {
    for (const f of fabric.faults) {
      const ms = toMs(f.created) ?? toMs(f.lastTransition);
      const where = [f.tenant && f.tenant !== 'unknown' ? `tenant ${f.tenant}` : null, f.node ? `node ${f.node}` : null]
        .filter(Boolean).join(', ');
      const detail = clip(`${f.severity || 'fault'} ${f.code || ''} ${f.descr || f.description || ''}`.replace(/\s+/g, ' ').trim()
        + (where ? ` (${where})` : ''), 220);
      if (ms === null) { undated.push('fabric'); continue; }
      events.push({ front: 'fabric', type: `${f.severity || 'fault'} fault`, ms, detail });
    }
  }

  // wan — vManage alarms. entry_time is epoch-ms, when the alarm was first raised.
  const wan = reads.wan;
  if (wan && Array.isArray(wan.alarms)) {
    for (const a of wan.alarms) {
      const ms = toMs(a.entryTime);
      const detail = clip(`${a.severity || 'alarm'} ${a.type || a.rule || 'alarm'}`
        + (a.device ? ` on ${a.device}` : '')
        + (a.site ? ` (site ${a.site})` : '')
        + (a.message ? ` — ${a.message}` : ''), 220);
      if (ms === null) { undated.push('wan'); continue; }
      events.push({ front: 'wan', type: a.type || a.rule || 'alarm', ms, detail });
    }
  }

  // incidents — Catalyst issues (the ACI faults this front also reads are the same
  // objects the fabric front contributes; counting them twice would invent a
  // correlation, so they are deliberately not added again here).
  const inc = reads.incidents;
  if (inc && Array.isArray(inc.issues)) {
    for (const i of inc.issues) {
      const ms = toMs(i.lastOccurred);
      const detail = clip(`${i.priority || ''} ${i.name || 'issue'}`.trim()
        + (i.category ? ` [${i.category}]` : '')
        + (i.deviceId ? ` on ${i.deviceId}` : '')
        + (i.occurrences ? ` ×${i.occurrences}` : ''), 220);
      if (ms === null) { undated.push('incidents'); continue; }
      events.push({ front: 'incidents', type: 'catalyst issue', ms, detail });
    }
  }

  // campus — the reachability read carries no per-item timestamp at all. That is a
  // real blind spot in TIME, and the note says so rather than pretending.
  const campus = reads.campus;
  if (campus && campus.state === 'degraded') undated.push('campus');

  // config — real running-config diffs (config-store). A change is exactly the kind
  // of event that turns a co-occurrence into a root-cause candidate.
  for (const c of (configFindings || [])) {
    if (!c || !c.changed) continue;
    const ms = toMs(c.when);
    const detail = clip(`${c.device || 'device'}: ${c.summary || 'running-config changed'}`, 220);
    if (ms === null) { undated.push('config'); continue; }
    events.push({ front: 'config', type: 'config change', ms, detail });
  }

  events.forEach((e) => { e.ts = iso(e.ms); e.detail = scrub(e.detail); e.type = scrub(e.type); });
  events.sort((a, b) => a.ms - b.ms);
  return { events, undated: [...new Set(undated)] };
}

// ── Step 2: greedy time clustering ───────────────────────────────────────────
// Walk the time-sorted events; an event joins the open cluster while it is within
// WINDOW_MS of the cluster's FIRST event ("all started ~T"), else it opens a new
// cluster. Deterministic: same input, same clusters, every time.
function clusterByTime(events) {
  const out = [];
  let cur = null;
  for (const e of events) {
    if (cur && e.ms - cur.tsStartMs <= WINDOW_MS) { cur.events.push(e); cur.tsEndMs = e.ms; continue; }
    cur = { tsStartMs: e.ms, tsEndMs: e.ms, events: [e] };
    out.push(cur);
  }
  return out;
}

// Collapse repeats so a 40-alarm burst reads as "interface-state-change ×40" and a
// member list stays human-sized. Keeps the FIRST occurrence's real timestamp.
function condense(events) {
  const byKey = new Map();
  for (const e of events) {
    const k = `${e.front}|${e.type}`;
    const g = byKey.get(k);
    if (!g) { byKey.set(k, { ...e, _n: 1 }); continue; }
    g._n += 1;
    if (e.ms < g.ms) { g.ms = e.ms; g.ts = e.ts; g.detail = e.detail; }
  }
  return [...byKey.values()]
    .sort((a, b) => a.ms - b.ms)
    .slice(0, MAX_EVENTS_PER_CLUSTER)
    .map((e) => ({
      front: e.front, type: e.type, ts: e.ts,
      detail: e._n > 1 ? `${e.detail}  (×${e._n} in this window)` : e.detail,
    }));
}

// How strongly a cluster co-occurs: more fronts and a tighter spread = stronger.
// A word, not a score — the UI shows it as a small chip.
function strengthOf(frontCount, spreadMs) {
  const tight = spreadMs <= WINDOW_MS / 2;
  if (frontCount >= 3 && tight) return 'high';
  if (frontCount >= 3 || tight) return 'medium';
  return 'low';
}

const human = (ms) => {
  const m = Math.round(ms / 60000);
  if (m <= 0) return 'the same minute';
  return `${m} minute${m === 1 ? '' : 's'}`;
};

// ── Step 3: the whole pass ───────────────────────────────────────────────────
// triage: the live triage object (reads + configFindings). sym: the parsed symptom
// (timeAnchorMs = the incident window start). Returns the pinned contract object.
// Never throws — a correlation failure must not take the bridge down.
function correlate(triage, sym) {
  try {
    return build(triage, sym);
  } catch (err) {
    return { clusters: [], topCandidate: null,
      note: `Correlation pass could not run (${(err && err.message) || 'error'}) — no correlation is claimed.` };
  }
}

function build(triage, sym) {
  const nowMs = Date.now();
  const anchorMs = sym && Number.isFinite(sym.timeAnchorMs) ? sym.timeAnchorMs : null;
  const windowStart = anchorMs !== null ? anchorMs : nowMs - DEFAULT_LOOKBACK_MS;
  const windowWord = anchorMs !== null ? 'the incident window' : 'the last 24h (no explicit window given)';

  const { events, undated } = collectEvents(triage.reads || {}, triage.configFindings || []);
  const undatedNote = undated.length
    ? ` ${undated.join(', ')} contributed events with no usable timestamp — they were left out rather than given an invented time.`
    : '';

  if (!events.length) {
    return { clusters: [], topCandidate: null,
      note: `No timestamped events came back from the connected fronts, so no time correlation could be computed — nothing is being claimed.${undatedNote}` };
  }

  const raw = clusterByTime(events);
  // Only multi-front clusters are correlations at all — one front bunching up is
  // just that front being busy.
  const multi = raw
    .map((c) => {
      const fronts = [...new Set(c.events.map((e) => e.front))];
      const inWindowEvents = c.events.filter((e) => e.ms >= windowStart);
      const inWindowFronts = [...new Set(inWindowEvents.map((e) => e.front))];
      return {
        ...c, fronts,
        spreadMs: c.tsEndMs - c.tsStartMs,
        inWindow: inWindowFronts.length >= 2,     // ≥2 fronts co-occurring INSIDE the window
        inWindowCount: inWindowEvents.length,
      };
    })
    .filter((c) => c.fronts.length >= 2);

  const shaped = multi
    .slice()
    .sort((a, b) => (b.fronts.length - a.fronts.length)
      || (b.inWindowCount - a.inWindowCount)
      || (a.spreadMs - b.spreadMs)
      || (b.tsStartMs - a.tsStartMs))
    .slice(0, MAX_CLUSTERS)
    .map((c) => ({
      tsStart: iso(c.tsStartMs), tsEnd: iso(c.tsEndMs),
      fronts: c.fronts, events: condense(c.events),
      strength: strengthOf(c.fronts.length, c.spreadMs),
      inWindow: c.inWindow,                       // extra field; the UI ignores it
    }));

  const totalFronts = [...new Set(events.map((e) => e.front))];

  if (!multi.length) {
    return { clusters: [], topCandidate: null,
      note: `No cross-front correlation: ${events.length} timestamped event${events.length === 1 ? '' : 's'} across ` +
        `${totalFronts.length} front${totalFronts.length === 1 ? '' : 's'} (${totalFronts.join(', ')}), but none from different fronts ` +
        `land within ${Math.round(WINDOW_MS / 60000)} minutes of each other. They look independent — no single root cause is claimed.${undatedNote}` };
  }

  // The candidate must co-occur INSIDE the window. Everything else is chronic.
  const candidates = multi.filter((c) => c.inWindow);
  if (!candidates.length) {
    const best = shaped[0];
    return { clusters: shaped, topCandidate: null,
      note: `Events do co-occur (${best.fronts.join(' + ')} within ${human(Date.parse(best.tsEnd) - Date.parse(best.tsStart))} around ` +
        `${best.tsStart}), but that cluster PRE-DATES ${windowWord} — chronic, standing noise, not the trigger for this symptom. ` +
        `No root-cause candidate is claimed.${undatedNote}` };
  }

  const winner = candidates.slice().sort((a, b) => (b.fronts.length - a.fronts.length)
    || (b.inWindowCount - a.inWindowCount)
    || (a.spreadMs - b.spreadMs)
    || (b.tsStartMs - a.tsStartMs))[0];

  // Per-front counts, straight from the real events — this is the sentence's spine.
  const perFront = winner.fronts.map((f) => {
    const n = winner.events.filter((e) => e.front === f).length;
    return `${n} ${f} event${n === 1 ? '' : 's'}`;
  }).join(', ');
  const spreadTxt = winner.spreadMs === 0 ? 'the same moment' : `${human(winner.spreadMs)} of each other`;
  const summary = `${perFront} all started within ${spreadTxt}, at ~${iso(winner.tsStartMs)} — inside ${windowWord}. ` +
    `Ranked as ONE cross-domain event across ${winner.fronts.join(' + ')}, not ${winner.fronts.length} separate problems.`;

  // Make sure the cluster the UI matches to the candidate is the winner (the UI
  // picks by tsStart..tsEnd containment first, and our ts is the cluster start).
  const winnerShaped = shaped.find((c) => c.tsStart === iso(winner.tsStartMs) && c.tsEnd === iso(winner.tsEndMs));
  const clusters = winnerShaped ? [winnerShaped, ...shaped.filter((c) => c !== winnerShaped)] : shaped;

  return {
    clusters,
    topCandidate: { ts: iso(winner.tsStartMs), fronts: winner.fronts, summary, narrated: false },
    note: `Correlated: ${winner.fronts.join(' + ')} co-occur within ${Math.round(WINDOW_MS / 60000)} minutes inside ${windowWord}.`,
  };
}

module.exports = { correlate, collectEvents, clusterByTime, WINDOW_MS };
