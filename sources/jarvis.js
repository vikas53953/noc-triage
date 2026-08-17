// jarvis.js — the REAL agentic Principal Engineer (Phase E).
//
// Vikas's decision (2026-08-15): Jarvis reasons with a real Claude call, NOT a
// rule-router. The user talks to Jarvis in plain words; Jarvis REASONS about WHO
// to delegate to, hands each agent its piece, gathers their REAL findings, and
// composes an answer strictly from those findings.
//
// Two Claude calls per question:
//   1) PLAN     — given the request + the roster (and what each agent can
//                 actually SEE), return which agents to task and with what
//                 question. Reasoning only; it never states a network fact.
//   2) SYNTHESIS— given ONLY the real gathered findings, compose Jarvis's answer.
//                 It is told to report only those findings and to say
//                 "not connected / unread" where data is missing. It must not
//                 invent a number, a device, or a status.
//
// Between the two, the app EXECUTES the plan for real: each agent's read goes
// through the permission gate + read-only guardrail + CLI/session log
// (live.gatherForJarvis). A denied read runs nothing; a not-connected agent says
// so; a dead source is reported unreachable. No fabrication anywhere.
//
// NO KEY = NO REASONING. When ANTHROPIC_API_KEY is absent, Jarvis shows an honest
// "needs your API key to think" state and declines. It does NOT fall back to a
// rule-router pretending to reason, and it invents nothing.

const claude = require('./claude');
const session = require('./session-log');

let ctx = null;
// ctx: { say(agentId,text), status(agentId,state,label), log(line),
//        gather(agentId,question) -> Promise<finding>,
//        roster() -> [{ id, name, connected, sees, note }] }
function init(hostCtx) { ctx = hostCtx; }

const RULE = '──────────────────────────────────';

// Presence only — never the value. Drives the UI banner + the refusal.
function keyStatus() {
  const present = claude.hasKey();
  return {
    present,
    model: claude.model(),
    // Plain-words line the UI shows on the Jarvis surface.
    message: present
      ? 'Jarvis is armed — real reasoning is live.'
      : 'Jarvis needs your Anthropic API key to think.',
  };
}

// The honest no-key state, spoken on the Jarvis chat surface. This is the ONLY
// thing Jarvis does without a key — it never guesses a plan or an answer.
function refuseNoKey(question) {
  ctx.say('jarvis',
    `🔑 I can't reason about this yet — I have no Anthropic API key.\n${RULE}\n` +
    `You asked: "${String(question || '').slice(0, 140)}"\n\n` +
    `Being the Principal Engineer here means actually REASONING about who to pull in and ` +
    `why — that runs on a real Claude call, and there is no key on this machine yet. ` +
    `I will NOT fake a plan or an answer, and I will NOT fall back to a keyword router ` +
    `and pass it off as thinking.\n\n` +
    `Add ANTHROPIC_API_KEY to .env.local and I will reason for real. Meanwhile you can ` +
    `still @mention any engineer directly for a live read, or open a triage — those work now.`);
  ctx.status('jarvis', 'idle', 'No API key — declined to reason');
  ctx.log(`[Jarvis] No API key — declined to reason (no fabrication): "${String(question || '').slice(0, 60)}"`);
}

// Build the roster block the planner reasons over: who exists and what each can
// actually SEE. This is the real capability map — the planner cannot invent an
// agent because the plan schema's enum is built from these ids.
function rosterText() {
  return ctx.roster().map((a) => {
    const head = `- ${a.id} (${a.name})` + (a.connected ? '' : ' [NOT CONNECTED]');
    const sees = a.sees && a.sees.length ? `\n    sees: ${a.sees.join('; ')}` : '';
    const note = a.note ? `\n    note: ${a.note}` : '';
    return head + sees + note;
  }).join('\n');
}

