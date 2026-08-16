// baseline-store.js — per-front count history so a sweep can lead with a DELTA
// instead of a raw absolute ("wan: 220 alarms (baseline 218, +2 since last sweep)").
//
// WHY: standing noise is chronic. 220 alarms means nothing on its own; "+2 since
// the last sweep" is the real signal. This store persists each sweep's per-front
// count so the next sweep can compute the change. Gap 2 of the triage spec.
//
// HONESTY: it only ever returns what was really recorded. previous() on a front
// that was never recorded returns null — the caller must then say "no baseline
// yet", never invent one.
//
// STORAGE: one small rolling JSON file per front under the gitignored workspace
// (squad/data/baseline/<front>.json). Each file is an append-only array of
// { count, ts } capped to the most recent MAX_HISTORY entries. No secrets are
// ever involved here (counts and timestamps only), but every path is still
// resolved through the workspace safeJoin guard so a hostile front name cannot
// climb out of the data folder.

const fs = require('fs');
const path = require('path');
const { SQUAD_ROOT, safeJoin } = require('../workspace');

const BASELINE_DIRNAME = 'baseline';
const MAX_HISTORY = 500; // rolling cap so a file cannot grow without bound

function baselineRoot() {
  return path.join(SQUAD_ROOT, 'data', BASELINE_DIRNAME);
}

// Turn a front label into a safe bare filename. Fronts are internal ("wan",
// "fabric", …) but we never trust an identifier that becomes a path: strip it
// to a conservative charset, then still resolve it through safeJoin so any "../"
// attempt (or a name that reduces to empty) is refused, not guessed.
function frontKey(front) {
  const raw = String(front == null ? '' : front).trim().toLowerCase();
  // Refuse anything path-shaped outright (separators, "..", null byte) rather
  // than silently rewriting it — the honest answer to a traversal attempt is
  // "no". safeJoin below is the backstop; this is the loud front door.
  if (!raw || raw.includes('/') || raw.includes('\\') || raw.includes('..') || raw.includes('\0')) return null;
  const key = raw.replace(/[^a-z0-9._-]+/g, '_').replace(/^\.+/, '').slice(0, 80);
  return key || null;
}

function fileForFront(front) {
  const key = frontKey(front);
  if (!key) return null;
  return safeJoin(baselineRoot(), key + '.json');
}

function readHistory(file) {
  if (!file || !fs.existsSync(file)) return [];
  try {
    const arr = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return []; // an unreadable file behaves like "no baseline yet", never a crash
  }
}

/**
 * Append a per-front count observation. Returns the stored entry, or null if the
 * front name could not be proven safe (path refused) or the write failed.
 * @param {string} front  e.g. "wan", "fabric"
 * @param {number} count  the count observed this sweep
 * @param {string} [ts]   ISO timestamp; defaults to now
 */
function record(front, count, ts) {
  const file = fileForFront(front);
  if (!file) return null;
  const n = Number(count);
  if (!Number.isFinite(n)) return null; // only real counts are stored
  const entry = { count: n, ts: ts || new Date().toISOString() };

  const history = readHistory(file);
  history.push(entry);
  // Keep only the most recent MAX_HISTORY observations (rolling file).
  const trimmed = history.length > MAX_HISTORY ? history.slice(history.length - MAX_HISTORY) : history;

  try {
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(trimmed, null, 2));
    return entry;
  } catch (e) {
    return null; // never take the process down for a baseline write
  }
}

/**
 * The most recent prior observation for a front, or null if none was ever
 * recorded. Intended to be called BEFORE record() in a sweep, so it returns the
 * previous sweep's count for the delta.
 * @returns {{count:number, ts:string}|null}
 */
function previous(front) {
  const file = fileForFront(front);
  if (!file) return null;
  const history = readHistory(file);
  if (!history.length) return null;
  const last = history[history.length - 1];
  if (!last || !Number.isFinite(Number(last.count))) return null;
  return { count: Number(last.count), ts: last.ts || null };
}

/**
 * Convenience for the caller: compute the delta of a fresh count against the
 * stored baseline WITHOUT recording it. Honest when there is no prior.
 * @returns {{count:number, baseline:number|null, delta:number|null,
 *            since:string|null, firstSweep:boolean}}
 */
function delta(front, count) {
  const n = Number(count);
  const prev = previous(front);
  if (!prev) {
    return { count: Number.isFinite(n) ? n : null, baseline: null, delta: null, since: null, firstSweep: true };
  }
  return {
    count: Number.isFinite(n) ? n : null,
    baseline: prev.count,
    delta: Number.isFinite(n) ? n - prev.count : null,
    since: prev.ts,
    firstSweep: false,
  };
}

module.exports = {
  record,
  previous,
  delta,
  // exported for tests / reuse
  frontKey,
  baselineRoot,
};
