// change-store.js — one store for one fact: every change this system has been
// asked to make to a device, and everything that happened to it.
//
// Plain words: the change engine (sources/change-runner.js) writes a record here
// the moment a change is asked for, and updates it at every step. Nothing about
// a change lives anywhere else, so "what did we do to sw2, when, who asked, and
// can we put it back" has exactly one answer.
//
// LAWS THIS FILE ENFORCES:
//   • SCRUBBED ON THE WAY IN. A change record carries running-config text, which
//     is full of secrets. Every persisted field goes through the same scrubbers
//     the config store uses (config-store.scrubConfig, itself layered on the
//     session-log JSON scrubber), so a secret cannot reach disk by arriving on a
//     new field someone added later — the scrub is applied to the record, not to
//     a hand-listed set of fields.
//   • EVERY TRANSITION AUDITED. status() is the only way a status changes, and it
//     writes a copilot audit line every time. There is no silent transition.
//   • HONEST STATUSES ONLY, from the CW-2 contract's list:
//       proposed → the operator asked; nothing has run.
//       approved → the permission gate let it through.
//       denied   → the gate said no. ZERO wire calls were made.
//       applied  → the config push really landed on the device.
//       failed   → a wrap step could not run, so the change is FROZEN with the
//                  step and the reason recorded. A "no write path to this
//                  device" is this status, never a fake "applied".
//       rolled-back → a later change put the pre-state back.

const fs = require('fs');
const path = require('path');
const { SQUAD_ROOT, safeJoin, safeWrite } = require('../workspace');
const session = require('./session-log');
const { scrubConfig } = require('./config-store');

const STORE_DIRNAME = 'changes';
const STORE_FILENAME = 'changes.json';
const MAX_RECORDS = 300;

const STATUSES = ['proposed', 'approved', 'denied', 'applied', 'failed', 'rolled-back'];

function storeFile() {
  return safeJoin(path.join(SQUAD_ROOT, 'data', STORE_DIRNAME), STORE_FILENAME);
}

function readAll() {
  const file = storeFile();
  if (!file || !fs.existsSync(file)) return [];
  try {
    const arr = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}

// Scrub EVERY string anywhere in the record, however deep and whatever it is
// called. A hand-listed set of fields falls behind the day a field is added; a
// walk cannot.
function scrubDeep(value) {
  if (typeof value === 'string') return scrubConfig(value);
  if (Array.isArray(value)) return value.map(scrubDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrubDeep(v);
    return out;
  }
  return value;
}

function writeAll(records) {
  const file = storeFile();
  if (!file) return false;
  const trimmed = records.length > MAX_RECORDS ? records.slice(records.length - MAX_RECORDS) : records;
  return safeWrite(file, JSON.stringify(trimmed, null, 2), 'change store');
}

// The desk watches a change happen step by step, so every write here is
// announced. Telemetry may never break a change: emit() swallows its own errors.
let onEvent = null;
function setBroadcast(fn) { onEvent = typeof fn === 'function' ? fn : null; }
function emit(rec) {
  if (!onEvent || !rec) return;
  try { onEvent('change_update', rec); } catch (e) { /* never break a change */ }
}

let seq = 0;
function newId() {
  return `chg-${Date.now().toString(36)}-${(++seq).toString(36)}`;
}

/**
 * Open a change record. Nothing has run yet — status is always 'proposed'.
 * @param {{device:string, deviceLabel?:string, commands:string[], reason:string,
 *          who:string, rollbackOf?:string}} input
 */
function create(input) {
  const rec = scrubDeep({
    id: newId(),
    ts: new Date().toISOString(),
    who: String(input.who || 'unknown'),
    device: String(input.device || ''),
    deviceLabel: input.deviceLabel || null,
    commands: (input.commands || []).map((c) => String(c)),
    reason: String(input.reason || ''),
    rollbackOf: input.rollbackOf || null,
    status: 'proposed',
    approval: null,
    pre: null,
    post: null,
    diff: null,
    validation: null,
    rollback: null,
    steps: [],
    frozenAt: null,
    frozenReason: null,
    history: [{ ts: new Date().toISOString(), status: 'proposed', by: String(input.who || 'unknown') }],
  });
  const all = readAll();
  all.push(rec);
  writeAll(all);
  emit(rec);
  session.audit({
    who: rec.who,
    what: `change ${rec.id} proposed: ${rec.commands.join(' / ')}`,
    device: rec.device,
    result: 'proposed — nothing has run',
  });
  return rec;
}

function get(id) {
  return readAll().find((r) => r.id === id) || null;
}

function list({ device, limit } = {}) {
  let out = readAll();
  if (device) {
    const d = String(device).toLowerCase();
    out = out.filter((r) => String(r.device).toLowerCase() === d || String(r.deviceLabel || '').toLowerCase() === d);
  }
  if (limit && out.length > limit) out = out.slice(out.length - limit);
  return out;
}

/** Merge fields into a record (no status change). Scrubbed on the way in. */
function patch(id, fields) {
  const all = readAll();
  const i = all.findIndex((r) => r.id === id);
  if (i < 0) return null;
  all[i] = { ...all[i], ...scrubDeep(fields) };
  writeAll(all);
  emit(all[i]);
  return all[i];
}

/**
 * Move a record to a new status. THE ONLY way a status changes, and it always
 * writes an audit line — a transition nobody can see did not happen.
 */
function status(id, next, { note, by } = {}) {
  if (!STATUSES.includes(next)) throw new Error(`unknown change status "${next}"`);
  const all = readAll();
  const i = all.findIndex((r) => r.id === id);
  if (i < 0) return null;
  const rec = all[i];
  const from = rec.status;
  rec.status = next;
  rec.history = (rec.history || []).concat([scrubDeep({
    ts: new Date().toISOString(), status: next, by: by || rec.who, note: note || null,
  })]);
  all[i] = rec;
  writeAll(all);
  emit(rec);
  session.audit({
    who: by || rec.who,
    what: `change ${rec.id} ${from} → ${next}`,
    device: rec.device,
    result: note ? String(note) : next,
  });
  return rec;
}

/** Record one wrap step's outcome on a record. Steps are the audit of the wrap. */
function step(id, name, state, detail) {
  const rec = get(id);
  if (!rec) return null;
  const steps = (rec.steps || []).filter((s) => s.name !== name);
  steps.push(scrubDeep({ name, state, detail: detail == null ? null : String(detail), ts: new Date().toISOString() }));
  const updated = patch(id, { steps });
  session.audit({
    who: rec.who,
    what: `change ${id} step ${name}: ${state}`,
    device: rec.device,
    result: detail ? String(detail).slice(0, 300) : state,
  });
  return updated;
}

module.exports = { create, get, list, patch, status, step, setBroadcast, STATUSES, storeFile, scrubDeep };