const PLAN_SYSTEM =
`You are Jarvis, the L4 / Principal Engineer of a live NOC (network operations) squad.
The operator talks to you in plain words. Your ONLY job in THIS step is to REASON about
WHO on the squad should be tasked to answer, and WITH WHAT concrete question each one.

You do NOT answer the operator here and you do NOT state any network fact. You have no
network data of your own — the agents below are the only things that can see the network,
and each can see ONLY what is listed. Choose the smallest set of agents whose combined
sight actually covers the request. It is fine to pick an agent that is marked
NOT CONNECTED if it is the right owner — it will honestly report that it has no data.
If the request is not about the network this squad can see at all, return an empty
delegation list and explain why in "note".

DEVICE CLI RULE: if the operator asks for a command to be RUN ON a device — "run show
version on sw1", "show running-config", "ping 10.10.20.48", "traceroute …" — that is a
CLI execution job, not an inventory question. Exactly one engineer holds a command path
onto the boxes: config-keeper, which runs read-only commands through Catalyst Center's
Command Runner. Delegate that piece to config-keeper and pass the command through in the
sub-question ("run show version on sw1"), NOT to an inventory-only engineer. Only
show / ping / traceroute / dir / more can ever be run; anything that changes a device is
refused downstream, so never ask for one.

First, in "intent", state in one or two plain sentences what the operator is actually
asking for (the parsed intent). Then, in "symptom", extract the incident shape from the
complaint: a TIME ANCHOR ("since 2pm" -> an ISO timestamp resolved against the current
time you are given; null if none stated), a SCOPE (the fronts/sites the problem is IN —
from campus, fabric, wan, incidents, firewall, loadbalancer, security — or named sites;
null if not scoped), and the rawSymptom (the operator's own words for what is wrong).
Then choose the delegations.

Return ONLY the structured plan. Phrase each agent's question in plain, specific terms.`;

const PLAN_FORMAT_BASE = {
  type: 'json_schema',
  // schema filled per-call with the live agent-id enum
};

const SYNTH_SYSTEM =
`You are Jarvis, the L4 / Principal Engineer of a live NOC squad, giving the operator your answer.

CRITICAL HONESTY RULE: compose your answer using ONLY the findings provided to you below.
Every one of those findings is the REAL result of a live read (or an honest "not connected",
"denied", or "unreachable"). You have NO other source of network truth.
- Do NOT invent, estimate, or infer any device, number, status, or fact that is not in the findings.
- Where a finding says the agent is not connected, the read was denied, or the source was
  unreachable, say that plainly — do not paper over the gap with a guess.
- If the findings are blank or all came back unread/denied/unreachable, say you have nothing
  solid to report and why.
Speak plainly, like a Principal Engineer briefing a colleague. Be concise. No preamble.`;

