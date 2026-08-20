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
// CW-9: the ONE bridge-conduct layer — the shared understanding gate and the
// pinned message envelope (with its hard caps). conduct.js knows nothing about
// Jarvis (no cycle): Jarvis hands it a planner, and every operator entry point
// goes through the same gate.
const conduct = require('./conduct');

let ctx = null;
// ctx: { say(agentId,text), status(agentId,state,label), log(line),
//        gather(agentId,question) -> Promise<finding>,
//        roster() -> [{ id, name, connected, sees, note }] }
function init(hostCtx) { ctx = hostCtx; }

const RULE = '──────────────────────────────────';

// NEVER CUT AN OPERATOR-FACING LINE MID-WORD (junior-UX fix). A hard `.slice(0,N)`
// on text Jarvis shows the operator chopped the capability answer and plan
// rationales in the middle of a word ("…ask about an i"), which reads as a broken,
// junior tool. softClip trims to a length WITHOUT splitting a word: it prefers the
// last sentence boundary, falls back to the last whole word, and marks the cut with
// an honest ellipsis so it never pretends to be complete. The final synthesised
// answer is shown in full and never passes through here.
function softClip(text, max) {
  const s = String(text == null ? '' : text).trim();
  if (s.length <= max) return s;
  const slice = s.slice(0, max);
  // A sentence boundary that is not too early keeps whole sentences.
  const sentence = Math.max(
    slice.lastIndexOf('. '), slice.lastIndexOf('! '), slice.lastIndexOf('? '), slice.lastIndexOf('\n'));
  if (sentence >= max * 0.6) return slice.slice(0, sentence + 1).trim() + ' …';
  const space = slice.lastIndexOf(' ');
  return (space > 0 ? slice.slice(0, space) : slice).trim() + ' …';
}

// Jarvis's OWN capability list, rendered for the PLAN call so the planner can
// answer a greeting or a "what can you do / help" meta-ask from the real, honest
// ability map (what is built, what is only half-wired and why) instead of guessing
// or listing just the network agents. Injected through ctx (like the roster) so
// jarvis.js stays decoupled and testable; absent → an empty list, and the planner
// simply has nothing extra to draw on.
function abilitiesText(list) {
  if (!Array.isArray(list) || !list.length) return '(capability list unavailable)';
  return list.map((a) => {
    const state = a.available ? 'AVAILABLE'
      : (a.engineBuilt ? 'BUILT, NOT CONNECTED' : 'NOT YET');
    const why = !a.available && a.reason ? `  (why not: ${a.reason})` : '';
    return `- ${a.label} [${state}]: ${a.plain}${why}`;
  }).join('\n');
}

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

DEVICE FIELD — structured, never buried in prose. For a device-CLI delegation, put the
target device the operator named in the delegation's "device" field as its bare name or
management IP (e.g. "sw2", "10.10.20.176"). The executor targets the box from THIS field,
not from the wording of "question", so you may reword the sub-question freely without
losing the target. Fill "device" ONLY when the operator unambiguously named exactly one
device. If they gave a prefix/partial ("sw", "the switches"), named several, or named
none, set "device" to null — do NOT invent or infer one; the executor resolves it against
the live inventory and asks the operator when more than one could serve the ask. For any
non-CLI delegation, set "device" to null.

AMBIGUOUS TARGET RULE — never instruct a guess. If the operator does not name exactly one
device ("show version on sw", "run show version" with no device at all, "on the switches"),
you STILL delegate the command to config-keeper, worded exactly as the operator asked it.
Do NOT tell any agent to pick "the closest match", "the first reachable one", or a specific
box you inferred (sw1) — you cannot see the inventory, and a guessed target is a wrong
answer wearing a right answer's clothes. Config-keeper resolves the target against the LIVE
inventory and, when more than one device could serve the ask, it runs NOTHING and asks the
operator which one, listing the real candidates. That question IS the correct outcome — pass
it back to the operator as it stands. Do not substitute an inventory listing for it (asking
netops to list the switches does not answer "show version"), and do not pick one yourself
from a list an agent returns.

THIS CONSOLE'S OWN INCIDENTS. This app opens and runs its own triage bridges, and each one
gets an id of the form INC-YYYYMMDD-NNN (internally trg-…). One engineer on the roster reads
that record — see its "sees" list. So "what is the latest incident?", "summarise
INC-20260817-013", "who is on this incident?", "give me a shift handover" ARE answerable:
delegate them to that engineer. Do NOT tell the operator this console cannot see its own
incidents. When the operator names an incident id, put it in the delegation's "incidentId"
field exactly as they wrote it; when they name none, set "incidentId" to null and the
engineer returns the live incident list to reason over. Never invent an incident id — if
the operator quotes one that does not exist, the engineer says so and you relay that.
For every non-incident delegation, set "incidentId" to null.

EXTERNAL MCP TOOLS (CW-8). Some entries on the roster are external tools exposed over the
Model Context Protocol, with ids of the form "mcp:<server>:<tool>" — see their "sees" line.
They are delegation targets exactly like an agent: if one genuinely covers part of the
request, task it, worded plainly. Reason about whether a tool FITS from what it does; never
pick one by keyword. A tool marked read-only auto-runs through the permission gate like any
read; a tool that looks like a write is proposed for approval and never runs on its own. If
none of the external tools fits, ignore them — they are extra reach, not a requirement.

YOU, JARVIS, ARE ALSO SOMEONE THE OPERATOR TALKS TO. If the operator only GREETS you
("hi", "hey jarvis", "morning", "thanks") or asks a META question ABOUT YOU — what you can
do, "help", "what are you", "who are you" — that is NOT a network task and there is no-one
to delegate to. Do NOT force a delegation, and do NOT decline it as off-network. Instead
write a warm, complete reply in "selfAnswer": greet back if you were greeted, then in plain
words say what you CAN do right now and, honestly, what is built-but-not-connected and why —
drawn ONLY from the "What you (Jarvis) can do" list given to you below. Lead with what you
can do; keep it readable, not a raw dump. NEVER say "I can't do that yet" to a greeting or a
help ask. For EVERY other request — anything that names or implies the network, a device, an
incident, or a task — set "selfAnswer" to null and delegate as normal (or, if truly nothing
on the squad can serve it, leave delegations empty and explain in "note").

