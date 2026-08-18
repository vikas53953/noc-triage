// ticket-store.js — one store for one fact: every ticket this NOC has raised,
// and everything that has happened to it. The internal queue is the SINGLE
// SOURCE OF TRUTH for tickets (CW-3 Gate-1 decision); ServiceNow (CW-6) becomes
// a mirror that syncs into the `snow` slot — never a second truth.
//
// Plain words: sources/tickets.js (the logic) writes a record here the moment a
// ticket is created and updates it on every assign / status change / work note.
// Nothing about a ticket lives anywhere else, so "what is TKT-…, who owns it,
// what state is it in, and what was done to it" has exactly one answer.
//
// This module MIRRORS the pattern of sources/incident-store.js (a persisted
// per-day sequence for the human id) and sources/change-store.js (a JSON array
// of records, secret-scrubbed on the way in, capped, never fatal on a bad disk).
//
// LAWS THIS FILE ENFORCES:
//   • HUMAN, STABLE IDs. TKT-YYYYMMDD-NNN, the date derived from the ticket's
//     REAL creation timestamp (never fabricated), the NNN a real monotonic daily
//     counter persisted to disk so a restart continues the sequence.
//   • SCRUBBED ON THE WAY IN. Every persisted string walks through the same
//     secret scrubber the session log uses (session.scrub), so a credential that
//     arrives on ANY field — even one added later — can never reach disk.
//   • XSS-ESCAPED ON THE WAY IN. Free operator text (title, description, work
//     notes) is HTML-escaped before it is stored, so a payload like
//     "<img onerror=…>" is inert everywhere it is later shown, not just where a
//     given sink remembers to escape. Belt to the UI's braces.
//   • NEVER FATAL. An unreadable or read-only store behaves like "start fresh"
//     and falls back to an in-memory reservation for the id — a ticket is still
//     issued, unique within the running process, rather than crashing.

const fs = require('fs');
const path = require('path');
const { SQUAD_ROOT, safeJoin, safeWrite } = require('../workspace');
const session = require('./session-log');

const STORE_DIRNAME = 'tickets';
const STORE_FILENAME = 'tickets.json';
const SEQ_FILENAME = 'ticket-seq.json';
const MAX_RECORDS = 1000;

// The honest ticket lifecycle. Kept here so the logic layer and any reader agree
// on the exact spelling of a state — a status nobody defined cannot be stored.
const STATUSES = ['open', 'assigned', 'in-progress', 'resolved', 'closed'];
const SEVERITIES = ['P1', 'P2', 'P3', 'P4'];

function dataDir() {
  return path.join(SQUAD_ROOT, 'data', STORE_DIRNAME);
}
function storeFile() {
  return safeJoin(dataDir(), STORE_FILENAME);
}
function seqFile() {
  return safeJoin(dataDir(), SEQ_FILENAME);
}

