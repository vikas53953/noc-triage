// workspace.js — the ONE place that decides where the squad workspace lives,
// the ONE place that turns anything a caller typed into a real path, and the
// ONE place that writes files without being able to kill the process.
//
// Plain words: every route that touches a file must ask this module first.
// If it says no, the file is outside the workspace and must not be served.

const fs = require('fs');
const path = require('path');

// Where the squad workspace lives. Env-driven so a fresh clone works on any
// machine; the default sits inside the repo so nothing is hardcoded to a laptop.
const SQUAD_ROOT = path.resolve(process.env.SQUAD_ROOT || path.join(__dirname, 'squad'));

const PATHS = {
  agentWorkspace: path.join(SQUAD_ROOT, 'agents'),
  tasksFile: path.join(SQUAD_ROOT, 'shared', 'TASKS.md'),
  activityLog: path.join(SQUAD_ROOT, 'shared', 'ACTIVITY_LOG.md'),
  alertsFile: path.join(SQUAD_ROOT, 'shared', 'ALERTS.md'),
  reportsFolder: path.join(SQUAD_ROOT, 'agents', 'netops', 'reports'),
  mentionsLog: path.join(SQUAD_ROOT, 'shared', 'MENTIONS.md'),
};

// Is `target` the same as `root`, or somewhere underneath it?
// path.relative already folds Windows case differences, so "C:\x" and "c:\X"
// compare equal, and a sibling folder called "squad-secret" cannot pass as
// "squad" (which a plain startsWith() check would have allowed).
function isInside(root, target) {
  const rel = path.relative(root, target);
  if (rel === '') return true;
  if (path.isAbsolute(rel)) return false;
  return rel !== '..' && !rel.startsWith('..' + path.sep);
}

// Walk up to the nearest existing ancestor and ask the OS for its real path,
// so a symlink or junction inside the workspace cannot smuggle us out of it.
function realpathOfNearestExisting(p) {
  let current = p;
  for (;;) {
    try {
      const real = fs.realpathSync.native(current);
      return current === p ? real : path.join(real, path.relative(current, p));
    } catch (e) {
      const parent = path.dirname(current);
      if (parent === current) return p;
      current = parent;
    }
  }
}

// Fully decode percent-encoding. Express decodes a route param ONCE and only
// AFTER matching, which is how `..%2f..%2f` walked past the old guard: the
// route saw one harmless-looking segment, the handler got `../../`.
function fullyDecode(value) {
  let out = String(value);
  for (let i = 0; i < 5; i++) {
    let next;
    try {
      next = decodeURIComponent(out);
    } catch (e) {
      return null; // malformed encoding — refuse rather than guess
    }
    if (next === out) return out;
    out = next;
  }
  return null; // absurd nesting — refuse
}

/**
 * Turn caller-supplied text into a path that is provably inside `root`.
 * Returns the absolute path, or null if the caller tried to leave.
 * EVERY filesystem path built from user input goes through here.
 */
function safeJoin(root, userPath) {
  if (typeof userPath !== 'string' || userPath.trim() === '') return null;

  const decoded = fullyDecode(userPath);
  if (decoded === null) return null;
  if (decoded.includes('\0')) return null;

  const rootResolved = path.resolve(root);
  // path.resolve also handles the case where the caller sent an absolute path
  // (the file browser does) — it is then checked against the root like any other.
  const candidate = path.resolve(rootResolved, decoded);
  if (!isInside(rootResolved, candidate)) return null;

  const realRoot = realpathOfNearestExisting(rootResolved);
  const realCandidate = realpathOfNearestExisting(candidate);
  if (!isInside(realRoot, realCandidate)) return null;

  return candidate;
}

// A bare file name with no directory part at all. Used by the download route,
// which has no business accepting a path in the first place.
function isPlainFilename(name) {
  const decoded = fullyDecode(name);
  if (decoded === null || decoded.trim() === '') return false;
  if (decoded.includes('\0')) return false;
  if (decoded.includes('/') || decoded.includes('\\')) return false;
  if (decoded === '.' || decoded === '..' || decoded.includes('..')) return false;
  if (/^[A-Za-z]:/.test(decoded)) return false;
  return true;
}

// Create the workspace on boot so a fresh clone runs instead of showing an
// empty dashboard (or crashing on the first command).
function ensureWorkspace(agentIds = []) {
  const made = [];
  const mk = (dir) => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      made.push(dir);
    }
  };

  mk(SQUAD_ROOT);
  mk(path.join(SQUAD_ROOT, 'shared'));
  mk(path.join(SQUAD_ROOT, 'agents'));
  agentIds.forEach((id) => {
    mk(path.join(SQUAD_ROOT, 'agents', id));
    mk(path.join(SQUAD_ROOT, 'agents', id, 'reports'));
  });

  if (!fs.existsSync(PATHS.tasksFile)) {
    fs.writeFileSync(
      PATHS.tasksFile,
      '# Agent Task Board\n\n## INBOX\n\n## IN PROGRESS\n\n## REVIEW\n\n## DONE\n\n## WAITING\n'
    );
    made.push(PATHS.tasksFile);
  }
  if (!fs.existsSync(PATHS.activityLog)) {
    fs.writeFileSync(PATHS.activityLog, `[${new Date().toISOString()}] [System] Workspace created\n`);
    made.push(PATHS.activityLog);
  }

  return made;
}

// Every write in the app goes through here. A failed write reports itself and
// returns false — it never takes the process down, which matters most for the
// writes that run inside timers where nothing is there to catch a throw.
let onWriteError = (label, err) => console.error(`[Workspace] ${label} failed:`, err.message);

function setWriteErrorHandler(fn) {
  if (typeof fn === 'function') onWriteError = fn;
}

function safeWrite(filePath, content, label = 'write') {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, content);
    return true;
  } catch (err) {
    onWriteError(label, err);
    return false;
  }
}

function safeAppend(filePath, content, label = 'append') {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(filePath, content);
    return true;
  } catch (err) {
    onWriteError(label, err);
    return false;
  }
}

module.exports = {
  SQUAD_ROOT,
  PATHS,
  safeJoin,
  isInside,
  isPlainFilename,
  ensureWorkspace,
  safeWrite,
  safeAppend,
  setWriteErrorHandler,
};