First, in "intent", state in one or two plain sentences what the operator is actually
asking for (the parsed intent). Then, in "symptom", extract the incident shape from the
complaint: a TIME ANCHOR ("since 2pm" -> an ISO timestamp resolved against the current
time you are given; null if none stated), a SCOPE (the fronts/sites the problem is IN —
from campus, fabric, wan, incidents, firewall, loadbalancer, security — or named sites;
null if not scoped), and the rawSymptom (the operator's own words for what is wrong).
Then choose the delegations.

BRIDGE ROSTER (CW-9). You are the call leader, so say out loud who you are NOT pulling
in. In "standDown", list the roster agents you deliberately left out THAT AN OPERATOR
MIGHT EXPECT to be involved, each with a one-line reason ("nothing in this points at
firewall policy"). Leave it empty when nothing needs saying. Never stand an agent down
and task it as well, and never invent a reason — if you have no reason, leave it out.

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
- If a finding is an agent ASKING the operator which device to run on (because several
  matched, or none was named), relay that question as YOUR answer — keep the candidate list
  exactly as given, with each device's mgmt IP and reachability, and tell the operator to
  reply with a name, a number, or "all". Never pick one of the candidates for them, and never
  present a candidate list as if the command had been run.
Speak plainly, like a Principal Engineer briefing a colleague. Be concise. No preamble.`;

// NO SILENT DROPPED TURNS (QA CLASS 6). A delegated read is meant to end in one
// of three honest outcomes: real output, an honest error, or an honest denial.
// The failure this closes is the FOURTH outcome — silence: a read that hangs on a
// slow/stuck sandbox (or, defensively, one that rejects or returns null/empty)
// used to leave the loop awaiting forever, so the operator saw the plan and the
// "@Config-Keeper — …" line and then NOTHING. This guard guarantees every
// delegation resolves to a rendered finding within a bounded time, and turns a
// hang / rejection / empty result into an explicit "no response" the operator can
// read. It NEVER fabricates a reading — the honest outcome is "the source did not
// answer", not a made-up device fact.
const GATHER_TIMEOUT_MS = Math.max(1000, Number(process.env.JARVIS_GATHER_TIMEOUT_MS) || 90000);

// Build an honest "nothing came back" finding, shaped exactly like a real one so
// the loop renders and synthesises it without special-casing.
function noResponseFinding(agentId, name, text) {
  return { agentId, name: name || ctx.nameOf(agentId) || agentId, connected: true, stance: 'unreachable', text };
}

async function gatherGuarded(d) {
  const agentId = d.agentId;
  const name = ctx.nameOf(agentId) || agentId;
  const secs = Math.round(GATHER_TIMEOUT_MS / 1000);
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(noResponseFinding(agentId, name,
      `No response — ${name} did not return anything within ${secs}s. The device or source did not answer in time, ` +
      `so I have no reading to show for this. Nothing was invented, and nothing was sent to any device on a guess. ` +
      `Try again, or narrow it to one device.`)), GATHER_TIMEOUT_MS);
  });
  // A rejection from gather is turned into an honest finding too, never a throw
  // that escapes the loop and strands the remaining delegations.
  const work = Promise.resolve()
    .then(() => ctx.gather(agentId, d.question, d.device || null, d.incidentId || null))
    .catch((err) => noResponseFinding(agentId, name,
      `The read could not complete — ${err && err.message ? err.message : 'an unexpected error'}. ` +
      `No reading to show, and nothing was invented.`));
  try {
    const f = await Promise.race([work, timeout]);
    // A null/undefined or empty-text finding is silence wearing a finding's
    // clothes — surface it as an explicit "nothing came back" instead.
    if (!f || typeof f !== 'object') {
      return noResponseFinding(agentId, name,
        `No response — ${name} returned nothing at all for this. The read did not complete, so there is nothing to show.`);
    }
    if (!String(f.text || '').trim()) {
      return { ...noResponseFinding(agentId, f.name || name,
        `No response — ${f.name || name} came back empty for this. There is nothing to show, and nothing was invented.`),
        stance: f.stance && f.stance !== 'evidence' ? f.stance : 'unreachable' };
    }
    return f;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Say something on the bridge in the PINNED ENVELOPE. `env` carries kind + its
// structured payload; the text is what an old client (or a plain reader) sees.
// Additive: ctx.say ignores a third argument it does not understand.
function speak(agentId, env) {
  ctx.say(agentId, env.text, env);
}

// ── CW-9: the bridge front door ─────────────────────────────────────────────
// EVERY operator message reaches Jarvis here, and the FIRST thing that happens
// is the shared conduct gate (sources/conduct.js) — the same gate the triage
// intake uses. An underspecified problem report gets up to 3 narrowing questions
// and NOTHING is engaged and NOTHING is read. That is the class fix for the
// 2026-08-19 failure: sweep-first-ask-last is now impossible, because the ask
// happens before any engagement decision exists.
async function ask(question, opts) {
  // NO KEY = NO REASONING. Honest state, zero fabrication, no rule-router.
  if (!claude.hasKey()) return refuseNoKey(question);

  const q = String(question || '').trim();
  const conversationId = (opts && opts.conversationId) || 'default';
  const operatorTz = (opts && opts.operatorTz) || null;

  let gate;
  try {
    gate = await conduct.assess({ conversationId, text: q, operatorTz });
  } catch (err) {
    gate = { decision: 'unavailable', why: (err && err.message) || 'the gate failed' };
  }

  // Underspecified problem report → ASK. Zero engagements, zero reads.
  if (gate.decision === 'ask') return askNarrowing(q, gate);
  // A real, specific problem report → run the bridge (roster + the CW-7 loop).
  if (gate.decision === 'proceed') return runBridge(q, gate, { conversationId, operatorTz });
  // The understanding step FAILED (threw, or came back in a shape we cannot
  // read). That is not permission to engage the squad — fail SAFE (reviewer
  // finding #7): say so, engage nobody, read nothing.
  if (gate.decision === 'unavailable' && gate.reason === 'failed') {
    speak('jarvis', conduct.envelope.say(
      `I could not reason about that — ${gate.why}. I have engaged nobody and read nothing. Say it again and I will try once more.`));
    ctx.status('jarvis', 'idle', 'Could not understand it — engaged nobody');
    ctx.log(`[Jarvis] Conduct gate failed safe (${gate.why}) — zero engagement — "${q.slice(0, 60)}"`);
    return;
  }
  // ONE GATE, FIRST, ON EVERY PATH (reviewer finding #4). The capability screen
  // used to sit in FRONT of this in server.js, which meant an operator's ANSWER
  // to parked questions could be swallowed by a change-proposal bubble and the
  // thread orphaned in awaiting-info forever. It now runs HERE — after the gate
  // has had its say — so nothing decides before conduct does. It may still only
  // refuse (safety) or offer a proposal; it never routes an answer away.
  if (typeof ctx.screen === 'function' && ctx.screen(q)) return;
  // Anything else (a question, a greeting, a command) takes the existing
  // plan → gather → answer path, unchanged.
  return planAndAnswer(q);
}

// The ask message: ONE short line plus up to 3 real narrowing questions from the
// planner. Nothing was engaged and nothing was read — and it says so.
function askNarrowing(q, gate) {
  const questions = (gate.questions || []).slice(0, conduct.MAX_QUESTIONS);
  // The questions are the point, so the 280-char budget is spent on WHOLE
  // questions: the lead line is dropped before a question is, and a question is
  // dropped whole rather than clipped into a dangling "3.". The envelope always
  // carries all of them, so the desk shows the full list either way.
  const fit = (lead) => {
    let text = lead;
    let n = 0;
    for (let i = 0; i < questions.length; i++) {
      const next = `${text}\n${i + 1}. ${questions[i]}`;
      if (next.length > conduct.TEXT_MAX) break;
      text = next; n++;
    }
    return { text, n };
  };
  const short = 'Nothing has run yet — first:';
  const withLead = fit(gate.message);
  const body = (withLead.n === questions.length ? withLead : fit(short)).text;
  speak('jarvis', conduct.envelope.ask(body, questions));
  session.recordReasoning({
    command: 'UNDERSTAND',
    raw: `Problem as stated: "${q}"\nNot specific enough to act on. Asked:\n` +
      questions.map((x, i) => `${i + 1}. ${x}`).join('\n'),
    interpretation: 'Ran the shared conduct gate BEFORE any engagement: the problem was underspecified, so Jarvis asked the operator to narrow it and engaged nobody — zero reads, zero device calls.',
  });
  ctx.status('jarvis', 'idle', 'Asked you to narrow it — engaged nobody');
  ctx.log(`[Jarvis] Conduct gate: asked ${questions.length} narrowing question(s), engaged nobody, read nothing — "${q.slice(0, 60)}"`);
}

async function planAndAnswer(q) {
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
        required: ['intent', 'symptom', 'delegations', 'standDown', 'note', 'selfAnswer'],
        properties: {
          intent: { type: 'string' },
          // A greeting or a meta/help ask about Jarvis itself is answered HERE, by
          // the planner, from Jarvis's real capability list — no delegation. null
          // for every network/task request (those delegate or decline as before).
          selfAnswer: { type: ['string', 'null'] },
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
              required: ['agentId', 'question', 'device', 'incidentId'],
              properties: {
                agentId: { type: 'string', enum: ids },
                question: { type: 'string' },
                // CLASS 9, same idiom as `device`: when the operator names one of
                // THIS console's incidents ("summarise INC-20260817-013"), the id
                // travels as a STRUCTURED field so the executor looks up exactly
                // that record. null when no incident was named — the executor then
                // grounds on the incident LIST and the conversation's own memory,
                // and never invents a record.
                incidentId: { type: ['string', 'null'] },
                // CLASS 2 durable fix: the device a CLI command targets travels
                // as a STRUCTURED field, not buried in reworded prose. The
                // executor reads THIS, not a regex over `question`, so a plan
                // that says "on the switch named sw2" still targets sw2. null
                // for a partial/several/none target — the executor then resolves
                // against the live inventory and asks (the ambiguity net).
                device: { type: ['string', 'null'] },
              },
            },
          },
          // CW-9 bridge roster: who you are deliberately NOT pulling in, and the
          // one-line reason each. It is what a call leader says out loud on a
          // bridge ("Firewall, stand down — nothing points at policy"), and it
          // stops a silent estate-wide sweep looking like diligence.
          standDown: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false,
              required: ['agentId', 'why'],
              properties: { agentId: { type: 'string', enum: ids }, why: { type: 'string' } },
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
        content: `Current time (UTC, for resolving "since 2pm" style anchors): ${new Date().toISOString()}\n\nSquad roster (the only things that can see the network):\n${rosterText()}\n\nWhat you (Jarvis) can do right now — YOUR OWN capability list, for answering a greeting or a "what can you do / help" meta-ask (use only for "selfAnswer"; it is not a network source):\n${abilitiesText((ctx.abilities && ctx.abilities()) || [])}\n\nOperator request:\n"${q}"`,
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

  // A greeting or a meta/help ask about Jarvis itself: the planner composed a warm
  // capability answer (from Jarvis's real ability list) instead of delegating.
  // Render it IN FULL — never sliced, no "I can't"/"tasked no-one" junior footer.
  // This IS the answer, so Jarvis never feels junior when simply greeted or asked
  // what it can do.
  const selfAnswer = plan.selfAnswer && String(plan.selfAnswer).trim() ? String(plan.selfAnswer).trim() : null;
  if (!valid.length && selfAnswer) {
    session.recordReasoning({
      command: 'SELF',
      raw: selfAnswer,
      interpretation: 'A greeting or a meta/help ask — answered warmly from Jarvis’s own capability list; no delegation needed and nothing read from the network.',
    });
    ctx.say('jarvis', `🎖️ ${selfAnswer}`);
    ctx.status('jarvis', 'idle', 'Answered — what I can do');
    ctx.log(`[Jarvis] Greeting/meta — answered from capability list — "${q.slice(0, 50)}"`);
    return;
  }

  if (!valid.length) {
    ctx.say('jarvis',
      `🤔 I reasoned about this and I don't have anyone who can actually answer it.\n${RULE}\n` +
      `You asked: "${q.slice(0, 140)}"\n\n` +
      // softClip, not a hard slice: never chop the rationale mid-word.
      (plan.note ? `${softClip(plan.note, 600)}\n\n` : '') +
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

  // CW-9: the plan IS the bridge roster — who is engaged, and who is standing
  // down, one line each. Short by construction (the envelope caps it), with the
  // structured roster riding alongside for the desk to render as a bridge card.
  const engaged = valid.map((d) => ({ agent: ctx.nameOf(d.agentId), why: d.question }));
  const stoodDown = (Array.isArray(plan.standDown) ? plan.standDown : [])
    .filter((s) => s && s.agentId && !valid.some((d) => d.agentId === s.agentId))
    .map((s) => ({ agent: ctx.nameOf(s.agentId), why: s.why }));
  speak('jarvis', conduct.envelope.roster(
    `Pulling in ${valid.length} ${valid.length === 1 ? 'engineer' : 'engineers'}: ` +
      engaged.map((e) => e.agent).join(', ') + '.' +
      (stoodDown.length ? ` Standing down: ${stoodDown.map((e) => e.agent).join(', ')}.` : ''),
    engaged, stoodDown));
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
    speak('jarvis', conduct.envelope.say(`@${ctx.nameOf(d.agentId)} — ${d.question}`));
    // Pass the STRUCTURED device (CLASS 2) alongside the sub-question so the
    // executor targets the box the planner resolved, not a regex over its prose.
    // NO SILENT DROPPED TURNS (QA CLASS 6): a tasked read must ALWAYS resolve to
    // something the operator can see — real output, an honest error, or an honest
    // denial. gatherGuarded wraps the delegation so a read that hangs, rejects, or
    // comes back null/empty becomes an explicit "no response" finding instead of
    // vanishing and leaving the operator staring at a plan that went nowhere.
    const f = await gatherGuarded(d);
    findings.push(f);
    // CW-9: the agent's result is surfaced as FINDINGS — one short line of
    // meaning each, with the real terminal evidence (host, command, raw output,
    // honest transport) travelling in finding.cli. Raw device output never goes
    // into message text again; that was the wall-of-text defect.
    emitFindings(d.agentId, f);
  }

  // ── Call 2: SYNTHESIS — strictly from the real findings ────────────────────
  ctx.status('jarvis', 'active', 'Composing the answer from findings…');
  let result;
  try {
    result = await synthesizeAnswer(q, findings);
  } catch (err) {
    return relayFindings(q, findings, `the write-up step could not run (${err && err.message ? err.message : 'error'})`);
  }
  // The optional summary was declined even after the one neutral retry — the reads
  // are already on screen, so relay honestly with the SHORT, calm message.
  if (result.relayed) return relayFindings(q, findings, result.why);
  const answer = result.answer;

  session.recordReasoning({
    command: 'SYNTHESIS',
    raw: String(answer || ''),
    interpretation: `Composed strictly from the ${findings.length} real finding(s) gathered above — no number, device, or status invented.`,
  });
  speak('jarvis', conduct.envelope.say(answer));
  ctx.status('jarvis', 'idle', 'Answered from live findings');
  ctx.log(`[Jarvis] Answered from ${findings.length} finding(s) — "${q.slice(0, 50)}"`);
}

