// lessons.js — CW-11 Part 4, THE LESSONS MEMORY.
//
// Plain words: when an incident closes, Jarvis writes down four short facts about
// it — what the cause turned out to be, which check found it fastest, what wasted
// time, and the symptom words an operator would use. Next time a similar problem
// comes in, it says so in one line and looks there FIRST.
//
// THE LAW THIS FILE OBEYS (contract-pinned): LESSONS ARE FACTS, NOT RULES.
//   • A lesson BIASES where to look first. It never bypasses the ask-first gate,
//     never auto-runs anything, and never overrides the ambiguity law. That is why
//     consult() returns ONLY a sentence and a "look here first" hint — there is no
//     agentId, no command, and no runnable action anywhere in its output.
//   • Similarity is judged by the LLM (intent-first law). There is not one keyword
//     match in this file: the model is handed the lessons and the new problem and
//     says which one is genuinely similar, or none.
//   • Everything written to disk goes through the SAME session-log scrubber every
//     other persisted artefact uses, so a credential in a device reading can never
//     land in a lesson file.
//
// Files: squad/lessons/<INC-id>.md — small, human-readable, hand-deletable, and
// served/deleted through GET/DELETE /api/lessons for the desk's Lessons panel.

const fs = require('fs');
const path = require('path');
const session = require('./session-log');
const { SQUAD_ROOT, safeWrite } = require('../workspace');

const LESSONS_DIR = path.join(SQUAD_ROOT, 'lessons');

// An incident id is a file name here, so it may only be the shape we mint:
// INC-YYYYMMDD-NNN / INV-YYYYMMDD-NNN, or a plain id with no path in it at all.
// Anything else is refused — a lesson can never write outside squad/lessons.
function safeId(id) {
  const s = String(id == null ? '' : id).trim();
  if (!s || s.length > 64) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(s)) return null;
  if (s.includes('..')) return null;
  return s;
}

function fileFor(id) {
  const safe = safeId(id);
  return safe ? path.join(LESSONS_DIR, `${safe}.md`) : null;
}

// ── The injected planner (the LLM half) ─────────────────────────────────────
// planner = {
//   available(): boolean,
//   compose({ incidentId, problem, cause, rounds, verdict }) ->
//       { cause, fastestCheck, wastedTime, keywords[] }
//   similar({ problem, understood, lessons }) ->
//       { matchId|null, why, lookFirst } }
let planner = null;
function setPlanner(p) { planner = p || null; }
function available() { return Boolean(planner && (typeof planner.available !== 'function' || planner.available())); }

// ── Write ───────────────────────────────────────────────────────────────────
// One short line per field, scrubbed, capped. Never a wall of text: a lesson an
// operator will not read is a lesson that does nothing.
const FIELD_MAX = 400;

function clean(text) {
  const scrubbed = session.scrub(String(text == null ? '' : text));
  return scrubbed.replace(/\s+/g, ' ').trim().slice(0, FIELD_MAX);
}

/**
 * Write (or overwrite) the lesson for one incident. Deterministic — the FACTS are
 * whatever the caller composed (the planner, at close time). Nothing is invented
 * here; a missing field is written as an honest "not recorded".
 * Returns the stored lesson, or null when it could not be written.
 */
function write({ incidentId, cause, fastestCheck, wastedTime, keywords, problem, closedAt } = {}) {
  const id = safeId(incidentId);
  if (!id) return null;
  const lesson = {
    id,
    problem: clean(problem) || 'not recorded',
    cause: clean(cause) || 'not recorded',
    fastestCheck: clean(fastestCheck) || 'not recorded',
    wastedTime: clean(wastedTime) || 'nothing stood out',
    keywords: (Array.isArray(keywords) ? keywords : [])
      .map((k) => clean(k).slice(0, 40)).filter(Boolean).slice(0, 12),
    closedAt: closedAt || new Date().toISOString(),
  };
  const md =
    `# Lesson — ${lesson.id}\n\n` +
    `- **Closed:** ${lesson.closedAt}\n` +
    `- **Problem:** ${lesson.problem}\n` +
    `- **Cause:** ${lesson.cause}\n` +
    `- **Fastest check:** ${lesson.fastestCheck}\n` +
    `- **Wasted time:** ${lesson.wastedTime}\n` +
    `- **Symptom keywords:** ${lesson.keywords.length ? lesson.keywords.join(', ') : 'none recorded'}\n\n` +
    `_Written by Jarvis on incident close. A lesson is a FACT about what happened — it biases where to look\n` +
    `first, it never runs anything and never skips the questions._\n`;
  if (!safeWrite(fileFor(id), md, 'lesson write')) return null;
  return lesson;
}

