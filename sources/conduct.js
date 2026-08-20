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

// Deterministic safety only (never routing, never answering): the clause-level
// write screen the CLI choke point already uses. Here it is the BACKSTOP behind
// the LLM's own judgement, so a change ask is never met with silence.
const guardrails = require('./guardrails');

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

// How much RAW output one terminal block carries into the chat (and onto disk).
// A 20 KB APIC JSON body per finding turned chat-history.json into 267 KB in 34
// messages and shipped the wall of text into the terminal pane (reviewer finding
// #8). The block is capped with the SAME honest truncation marker the session log
// uses, and it names where the untruncated read still lives — nothing is hidden,
// and no read is silently shortened.
const OUTPUT_MAX = Number(process.env.CW9_CLI_OUTPUT_MAX) > 0
  ? Number(process.env.CW9_CLI_OUTPUT_MAX) : 4000;

function capOutput(text) {
  const s = text == null ? '' : String(text);
  if (s.length <= OUTPUT_MAX) return s;
  return s.slice(0, OUTPUT_MAX) +
    `\n… (${s.length - OUTPUT_MAX} more chars truncated — full read in the CLI/session view, /api/session)`;
}

function cliOf(cli) {
  if (!cli || typeof cli !== 'object') return null;
  return {
    host: String(cli.host || '').trim() || 'unknown host',
    command: String(cli.command || '').trim(),
    // RAW output (already secret-scrubbed upstream by the session log). It is
    // never summarised away and never re-typed into `text` — it travels ONLY
    // here, capped with an honest marker, and the UI escapes it at the sink.
    output: capOutput(cli.output),
    transport: transportOf(cli.transport),
    // Which source system this read touched (roster-truth checking + the UI's
    // caption). Never guessed: it comes from the record that made the call.
    source: cli.source ? String(cli.source) : null,
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

// CW-11 Part 2 (ADDITIVE): a verdict may now carry the result of the self-check —
// which claims were traced to a real evidence record from THIS incident
// (`verified`) and which were not and are therefore labelled suspected —
// unverified (`suspected`). Both default to empty, so every pre-CW-11 caller and
// every old client sees exactly the verdict it saw before.
function verdictMsg(text, { cause, confidence, rounds, verified, suspected, causeSupported } = {}) {
  return {
    kind: 'verdict',
    text: capText(text),
    verdict: {
      cause: capText(cause),
      confidence: typeof confidence === 'number' ? Math.max(0, Math.min(1, confidence)) : null,
      rounds: Number.isFinite(rounds) ? rounds : null,
      verified: (Array.isArray(verified) ? verified : []).map((v) => ({
        claim: capLine(v && v.claim),
        evidenceIds: (Array.isArray(v && v.evidenceIds) ? v.evidenceIds : []).map(String).filter(Boolean),
      })).filter((v) => v.claim),
      suspected: (Array.isArray(suspected) ? suspected : []).map((s) => ({
        claim: capLine(s && s.claim),
        why: capLine((s && s.why) || 'no reading from this incident backs it'),
      })).filter((s) => s.claim),
      // null when the self-check did not run at all (nothing is dressed up either way).
      causeSupported: typeof causeSupported === 'boolean' ? causeSupported : null,
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

// ── Evidence identity: is this the same check we already showed? ────────────
// (re-review M1). Signing on the literal command let a cache-buster defeat the
// round dedupe: `/network-health?timestamp=1787207261737` and
// `/network-health?timestamp=1787207291757` are the SAME read, and announcing
// the second as a new check — with an identical body and an identical finding
// line — is the "says more than it does" defect in miniature.
//
// Two keys, and a repeat on EITHER means it is not new:
//   • identityKey — method + path + the stable query params (volatile ones
//     dropped, the rest sorted so order cannot fake a difference);
//   • outputKey   — the source plus a hash of the raw output, which catches a
//     re-read that arrives under a different URL entirely.
const VOLATILE_PARAMS = /^(?:_|t|ts|time|timestamp|nonce|rand|random|cache|cachebust|cb|__|v|version_ts|epoch|requestid|request_id|traceid|trace_id)$/i;

function normalizeCommand(command) {
  const raw = String(command || '').trim();
  const qi = raw.indexOf('?');
  if (qi < 0) return raw;
  const head = raw.slice(0, qi);
  // The trailing "(fetch command output)"-style annotation the session log adds
  // must survive; split it off the query string before parsing.
  const rest = raw.slice(qi + 1);
  const spaceAt = rest.search(/\s/);
  const query = spaceAt < 0 ? rest : rest.slice(0, spaceAt);
  const tail = spaceAt < 0 ? '' : rest.slice(spaceAt);
  const kept = query.split('&')
    .filter(Boolean)
    .filter((pair) => !VOLATILE_PARAMS.test(decodeURIComponent(pair.split('=')[0] || '')))
    .sort();
  return head + (kept.length ? `?${kept.join('&')}` : '') + tail;
}

// Small, fast, dependency-free content hash (djb2). Not a security hash — it
// only answers "is this the same body we already showed?".
function hashOf(text) {
  const s = String(text == null ? '' : text);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return `${s.length}:${h.toString(36)}`;
}

function identityKey(entry) {
  return `${(entry && entry.source) || 'unknown'}|${normalizeCommand(entry && entry.command)}`;
}
function outputKey(entry) {
  return `${(entry && entry.source) || 'unknown'}|${hashOf(entry && entry.output)}`;
}

// ── The shared write screen (re-review F1) ──────────────────────────────────
// A CHANGE ASK MAY NEVER BE MET WITH SILENCE. The old screen only ran when
// `isDeviceCliRequest()` said the text was a device-CLI request — which is false
// for "reload sw2" and for a scoping answer with a reload tacked on, so the
// refusal branch could never fire and the operator was told nothing at all.
//
// This screen lives at the conduct layer, so EVERY operator entry point gets it,
// and it works on the operator's own text. It has two halves, in the order the
// intent-first law demands:
//   • the LLM's judgement (`changeAsk` from the understanding) decides what the
//     operator MEANT — that is reasoning, and it is primary;
//   • this deterministic clause screen is the SAFETY BACKSTOP behind it, so a
//     change ask the model missed is still acknowledged.
// Neither half BLOCKS anything: the change is refused out loud and the rest of
// the message carries on being understood. Nothing here can run a change; the
// gate + choke point are unchanged.
function writeAsk(text) {
  try {
    const v = guardrails.splitIntent(String(text || ''));
    if (!v || !v.destructive || !v.change) return null;
    return { keyword: v.change.keyword, clause: v.change.clause || String(text || ''), source: 'guardrail' };
  } catch (e) { return null; }
}

// The one honest sentence said when the operator asks for a change on a
// read-only path. Built here so chat, intake and any future path say the same.
function writeRefusalText(ask) {
  const what = capLine((ask && (ask.clause || ask.keyword)) || 'that');
  return `That is a change ("${what}") — this path is read-only, so I have not done it and nothing was sent to any device. ` +
    `Changes go through the change engine, approve-first.`;
}

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

// Bounded (reviewer finding #14): a console left running for weeks must not
// accumulate threads forever. Oldest-first eviction, and a thread is only ever
// a few short strings.
const MAX_THREADS = 200;
function saveThread(conversationId, t) {
  const key = String(conversationId || 'default');
  threads.delete(key);          // re-insert so Map order is least-recent-first
  threads.set(key, t);
  while (threads.size > MAX_THREADS) threads.delete(threads.keys().next().value);
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
async function assess({ conversationId, text, operatorTz, _depth } = {}) {
  const said = String(text || '').trim();
  if (!available()) {
    // No planner at all (no key / not wired). The caller keeps its own honest
    // path — this is not a reasoning FAILURE, it is reasoning being absent.
    // Even with no reasoning at all, a change ask is acknowledged, never met
    // with silence — the deterministic screen is the safety net.
    return { decision: 'unavailable', reason: 'no-planner', changeAsk: writeAsk(said),
      why: 'no reasoning planner is wired up or it has no key' };
  }

  const open = pending(conversationId);
  // An open thread means this message is the ANSWER to the questions already
  // asked — the understanding resumes, it does not restart.
  const problem = open ? open.problem : said;
  const answers = open ? open.answers.concat([said]) : [];
  const askRounds = open ? open.askRounds : 0;

  let u;
  try {
    u = await planner.understand({
      problem, operatorTz: operatorTz || null, answers: answers.slice(),
      // The LATEST reply, given separately on a resume so the planner can judge
      // whether it answers the questions, changes the subject, or abandons the
      // problem entirely (reviewer finding #5).
      reply: open ? said : null,
    });
  } catch (err) {
    return { decision: 'unavailable', reason: 'failed', changeAsk: writeAsk(said),
      why: (err && err.message) || 'the understanding step failed' };
  }

  // FAIL SAFE, NOT OPEN (reviewer finding #7). A null, a number, or a
  // schema-drifted object is not "specific enough to engage the squad" — it is
  // an understanding we do not have. Step aside honestly; engage nobody.
  if (!u || typeof u !== 'object' || Array.isArray(u)
      || typeof u.specific !== 'boolean' || typeof u.understood !== 'string') {
    return { decision: 'unavailable', reason: 'failed', changeAsk: writeAsk(said),
      why: 'the understanding step came back in a shape I could not read, so I did not act on it' };
  }

  const understood = (u && u.understood) || problem;
  const hypotheses = (u && Array.isArray(u.hypotheses)) ? u.hypotheses : [];
  const relevantFronts = (u && Array.isArray(u.relevantFronts)) ? u.relevantFronts : [];
  // Did they ask for a CHANGE anywhere in this message? The model's reading of
  // it wins; the deterministic clause screen is the backstop for what it missed.
  // Carried on EVERY decision so no path can drop it (re-review F1).
  const detected = writeAsk(said);
  const changeAsk = (u && typeof u.changeAsk === 'string' && u.changeAsk.trim())
    ? { keyword: null, clause: u.changeAsk.trim(), source: 'reasoning' }
    : detected;

  // ── A REPLY to parked questions is judged by the LLM, not assumed ──────────
  // (reviewer finding #5). It either answers them, changes the subject, or walks
  // away — and "never mind, what can you do?" must NEVER open a bridge on the
  // problem the operator just abandoned.
  if (open) {
    const intent = typeof u.replyIntent === 'string' ? u.replyIntent : 'answers';
    if (intent === 'abandons') {
      clear(conversationId);
      return { decision: 'not-a-problem', understood: said, abandoned: true, dropped: problem, changeAsk };
    }
    if (intent === 'new-topic') {
      clear(conversationId);
      // Start again on what they ACTUALLY said now. One level only — a planner
      // that kept saying "new topic" could otherwise loop.
      if ((_depth || 0) < 1) return assess({ conversationId, text: said, operatorTz, _depth: (_depth || 0) + 1 });
      return { decision: 'not-a-problem', understood: said, switched: true, changeAsk };
    }
  } else if (u.problemReport === false) {
    // Not a problem report at all (a greeting, a meta ask, "run show version on
    // sw2") — the gate stays out of the way. It never asks narrowing questions
    // about something that is not a problem.
    clear(conversationId);
    return { decision: 'not-a-problem', understood, changeAsk };
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
      changeAsk,
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
    changeAsk,
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
    // NOT sliced here (reviewer finding #10): the triage intake has always been
    // allowed 4 questions and applies its own slice. The 3-question cap is a
    // CHAT-ENVELOPE rule (envelope.ask), not a property of understanding.
    questions: (u && Array.isArray(u.questions)) ? u.questions.map(String).filter(Boolean) : [],
    relevantFronts: (u && Array.isArray(u.relevantFronts)) ? u.relevantFronts : [],
  };
}

module.exports = {
  setPlanner, getPlanner, available,
  assess, understand,
  // The shared write screen + its one honest sentence (re-review F1).
  writeAsk, writeRefusalText,
  // Evidence identity for the round dedupe (re-review M1).
  identityKey, outputKey, normalizeCommand, hashOf,
  pending, clear,
  envelope,
  capText, capLine, clip, transportOf,
  TEXT_MAX, LINE_MAX, MAX_QUESTIONS, MAX_ASK_ROUNDS, TRANSPORTS,
  // Exposed for the deterministic tests only.
  _threads: threads,
};