// ── CW-9: findings as evidence, never as a wall of text ─────────────────────
// One finding message per REAL read: a single sentence of meaning (hard-capped
// at 200 chars) plus the terminal evidence behind it — host, exact command, raw
// (already secret-scrubbed) output and the HONEST transport label. A read that
// produced no terminal evidence (not connected / denied / unreachable / an
// answer built from an API summary) still gets its one honest line.
function emitFindings(agentId, finding) {
  const name = (finding && finding.name) || ctx.nameOf(agentId) || agentId;
  const cli = finding && Array.isArray(finding.cli) ? finding.cli : [];
  if (!cli.length) {
    speak(agentId, conduct.envelope.finding({ agent: name, line: finding.text, cli: null }));
    return;
  }
  for (const e of cli) {
    speak(agentId, conduct.envelope.finding({
      agent: name,
      line: e.line || `${name} ran "${e.command}" on ${e.host}.`,
      cli: e,
    }));
  }
}

// ── CW-9: the BRIDGE — a real problem report, run like a P1 call ────────────
// The conduct gate already understood the problem (one gate, no second grill).
// From here Jarvis behaves like the call leader:
//   1. names the bridge roster out loud — who is engaged and who is standing
//      down, one line each (and the loop may then task ONLY the engaged);
//   2. reuses the CW-7 investigation loop round by round — each round is one
//      short 'say' plus the finding evidence that arrived;
//   3. closes with a verdict, and — when the fix is a config change — a change
//      record drafted through the CW-2 engine and HELD FOR APPROVAL. Never
//      applied: the gate law is unchanged.
// Everything reasoned is the LLM's; everything enforced (caps, engagement set,
// held-for-approval) is code.
async function runBridge(q, gate, opts) {
  if (!ctx.investigate || typeof ctx.investigate.create !== 'function') {
    // No loop wired up (an old host / a test harness): fall back to the plan
    // path rather than dead-end the operator.
    return planAndAnswer(q);
  }
  const roster = ctx.roster();
  ctx.status('jarvis', 'active', 'Opening the bridge…');

  let call;
  try {
    call = await planBridgeRoster({ problem: gate.problem, understood: gate.understood, roster });
  } catch (err) {
    call = null;
  }
  const engagedIds = (call && call.engaged.length ? call.engaged : [])
    .filter((e) => roster.some((a) => a.id === e.agentId));
  if (!engagedIds.length) {
    speak('jarvis', conduct.envelope.say(
      'I understood the problem but there is nobody on this squad who can see it, so I engaged no-one and read nothing.'));
    ctx.status('jarvis', 'idle', 'Nobody can see this — engaged nobody');
    return;
  }
  const engaged = engagedIds.map((e) => ({ agent: ctx.nameOf(e.agentId), why: e.why }));

  // ROSTER TRUTH (reviewer blocker #1). A stand-down claim is only made when it
  // is true of the READS, not just of the plan: an agent whose own source
  // systems an ENGAGED agent is going to read is NOT announced as standing down
  // — it is named honestly as "not on the call, but their systems get read".
  // Never-connected agents are left off entirely: naming them every time is
  // noise on the one card that has to be scannable.
  const sourcesOf = (id) => ((roster.find((a) => a.id === id) || {}).sources || []);
  const engagedSources = new Set(engagedIds.flatMap((e) => sourcesOf(e.agentId)));
  const claimed = ((call && call.stoodDown) || [])
    .filter((s) => s && s.agentId && !engagedIds.some((e) => e.agentId === s.agentId))
    .filter((s) => (roster.find((a) => a.id === s.agentId) || {}).connected !== false);
  const stoodDown = claimed
    .filter((s) => !sourcesOf(s.agentId).some((src) => engagedSources.has(src)))
    .map((s) => ({ agent: ctx.nameOf(s.agentId), why: s.why }));
  const overlapping = claimed
    .filter((s) => sourcesOf(s.agentId).some((src) => engagedSources.has(src)))
    .map((s) => ({ agent: ctx.nameOf(s.agentId), shared: sourcesOf(s.agentId).filter((src) => engagedSources.has(src)) }));

  speak('jarvis', conduct.envelope.say(conduct.capText(gate.understood)));
  // The gate ran out of narrowing rounds and we are working a thin problem —
  // say so plainly, and say what is being assumed (ambiguity law).
  if (gate.thin) {
    speak('jarvis', conduct.envelope.say(
      `Heads up: this is still under-specified after ${conduct.MAX_ASK_ROUNDS} rounds of questions. ` +
      `I am proceeding on the assumption that it means: ${gate.understood} — correct me and I will re-scope.`));
  }
  speak('jarvis', conduct.envelope.roster(
    `On the bridge: ${engaged.map((e) => e.agent).join(', ')}.` +
      (stoodDown.length ? ` Standing down: ${stoodDown.map((e) => e.agent).join(', ')}.` : '') +
      (overlapping.length
        ? ` Not on the call, but their systems (${overlapping[0].shared.join(', ')}) still get read: ${overlapping.map((o) => o.agent).join(', ')}.`
        : ''),
    engaged, stoodDown));
  session.recordReasoning({
    command: 'BRIDGE',
    raw: `Understood: ${gate.understood}\nEngaged: ${engaged.map((e) => `${e.agent} — ${e.why}`).join('\n')}\n` +
      (stoodDown.length ? `Stood down: ${stoodDown.map((e) => `${e.agent} — ${e.why}`).join('\n')}` : 'Stood down: nobody named'),
    interpretation: 'Opened a bridge on a problem the shared conduct gate judged specific enough to work — the engaged set is the only set the investigation loop may task.',
  });

  const observer = bridgeObserver({
    // The backstop for the roster claim: if a round's REAL evidence touches a
    // system belonging to someone we announced as standing down, Jarvis says so
    // out loud instead of leaving a false claim standing.
    stoodDown: claimed
      .filter((s) => !sourcesOf(s.agentId).some((src) => engagedSources.has(src)))
      .map((s) => ({ agent: ctx.nameOf(s.agentId), sources: sourcesOf(s.agentId) })),
  });
  const rec = ctx.investigate.create({
    problem: gate.problem,
    understood: gate.understood,
    hypotheses: gate.hypotheses,
    operatorTz: (opts && opts.operatorTz) || null,
    agents: engagedIds.map((e) => e.agentId),
    observer,
  });
  ctx.log(`[Jarvis] Bridge ${rec.id} opened from chat — engaged ${engagedIds.map((e) => e.agentId).join(', ')} — "${q.slice(0, 50)}"`);
  await ctx.investigate.run(rec.id);
  ctx.status('jarvis', 'idle', 'Bridge closed');
}

