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
        required: ['delegations', 'note'],
        properties: {
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
        content: `Squad roster (the only things that can see the network):\n${rosterText()}\n\nOperator request:\n"${q}"`,
      }],
      maxTokens: 900,
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

  // Show the plan (real reasoning output, not a canned menu).
  ctx.say('jarvis',
    `🗺️ Plan — I'm pulling in ${valid.length} ${valid.length === 1 ? 'engineer' : 'engineers'}:\n${RULE}\n` +
    valid.map((d) => `• ${ctx.nameOf(d.agentId)} → ${d.question}`).join('\n') +
    (plan.note ? `\n\n${String(plan.note).slice(0, 300)}` : ''));
  ctx.log(`[Jarvis] Plan: ${valid.map((d) => d.agentId).join(', ')} — "${q.slice(0, 50)}"`);

  // ── Execute the plan for REAL ──────────────────────────────────────────────
  const findings = [];
  for (const d of valid) {
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
      maxTokens: 1200,
      effort: 'high',
    });
    if (res.refused) return refusedToReason(q);
    answer = res.text;
  } catch (err) {
    return reasoningError(q, err);
  }

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

module.exports = { init, ask, keyStatus };