async function ask(question) {
  // NO KEY = NO REASONING. Honest state, zero fabrication, no rule-router.
  if (!claude.hasKey()) return refuseNoKey(question);

  const q = String(question || '').trim();
  ctx.status('jarvis', 'active', 'Reasoning about who to task…');
  ctx.say('jarvis', `🧠 Let me think about who should look at this…`);

  const roster = ctx.roster();
  const ids = roster.map((a) => a.id);

  // ── Call 1: PLAN ───────────────────────────────────────────────────────────
  let plan;
  try {
    const format = {
      type: 'json_schema',
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['intent', 'symptom', 'delegations', 'note'],
        properties: {
          intent: { type: 'string' },
          symptom: {
            type: 'object',
            additionalProperties: false,
            required: ['timeAnchor', 'scope', 'rawSymptom'],
            properties: {
              timeAnchor: { type: ['string', 'null'] },
              scope: { type: ['array', 'null'], items: { type: 'string' } },
              rawSymptom: { type: 'string' },
            },
          },
          delegations: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['agentId', 'question'],
              properties: {
                agentId: { type: 'string', enum: ids },
                question: { type: 'string' },
              },
            },
          },
          note: { type: 'string' },
        },
      },
    };
    const res = await claude.reason({
      system: PLAN_SYSTEM,
      messages: [{
        role: 'user',
        content: `Current time (UTC, for resolving "since 2pm" style anchors): ${new Date().toISOString()}\n\nSquad roster (the only things that can see the network):\n${rosterText()}\n\nOperator request:\n"${q}"`,
      }],
      // Headroom above the JSON plan itself: on the current tiers adaptive
      // thinking shares this budget, so a tight cap could truncate the plan.
      maxTokens: 6000,
      effort: 'high',
      format,
    });
    if (res.refused) return refusedToReason(q);
    plan = JSON.parse(res.text);
  } catch (err) {
    return reasoningError(q, err);
  }

  const delegations = Array.isArray(plan.delegations) ? plan.delegations : [];
  // Belt-and-braces: keep only real agent ids (the enum should already ensure this).
  const valid = delegations.filter((d) => d && ids.includes(d.agentId) && d.question);

  if (!valid.length) {
    ctx.say('jarvis',
      `🤔 I reasoned about this and I don't have anyone who can actually answer it.\n${RULE}\n` +
      `You asked: "${q.slice(0, 140)}"\n\n` +
      (plan.note ? `${String(plan.note).slice(0, 400)}\n\n` : '') +
      `This squad only sees the network it is wired to. I have tasked no-one and read nothing.`);
    ctx.status('jarvis', 'idle', 'Nothing to delegate — ran nothing');
    ctx.log(`[Jarvis] Reasoned: nothing to delegate — "${q.slice(0, 60)}"`);
    return;
  }

  // Jarvis makes no device calls, so its CLI would be empty. Capture its REAL
  // reasoning as session records (agent:"jarvis", kind:"reasoning") so its CLI
  // shows the full routing chain: INTENT → PLAN → DELEGATE →<agent> → SYNTHESIS.
  // raw is the real detail the Claude call produced; interpretation is why.
  if (plan.intent) {
    session.recordReasoning({
      command: 'INTENT',
      raw: String(plan.intent),
      interpretation: 'Parsed the operator’s plain-words request into a concrete intent before choosing who to task.',
    });
  }
  session.recordReasoning({
    command: 'PLAN',
    raw: `Tasking ${valid.length} agent(s):\n` +
      valid.map((d) => `→ ${ctx.nameOf(d.agentId)} (${d.agentId}): ${d.question}`).join('\n') +
      (plan.note ? `\n\nWhy: ${String(plan.note)}` : ''),
    interpretation: 'Chose the smallest set of agents whose combined sight covers the request, with the exact sub-question sent to each.',
  });

  // Show the plan (real reasoning output, not a canned menu).
  ctx.say('jarvis',
    `🗺️ Plan — I'm pulling in ${valid.length} ${valid.length === 1 ? 'engineer' : 'engineers'}:\n${RULE}\n` +
    valid.map((d) => `• ${ctx.nameOf(d.agentId)} → ${d.question}`).join('\n') +
    (plan.note ? `\n\n${String(plan.note).slice(0, 300)}` : ''));
  ctx.log(`[Jarvis] Plan: ${valid.map((d) => d.agentId).join(', ')} — "${q.slice(0, 50)}"`);

  // ── Execute the plan for REAL ──────────────────────────────────────────────
  const findings = [];
  for (const d of valid) {
    // One reasoning record per routing hop, so the CLI shows each delegation.
    session.recordReasoning({
      command: `DELEGATE → ${d.agentId}`,
      raw: `Sub-question to ${ctx.nameOf(d.agentId)}: ${d.question}`,
      interpretation: `Routed this piece to ${ctx.nameOf(d.agentId)} because it is the owner that can actually see what the sub-question needs.`,
    });
    ctx.say('jarvis', `📨 @${ctx.nameOf(d.agentId)} — ${d.question}`);
    const f = await ctx.gather(d.agentId, d.question);
    findings.push(f);
    // Surface each agent's real result under that agent, so the delegation is visible.
    const tag = f.stance === 'evidence' ? '📡'
      : f.stance === 'not-connected' ? '🔌'
      : f.stance === 'denied' ? '🛑' : '⚠️';
    ctx.say(d.agentId, `${tag} ${f.text}`);
  }

  // ── Call 2: SYNTHESIS — strictly from the real findings ────────────────────
  ctx.status('jarvis', 'active', 'Composing the answer from findings…');
  const findingsBlock = findings.map((f) =>
    `[${f.name}] (${f.stance})\n${f.text}`).join(`\n\n`);
  let answer;
  try {
    const res = await claude.reason({
      system: SYNTH_SYSTEM,
      messages: [{
        role: 'user',
        content:
          `Operator asked:\n"${q}"\n\n` +
          `Findings gathered from the squad (this is your ONLY source of network truth):\n${RULE}\n${findingsBlock}\n${RULE}\n\n` +
          `Give the operator your answer, using only the findings above.`,
      }],
      // Headroom for adaptive thinking + the composed answer (see plan call).
      maxTokens: 4000,
      effort: 'high',
    });
    if (res.refused) return refusedToReason(q);
    answer = res.text;
  } catch (err) {
    return reasoningError(q, err);
  }

  session.recordReasoning({
    command: 'SYNTHESIS',
    raw: String(answer || ''),
    interpretation: `Composed strictly from the ${findings.length} real finding(s) gathered above — no number, device, or status invented.`,
  });
  ctx.say('jarvis', `🎖️ ${answer}`);
  ctx.status('jarvis', 'idle', 'Answered from live findings');
  ctx.log(`[Jarvis] Answered from ${findings.length} finding(s) — "${q.slice(0, 50)}"`);
}