// Narrates the CW-7 loop into the pinned envelope, round by round.
//
// NARRATION IS COMPOSED FROM THE EVIDENCE, NOT FROM THE PLAN (reviewer blocker
// #2). The first cut printed the probe's QUESTION as if it were what ran, so
// three rounds that produced byte-identical reads read like three escalating
// investigations. Now each round is described by the checks it ACTUALLY
// produced, diffed against every earlier round: a round that turned up nothing
// new says so in plain words, and its repeated evidence is not posted again.
function bridgeObserver(opts) {
  let closed = false;
  const seen = new Set();                       // source|command already evidenced
  const stoodDown = (opts && opts.stoodDown) || [];
  const corrected = new Set();
  return {
    onRound(snap, round) {
      if (!round) return;
      const report = round.report || {};
      const cli = Array.isArray(report.cli) ? report.cli : [];
      const sig = (e) => `${e.source || 'unknown'}|${e.command || ''}`;
      const fresh = cli.filter((e) => !seen.has(sig(e)));
      cli.forEach((e) => seen.add(sig(e)));
      const lead = (round.hypotheses || []).find((h) => h.status === 'confirmed')
        || (round.hypotheses || []).find((h) => h.status !== 'eliminated');
      const tail = lead ? ` Leading line: ${lead.text} (${Math.round((round.confidence || 0) * 100)}%).` : '';

      // What actually happened this round, in the order of what is TRUE.
      const head = !cli.length
        ? `Round ${round.round} — ${round.agent}: no reading came back (${report.stance}).`
        : !fresh.length
          ? `Round ${round.round} — ${round.agent}: ${cli.length} check(s) ran and returned the same picture as before — nothing new.`
          : `Round ${round.round} — ${round.agent}: ${fresh.length} new check(s) — ${fresh.slice(0, 2).map((e) => e.command).join(', ')}.`;
      speak('jarvis', conduct.envelope.say(head + tail));

      // Only NEW evidence is posted as findings; a repeat is not re-dumped.
      if (fresh.length) {
        emitFindings((round.probe && round.probe.agentId) || 'jarvis',
          { name: report.agentName, text: report.text, cli: fresh });
      } else if (!cli.length) {
        emitFindings((round.probe && round.probe.agentId) || 'jarvis',
          { name: report.agentName, text: report.text, cli: [] });
      }

      // ROSTER BACKSTOP: did this round read a system we said was standing down?
      for (const s of stoodDown) {
        const hit = cli.find((e) => s.sources.includes(e.source));
        if (hit && !corrected.has(s.agent)) {
          corrected.add(s.agent);
          speak('jarvis', conduct.envelope.say(
            `Correction: I said ${s.agent} was standing down, but that check read ${hit.source} — ` +
            `${s.agent}'s own system. The read stands; the stand-down claim does not.`));
        }
      }
    },
    onUpdate(snap) {
      if (closed || !snap) return;
      if (snap.status === 'resolved') {
        closed = true;
        const rounds = (snap.rounds || []).length;
        speak('jarvis', conduct.envelope.verdict(
          `Cause: ${snap.rootCause || (snap.fixPlan && snap.fixPlan.summary) || 'isolated — see the rounds above'}`,
          { cause: snap.rootCause || '', confidence: snap.confidence, rounds }));
        offerChange(snap);
        return;
      }
      if (['capped', 'stuck', 'blocked', 'reasoning-unavailable'].includes(snap.status)) {
        closed = true;
        speak('jarvis', conduct.envelope.say(snap.stuckReason || 'I stopped rather than claim a cause I have not proven.'));
      }
    },
  };
}

