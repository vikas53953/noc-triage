// conduct.js — CW-9, the ONE bridge-conduct layer.
//
// Plain words: this is how Jarvis BEHAVES on a bridge, in one place, for EVERY
// operator entry point (the chat, the triage intake, and any path added later).
// It owns two things and nothing else:
//
//   1. THE UNDERSTANDING GATE. A problem report that is too vague to act on gets
//      up to 3 narrowing questions BEFORE any agent is engaged and before a
//      single read runs. The operator's answer resumes the SAME understanding
//      (remembered for that conversation), so nobody is asked twice.
//   2. THE PINNED MESSAGE ENVELOPE. say / ask / roster / finding / verdict /
//      change, with the hard caps enforced HERE, in code — Jarvis text ≤ 280
//      chars, finding.line ≤ 200 — so "keep it short" is a property of the
//      system, not a hope pinned on a prompt.
//
// THE DEFECT THIS FIXES (2026-08-19, squad/data/chat/chat-history.json): "hey
// jarvis facing issue in epg" → two engineers engaged, the estate swept, walls
// of raw agent text posted, and "You didn't name the EPG" said at the END. The
// class-level cause was a PER-PATH fix: ask-first had been built into the triage
// intake only, so the chat path still swept first and asked last. One shared
// gate is the class fix — there are no path-specific conduct rules any more.
//
// INTENT-FIRST (HANDOFF law). Nothing here decides by keyword or regex whether a
// message is a problem report or whether it is specific enough — an injected
// PLANNER (the LLM) decides both. This file only orchestrates: it remembers the
// thread, counts ask rounds, enforces the caps, and shapes the envelope. With no
// planner it says so honestly and gets out of the way; it never invents a
// question, an answer, or a verdict.
//
// TESTABLE WITHOUT CREDITS. setPlanner() takes a scripted planner, so the whole
// gate (vague → ask → answer → proceed), the caps and the envelope shapes are
// deterministically testable offline. The real planner (sources/jarvis.js →
// conductPlanner) drops into the same seam unchanged.

// ── Hard caps (contract-pinned, enforced in code) ───────────────────────────
const TEXT_MAX = 280;      // any jarvis say/ask text
const LINE_MAX = 200;      // finding.line — one sentence of meaning
const MAX_QUESTIONS = 3;   // narrowing questions per ask
// How many times one thread may be sent back for narrowing before Jarvis works
// with what it has. Without this an unhelpful answer could loop the operator
// forever; with it, the worst case is that Jarvis engages on a thin problem and
// says so, which is what a real call leader does.
const MAX_ASK_ROUNDS = 2;

// The only transports that may ever be claimed. A Command Runner read is
// 'cmdrunner' — NEVER dressed up as 'ssh'. Anything that is not a device CLI
// session is an 'api' read.
const TRANSPORTS = ['ssh', 'cmdrunner', 'api'];

// ── Word-safe clipping ──────────────────────────────────────────────────────
// Never cut an operator-facing line mid-word (the junior-UX law). Prefers a
// sentence boundary, falls back to the last whole word, and marks the cut with
// an honest ellipsis so a clipped line never pretends to be complete.
function clip(text, max) {
  // Line breaks are meaning (a question list is not one run-on line), so only
  // runs of spaces/tabs collapse — newlines survive the cap.
  const s = String(text == null ? '' : text)
    .replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (s.length <= max) return s;
  const slice = s.slice(0, max - 2);
  const sentence = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('! '), slice.lastIndexOf('? '));
  if (sentence >= max * 0.6) return slice.slice(0, sentence + 1).trim();
  const space = slice.lastIndexOf(' ');
  return (space > 0 ? slice.slice(0, space) : slice).trim() + ' …';
}

function capText(text) { return clip(text, TEXT_MAX); }
// A finding line is ONE sentence of meaning, so it is flattened to one line
// before the cap — no smuggling a wall of output in behind newlines.
function capLine(text) { return clip(String(text == null ? '' : text).replace(/\s+/g, ' '), LINE_MAX); }

// ── The pinned envelope ─────────────────────────────────────────────────────
// Each builder returns the ADDITIVE fields that ride on the existing
// chat_message payload — `kind` plus whatever that kind carries. Old clients
// that only read `text` keep working exactly as before.

function sayMsg(text) {
  return { kind: 'say', text: capText(text) };
}

