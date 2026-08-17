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
//
// The LIST is the single source of truth and the regex is BUILT from it, so a
// character can never be in one and not the other. The SSH sidecar mirrors this
// list and the parity test compares against this exported array — not a copy of
// it typed into the test, which is how a dropped character slipped through
// before while the suite still reported green.
const CHAIN_CHAR_LIST = [';', '&', '|', '>', '<', '`', '$', '\n', '\r'];
const CHAIN_CHARS = new RegExp(
  `[${CHAIN_CHAR_LIST.map((c) => c.replace(/[.*+?^${}()|[\]\\\-]/g, '\\$&')).join('')}]`
);

// Charset ALLOWLIST — printable ASCII only (space .. tilde).
//
// The chain-char list above is a blacklist: it only blocks characters we
// thought of. Control and exotic-Unicode characters (NUL, ESC, VTAB, FORMFEED,
// BACKSPACE, NEL \x85, U+2028/U+2029 line separators) sailed straight past it
// and would have been written into the SSH channel. Rather than grow the
// blacklist one discovered character at a time, the charset is now allowlisted:
// anything outside printable ASCII is refused. Every real show-class command is
// printable ASCII, so nothing legitimate is lost and the unknown-unknowns close.
const PRINTABLE_ASCII_MIN = 0x20;
const PRINTABLE_ASCII_MAX = 0x7e;
const PRINTABLE_ASCII = new RegExp(
  `^[\\u${PRINTABLE_ASCII_MIN.toString(16).padStart(4, '0')}-\\u${PRINTABLE_ASCII_MAX.toString(16).padStart(4, '0')}]+$`
);

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

// ── Nouns that look like verbs (CW-2 pre-work, class fix) ───────────────────
// Reviewer-logged bug (PR #38): checkIntent judged FREE PROSE as if it were a
// command. A delegated read whose justification read "…confirm the image after
// the upgrade" split at "after", left the clause "the upgrade", stripped the
// article as filler, and refused a legitimate show because the NOUN "upgrade"
// sat on the state-changing list.
//
// The class is: a word on STATE_CHANGING is only a COMMAND when it is used as a
// VERB. Several of those words are also ordinary English NOUNS naming an event
// that already happened or is planned ("the upgrade", "since the last reload",
// "after restart"). Two structural signals separate the two uses, and both look
// at the clause BEFORE conversational filler is stripped:
//
//   (a) DETERMINER TEST — a determiner or possessive immediately in front of the
//       word makes it a noun phrase ("the upgrade", "last reload", "its reboot").
//       A real instruction never says "the reload sw1".
//   (b) BARE-EVENT TEST — the clause is nothing but the word, and it arrived
//       after a TIME separator ("…after restart"). That is a point in time being
//       referred to, not an order.
//
// Both tests apply ONLY to the event-noun list below. Words with no noun life
// on a device ("erase", "wipe", "shut") are never excused, so "; erase" and
// "then wipe the config" are refused exactly as before. And the tests need the
// SEPARATOR that produced the clause, which is why clausesOf now returns it.
const EVENT_NOUNS = new Set([
  'upgrade', 'downgrade', 'reload', 'reboot', 'restart', 'change', 'deploy',
  'rollback', 'commit', 'install', 'patch', 'provision', 'copy', 'reset',
  'boot', 'archive', 'config', 'configuration', 'maintenance',
]);

// Determiners / possessives / quantifiers. In front of an event noun they make
// it a noun phrase. NOT pronoun subjects ("you", "we") — "after you reload the
// router" is still a real instruction and must still be refused.
const DETERMINERS = new Set([
  'the', 'a', 'an', 'this', 'that', 'these', 'those', 'my', 'your', 'our',
  'its', 'their', 'his', 'her', 'last', 'latest', 'next', 'previous', 'recent',
  'any', 'each', 'every', 'some', 'one', 'another', 'scheduled', 'planned',
  'emergency', 'unplanned', 'first', 'second', 'no', 'both', 'said',
]);