// A fixable cause becomes a CHANGE RECORD through the CW-2 engine, opened in the
// held-for-approval state. Nothing is applied and nothing is scheduled — the
// operator approves it (or does not) exactly as before.
function offerChange(snap) {
  const proposal = snap && snap.fixPlan && snap.fixPlan.proposal;
  if (!proposal || !ctx.proposeChange) return;
  try {
    const rec = ctx.proposeChange({
      device: proposal.device,
      commands: proposal.commands,
      reason: proposal.reason || `Fix for ${snap.id}: ${snap.rootCause || 'the isolated cause'}`,
    });
    if (!rec || !rec.id) return;
    speak('jarvis', conduct.envelope.change(
      `Fix drafted for ${proposal.device} — ${rec.id}, held for your approval. Nothing has run.`,
      // The steps shown are the ones the RECORD holds (reviewer finding #13) —
      // the approval card can never show a different list from what would run.
      { id: rec.id, steps: Array.isArray(rec.commands) && rec.commands.length ? rec.commands : proposal.commands }));
    ctx.log(`[Jarvis] Change ${rec.id} drafted from bridge ${snap.id} — held for approval, nothing applied`);
  } catch (err) {
    speak('jarvis', conduct.envelope.say(
      `I could not open the change record (${(err && err.message) || 'error'}), so nothing was drafted and nothing ran.`));
  }
}

// ── The bridge roster call ──────────────────────────────────────────────────
// Who is on this call and who stands down — reasoned, never keyed off words.
const ROSTER_SYSTEM =
`You are Jarvis, L4 / Principal Engineer, opening a P1 bridge on a live NOC. The problem is
already understood; your only job now is to say WHO IS ON THE CALL.
- "engaged": the smallest set of agents whose sight actually covers this problem, each with a
  one-line reason. Never pad it — an engineer on a call who has nothing to look at is noise,
  and every extra agent means an estate sweep the operator did not ask for.
- "stoodDown": the agents an operator might reasonably expect on this call that you are
  deliberately NOT engaging, each with a one-line reason. Leave it empty rather than invent one.
Only the agents listed can see the network, and each sees only what its "sees" line lists.
State no network fact — you have no data yet.`;

async function planBridgeRoster({ problem, understood, roster }) {
  const ids = (roster || []).map((a) => a.id);
  const entry = {
    type: 'object', additionalProperties: false,
    required: ['agentId', 'why'],
    properties: { agentId: { type: 'string', enum: ids }, why: { type: 'string' } },
  };
  const res = await claude.reason({
    system: ROSTER_SYSTEM,
    messages: [{ role: 'user', content:
      `Problem as the operator gave it: "${problem}"\n` +
      `Understood as: ${understood}\n\n` +
      `The squad (the only things that can see the network):\n${rosterTextFrom(roster)}\n\n` +
      `Name the bridge: who is engaged, and who stands down.` }],
    maxTokens: 2000, effort: 'high',
    format: { type: 'json_schema', schema: {
      type: 'object', additionalProperties: false,
      required: ['engaged', 'stoodDown'],
      properties: { engaged: { type: 'array', items: entry }, stoodDown: { type: 'array', items: entry } },
    } },
  });
  if (res.refused) throw new Error('reasoning declined');
  const p = JSON.parse(res.text);
  return {
    engaged: (Array.isArray(p.engaged) ? p.engaged : []).filter((e) => e && ids.includes(e.agentId)),
    stoodDown: (Array.isArray(p.stoodDown) ? p.stoodDown : []).filter((e) => e && ids.includes(e.agentId)),
  };
}