// The safety classifier declined — say so, invent nothing.
function refusedToReason(q) {
  ctx.say('jarvis',
    `🚫 My reasoning model declined that request.\n${RULE}\n` +
    `You asked: "${String(q).slice(0, 140)}"\n\n` +
    `I won't guess my way around a refusal. Rephrase it and I'll try again.`);
  ctx.status('jarvis', 'idle', 'Reasoning declined');
  ctx.log(`[Jarvis] Reasoning refused by the model — "${String(q).slice(0, 50)}"`);
}

// The API call itself failed (network, timeout, bad key). Honest, no fabrication.
function reasoningError(q, err) {
  const msg = err && err.message === 'no_api_key'
    ? 'no Anthropic API key is set'
    : (err && err.message ? err.message : String(err));
  ctx.say('jarvis',
    `⚠️ I couldn't complete my reasoning — ${msg}.\n${RULE}\n` +
    `I have not invented a plan or an answer. Nothing was sent to any device on the strength of a guess.`);
  ctx.status('jarvis', 'idle', 'Reasoning unavailable');
  ctx.log(`[Jarvis] Reasoning error — ${msg}`);
}

// ── Symptom extraction for a triage (gap 1) ─────────────────────────────────
// A triage opens with just (severity, description). Before the bridge filters
// evidence it needs the incident SHAPE: when did it start (timeAnchor) and where
// is it (scope). This is the SAME real Claude reasoning the planner uses, run as
// its own call so triage.js can await a structured result.
//
// Returns { timeAnchor: ISO|null, timeAnchorMs: number|null, scope: string[]|null,
//           rawSymptom, note, source: 'claude'|'heuristic'|'none' }.
// HONESTY: with no API key we do NOT invent an anchor with Claude — we fall back
// to a small deterministic parse and label it source:'heuristic' so the bridge
// says so out loud. If even that finds nothing, source:'none' and the bridge uses
// a sensible recent default and says it did.
const SYMPTOM_SYSTEM =
`You extract the incident shape from a NOC operator's plain-words complaint.
You are told the OPERATOR'S timezone and the current time in that timezone. Absolute /
bare clock times the operator states ("2pm", "09:30", "from 14:00") are in the OPERATOR'S
LOCAL timezone, NOT UTC — reason about them in that local zone.
Return ONLY:
- timeAnchor: an ISO-8601 timestamp for when the problem STARTED. For a bare/absolute
  clock time, interpret it in the operator's LOCAL timezone and anchor it to the MOST
  RECENT PAST occurrence (if "2pm" has not happened yet today in the operator's zone,
  it means yesterday's 2pm). For a relative phrase ("last 30 minutes", "an hour ago"),
  offset from the current time you are given. Return the timestamp with an explicit UTC
  offset or as UTC (…Z). null if no time is stated.
- scope: the array of fronts the problem is IN, chosen from exactly these keys —
  campus, fabric, wan, incidents, firewall, loadbalancer, security — plus any named
  sites. A front the operator says is FINE is NOT in scope. null if the complaint
  names no scope. ("DC apps slow, campus fine" -> scope ["fabric","wan","incidents"],
  campus excluded.)
- rawSymptom: the operator's own words for what is wrong.
Reason only about what is stated. Do not invent a time or a front that was not implied.`;

