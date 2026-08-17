// Read-only guardrail: the ONLY commands this server may ever send to a device.
// Anything that is not a show-class read is rejected here, before any adapter
// is called. This is the code-level half of "read-only against real kit".
//
// Two separate jobs live in this file, and keeping them apart is the whole point:
//
//   checkCommand(cmd)  — is this exact CLI string safe to send to a device?
//                        Strict. Leading verb must be a read verb, and no shell
//                        or CLI chaining characters may appear anywhere.
//
//   checkIntent(text)  — does this plain-English request ASK for something
//                        destructive? Runs against the RAW user text, so a
//                        destructive request is refused out loud instead of
//                        being quietly dropped.
//
// The old code ran one keyword regex over an already-extracted fragment, which
// meant: destructive text after a ";" was trimmed away before the check (silent
// pass), while the harmless noun "config" inside "show me the running config"
// was blocked. Command intent, not word presence, is what decides now.
const READ_VERBS = ['show', 'ping', 'traceroute', 'dir', 'more'];

// Chaining / redirection characters. These are how a read command gets turned
// into a write, so they are refused wherever they appear in a device command.
const CHAIN_CHARS = /[;&|><`$\n\r]/;

// Charset ALLOWLIST — printable ASCII only (space .. tilde).
//
// The chain-char list above is a blacklist: it only blocks characters we
// thought of. Control and exotic-Unicode characters (NUL, ESC, VTAB, FORMFEED,
// BACKSPACE, NEL \x85, U+2028/U+2029 line separators) sailed straight past it
// and would have been written into the SSH channel. Rather than grow the
// blacklist one discovered character at a time, the charset is now allowlisted:
// anything outside printable ASCII is refused. Every real show-class command is
// printable ASCII, so nothing legitimate is lost and the unknown-unknowns close.
const PRINTABLE_ASCII = /^[\x20-\x7E]+$/;

// Verbs that change device state. These block only when they are the COMMAND
// INTENT — the first real word of the request or of a chained clause — never
// when they appear as a noun inside a legitimate read ("running config",
// "backup status", "clear-text", "debug logs").
const STATE_CHANGING = [
  'config', 'configure', 'conf', 'write', 'wr', 'erase', 'reload', 'reboot',
  'restart', 'copy', 'delete', 'remove', 'clear', 'set', 'unset', 'no',
  'shut', 'shutdown', 'reset', 'debug', 'undebug', 'install', 'request',
  'boot', 'format', 'rename', 'rollback', 'commit', 'enable', 'disable',
  'upgrade', 'downgrade', 'provision', 'deploy', 'push', 'apply', 'archive',
  // Plain-English ways people ask for the same destruction.
  'wipe', 'nuke', 'destroy', 'overwrite', 'flush', 'factory', 'purge', 'kill',
];

// Verbs on the list above that are ALSO ordinary English. They mean "change the
// device" only when what follows is device-shaped; followed by any of these
// words they are authoring, not configuring, and must not be refused.
// ("write me a report" is a Doc-Writer job; "write erase" is not.)
const SOFT_VERBS = {
  write: /^(a|an|me|us|up|out|report|reports|doc|docs|document|documentation|summary|notes|note|file|markdown|md|inventory|down)\b/i,
};

// Words people put in front of the real verb. Stripped before we decide what
// the command intent actually is, so "please erase startup-config" is caught.
const FILLER = new Set([
  'please', 'pls', 'kindly', 'can', 'could', 'would', 'will', 'you', 'u',
  'hey', 'hi', 'ok', 'okay', 'just', 'also', 'now', 'then', 'go', 'and',
  'lets', "let's", 'let', 'us', 'me', 'i', 'want', 'need', 'to', 'do',
  'the', 'a', 'an', 'my', 'your', 'our', 'this', 'that', 'it', 'quickly',
]);

function checkCommand(command) {
  const cmd = String(command || '').trim();
  if (!cmd) return { allowed: false, reason: 'Empty command — nothing to run.' };

  // Charset allowlist runs FIRST — a control character is refused before any
  // other rule gets a chance to normalise it away.
  if (!PRINTABLE_ASCII.test(cmd)) {
    return {
      allowed: false,
      reason: 'Blocked: that command contains characters outside printable ASCII (control or exotic Unicode). Only plain printable text is allowed.',
    };
  }

  if (CHAIN_CHARS.test(cmd)) {
    return {
      allowed: false,
      reason: 'Blocked: that command chains or redirects (; & | > < ` $). Only a single read command is allowed.',
    };
  }

  const verb = cmd.split(/\s+/)[0].toLowerCase();
  if (!READ_VERBS.includes(verb)) {
    return {
      allowed: false,
      reason: `Blocked: "${verb}" is not a read-only command. Allowed verbs: ${READ_VERBS.join(', ')}.`,
    };
  }

  // With chaining characters already refused above, everything after a read
  // verb is an argument to that read — it cannot change device state. So the
  // noun "config" in "show running-config" is fine, which is the whole job of
  // the agent that uses this.
  return { allowed: true, command: cmd };
}