// ── SYNTHESIS with a one-shot neutral retry (class fix, 2026-08-19) ──────────
// The optional write-up/summary (Call 2) is sometimes DECLINED HTTP-200 by the
// safety classifier when the findings it must summarise contain device config,
// credential-looking strings, or HTML/script literals in a ticket title — all of
// which are legitimate DATA a read returned. We do ONE retry, on the SAME model,
// with those sensitive/hostile literals REDACTED/neutralised — secrets become
// [redacted], markup becomes an inert note — so the summariser never has to
// reproduce a credential or raw markup (this is data hygiene, and matches the
// secrets-never-persist rule). We deliberately do NOT switch to a more permissive
// model to get around a refusal — that would be defeating a safety guard, not a
// data fix. If the neutralised retry ALSO refuses, we relay the already-on-screen
// readings with a short, calm note. Touches the optional summary only; the reads
// ran at the wire and are unchanged.
//
// Returns { answer } | { answer, retried:true } | { relayed:true, why }. Throws
// only if the API call itself errors (network/timeout) — ask() relays on that too.
async function synthesizeAnswer(q, findings) {
  const list = Array.isArray(findings) ? findings : [];
  const block = list.map((f) => `[${f.name}] (${f.stance})\n${f.text}`).join('\n\n');
  const primary = await runSynthesis(q, block);
  if (!primary.refused) return { answer: primary.text };

  // One neutral retry on the SAME model: the sensitive/hostile literals are
  // redacted/neutralised (secrets → [redacted], markup → inert note) so the
  // summariser no longer has to reproduce a credential or raw <script>. If it
  // STILL refuses, we do NOT switch to a more permissive model to defeat the
  // refusal — we fall through to the honest short relay. The reads are on screen.
  const safeBlock = list.map((f) =>
    `[${f.name}] (${f.stance})\n${neutralizeFindingText(f.text)}`).join('\n\n');
  const retry = await runSynthesis(q, safeBlock);
  if (!retry.refused) return { answer: retry.text, retried: true };
  return { relayed: true, why: 'the write-up step was declined by the model' };
}

// One synthesis call. `model` null → the app default tier; a value → that tier
// (used for the fallback retry). Kept tiny so ask() and the test share one path.
function runSynthesis(q, findingsBlock, model = null) {
  return claude.reason({
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
    model,
  });
}