function askMsg(text, questions) {
  const qs = (Array.isArray(questions) ? questions : [])
    .map((q) => capText(q))
    .filter(Boolean)
    .slice(0, MAX_QUESTIONS);
  return { kind: 'ask', text: capText(text), questions: qs };
}

function rosterEntry(e) {
  return { agent: String((e && (e.agent || e.name || e.agentId)) || '').trim(), why: capLine((e && e.why) || '') };
}

function rosterMsg(text, engaged, stoodDown) {
  return {
    kind: 'roster',
    text: capText(text),
    roster: {
      engaged: (Array.isArray(engaged) ? engaged : []).map(rosterEntry).filter((e) => e.agent),
      stoodDown: (Array.isArray(stoodDown) ? stoodDown : []).map(rosterEntry).filter((e) => e.agent),
    },
  };
}

// The honest transport label. An unrecognised label is NOT guessed into 'ssh' —
// anything that is not a known device-CLI session is reported as an API read.
function transportOf(value) {
  const v = String(value || '').toLowerCase().trim();
  if (v === 'ssh') return 'ssh';
  if (v === 'cmdrunner' || v === 'command-runner' || v === 'commandrunner') return 'cmdrunner';
  return 'api';
}

function cliOf(cli) {
  if (!cli || typeof cli !== 'object') return null;
  return {
    host: String(cli.host || '').trim() || 'unknown host',
    command: String(cli.command || '').trim(),
    // RAW output (already secret-scrubbed upstream by the session log). It is
    // never summarised away and never re-typed into `text` — it travels ONLY
    // here, and the UI escapes it at the sink.
    output: cli.output == null ? '' : String(cli.output),
    transport: transportOf(cli.transport),
  };
}

// A finding: ONE sentence of meaning + the terminal evidence behind it. The raw
// output may never appear in the message text — that is the wall-of-text defect.
function findingMsg({ agent, line, cli }) {
  const one = capLine(line);
  return {
    kind: 'finding',
    text: one,
    finding: { agent: String(agent || '').trim(), line: one, cli: cliOf(cli) },
  };
}

function verdictMsg(text, { cause, confidence, rounds } = {}) {
  return {
    kind: 'verdict',
    text: capText(text),
    verdict: {
      cause: capText(cause),
      confidence: typeof confidence === 'number' ? Math.max(0, Math.min(1, confidence)) : null,
      rounds: Number.isFinite(rounds) ? rounds : null,
    },
  };
}

// A change is ALWAYS held for approval — the gate law is unchanged, nothing
// here can apply anything.
function changeMsg(text, { id, steps } = {}) {
  return {
    kind: 'change',
    text: capText(text),
    change: {
      id: String(id || ''),
      steps: (Array.isArray(steps) ? steps : []).map((s) => String(s)).filter(Boolean),
      state: 'held-for-approval',
    },
  };
}

const envelope = { say: sayMsg, ask: askMsg, roster: rosterMsg, finding: findingMsg, verdict: verdictMsg, change: changeMsg };

// ── The injected planner (the LLM half) ─────────────────────────────────────
// planner = { available(): boolean,
//             understand({ problem, operatorTz, answers }) -> {
//               problemReport, specific, understood, questions[], hypotheses[], relevantFronts[] } }
let planner = null;
function setPlanner(p) { planner = p || null; }
function getPlanner() { return planner; }
function available() {
  return Boolean(planner && typeof planner.understand === 'function'
    && (typeof planner.available !== 'function' || planner.available()));
}

// ── Thread memory (per conversation, like PR #46's device memory) ────────────
// Scoped to ONE conversation id — never global, never across operators.
const threads = new Map();

function threadFor(conversationId) {
  return threads.get(String(conversationId || 'default')) || null;
}

function pending(conversationId) {
  const t = threadFor(conversationId);
  return t && t.status === 'awaiting-info' ? { ...t, answers: t.answers.slice(), questions: t.questions.slice() } : null;
}

function clear(conversationId) {
  threads.delete(String(conversationId || 'default'));
}

function saveThread(conversationId, t) {
  threads.set(String(conversationId || 'default'), t);
  return t;
}

// ── The gate ────────────────────────────────────────────────────────────────
/**
 * Decide what this operator message deserves BEFORE anything is engaged.
 *
 * Returns one of:
 *   { decision:'unavailable', why }            — no reasoning available; the caller
 *                                                falls back to its own honest path.
 *   { decision:'not-a-problem', understood }   — not a problem report (a question,
 *                                                a greeting, a command): the caller's
 *                                                normal path handles it.
 *   { decision:'ask', questions, message }     — underspecified: ask and run NOTHING.
 *   { decision:'proceed', problem, understood, hypotheses, relevantFronts, answers, asked }
 *
 * Nothing here reads the network or engages an agent; that is the whole point.
 */