// Split plain English into command clauses. A destructive verb hiding after a
// ";", a "|", "&&", a comma, or a joining word like "then" / "before" / "once"
// is still a command, so each clause is judged on its own. Miss a separator and
// a request like "show version after you reload the router" reads as a plain
// show — the read runs and the reload is dropped without a word, which is the
// silent substitution this whole file exists to prevent.
function clausesOf(text) {
  return String(text || '')
    .split(/[;&|,\n\r]+|\band then\b|\bafter that\b|\bthen\b|\band\b|\bbefore\b|\bafter\b|\bonce\b|\bwhile\b|\bunless\b|\bbut\b|\bso\b|\balso\b/i)
    .map((c) => c.trim())
    .filter(Boolean);
}

// First meaningful word of a clause, with conversational filler stripped.
function commandWord(clause) {
  const words = String(clause || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  for (const w of words) {
    if (!FILLER.has(w)) return w;
  }
  return '';
}

// Does this plain-English request ASK for a state change?
// Returns { destructive, keyword, clause } — keyword/clause are what the
// refusal message quotes back, so the user is told exactly what was refused.
function checkIntent(text) {
  const raw = String(text || '');
  for (const clause of clausesOf(raw)) {
    const word = commandWord(clause);
    if (!word) continue;
    if (READ_VERBS.includes(word)) continue; // a read clause is a read clause
    // A clause that is nothing but the word "no" is the English "no", not the
    // Cisco "no <command>" — "no, show me the version" must not be refused.
    // "no shut" still has a second word, so it is still judged a change.
    if (word === 'no' && /^no\W*$/i.test(clause.trim())) continue;
    // Ordinary-English use of a verb that is only destructive on a device.
    if (SOFT_VERBS[word]) {
      const rest = String(clause).toLowerCase().replace(/[^a-z0-9\s'-]/g, ' ')
        .split(/\s+/).filter(Boolean);
      const after = rest.slice(rest.indexOf(word) + 1).join(' ');
      if (SOFT_VERBS[word].test(after)) continue;
    }
    if (STATE_CHANGING.includes(word)) {
      return { destructive: true, keyword: word, clause: clause.trim() };
    }
  }
  return { destructive: false };
}

// Convenience wrapper for callers: throws with a plain-words message.
function assertReadOnly(command) {
  const verdict = checkCommand(command);
  if (!verdict.allowed) throw new Error(verdict.reason);
  return verdict.command;
}

module.exports = {
  checkCommand, checkIntent, assertReadOnly, commandWord,
  READ_VERBS, STATE_CHANGING,
  // Exported so the SSH sidecar's mirrored rules can be parity-checked against
  // these (sources/ssh-runner.smoke.js). Drift between the two layers must fail
  // a test, not sit silently until someone tightens one side only.
  PRINTABLE_ASCII, CHAIN_CHARS,
};