// Neutralise the hostile-LOOKING literals in ONE finding's text before it goes
// into the synthesis-retry prompt. These are DATA a read returned (a ticket title,
// a running-config, a leaked-cred banner) that the operator ALREADY saw verbatim
// per engineer — the summary does not need the live literals, only a faithful,
// inert description. HTML/script markup becomes an inert bracketed note; raw angle
// brackets become words; secret values and hash blobs become [redacted]. It never
// changes what was read; it only stops the summariser choking on device-config /
// credential / markup shapes it treats as unsafe to reproduce.
function neutralizeFindingText(text) {
  let s = String(text == null ? '' : text);
  // HTML/script-like markup → an inert note that keeps the tag name for the summary.
  s = s.replace(/<\s*\/?\s*([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g, (m, tag) => `[markup:${tag}]`);
  // Any remaining raw angle brackets → words, so nothing else reads as a tag.
  s = s.replace(/</g, '(lt)').replace(/>/g, '(gt)');
  // Hash/secret blobs ($1$…, $9$…, long hex) → [redacted] (the value, not the key).
  s = s.replace(/\$\d[\w$./]{6,}/g, '[redacted]').replace(/\b[0-9A-Fa-f]{16,}\b/g, '[redacted]');
  // Secret/credential-bearing values → [redacted]; the KEY word stays so the
  // summary can still say "a secret is set", just never the secret itself.
  s = s.replace(/\b(secret|password|passwd|community|tacacs-server key|key\s+\d+|md5)\b([^\n,;]*)/gi,
    (m, key) => `${key} [redacted]`);
  return s;
}

// Relay the already-on-screen readings when the optional write-up could not run
// even after the one neutral retry (declined both times, or the call errored). The
// reads already happened at the wire — safely, through the gate + guardrail — and
// each engineer's real output is ALREADY shown above, so this is deliberately a
// SHORT, calm one-liner, not a second big paragraph re-dumping every reading. It
// stays honest (nothing invented, nothing failed at the device) while being small
// and non-alarming — the fix for "it keeps on showing" a large scary block.
function relayFindings(q, findings, why) {
  const list = Array.isArray(findings) ? findings : [];
  const evidence = list.filter((f) => f.stance === 'evidence').length;
  ctx.say('jarvis', `🎖️ Summary skipped on this one — the raw readings from each engineer are above, all real.`);
  session.recordReasoning({
    command: 'SYNTHESIS',
    raw: `Relayed to the on-screen readings (${list.length} finding(s), ${evidence} live reading(s)); the write-up step did not run — ${why}.`,
    interpretation: 'The reads succeeded and ARE the answer; the optional composition step was skipped after a neutral retry, so Jarvis pointed to the real findings already on screen without a false refusal.',
  });
  ctx.status('jarvis', 'idle', 'Relayed to live findings (write-up step skipped)');
  ctx.log(`[Jarvis] Relayed to ${list.length} on-screen finding(s) without synthesis — ${why} — "${String(q).slice(0, 50)}"`);
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
    return txt ? softClip(txt, 600) : null;
  } catch (err) {
    return null;
  }
}

// ── CW-7: the INVESTIGATION planner (reasoning hooks for the loop engine) ────
// sources/investigation.js orchestrates the iterative loop deterministically;
// THIS object is the reasoning half — the four LLM steps the loop asks for. It is
// injected into the engine as the default planner so the engine never imports
// jarvis directly (that would make the loop impossible to test without the LLM).
//
// Every method reasons with a real Claude call and states ONLY what the evidence
// supports. There is NO keyword/decision-tree here: `probe` reads the current
// hypotheses + the real reports so far and the model picks the single
// highest-value unknown; `assess` narrows STRICTLY from the one real report it is
// given. `available()` is the honest-under-a-dead-LLM gate: no key → the engine
// stops and says "reasoning unavailable", never a canned investigation.
function investigationAvailable() { return claude.hasKey(); }

// Compact renderings the reasoning calls read.
function hypothesesText(hyps) {
  if (!Array.isArray(hyps) || !hyps.length) return '(none yet)';
  return hyps.map((h) => `- [${h.id}] (${h.status || 'standing'}) ${h.text}`).join('\n');
}
function roundsText(rounds) {
  if (!Array.isArray(rounds) || !rounds.length) return '(no probes run yet)';
  return rounds.map((r) =>
    `Round ${r.round} — asked ${r.agent}: "${r.probe && r.probe.question}"\n` +
    `  ${r.report && r.report.stance}: ${String((r.report && r.report.text) || '').slice(0, 500)}`).join('\n');
}
function rosterTextFrom(roster) {
  return (roster || []).map((a) => {
    const head = `- ${a.id} (${a.name})` + (a.connected ? '' : ' [NOT CONNECTED]');
    const sees = a.sees && a.sees.length ? `\n    sees: ${a.sees.join('; ')}` : '';
    return head + sees;
  }).join('\n');
}

const INV_UNDERSTAND_SYSTEM =
`You are Jarvis, L4 / Principal Engineer, about to run an ITERATIVE investigation on a live NOC.

FIRST decide, in "problemReport", whether the operator is actually REPORTING A PROBLEM with the
network ("epg is not reachable", "branch users can't get to the app", "the fabric went down at
2pm") — true — or doing something else entirely: greeting you, asking what you can do, asking a
question about the estate or an incident, or telling you to run a specific command ("run show
version on sw2", "who is on INC-20260817-013?"). Those are false. Reason about what they MEAN;
never decide this from keywords. Everything below only matters when problemReport is true — when
it is false, set specific=true, questions to an empty list, and do not grill anyone.

WHEN THE OPERATOR IS REPLYING to clarifying questions you already asked, you are also given
their latest reply on its own. Judge it in "replyIntent":
  - "answers"   — it narrows the SAME problem (even partially, even badly).
  - "new-topic" — they are now talking about a DIFFERENT problem or asking something else.
  - "abandons"  — they are dropping it ("never mind", "forget it", "what can you do?").
Only "answers" may continue the parked problem; the other two mean it is finished. Never treat
a change of subject as an answer, and never assume: judge what they MEAN. When you are not
replying to questions, set replyIntent to "answers".

Before probing anything you must decide whether the problem is SPECIFIC ENOUGH to investigate.
A problem is specific enough when you can name a first read-only check worth running — it has
enough of a symptom, a scope (a device/site/front) and/or a timeframe to act on.
If it is TOO VAGUE ("the network is slow", "something is wrong") — no scope, no timeframe, no
target you could probe — set specific=false and ask the OPERATOR 1-3 pointed clarifying questions
that would let you start (which sites/devices, since when, what exactly is failing). Do NOT guess a
scope and investigate it. When it IS specific, set specific=true, state the understood problem in
one plain sentence, and list your initial candidate hypotheses (unproven, to be tested by probes).
State no network fact — you have no data yet; these are hypotheses to test, not findings.

ALSO decide which NOC fronts are actually worth reading for THIS problem, and return them in
"relevantFronts" as a subset of exactly these four keys:
  - campus    → Catalyst campus switches / access + distribution (user-edge reachability, LAN)
  - fabric    → ACI data-center fabric (leaf/spine, tenants/EPGs — data-center apps)
  - wan       → SD-WAN / vManage (branch↔hub overlay, circuits, tunnels)
  - incidents → currently-open Catalyst issues + ACI faults (estate-wide fault backdrop)
Pick ONLY the fronts a competent NOC engineer would actually look at for this symptom — e.g. a single
user who cannot reach one website is a campus/edge + DNS/upstream question, NOT a data-center fabric
or SD-WAN overlay question, so relevantFronts would be ["campus"] (add "incidents" only if a
same-time estate fault could plausibly explain it). If you genuinely cannot tell which fronts matter,
return an EMPTY relevantFronts array (all fronts will then be read). Never pad the list to look
thorough — an irrelevant front swept is noise that buries the real signal.`;

const INV_PROBE_SYSTEM =
`You are Jarvis, L4 / Principal Engineer, mid-investigation on a live NOC. You have a set of standing
hypotheses and the real reports from the probes run so far. Choose the SINGLE highest-value next
probe — the ONE read-only check that would most narrow the hypothesis set (confirm or eliminate the
most). Delegate it to the RIGHT agent from the roster (only those agents can see the network, and
only what their "sees" line lists). The probe MUST be read-only (show / ping / traceroute / dir /
more, or a read query an agent already supports) — never a change. For a device-CLI probe put the
target device in "device" as its bare name or mgmt IP; else null. If NOTHING you can reach would
narrow this further — you need a device you cannot reach, an operator input, or credentials you do
not have — set "stuck" to a plain sentence saying exactly what it needs, and pick no probe. Never
invent a probe just to look busy; a real dead-end is an honest stuck, not a wasted round.`;

const INV_ASSESS_SYSTEM =
`You are Jarvis, L4 / Principal Engineer, narrowing an investigation from ONE real agent report.
You are given the standing hypotheses, the probe you just ran, and the REAL report it returned.
Update the hypothesis set using ONLY that report plus what was already established:
- mark each hypothesis standing / eliminated / confirmed, and keep its short text.
- set confidence: a number 0..1 for how confident you are in the leading (confirmed or most likely)
  cause. It is HIGH only when a hypothesis is genuinely confirmed by a real report; keep it low while
  causes are still open, and DO NOT inflate it — a false certainty is a defect. If the report was an
  honest "not connected / unreachable / denied", it eliminated nothing: leave confidence where it was
  and say so in the note.
Never confirm a cause the report does not actually support, and never state a device/number not in it.`;

const INV_FIX_SYSTEM =
`You are Jarvis, L4 / Principal Engineer, closing an investigation whose root cause is now isolated.
Compose a fix, grounded ONLY in the evidence gathered (the rounds/reports). Return:
- rootCause: the isolated cause in one plain sentence, citing what proved it.
- summary: the fix plan in plain words a NOC engineer can act on.
- proposal: if (and only if) the fix is a CONFIG CHANGE on a device we can name, return
  { device, commands:[exact config lines], reason }. It will be routed through the change engine as
  an approve-FIRST proposal — never applied automatically — so give the real lines. If the fix is
  manual/external (replace hardware, call a carrier, an operator action), set proposal to null and put
  the steps in summary. Never propose a change the evidence does not justify.`;

async function invUnderstand({ problem, operatorTz, answers, reply }) {
  const format = { type: 'json_schema', schema: {
    type: 'object', additionalProperties: false,
    required: ['problemReport', 'replyIntent', 'specific', 'understood', 'hypotheses', 'questions', 'relevantFronts'],
    properties: {
      // CW-9 (resume): does the operator's latest reply answer the parked
      // questions, change the subject, or drop it? An abandoned problem must
      // never be quietly investigated anyway.
      replyIntent: { type: 'string', enum: ['answers', 'new-topic', 'abandons'] },
      // CW-9: is this a problem report at all? The shared conduct gate only
      // narrows PROBLEMS — a greeting or a direct command is never grilled.
      problemReport: { type: 'boolean' },
      specific: { type: 'boolean' },
      understood: { type: 'string' },
      hypotheses: { type: 'array', items: { type: 'object', additionalProperties: false,
        required: ['id', 'text'], properties: { id: { type: 'string' }, text: { type: 'string' } } } },
      questions: { type: 'array', items: { type: 'string' } },
      // Which of the four live NOC fronts are worth reading for THIS problem.
      // A subset of campus/fabric/wan/incidents; empty = "cannot tell, read all".
      relevantFronts: { type: 'array', items: { type: 'string', enum: ['campus', 'fabric', 'wan', 'incidents'] } },
    },
  } };
  const answerBlock = (answers && answers.length)
    ? `\n\nThe operator has since answered your clarifying questions:\n` +
      answers.map((a) => `- ${a.text || a}`).join('\n')
    : '';
  const res = await claude.reason({
    system: INV_UNDERSTAND_SYSTEM,
    messages: [{ role: 'user', content:
      `Current time (UTC): ${new Date().toISOString()}${operatorTz ? `  Operator timezone: ${operatorTz}` : ''}\n\n` +
      `Problem the operator gave:\n"${String(problem || '')}"${answerBlock}` +
      (reply ? `\n\nTheir LATEST reply, to the clarifying questions you asked:\n"${String(reply)}"\n` +
        `Judge it in replyIntent: does it answer those questions, change the subject, or abandon the problem?` : '') +
      `\n\nDecide if this is specific enough to start probing. If not, ask; if yes, state it + initial hypotheses.` }],
    maxTokens: 3000, effort: 'high', format,
  });
  if (res.refused) throw new Error('reasoning declined');
  const p = JSON.parse(res.text);
  return {
    // Additive: investigation.js and triage.js ignore problemReport; the CW-9
    // conduct gate uses it to keep its hands off anything that is not a problem.
    problemReport: p.problemReport !== false,
    // 'answers' | 'new-topic' | 'abandons' — only meaningful on a resume.
    replyIntent: ['answers', 'new-topic', 'abandons'].includes(p.replyIntent) ? p.replyIntent : 'answers',
    specific: p.specific !== false,
    understood: p.understood || String(problem || ''),
    hypotheses: Array.isArray(p.hypotheses) ? p.hypotheses : [],
    questions: Array.isArray(p.questions) ? p.questions : [],
    // Additive (investigation.js ignores it; triage.js uses it to scope the sweep).
    relevantFronts: Array.isArray(p.relevantFronts) ? p.relevantFronts : [],
  };
}

async function invProbe({ problem, understood, hypotheses, rounds, roster }) {
  const format = { type: 'json_schema', schema: {
    type: 'object', additionalProperties: false,
    required: ['stuck', 'agentId', 'question', 'device', 'rationale'],
    properties: {
      stuck: { type: ['string', 'null'] },
      // Nullable enum: a strict json_schema validator rejects `enum` combined with
      // a `type` ARRAY (it flags each string enum value as "not matching type
      // ['string','null']"). anyOf expresses "one of the agent ids, OR null"
      // correctly — the agent to task, or null when the planner is stuck.
      agentId: { anyOf: [{ type: 'string', enum: (roster || []).map((a) => a.id) }, { type: 'null' }] },
      question: { type: ['string', 'null'] },
      device: { type: ['string', 'null'] },
      rationale: { type: ['string', 'null'] },
    },
  } };
  const res = await claude.reason({
    system: INV_PROBE_SYSTEM,
    messages: [{ role: 'user', content:
      `Understood problem: ${understood || problem}\n\n` +
      `Agents you can task (the only things that see the network):\n${rosterTextFrom(roster)}\n\n` +
      `Standing hypotheses:\n${hypothesesText(hypotheses)}\n\n` +
      `Probes run so far and their REAL reports:\n${roundsText(rounds)}\n\n` +
      `Pick the single highest-value next read-only probe, or set "stuck".` }],
    maxTokens: 2500, effort: 'high', format,
  });
  if (res.refused) throw new Error('reasoning declined');
  const p = JSON.parse(res.text);
  if (p.stuck && String(p.stuck).trim()) return { stuck: String(p.stuck).trim() };
  if (!p.agentId || !p.question) return { stuck: 'The model returned no runnable probe and no reason — stopping rather than guessing.' };
  return { agentId: p.agentId, question: p.question, device: p.device || null, incidentId: null, rationale: p.rationale || null };
}

async function invAssess({ understood, hypotheses, probe, report }) {
  const format = { type: 'json_schema', schema: {
    type: 'object', additionalProperties: false,
    required: ['hypotheses', 'confidence', 'note'],
    properties: {
      hypotheses: { type: 'array', items: { type: 'object', additionalProperties: false,
        required: ['id', 'text', 'status'],
        properties: { id: { type: 'string' }, text: { type: 'string' },
          status: { type: 'string', enum: ['standing', 'eliminated', 'confirmed'] } } } },
      confidence: { type: 'number' },
      note: { type: 'string' },
    },
  } };
  const res = await claude.reason({
    system: INV_ASSESS_SYSTEM,
    messages: [{ role: 'user', content:
      `Understood problem: ${understood}\n\n` +
      `Standing hypotheses:\n${hypothesesText(hypotheses)}\n\n` +
      `Probe just run — ${probe.agentName || probe.agentId}: "${probe.question}"\n` +
      `REAL report (your ONLY new evidence):\n${RULE}\n[${report.stance}] ${report.text}\n${RULE}\n\n` +
      `Update the hypotheses (standing/eliminated/confirmed) and set confidence 0..1.` }],
    maxTokens: 2500, effort: 'high', format,
  });
  if (res.refused) throw new Error('reasoning declined');
  const p = JSON.parse(res.text);
  return {
    hypotheses: Array.isArray(p.hypotheses) ? p.hypotheses : hypotheses,
    confidence: typeof p.confidence === 'number' ? p.confidence : 0,
    note: p.note || '',
  };
}

async function invFix({ understood, hypotheses, rounds, rootCause }) {
  const format = { type: 'json_schema', schema: {
    type: 'object', additionalProperties: false,
    required: ['rootCause', 'summary', 'proposal'],
    properties: {
      rootCause: { type: 'string' },
      summary: { type: 'string' },
      proposal: { type: ['object', 'null'], additionalProperties: false,
        required: ['device', 'commands', 'reason'],
        properties: { device: { type: 'string' }, commands: { type: 'array', items: { type: 'string' } },
          reason: { type: 'string' } } },
    },
  } };
  const res = await claude.reason({
    system: INV_FIX_SYSTEM,
    messages: [{ role: 'user', content:
      `Understood problem: ${understood}\n\n` +
      `Final hypotheses:\n${hypothesesText(hypotheses)}\n` +
      (rootCause ? `Isolated root cause: ${rootCause}\n` : '') + `\n` +
      `The evidence (every real probe report):\n${roundsText(rounds)}\n\n` +
      `Compose the root cause + fix plan. A config fix → a proposal; a manual fix → proposal null.` }],
    maxTokens: 3000, effort: 'high', format,
  });
  if (res.refused) throw new Error('reasoning declined');
  const p = JSON.parse(res.text);
  return { rootCause: p.rootCause || rootCause || '', summary: p.summary || '', proposal: p.proposal || null };
}

const investigationPlanner = {
  available: investigationAvailable,
  understand: invUnderstand,
  probe: invProbe,
  assess: invAssess,
  fix: invFix,
};

// CW-9 — the reasoning half of the SHARED conduct gate. It is deliberately the
// SAME understanding call the investigation loop and the triage intake use, so
// chat, intake and any future entry point can never drift into different
// behaviour. That drift is exactly what produced the 2026-08-19 failure.
const conductPlanner = {
  available: investigationAvailable,
  understand: invUnderstand,
};

module.exports = {
  init, ask, keyStatus, extractSymptom, rankBlindSpots, synthesizeTriageVerdict, narrateCorrelation,
  // CW-7: the reasoning planner injected into the investigation loop engine.
  investigationPlanner,
  // CW-9: the reasoning planner injected into the shared conduct gate.
  conductPlanner,
  // Exposed for the QA CLASS 6 offline test only (the always-surfaces guarantee):
  // a delegated read that hangs / rejects / returns null-or-empty must resolve to
  // an explicit honest finding, never silence.
  _test: { gatherGuarded, GATHER_TIMEOUT_MS, softClip, abilitiesText,
    // CW-9: the bridge pieces, exercised offline with a stubbed planner.
    askNarrowing, emitFindings, bridgeObserver, runBridge, planAndAnswer, speak,
    // 2026-08-19 synthesis-refusal class fix: the one-shot neutral retry + the
    // short honest fallback, exercised offline with a mocked claude.reason.
    synthesizeAnswer, relayFindings, neutralizeFindingText },
};