// Resolve the timezone the operator's absolute clock times should be read in. A valid
// IANA string from the client wins; otherwise fall back to the server's local zone and
// SAY so (source: 'server') — never silently assume UTC.
function resolveTz(operatorTz) {
  const server = (() => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; }
    catch (e) { return 'UTC'; }
  })();
  const tz = typeof operatorTz === 'string' && operatorTz.trim() ? operatorTz.trim() : null;
  if (tz && tzIsValid(tz)) return { tz, source: 'operator' };
  return { tz: server, source: 'server' };
}

function tzIsValid(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; }
  catch (e) { return false; }
}

// Offset (local − UTC, in ms) that timezone `tz` was at the UTC instant `dateMs`.
function tzOffsetMs(tz, dateMs) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const map = {};
  for (const p of dtf.formatToParts(new Date(dateMs))) map[p.type] = p.value;
  const asUTC = Date.UTC(+map.year, +map.month - 1, +map.day, +map.hour, +map.minute, +map.second);
  return asUTC - dateMs;
}

// Real UTC ms for a wall-clock (y,mo,d,h,mi) that is stated in timezone `tz`.
function zonedWallClockToUtcMs(y, mo, d, h, mi, tz) {
  const guess = Date.UTC(y, mo, d, h, mi, 0);
  // Two-pass to settle DST near a transition.
  let utc = guess - tzOffsetMs(tz, guess);
  utc = guess - tzOffsetMs(tz, utc);
  return utc;
}

// The date (y,mo,d) it is RIGHT NOW in timezone `tz`.
function todayInTz(tz, nowMs) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const map = {};
  for (const p of dtf.formatToParts(new Date(nowMs))) map[p.type] = p.value;
  return { y: +map.year, mo: +map.month - 1, d: +map.day };
}

// Human "now" in tz, for the reasoning prompt (e.g. "2026-08-17 12:10 Asia/Kolkata").
function nowInTzLabel(tz, nowMs) {
  try {
    const dtf = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    });
    const map = {};
    for (const p of dtf.formatToParts(new Date(nowMs))) map[p.type] = p.value;
    return `${map.year}-${map.month}-${map.day} ${map.hour}:${map.minute} ${tz}`;
  } catch (e) { return `${new Date(nowMs).toISOString()} ${tz}`; }
}

// Deterministic, timezone-correct anchor for a BARE/ABSOLUTE clock time in the text.
// Interprets the clock in `tz` and anchors to the MOST RECENT PAST occurrence — so it is
// never in the future and never mis-read as UTC. Relative phrasing ("last 30 minutes")
// has no absolute clock and returns null (the caller keeps the relative anchor). Returns
// { iso, ms, hour, min } or null.
function absoluteClockToUtc(text, tz, nowMs) {
  const s = String(text || '');
  const m = /\b(?:since|from|around|at|about)?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i.exec(s);
  if (!m) return null;
  // Require real clock-time context, not a stray number.
  if (!/\b(since|from|around|at|about)\b/i.test(s) && !/(am|pm|:)/i.test(s)) return null;
  let hr = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  const ap = (m[3] || '').toLowerCase();
  if (!ap && !m[2] && hr > 23) return null;
  if (ap === 'pm' && hr < 12) hr += 12;
  if (ap === 'am' && hr === 12) hr = 0;
  if (hr < 0 || hr > 23 || min < 0 || min > 59) return null;
  const today = todayInTz(tz, nowMs);
  let ms = zonedWallClockToUtcMs(today.y, today.mo, today.d, hr, min, tz);
  if (ms > nowMs) ms -= 24 * 60 * 60 * 1000; // not reached yet today -> yesterday's occurrence
  // Recompute against the shifted day so a DST change on the boundary is honoured.
  if (ms > nowMs) ms = nowMs;
  return { iso: new Date(ms).toISOString(), ms, hour: hr, min };
}