// ── XSS escape (stored, not just displayed) ─────────────────────────────────
// Turn the five HTML-significant characters into entities so stored operator
// text can never open a tag or an attribute wherever it is later rendered.
function escapeHtml(value) {
  if (value == null) return value;
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── Secret scrub, walked over the whole record ──────────────────────────────
// A hand-listed set of fields falls behind the day someone adds a field; a walk
// cannot. Every string, however deep, goes through the session-log scrubber.
function scrubDeep(value) {
  if (typeof value === 'string') return session.scrub(value);
  if (Array.isArray(value)) return value.map(scrubDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrubDeep(v);
    return out;
  }
  return value;
}

// ── The record array ─────────────────────────────────────────────────────────
function readAll() {
  const file = storeFile();
  if (!file || !fs.existsSync(file)) return [];
  try {
    const arr = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return []; // an unreadable store behaves like "start fresh", never a crash
  }
}

function writeAll(records) {
  const file = storeFile();
  if (!file) return false;
  const trimmed = records.length > MAX_RECORDS ? records.slice(records.length - MAX_RECORDS) : records;
  return safeWrite(file, JSON.stringify(trimmed, null, 2), 'ticket store');
}

// ── The desk watches the queue live ─────────────────────────────────────────
let onEvent = null;
function setBroadcast(fn) { onEvent = typeof fn === 'function' ? fn : null; }
function emit(type, rec) {
  if (!onEvent || !rec) return;
  try { onEvent(type, rec); } catch (e) { /* telemetry must never break a write */ }
}

// ── Human id: TKT-YYYYMMDD-NNN (mirrors incident-store) ─────────────────────
const memorySeq = {}; // in-memory fallback if the seq file can't be read/written

function dateKeyFrom(ts) {
  const d = ts ? new Date(ts) : new Date();
  const use = Number.isFinite(d.getTime()) ? d : new Date(); // never off a bad ts
  const y = use.getUTCFullYear();
  const m = String(use.getUTCMonth() + 1).padStart(2, '0');
  const day = String(use.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}
function readSeq() {
  const file = seqFile();
  if (!file || !fs.existsSync(file)) return {};
  try {
    const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
    return obj && typeof obj === 'object' ? obj : {};
  } catch (e) { return {}; }
}
function writeSeq(obj) {
  const file = seqFile();
  if (!file) return false;
  return safeWrite(file, JSON.stringify(obj, null, 2), 'ticket sequence');
}
function nextId(ts) {
  const dateKey = dateKeyFrom(ts);
  const store = readSeq();
  const prior = Math.max(Number(store[dateKey]) || 0, Number(memorySeq[dateKey]) || 0);
  const seq = prior + 1;
  store[dateKey] = seq;
  memorySeq[dateKey] = seq;      // reserve in memory even if the disk write fails
  writeSeq(store);
  return `TKT-${dateKey}-${String(seq).padStart(3, '0')}`;
}

// ── CRUD ─────────────────────────────────────────────────────────────────────
/**
 * Persist a fully-built ticket record. The logic layer (sources/tickets.js) owns
 * the shape, validation and audit; this only escapes + scrubs + writes it and
 * hands back the stored copy. Escaping runs BEFORE scrubbing so a secret hidden
 * behind an entity is still caught.
 */
function insert(rec) {
  // Escape the free-text operator fields, then scrub secrets across everything.
  const escaped = {
    ...rec,
    title: escapeHtml(rec.title),
    description: escapeHtml(rec.description),
    worknotes: (rec.worknotes || []).map((w) => ({ ...w, text: escapeHtml(w.text) })),
  };
  const stored = scrubDeep(escaped);
  const all = readAll();
  all.push(stored);
  writeAll(all);
  return stored;
}

function get(id) {
  return readAll().find((t) => t.id === id) || null;
}

function list({ status, assignee, limit } = {}) {
  let out = readAll();
  if (status) {
    const s = String(status).toLowerCase();
    out = out.filter((t) => String(t.status).toLowerCase() === s);
  }
  if (assignee) {
    const a = String(assignee).toLowerCase();
    out = out.filter((t) => String(t.assignee || '').toLowerCase() === a);
  }
  // Most-recent first for the queue view.
  out = out.slice().sort((x, y) => (x.ts < y.ts ? 1 : -1));
  if (limit && out.length > limit) out = out.slice(0, limit);
  return out;
}

/**
 * Replace a whole record in place (the logic layer builds the next version:
 * updated status/assignee + appended history/worknotes). Escaped + scrubbed on
 * the way in, same boundary as insert, so a work note added here is as safe as
 * one added at create. Returns the stored copy or null if the id is unknown.
 */
function replace(id, rec) {
  const all = readAll();
  const i = all.findIndex((t) => t.id === id);
  if (i < 0) return null;
  const escaped = {
    ...rec,
    title: escapeHtml(rec.title),
    description: escapeHtml(rec.description),
    worknotes: (rec.worknotes || []).map((w) => ({ ...w, text: escapeHtml(w.text) })),
  };
  all[i] = scrubDeep(escaped);
  writeAll(all);
  return all[i];
}

module.exports = {
  insert, get, list, replace, nextId, dateKeyFrom,
  setBroadcast, emit,
  escapeHtml, scrubDeep,
  STATUSES, SEVERITIES, storeFile, seqFile,
};
