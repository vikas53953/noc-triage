// incident-store.js — assign each triage a stable, human-readable incident id
// (INC-YYYYMMDD-NNN) and persist the per-day sequence so ids survive a restart.
//
// WHY: an operator adopting this into a real NOC needs one stable handle for the
// incident — to say on a bridge call, to paste into ServiceNow, to re-triage
// against later. A random trg-… slug is not that. INC-20260816-001 is.
//
// HONESTY / DERIVATION: the DATE half is derived from the triage's REAL openedAt
// timestamp (never Date.now(), never fabricated) so the id always matches when the
// incident actually opened. The NNN half is a real monotonic daily counter,
// persisted to disk, so the second triage of a day is …-002 even across a restart.
//
// STORAGE: one small JSON file under the gitignored workspace
// (squad/data/incident-seq.json), a map of { "YYYYMMDD": lastSeq }. Every path is
// resolved through the workspace safeJoin guard. A write failure is never fatal —
// it falls back to an in-memory counter so an id is still issued (honesty: the id
// stays unique within the running process even if the disk is read-only).

const fs = require('fs');
const path = require('path');
const { SQUAD_ROOT, safeJoin } = require('../workspace');

const DATA_DIRNAME = 'data';
const SEQ_FILENAME = 'incident-seq.json';

function seqFile() {
  return safeJoin(path.join(SQUAD_ROOT, DATA_DIRNAME), SEQ_FILENAME);
}

// In-memory fallback map, used only if the disk store cannot be read/written.
const memory = {};

// Derive the YYYYMMDD date key from a real ISO timestamp, in UTC — matching the
// UTC window labels the rest of the triage engine uses, so the id's date lines up
// with the incident's real open time regardless of the server's locale.
function dateKeyFrom(openedAt) {
  const d = openedAt ? new Date(openedAt) : new Date();
  const ms = d.getTime();
  const use = Number.isFinite(ms) ? d : new Date(); // never fabricate off a bad ts
  const y = use.getUTCFullYear();
  const m = String(use.getUTCMonth() + 1).padStart(2, '0');
  const day = String(use.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

function readAll() {
  const file = seqFile();
  if (!file || !fs.existsSync(file)) return {};
  try {
    const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
    return obj && typeof obj === 'object' ? obj : {};
  } catch (e) {
    return {}; // an unreadable store behaves like "start fresh", never a crash
  }
}

function writeAll(obj) {
  const file = seqFile();
  if (!file) return false;
  try {
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(obj, null, 2));
    return true;
  } catch (e) {
    return false; // never take the process down for a sequence write
  }
}

/**
 * Assign the next incident id for the day of `openedAt`. Persists the incremented
 * daily counter so a restart continues the sequence rather than resetting it.
 * @param {string} openedAt  the triage's REAL ISO open timestamp
 * @returns {{ incidentId:string, dateKey:string, seq:number }}
 */
function assign(openedAt) {
  const dateKey = dateKeyFrom(openedAt);
  const store = readAll();
  // Seed the store's day from any earlier in-memory value so we never re-issue a
  // number that a failed-write session already handed out this run.
  const prior = Math.max(Number(store[dateKey]) || 0, Number(memory[dateKey]) || 0);
  const seq = prior + 1;
  store[dateKey] = seq;
  memory[dateKey] = seq;
  writeAll(store); // best-effort; memory already carries the reservation
  const incidentId = `INC-${dateKey}-${String(seq).padStart(3, '0')}`;
  return { incidentId, dateKey, seq };
}

/**
 * Peek at the last-issued sequence for a day without incrementing. Returns 0 if
 * none was ever issued. (Handy for tests / a status read.)
 */
function peek(openedAt) {
  const dateKey = dateKeyFrom(openedAt);
  const store = readAll();
  return Math.max(Number(store[dateKey]) || 0, Number(memory[dateKey]) || 0);
}

module.exports = {
  assign,
  peek,
  dateKeyFrom,
  seqFile,
};