async function extractSymptom(description, operatorTz) {
  const desc = String(description || '').trim();
  const nowMs = Date.now();
  const { tz, source: tzSource } = resolveTz(operatorTz);
  const tzTag = { operatorTz: tz, tzSource };
  const base = { timeAnchor: null, timeAnchorMs: null, scope: null, rawSymptom: desc, ...tzTag };
  // Deterministic tz-correct anchor for any bare/absolute clock time (class-level fix:
  // ALWAYS interpret absolute clocks in the operator's zone, past-anchored — regardless
  // of what the reasoning returns).
  const clk = absoluteClockToUtc(desc, tz, nowMs);
  const tzNote = tzSource === 'operator'
    ? `Absolute clock times read in the operator's timezone (${tz}).`
    : `No operator timezone sent — absolute clock times read in the server's local timezone (${tz}).`;

  if (!claude.hasKey()) {
    const h = heuristicSymptom(desc, tz, nowMs);
    // Prefer the deterministic tz-correct clock anchor when present.
    if (clk) { h.timeAnchor = clk.iso; h.timeAnchorMs = clk.ms; }
    return { ...base, ...h, note: (h.timeAnchor || h.scope
      ? 'Parsed the complaint with a simple keyword pass (no API key for full reasoning).'
      : 'No API key to reason about the complaint, and no obvious time/scope keywords — using a recent default window.') + ' ' + tzNote,
      source: h.timeAnchor || h.scope ? 'heuristic' : 'none' };
  }

  try {
    const format = {
      type: 'json_schema',
      schema: {
        type: 'object', additionalProperties: false,
        required: ['timeAnchor', 'scope', 'rawSymptom'],
        properties: {
          timeAnchor: { type: ['string', 'null'] },
          scope: { type: ['array', 'null'], items: { type: 'string' } },
          rawSymptom: { type: 'string' },
        },
      },
    };
    const res = await claude.reason({
      system: SYMPTOM_SYSTEM,
      messages: [{ role: 'user', content:
        `Operator timezone: ${tz} (${tzSource === 'operator' ? 'sent by the client' : 'server local — client sent none'})\n` +
        `Current time in the operator's timezone: ${nowInTzLabel(tz, nowMs)}\n` +
        `Current time (UTC): ${new Date(nowMs).toISOString()}\n\nComplaint:\n"${desc}"` }],
      maxTokens: 1500, effort: 'medium', format,
    });
    if (res.refused) { const h = heuristicSymptom(desc, tz, nowMs); if (clk) { h.timeAnchor = clk.iso; h.timeAnchorMs = clk.ms; } return { ...base, ...h, note: 'Reasoning declined; used a keyword pass. ' + tzNote, source: h.timeAnchor || h.scope ? 'heuristic' : 'none' }; }
    const parsed = JSON.parse(res.text);
    let timeAnchor = parsed.timeAnchor || null;
    let ms = toMsSafe(timeAnchor);
    // Override with the deterministic tz-correct clock anchor whenever the complaint
    // names an absolute clock — this is the guard against a UTC misread.
    if (clk) { timeAnchor = clk.iso; ms = clk.ms; }
    const scope = Array.isArray(parsed.scope) && parsed.scope.length ? parsed.scope.map(String) : null;
    return {
      ...tzTag,
      timeAnchor,
      timeAnchorMs: ms,
      scope,
      rawSymptom: parsed.rawSymptom || desc,
      note: 'Extracted from the complaint by real reasoning. ' + tzNote,
      source: 'claude',
    };
  } catch (err) {
    const h = heuristicSymptom(desc, tz, nowMs);
    if (clk) { h.timeAnchor = clk.iso; h.timeAnchorMs = clk.ms; }
    return { ...base, ...h, note: `Reasoning unavailable (${err && err.message ? err.message : 'error'}); used a keyword pass. ` + tzNote, source: h.timeAnchor || h.scope ? 'heuristic' : 'none' };
  }
}

// Deterministic fallback: pull a clock time ("2pm", "14:00", "2:30pm") anchored in the
// operator's timezone to the most-recent-past occurrence, and a coarse scope from front
// keywords. Honest and clearly labelled.
function heuristicSymptom(desc, tz, nowMs) {
  const text = String(desc || '');
  const zone = tz || (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (e) { return 'UTC'; } })();
  const at = typeof nowMs === 'number' ? nowMs : Date.now();
  let timeAnchor = null, timeAnchorMs = null;
  const clk = absoluteClockToUtc(text, zone, at);
  if (clk) { timeAnchor = clk.iso; timeAnchorMs = clk.ms; }
  const scope = [];
  const S = [
    ['campus', /\b(campus|catalyst|switch|access|sw\d)\b/i],
    ['fabric', /\b(fabric|aci|apic|leaf|spine|nexus|tenant|dc|data[\s-]?cent)\b/i],
    ['wan', /\b(wan|sd-?wan|vmanage|overlay|vedge|circuit|branch)\b/i],
    ['incidents', /\b(incident|fault|issue|outage)\b/i],
    ['loadbalancer', /\b(load[\s-]?bal|f5|vip|pool|app|application|slow|latency)\b/i],
    ['firewall', /\b(firewall|acl|vpn|tunnel|blocked|dropped)\b/i],
    ['security', /\b(cve|breach|attack|threat|malware)\b/i],
  ];
  for (const [k, re] of S) if (re.test(text)) scope.push(k);
  return { timeAnchor, timeAnchorMs, scope: scope.length ? scope : null };
}