// ── Read ────────────────────────────────────────────────────────────────────
function parse(id, md) {
  const field = (label) => {
    const m = new RegExp(`^- \\*\\*${label}:\\*\\* (.*)$`, 'm').exec(md);
    return m ? m[1].trim() : '';
  };
  const kw = field('Symptom keywords');
  return {
    id,
    closedAt: field('Closed') || null,
    problem: field('Problem'),
    cause: field('Cause'),
    fastestCheck: field('Fastest check'),
    wastedTime: field('Wasted time'),
    keywords: kw && kw !== 'none recorded' ? kw.split(',').map((s) => s.trim()).filter(Boolean) : [],
  };
}

function list() {
  let names;
  try { names = fs.readdirSync(LESSONS_DIR); } catch (e) { return []; }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.md')) continue;
    const id = safeId(name.slice(0, -3));
    if (!id) continue;
    try { out.push(parse(id, fs.readFileSync(path.join(LESSONS_DIR, name), 'utf8'))); }
    catch (e) { /* an unreadable lesson is skipped, never guessed at */ }
  }
  return out.sort((a, b) => String(b.closedAt || '').localeCompare(String(a.closedAt || '')));
}

function get(id) {
  const file = fileFor(id);
  if (!file) return null;
  try { return parse(safeId(id), fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

function remove(id) {
  const file = fileFor(id);
  if (!file) return false;
  try { fs.unlinkSync(file); return true; } catch (e) { return false; }
}

// ── Compose at close (the LLM half) ─────────────────────────────────────────
/**
 * Ask the planner for the four facts, then write them. Never throws, never blocks
 * a close: a failure means no lesson, not a broken incident.
 */
async function recordFromIncident({ incidentId, problem, cause, verdict, rounds, closedAt } = {}) {
  const id = safeId(incidentId);
  if (!id) return null;
  let facts = null;
  if (available() && typeof planner.compose === 'function') {
    try {
      facts = await planner.compose({ incidentId: id, problem, cause, verdict, rounds });
    } catch (err) { facts = null; }
  }
  // With no reasoning we still record the FACTS we hold (the cause we committed
  // and the problem as reported). We do not invent a "fastest check".
  return write({
    incidentId: id,
    problem,
    cause: (facts && facts.cause) || cause,
    fastestCheck: facts && facts.fastestCheck,
    wastedTime: facts && facts.wastedTime,
    keywords: facts && facts.keywords,
    closedAt,
  });
}

// ── Consult on a NEW problem (the LLM half) ─────────────────────────────────
/**
 * Is this new problem like one we have closed before? The MODEL decides — there is
 * no keyword matching here (intent-first law).
 *
 * Returns null when there is nothing honest to say (no lessons, no reasoning, or
 * the model found no genuine match). Otherwise:
 *   { id, line, lookFirst } — a SENTENCE and a hint. Deliberately NOT an action:
 *   nothing in this return value can be executed, so a lesson can never auto-run
 *   a check or skip the ask-first gate.
 */
async function consult({ problem, understood } = {}) {
  const all = list();
  if (!all.length) return null;
  if (!available() || typeof planner.similar !== 'function') return null;
  let out;
  try {
    out = await planner.similar({
      problem: String(problem || ''),
      understood: String(understood || ''),
      lessons: all.map((l) => ({ id: l.id, problem: l.problem, cause: l.cause,
        fastestCheck: l.fastestCheck, keywords: l.keywords })),
    });
  } catch (err) { return null; }
  if (!out || !out.matchId) return null;
  // The match must name a lesson that really exists — the model cannot cite an
  // incident we never closed.
  const hit = all.find((l) => l.id === String(out.matchId));
  if (!hit) return null;
  const lookFirst = String((out.lookFirst || hit.fastestCheck || '')).trim();
  const why = String(out.why || '').trim();
  return {
    id: hit.id,
    lookFirst: lookFirst || null,
    why: why || null,
    line: `This looks similar to ${hit.id}${why ? ` — ${why}` : ''}${lookFirst ? `. Checking ${lookFirst} first` : ''}. ` +
      `That is a past fact, not a shortcut — I am still asking before I run anything.`,
    lesson: hit,
  };
}

module.exports = {
  setPlanner, available,
  write, list, get, remove, recordFromIncident, consult,
  LESSONS_DIR, safeId,
};
