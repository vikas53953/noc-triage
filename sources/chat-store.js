// chat-store.js — reload persistence for direct chat/DM + Live Activity (bug B4).
//
// Plain words: the dashboard used to lose the whole conversation and the Live
// Activity feed on a browser refresh, because the WS `init` snapshot carried
// neither. That is bad for a NOC shift handover — the incoming operator opens the
// tab and the chat is blank. This store keeps a rolling window of the recent
// chat_message and activity_new payloads on disk so a reconnecting client can
// restore exactly what was on screen, and it survives a server restart too.
//
// ONE SEAM: the server appends here from inside broadcast() — the single place
// every chat_message / activity_new passes through — so there is no per-caller
// wiring and no broadcast path can be missed.
//
// SECRETS NEVER TOUCH DISK: every string field of every payload is run through
// the same Phase-B scrubber (sources/session-log.scrub) that guards the session
// records before it is written or returned, so a credential can never land in
// the persisted history or on the wire to a reconnecting browser.
//
// PATH SAFETY: the two files live under the workspace via safeJoin — the same
// guard every other file write in the app goes through.

const fs = require('fs');
const path = require('path');
const { SQUAD_ROOT, safeJoin } = require('../workspace');
const { scrub } = require('./session-log');

const STORE_DIRNAME = 'chat';
const CHAT_FILE = 'chat-history.json';
const ACTIVITY_FILE = 'activity-history.json';

// Recent window kept per store. Enough for a shift handover; small enough that
// the init snapshot stays light and the files never grow unbounded.
const MAX_CHAT = 200;
const MAX_ACTIVITY = 200;

function storeRoot() {
  return path.join(SQUAD_ROOT, 'data', STORE_DIRNAME);
}

function fileFor(name) {
  return safeJoin(storeRoot(), name);
}

// ── Deep secret-scrub of a payload ──────────────────────────────────────────
// Scrub every string the payload carries (text, agent names, reply headers…)
// with the same scrubber the session log uses, so nothing credential-shaped is
// ever written. Non-string leaves pass through unchanged.
function scrubValue(value) {
  if (typeof value === 'string') return scrub(value);
  if (Array.isArray(value)) return value.map(scrubValue);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) out[k] = scrubValue(value[k]);
    return out;
  }
  return value;
}

// ── In-memory cache, lazily loaded from disk once ───────────────────────────
let chatCache = null;
let activityCache = null;

function readArray(file) {
  if (!file || !fs.existsSync(file)) return [];
  try {
    const arr = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}

function loadChat() {
  if (chatCache === null) chatCache = readArray(fileFor(CHAT_FILE));
  return chatCache;
}

function loadActivity() {
  if (activityCache === null) activityCache = readArray(fileFor(ACTIVITY_FILE));
  return activityCache;
}

function writeArray(name, arr) {
  const file = fileFor(name);
  if (!file) return false; // path refused — never write outside the workspace
  try {
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(arr, null, 2));
    return true;
  } catch (e) {
    return false;
  }
}

// ── Public append seams (called from server.broadcast) ──────────────────────

/**
 * Persist one chat_message payload (the exact shape broadcast sends, already
 * request-stamped). Scrubbed before it touches disk; capped to the recent
 * window. A malformed/empty payload is ignored.
 */
function appendChat(payload) {
  if (!payload || typeof payload !== 'object') return;
  const cache = loadChat();
  cache.push(scrubValue(payload));
  if (cache.length > MAX_CHAT) cache.splice(0, cache.length - MAX_CHAT);
  writeArray(CHAT_FILE, cache);
}

/**
 * Persist one activity_new payload ({source, text, ts}). Same scrub + cap.
 */
function appendActivity(payload) {
  if (!payload || typeof payload !== 'object') return;
  const cache = loadActivity();
  cache.push(scrubValue(payload));
  if (cache.length > MAX_ACTIVITY) cache.splice(0, cache.length - MAX_ACTIVITY);
  writeArray(ACTIVITY_FILE, cache);
}

/** Recent chat_message payloads, oldest→newest (init contract: data.chatHistory). */
function getChatHistory() {
  return loadChat().slice();
}

/** Recent activity_new payloads, oldest→newest (init contract: data.activityHistory). */
function getActivityHistory() {
  return loadActivity().slice();
}

module.exports = {
  appendChat,
  appendActivity,
  getChatHistory,
  getActivityHistory,
  // exported for tests / reuse
  scrubValue,
  storeRoot,
};