function toMsSafe(ts) {
  if (!ts) return null;
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? null : ms;
}

// ── Blind-spot ranking by symptom relevance (gap 6) ─────────────────────────
// For "DC apps slow" the load-balancer blind spot is the likely hiding place, not
// a grey footer. This is a relevance HEURISTIC over the operator's own words — it
// never states a network fact, so it fabricates nothing; it just says "check this
// blind front FIRST for this symptom". Returns the blind spots with {risk, why},
// high-risk first.
const BLIND_RELEVANCE = {
  loadbalancer: /\b(slow|latency|lag|app|apps|application|timeout|time[\s-]?out|degrad|perform|response|throughput|500|502|503|504|gateway|hang|unrespons)\b/i,
  firewall: /\b(block|blocked|drop|dropped|deny|denied|reach|unreach|connection|connect|access|vpn|tunnel|ipsec|port|acl|reset|refused)\b/i,
  security: /\b(breach|attack|attacked|cve|exploit|malware|threat|scan|scanning|intrusion|compromis|ddos|exfil|ransom|phish)\b/i,
};

function rankBlindSpots(blindSpots, symptomText) {
  const text = String(symptomText || '');
  const ranked = (blindSpots || []).map((b) => {
    const re = BLIND_RELEVANCE[b.front];
    const hit = re && re.test(text);
    return {
      front: b.front,
      reason: b.reason,
      risk: hit ? 'high' : 'low',
      why: hit
        ? `high-risk for this symptom — the "${b.front}" front can hide exactly this kind of problem, and it is a blind spot. Check it manually first.`
        : `no direct match to this symptom, but still unmonitored — rule it out if the connected fronts come back clean.`,
    };
  });
  // High-risk first, otherwise keep declared order.
  return ranked.sort((a, b) => (a.risk === 'high' ? 0 : 1) - (b.risk === 'high' ? 0 : 1));
}

// ── Committed hypothesis for the L4 verdict (gap 7) ─────────────────────────
// The synthesis Claude call turns the collected REAL findings into a ranked
// hypothesis + a disambiguating if/then next check + confidence + why. Strictly
// from the findings block passed in; honest & low-confidence when data is thin.
// Returns { hypothesis, ranked:[{cause,likelihood}], ifThen, confidence, why } or
// null when there is no key / the call fails — triage.js then keeps its honest
// rule-built verdict rather than inventing one.
const HYPOTHESIS_SYSTEM =
`You are Jarvis, L4 / Principal Engineer, closing a live NOC triage bridge.
You are given the REAL findings the bridge collected — in-window vs pre-existing fault
counts, alarm groups (chronic vs new), per-front deltas vs baseline, a config-diff
finding, ranked blind spots, and the operator's symptom (time window + scope).

Commit to a diagnosis, using ONLY those findings:
- hypothesis: the single most likely cause, in one plain sentence. If the data is thin
  or every connected front is clean, say so honestly and point at the highest-risk blind
  spot instead of inventing a fault.
- ranked: the candidate causes in order, each with a short likelihood word (likely /
  possible / unlikely).
- ifThen: ONE disambiguating next check phrased as "check X — if clean, pivot to Y".
- confidence: high / medium / low — low when the connected estate is clean or the
  evidence is pre-window/out-of-scope.
- why: one sentence grounding the call in the findings (e.g. "campus reads clean and the
  fabric fault pre-dates the window").
Never state a number or device that is not in the findings.`;