async function assess({ conversationId, text, operatorTz } = {}) {
  const said = String(text || '').trim();
  if (!available()) {
    return { decision: 'unavailable', why: 'no reasoning planner is wired up or it has no key' };
  }

  const open = pending(conversationId);
  // An open thread means this message is the ANSWER to the questions already
  // asked — the understanding resumes, it does not restart.
  const problem = open ? open.problem : said;
  const answers = open ? open.answers.concat([said]) : [];
  const askRounds = open ? open.askRounds : 0;

  let u;
  try {
    u = await planner.understand({ problem, operatorTz: operatorTz || null, answers: answers.slice() });
  } catch (err) {
    return { decision: 'unavailable', why: (err && err.message) || 'the understanding step failed' };
  }

  const understood = (u && u.understood) || problem;
  const hypotheses = (u && Array.isArray(u.hypotheses)) ? u.hypotheses : [];
  const relevantFronts = (u && Array.isArray(u.relevantFronts)) ? u.relevantFronts : [];

  // Not a problem report at all (a greeting, a meta ask, "run show version on
  // sw2") — the gate stays out of the way. It never asks narrowing questions
  // about something that is not a problem.
  if (u && u.problemReport === false && !open) {
    clear(conversationId);
    return { decision: 'not-a-problem', understood };
  }

  const vague = Boolean(u && u.specific === false);
  if (vague && askRounds < MAX_ASK_ROUNDS) {
    const questions = (Array.isArray(u.questions) ? u.questions : [])
      .map((q) => String(q || '').trim())
      .filter(Boolean)
      .slice(0, MAX_QUESTIONS);
    const asked = questions.length
      ? questions
      : ['Which device, EPG or site is affected — and since when?'];
    saveThread(conversationId, {
      problem, answers, questions: asked, askRounds: askRounds + 1,
      status: 'awaiting-info', understood, hypotheses, relevantFronts,
      updatedAt: new Date().toISOString(),
    });
    return {
      decision: 'ask',
      questions: asked,
      problem,
      understood,
      // The short line that goes with the questions — composed by the caller if
      // it has something better; this is the honest default.
      message: capText(`Before I pull anyone in, ${asked.length === 1 ? 'one question' : `${asked.length} quick questions`} so I scope this right — I have run nothing yet.`),
    };
  }

  // Specific enough (or we already asked our rounds and will work with what we
  // have, saying so). Engagement may now begin.
  saveThread(conversationId, {
    problem, answers, questions: [], askRounds,
    status: 'engaged', understood, hypotheses, relevantFronts,
    updatedAt: new Date().toISOString(),
  });
  return {
    decision: 'proceed',
    problem,
    understood,
    hypotheses,
    relevantFronts,
    answers: answers.slice(),
    asked: askRounds > 0,
    // TRUE when we ran out of narrowing rounds and are proceeding on a thin
    // problem — the caller says so out loud rather than pretending it is clear.
    thin: vague,
  };
}

/**
 * The triage intake's understanding step, served by the SAME module and the SAME
 * planner as the chat gate (that is the class law for this wave). Shape is
 * exactly what sources/triage.js already expects, so the intake is unchanged.
 */
async function understand({ problem, priorAnswers, operatorTz } = {}) {
  if (!available()) throw new Error('no reasoning planner available');
  const u = await planner.understand({
    problem, operatorTz: operatorTz || null, answers: Array.isArray(priorAnswers) ? priorAnswers : [],
  });
  return {
    specific: !(u && u.specific === false),
    understood: (u && u.understood) || String(problem || ''),
    hypotheses: (u && Array.isArray(u.hypotheses)) ? u.hypotheses : [],
    questions: (u && Array.isArray(u.questions)) ? u.questions.map(String).filter(Boolean).slice(0, MAX_QUESTIONS) : [],
    relevantFronts: (u && Array.isArray(u.relevantFronts)) ? u.relevantFronts : [],
  };
}

module.exports = {
  setPlanner, getPlanner, available,
  assess, understand,
  pending, clear,
  envelope,
  capText, capLine, transportOf,
  TEXT_MAX, LINE_MAX, MAX_QUESTIONS, MAX_ASK_ROUNDS, TRANSPORTS,
  // Exposed for the deterministic tests only.
  _threads: threads,
};
