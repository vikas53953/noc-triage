// spend-store.js — CW-10 item 4 (BE half): what every model call actually cost.
//
// Plain words: until now the app could tell you what it DID, but not what it
// SPENT doing it. Every Claude call now drops one small record here — when it
// ran, which conversation/incident it belonged to, what it was for, which model
// served it, and the token counts the API itself reported. /api/spend/summary
// adds those up per day, per purpose and per model, so the Desk can show a real
// number instead of a guess.
//
// HARD RULE — PROMPT TEXT NEVER ENTERS THIS FILE. A spend record is numbers and
// short labels only: no system prompt, no operator message, no model answer, no
// findings. The only strings written are the purpose label, the model id and an
// id the app already holds. That is deliberate: this file is small, long-lived
// and easy to read, which is exactly what a prompt log must never be.
//
// ROTATION: the file is capped at 5MB. When it would cross the cap the oldest
// half is dropped (the current file is first copied to <name>.1.json so nothing
// vanishes silently), so a long-running server can never fill the disk.
//
// PATH SAFETY: written through the same workspace safeJoin guard as every other
// file the app writes.

const fs = require('fs');
const path = require('path');
const { SQUAD_ROOT, safeJoin } = require('../workspace');

const STORE_DIRNAME = 'spend';
const SPEND_FILE = 'spend.json';
const ROTATED_FILE = 'spend.1.json';

// 5MB, per the CW-10 contract. One record is ~200 bytes, so this is roughly
// 25k model calls before the first rotation.
const MAX_BYTES = Number(process.env.SPEND_MAX_BYTES || 5 * 1024 * 1024);

// The purposes the app actually records. An unknown label is kept verbatim (a
// new call site should show up in the summary, not be silently binned as
// "other") but it is trimmed and capped so it can never carry prose.
const PURPOSE_MAX = 40;

let cache = null;          // lazily loaded array of records
let dirOverride = null;    // tests point the store at a temp dir

function storeRoot() {
  return dirOverride || path.join(SQUAD_ROOT, 'data', STORE_DIRNAME);
}

function fileFor(name) {
  return dirOverride ? path.join(dirOverride, name) : safeJoin(storeRoot(), name);
}

function readArray(file) {
  if (!file || !fs.existsSync(file)) return [];
  try {
    const arr = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];                     // a corrupt file must never crash a model call
  }
}

function load() {
  if (cache === null) cache = readArray(fileFor(SPEND_FILE));
  return cache;
}

function write(arr) {
  const file = fileFor(SPEND_FILE);
  if (!file) return false;         // path refused — never write outside the workspace
  try {
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(arr, null, 2));
    return true;
  } catch (e) {
    return false;                  // spend accounting must never break a real call
  }
}

// Keep the file under the cap. The current file is preserved as spend.1.json
// (one generation) and the live file keeps the newest half of the records.
function rotateIfNeeded(arr) {
  const size = Buffer.byteLength(JSON.stringify(arr, null, 2), 'utf8');
  if (size <= MAX_BYTES) return arr;
  const rotated = fileFor(ROTATED_FILE);
  try {
    if (rotated) {
      const dir = path.dirname(rotated);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(rotated, JSON.stringify(arr, null, 2));
    }
  } catch (e) { /* rotation is best-effort; the cap still gets enforced below */ }
  return arr.slice(Math.floor(arr.length / 2));
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
}

function label(v, max) {
  const s = String(v == null ? '' : v).trim().replace(/\s+/g, ' ');
  return s ? s.slice(0, max) : null;
}

/**
 * Record ONE model call.
 *
 * @param {object} e
 *   purpose        what the call was for (understand|plan|probe|synthesize|…)
 *   model          the model id the API reported
 *   conversationId chat conversation this belonged to (optional)
 *   incidentId     incident this belonged to (optional)
 *   usage          the API's own response.usage object
 *   ts             ISO timestamp (defaults to now)
 *
 * Never throws — a failure here must never take down a real reasoning call.
 */
function record(e) {
  try {
    const entry = e || {};
    const usage = entry.usage || {};
    const rec = {
      ts: entry.ts || new Date().toISOString(),
      purpose: label(entry.purpose, PURPOSE_MAX) || 'unknown',
      model: label(entry.model, 60) || 'unknown',
      input_tokens: num(usage.input_tokens),
      output_tokens: num(usage.output_tokens),
      cache_read_input_tokens: num(usage.cache_read_input_tokens),
      cache_creation_input_tokens: num(usage.cache_creation_input_tokens),
    };
    const conversationId = label(entry.conversationId, 80);
    const incidentId = label(entry.incidentId, 80);
    if (conversationId) rec.conversationId = conversationId;
    if (incidentId) rec.incidentId = incidentId;

    const arr = load();
    arr.push(rec);
    cache = rotateIfNeeded(arr);
    write(cache);
    return rec;
  } catch (err) {
    return null;
  }
}

function dayOf(ts) {
  const s = String(ts || '');
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : 'unknown';
}

function blankTotals() {
  return { calls: 0, input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
}

function addInto(target, rec) {
  target.calls += 1;
  target.input_tokens += rec.input_tokens || 0;
  target.output_tokens += rec.output_tokens || 0;
  target.cache_read_input_tokens += rec.cache_read_input_tokens || 0;
  target.cache_creation_input_tokens += rec.cache_creation_input_tokens || 0;
  return target;
}

/**
 * Totals for the Desk panel and GET /api/spend/summary:
 *   { generatedAt, calls, total, today, week, byDay, byPurpose, byModel }
 * Numbers only — nothing here can carry prompt text, because nothing here was
 * ever written with any.
 */
function summary(now = Date.now()) {
  const all = load();
  const todayKey = new Date(now).toISOString().slice(0, 10);
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;

  const out = {
    generatedAt: new Date(now).toISOString(),
    calls: all.length,
    total: blankTotals(),
    today: blankTotals(),
    week: blankTotals(),
    byDay: {},
    byPurpose: {},
    byModel: {},
  };

  for (const rec of all) {
    if (!rec || typeof rec !== 'object') continue;
    const day = dayOf(rec.ts);
    addInto(out.total, rec);
    if (day === todayKey) addInto(out.today, rec);
    const ms = Date.parse(rec.ts);
    if (Number.isFinite(ms) && ms >= weekAgo) addInto(out.week, rec);
    addInto(out.byDay[day] || (out.byDay[day] = blankTotals()), rec);
    const p = rec.purpose || 'unknown';
    addInto(out.byPurpose[p] || (out.byPurpose[p] = blankTotals()), rec);
    const m = rec.model || 'unknown';
    addInto(out.byModel[m] || (out.byModel[m] = blankTotals()), rec);
  }
  return out;
}

/** Every record, oldest→newest (tests / debugging). */
function all() { return load().slice(); }

// Test seam: point the store at a temp directory and drop the cache.
function _setDir(dir) { dirOverride = dir || null; cache = null; }
function _reset() { cache = null; }

module.exports = { record, summary, all, storeRoot, _setDir, _reset, MAX_BYTES };