async function synthesizeTriageVerdict(input) {
  if (!claude.hasKey()) return null;
  const { title, severity, symptom, findingsBlock } = input || {};
  try {
    const format = {
      type: 'json_schema',
      schema: {
        type: 'object', additionalProperties: false,
        required: ['hypothesis', 'ranked', 'ifThen', 'confidence', 'why'],
        properties: {
          hypothesis: { type: 'string' },
          ranked: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false,
              required: ['cause', 'likelihood'],
              properties: { cause: { type: 'string' }, likelihood: { type: 'string' } },
            },
          },
          ifThen: { type: 'string' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          why: { type: 'string' },
        },
      },
    };
    const res = await claude.reason({
      system: HYPOTHESIS_SYSTEM,
      messages: [{ role: 'user', content:
        `Triage: ${severity || ''} — "${title || ''}"\n` +
        `Operator symptom: ${symptom && symptom.rawSymptom ? symptom.rawSymptom : '(none given)'}\n` +
        `Incident window: ${symptom && symptom.timeAnchor ? `since ${symptom.timeAnchor}` : 'no explicit anchor (recent default)'}\n` +
        `In-scope fronts: ${symptom && symptom.scope ? symptom.scope.join(', ') : 'not scoped'}\n\n` +
        `Findings (your ONLY source of truth):\n${RULE}\n${findingsBlock || '(no findings collected)'}\n${RULE}\n\n` +
        `Commit to a ranked hypothesis + if/then next check + confidence + why.` }],
      maxTokens: 2500, effort: 'high', format,
    });
    if (res.refused) return null;
    return JSON.parse(res.text);
  } catch (err) {
    return null;
  }
}

// ── Wave 4: NARRATE a correlation the app already FOUND ──────────────────────
// The finding itself is deterministic (sources/correlation.js, computed from real
// timestamps). This call only puts it into one operator sentence. It cannot create,
// delete or move a correlation: no key / a refusal / any error simply returns null
// and the deterministic sentence stands.
const CORRELATION_SYSTEM =
`You are Jarvis, L4 / Principal Engineer, on a live NOC bridge.
The app has ALREADY established, from real event timestamps, that events on several
fronts co-occurred inside the incident window. Your ONLY job is to say that finding in
ONE plain sentence an operator can read on a bridge call: which fronts, roughly when,
and that it should be treated as one event rather than several separate problems.
Rules: use ONLY the fronts, times and event lines given. Never add a device, number,
cause or front that is not listed. Do not speculate about the root cause. Do not
hedge the correlation away — it was measured, not guessed. One sentence, no preamble.`;

async function narrateCorrelation(input) {
  if (!claude.hasKey()) return null;
  const { topCandidate, cluster, symptom } = input || {};
  if (!topCandidate || !Array.isArray(topCandidate.fronts) || topCandidate.fronts.length < 2) return null;
  try {
    const lines = ((cluster && cluster.events) || [])
      .map((e) => `- ${e.front} | ${e.type} | ${e.ts} | ${e.detail}`).join('\n');
    const res = await claude.reason({
      system: CORRELATION_SYSTEM,
      messages: [{ role: 'user', content:
        `Operator symptom: ${symptom && symptom.rawSymptom ? symptom.rawSymptom : '(none given)'}\n` +
        `Incident window: ${symptom && symptom.timeAnchor ? `since ${symptom.timeAnchor}` : 'no explicit anchor (recent default)'}\n` +
        `Correlated fronts: ${topCandidate.fronts.join(', ')}\n` +
        `They all started ~ ${topCandidate.ts}\n` +
        `Deterministic finding: ${topCandidate.summary}\n\n` +
        `Member events (your ONLY source of truth):\n${RULE}\n${lines || '(none)'}\n${RULE}\n\n` +
        `Narrate this correlation in one sentence.` }],
      // Headroom: on the current tiers thinking shares max_tokens, so a one-sentence
      // answer still needs room above its own size or it truncates to nothing.
      maxTokens: 1500, effort: 'medium',
    });
    if (res.refused) return null;
    const txt = (res.text || '').trim();
    return txt ? txt.slice(0, 600) : null;
  } catch (err) {
    return null;
  }
}

module.exports = { init, ask, keyStatus, extractSymptom, rankBlindSpots, synthesizeTriageVerdict, narrateCorrelation };