// Separators that introduce a POINT IN TIME rather than a fresh instruction.
// Used only by the bare-event test — ";" "&&" "then" are NOT here, so
// "show version; reload" and "show version then reload" stay refusals.
const TEMPORAL_SEPS = /^(?:after|before|once|while|since|until|during|following|afterwards?|subsequently|later|thereafter|eventually|meanwhile)$/i;

// Words people put in front of the real verb. Stripped before we decide what
// the command intent actually is, so "please erase startup-config" is caught.
const FILLER = new Set([
  'please', 'pls', 'kindly', 'can', 'could', 'would', 'will', 'you', 'u',
  'hey', 'hi', 'ok', 'okay', 'just', 'also', 'now', 'then', 'go', 'and',
  'lets', "let's", 'let', 'us', 'me', 'i', 'want', 'need', 'to', 'do',
  'the', 'a', 'an', 'my', 'your', 'our', 'this', 'that', 'it', 'quickly',
  // SEQUENCING ADVERBS. These say WHEN the next command runs, never WHAT it is,
  // so they must never be mistaken for the command word. Left in place, the
  // adverb stood at the head of the clause and shielded the real verb behind it:
  // "…and afterwards reload it" read as the harmless word "afterwards", the read
  // ran, and the operator was never told the reload had been dropped. Listed
  // here AND as clause separators below, so the verb is exposed whether the
  // adverb joins two clauses or merely leads one.
  'afterwards', 'afterward', 'subsequently', 'later', 'thereafter', 'finally',
  'next', 'eventually', 'immediately', 'straightaway', 'meanwhile', 'lastly',
  'firstly', 'secondly', 'first', 'second', 'again', 'quickly', 'promptly',
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
//
// The list therefore has to cover every way English says "and then do this
// other thing" — not just the conjunctions but the SEQUENCING ADVERBS people
// naturally reach for ("afterwards", "subsequently", "later", "finally",
// "next"). Each one is a joint between two commands, and any joint this misses
// is a second command nobody is judging.
// The separator that produced each clause is KEPT (capturing group), because
// "after restart" and "; restart" are different English and must be judged
// differently — see the EVENT_NOUNS block above.
const CLAUSE_SPLIT = /([;&|,\n\r]+|\band then\b|\bafter that\b|\bthen\b|\band\b|\bbefore\b|\bafter\b|\bonce\b|\bwhile\b|\bunless\b|\bbut\b|\bso\b|\balso\b|\bafterwards?\b|\bsubsequently\b|\blater\b|\bthereafter\b|\bfinally\b|\bnext\b|\beventually\b|\bmeanwhile\b|\blastly\b|\bfollowed by\b)/i;

// Clauses WITH the separator that introduced each one: [{ text, sep }].
// `sep` is null for the first clause (nothing introduced it).
function clauseParts(text) {
  const pieces = String(text || '').split(new RegExp(CLAUSE_SPLIT.source, 'gi'));
  const out = [];
  let sep = null;
  for (let i = 0; i < pieces.length; i++) {
    const piece = String(pieces[i] || '');
    if (i % 2 === 1) { sep = piece.trim(); continue; } // captured separator
    const t = piece.trim();
    if (t) out.push({ text: t, sep });
  }
  return out;
}

// Back-compatible: the clause strings only.
function clausesOf(text) {
  return clauseParts(text).map((c) => c.text);
}

function tokensOf(clause) {
  return String(clause || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

// First meaningful word of a clause, with conversational filler stripped.
function commandWord(clause) {
  for (const w of tokensOf(clause)) {
    if (!FILLER.has(w)) return w;
  }
  return '';
}

// The first meaningful word PLUS the structure around it, which is what tells a
// verb from a noun. `prev` is the raw word in front of it (filler NOT stripped —
// the article is the evidence), and `bare` means the clause ends there.
function commandShape(clause) {
  const words = tokensOf(clause);
  for (let i = 0; i < words.length; i++) {
    if (FILLER.has(words[i])) continue;
    return {
      word: words[i],
      prev: i > 0 ? words[i - 1] : null,
      bare: i === words.length - 1,
    };
  }
  return { word: '', prev: null, bare: true };
}

// Is this occurrence a NOUN (an event being referred to) rather than a command?
// Only ever true for the event-noun list; see the block above for the two tests.
function isEventReference(shape, sep) {
  if (!EVENT_NOUNS.has(shape.word)) return false;
  if (shape.prev && DETERMINERS.has(shape.prev)) return true;          // (a)
  if (shape.bare && sep && TEMPORAL_SEPS.test(sep)) return true;       // (b)
  return false;
}

// Does this plain-English request ASK for a state change?
// Returns { destructive, keyword, clause } — keyword/clause are what the
// refusal message quotes back, so the user is told exactly what was refused.
function checkIntent(text) {
  const raw = String(text || '');
  for (const { text: clause, sep } of clauseParts(raw)) {
    const shape = commandShape(clause);
    const word = shape.word;
    if (!word) continue;
    if (READ_VERBS.includes(word)) continue; // a read clause is a read clause
    // A clause that is nothing but the word "no" is the English "no", not the
    // Cisco "no <command>" — "no, show me the version" must not be refused.
    // "no shut" still has a second word, so it is still judged a change.
    if (word === 'no' && /^no\W*$/i.test(clause.trim())) continue;
    // Ordinary-English use of a verb that is only destructive on a device.
    if (SOFT_VERBS[word]) {
      const rest = tokensOf(clause);
      const after = rest.slice(rest.indexOf(word) + 1).join(' ');
      if (SOFT_VERBS[word].test(after)) continue;
    }
    // The word is on the list, but is it being USED as a command? A rationale
    // that refers to an event ("after the upgrade", "…after restart") is prose,
    // not an instruction, and refusing it refuses a legitimate read.
    if (isEventReference(shape, sep)) continue;
    if (STATE_CHANGING.includes(word)) {
      return { destructive: true, keyword: word, clause: clause.trim() };
    }
  }
  return { destructive: false };
}

// ── Compound "read then change" (CW-2 pre-work 2) ───────────────────────────
// "reload sw1 then show me the version" is TWO asks in one sentence. Refusing
// the whole thing drops the read silently; running the whole thing is a write.
// So the two halves are separated here, at the one place that already knows how
// to cut a sentence into clauses, and the caller honours the read half out loud
// while refusing the change half out loud.
//
// readText is rebuilt from the READ clauses ONLY, so no fragment of the change
// half can reach the command parser or the wire.
function splitIntent(text) {
  const raw = String(text || '');
  const readClauses = [];
  let change = null;
  for (const { text: clause, sep } of clauseParts(raw)) {
    const shape = commandShape(clause);
    const word = shape.word;
    if (!word) continue;
    if (READ_VERBS.includes(word)) { readClauses.push(clause.trim()); continue; }
    if (word === 'no' && /^no\W*$/i.test(clause.trim())) continue;
    if (SOFT_VERBS[word]) {
      const rest = tokensOf(clause);
      const after = rest.slice(rest.indexOf(word) + 1).join(' ');
      if (SOFT_VERBS[word].test(after)) continue;
    }
    if (isEventReference(shape, sep)) continue;
    if (STATE_CHANGING.includes(word) && !change) {
      change = { keyword: word, clause: clause.trim() };
    }
  }
  return {
    destructive: Boolean(change),
    change,
    readClauses,
    readText: readClauses.join('. '),
    compound: Boolean(change) && readClauses.length > 0,
  };
}

// Convenience wrapper for callers: throws with a plain-words message.
function assertReadOnly(command) {
  const verdict = checkCommand(command);
  if (!verdict.allowed) throw new Error(verdict.reason);
  return verdict.command;
}

module.exports = {
  checkCommand, checkIntent, assertReadOnly, commandWord,
  splitIntent, clausesOf, clauseParts, commandShape,
  READ_VERBS, STATE_CHANGING, EVENT_NOUNS, DETERMINERS,
  // Exported so the SSH sidecar's mirrored rules can be parity-checked against
  // these (sources/ssh-runner.smoke.js). Drift between the two layers must fail
  // a test, not sit silently until someone tightens one side only.
  PRINTABLE_ASCII, PRINTABLE_ASCII_MIN, PRINTABLE_ASCII_MAX,
  CHAIN_CHARS, CHAIN_CHAR_LIST,
};
