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

// ── Write verbs, split by how much they overlap with ordinary English ────────
// (CLASS 4 fix — judge the COMMAND, not the English word.)
//
// The old design put EVERY state-changing verb on one flat list and refused a
// clause whenever that word led it. That refused ordinary prose: "no rush",
// "clear it up", "copy the report to the incident record", the planner's own
// "if no target was named" — none of them a device command, all refused as one.
// The class fix is to ask whether the verb is actually giving a device an order.
//
// HARD_WRITE — device-specific verbs with essentially no innocent English life
// as a verb ("reload", "wipe", "erase"). Used as a verb (i.e. NOT an event-noun
// reference like "the reload" / "after restart"), they ALWAYS refuse.
const HARD_WRITE = new Set([
  'reload', 'reboot', 'restart', 'reset', 'erase', 'wipe', 'nuke', 'destroy',
  'overwrite', 'flush', 'factory', 'purge', 'format', 'shutdown', 'shut',
  'downgrade', 'upgrade', 'rollback', 'debug', 'undebug', 'reimage',
  'config', 'configure', 'conf',
]);

// AMBIGUOUS_WRITE — verbs that are ALSO everyday English ("no", "clear", "copy",
// "set", "remove", "delete", "kill", "enable", "disable"). On a device they are
// real writes; in prose they are ordinary words. They refuse ONLY when what they
// govern is device-shaped (a config/exec object, or a named device / IP) — never
// on a plain English object ("clear it up", "copy the report", "no rush"). Real
// writes always name their object ("clear counters", "no shutdown", "copy
// running-config"), which is exactly what the device-object test catches.
const AMBIGUOUS_WRITE = new Set([
  'no', 'clear', 'copy', 'set', 'unset', 'remove', 'delete', 'kill', 'apply',
  'push', 'deploy', 'install', 'provision', 'request', 'boot', 'archive',
  'commit', 'enable', 'disable', 'rename', 'write', 'wr',
]);

// The flat union stays exported for back-compat (SSH sidecar parity, callers).
const STATE_CHANGING = [...HARD_WRITE, ...AMBIGUOUS_WRITE];

// Device-shaped objects. When an AMBIGUOUS_WRITE verb is immediately followed
// (past one leading article) by one of these — a config/exec noun, a named
// device, or an IP — it is a real command, not English. Deliberately device/
// config vocabulary only, so ordinary objects ("the report", "it up", "rush",
// "the noise", "target") never qualify.
const DEVICE_OBJECT_WORDS = new Set([
  'config', 'configuration', 'running-config', 'startup-config', 'running',
  'startup', 'run', 'start', 'boot', 'mem', 'memory', 'terminal', 'term', 'flash',
  'bootflash', 'nvram', 'disk0', 'slot0', 'counters', 'counter', 'interface',
  'interfaces', 'int', 'vlan', 'vlans', 'route', 'routes', 'arp', 'mac', 'cam',
  'line', 'vty', 'logging', 'ip', 'ipv6', 'bootvar', 'system', 'image',
  'license', 'licenses', 'crypto', 'access-list', 'acl', 'port', 'ports',
  'trunk', 'vtp', 'stp', 'spanning-tree', 'service', 'process', 'processes',
  'session', 'sessions', 'tunnel', 'bgp', 'ospf', 'eigrp', 'isis', 'ntp',
  'snmp', 'ssh', 'telnet', 'clock', 'hostname', 'banner', 'username', 'secret',
  'password', 'aaa', 'tacacs', 'radius', 'dhcp', 'dns', 'nat', 'qos', 'vrf',
  'mpls', 'feature', 'module', 'redundancy', 'stack', 'switchport',
  'channel-group', 'port-channel', 'standby', 'hsrp', 'vrrp', 'mtu', 'cdp',
  'lldp', 'dot1x', 'shut', 'shutdown', 'errdisable', 'startup-configuration',
  'device', 'devices', 'switch', 'switches', 'router', 'routers', 'node',
  'nodes', 'chassis', 'controller',
]);

// A named device ("sw1", "leaf2", "n9k1", "gi1/0/3") or an IPv4 address is also
// a device-shaped object.
const DEVICE_NAME = /^(?:sw|swi|switch|rtr|router|r|leaf|spine|nexus|n9k|core|dist|acc|edge|agg|fw|asa|ftd|lb|f5|node|dev|device|box|cat|c9|gi|te|fa|eth|po)\d|^\d{1,3}(?:\.\d{1,3}){3}$/i;

function isDeviceObject(tok) {
  if (!tok) return false;
  const t = String(tok).toLowerCase();
  return DEVICE_OBJECT_WORDS.has(t) || DEVICE_NAME.test(t);
}

// ── Inflection (CLASS 4 fix — catch every tense) ────────────────────────────
// The old list matched only the bare lemma, so "reboots sw2", "he reloads it"
// and "wiping the config" slipped the intent screen (they still failed safe at
// the command parser, but the naming was inconsistent — a logged CW-2 debt).
// Rather than hand-list every tense, the common English inflections of each
// write verb are generated once into a lookup, so any tense maps to its lemma.
function inflect(base) {
  const f = new Set([base]);
  f.add(base + 's'); f.add(base + 'es'); f.add(base + 'ing'); f.add(base + 'ed');
  if (base.endsWith('e')) { f.add(base.slice(0, -1) + 'ing'); f.add(base + 'd'); } // wipe→wiping/wiped
  if (base.endsWith('y')) { f.add(base.slice(0, -1) + 'ies'); f.add(base.slice(0, -1) + 'ied'); } // copy→copies
  if (/[^aeiou][aeiou][^aeiouwxy]$/.test(base)) {              // shut→shutting, set→setting
    const d = base[base.length - 1];
    f.add(base + d + 'ing'); f.add(base + d + 'ed');
  }
  return f;
}
const WRITE_FORM_TO_BASE = new Map();
for (const base of STATE_CHANGING) {
  for (const form of inflect(base)) {
    if (!WRITE_FORM_TO_BASE.has(form)) WRITE_FORM_TO_BASE.set(form, base);
  }
}
// A read verb must never be shadowed by a generated write form.
for (const rv of READ_VERBS) WRITE_FORM_TO_BASE.delete(rv);

// PUNCTUATION INSIDE THE VERB (reviewer fix, class-level). tokensOf keeps
// hyphens and apostrophes, so a verb somebody typed with punctuation in it
// ("re-set the host-name on sw1", "re-load sw2", "shut-down gi1/0/3") missed the
// lookup entirely and the whole intent screen fell silent — the operator got
// "I could not find a read command" for what was plainly a change. Same class as
// the carrier and adverb shields: nothing standing inside or in front of the
// verb may hide it. The raw form is tried FIRST (so nothing already recognised
// changes), then the same token with its punctuation removed.
function writeBaseOf(tok) {
  if (!tok) return undefined;
  const raw = String(tok);
  const direct = WRITE_FORM_TO_BASE.get(raw);
  if (direct) return direct;
  const stripped = raw.replace(/[-'.]/g, '');
  if (stripped === raw) return undefined;
  if (READ_VERBS.includes(stripped)) return undefined;   // never shadow a read
  return WRITE_FORM_TO_BASE.get(stripped);
}

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

// Subject pronouns. "you reload", "we reboot", "I wipe it" name an ACTOR being
// told to act — that is an instruction, not a reference to a past event, even
// with no object after the verb ("after you reload" full stop). The old bare-
// event test (b) missed this: it saw only that "reload" was the last token after
// "after" and excused it, dropping a real write silently. This is exactly the
// verb-vs-noun class the pre-work exists to close, so the pronoun subject is
// named here and blocks the excuse in isEventReference below.
const SUBJECT_PRONOUNS = new Set(['you', 'we', 'i', 'u', 'they', 'he', 'she']);

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
  // SUBJECT PRONOUNS. A pronoun leading a clause ("you reload", "we reboot")
  // must be STEPPED PAST so the verb behind it is exposed as the command word —
  // otherwise the pronoun itself is read as the command word and the real verb
  // ("reload") is never judged at all, dropping the write silently. They are
  // ALSO listed in SUBJECT_PRONOUNS, where isEventReference reads `prev` (the
  // stepped-past token) to refuse "after you reload" as the instruction it is.
  // ('you', 'u', 'i', 'it', 'me', 'us' are already above.)
  'we', 'they', 'he', 'she',
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
  // A subject pronoun in front ("you reload", "we reboot") is an ACTOR being
  // instructed — never a past-event noun. This wins over BOTH tests below, so
  // "after you reload" (no object) is refused exactly as "after you reload the
  // router" already was.
  if (shape.prev && SUBJECT_PRONOUNS.has(shape.prev)) return false;
  if (shape.prev && DETERMINERS.has(shape.prev)) return true;          // (a)
  // (b) The clause is nothing but the event word after a time separator
  //     ("…after restart"). Only excused when nothing that could be a SUBJECT
  //     sits in front of it — a determiner is fine ("after the reload"), a bare
  //     event is fine ("after restart"), but any other leading word is treated
  //     as a possible actor and the excuse is withheld, failing safe to refuse.
  if (shape.bare && sep && TEMPORAL_SEPS.test(sep) && (!shape.prev || DETERMINERS.has(shape.prev))) return true;
  return false;
}

// ── Innocent everyday objects (fail-closed allowlist) ───────────────────────
// The object test below decides whether an ambiguous verb ("clear", "set",
// "install") is giving a device an order or just speaking English. It used to
// look ONLY at the token right after the verb, stepping past exactly ONE
// article — so a single adjective defeated it:
//
//   "clear all the counters on sw2"  → looked at "all" → not device → PASSED
//   "install the new image on sw1"   → looked at "new" → not device → PASSED
//   "set a new hostname"             → looked at "new" → not device → PASSED
//
// That is failing OPEN: the operator was never told the change was refused.
// The rule is now fail-CLOSED and reads the WHOLE object phrase:
//
//   1. a device-shaped token ANYWHERE after the verb  → WRITE (refuse)
//   2. otherwise, an explicitly innocent everyday word → English (pass)
//   3. otherwise → WRITE (refuse). Unrecognised objects fail closed.
//
// Only a clearly innocent object lets the clause through, so the failure mode
// is "refused something harmless" (visible, correctable) instead of "let a
// change through quietly" (invisible, dangerous).
//
// A bare verb with NO object at all is English: a real device command always
// names what it acts on ("clear counters", "no shutdown"), while ordinary
// speech does not ("no, that is fine", "let us clear it up" is covered by the
// particle "it"). So an empty object phrase passes.
const INNOCENT_OBJECTS = new Set([
  // pronouns and phrasal particles — "clear it up", "set up a call"
  'it', 'me', 'us', 'them', 'him', 'her', 'you', 'myself', 'ourselves',
  'up', 'out', 'off', 'over', 'through', 'along', 'aside', 'together',
  // ordinary quantity / degree words used as bare objects — "no more", "no rush"
  'more', 'less', 'rush', 'hurry', 'worries', 'problem', 'stress', 'panic',
  'doubt', 'idea', 'clue', 'air', 'noise', 'confusion', 'ambiguity',
  // the paperwork of an incident — never a device
  'report', 'reports', 'doc', 'docs', 'document', 'documents', 'documentation',
  'summary', 'note', 'notes', 'minutes', 'ticket', 'tickets', 'record',
  'records', 'log' , 'writeup', 'write-up', 'postmortem', 'rca', 'timeline',
  'page', 'wiki', 'readme', 'markdown', 'md', 'file', 'files', 'draft',
  // people and meetings
  'meeting', 'call', 'calls', 'bridge', 'thread', 'channel', 'email', 'mail',
  'message', 'messages', 'chat', 'invite', 'agenda', 'team', 'teams', 'people',
  'folks', 'everyone', 'anyone', 'staff', 'operator', 'operators', 'engineer',
  'engineers', 'shift', 'handover', 'standup', 'schedule', 'calendar',
  // planning words
  'target', 'targets', 'plan', 'plans', 'task', 'tasks', 'item', 'items',
  'list', 'backlog', 'board', 'comment', 'comments', 'question', 'questions',
  'answer', 'expectation', 'expectations', 'assumption', 'assumptions',
  'picture', 'scope', 'reminder', 'deadline', 'date', 'time',
  // software that is NOT the device's own image
  'build', 'dashboard', 'app', 'browser', 'laptop', 'desktop',
  // ordinary incident chatter
  'alert', 'alerts', 'alarm-noise', 'escalation', 'update', 'updates', 'status',
]);

// Every token after the verb, to the end of the clause. That whole phrase — not
// the one token after one article — is what the verb governs.
function objectPhrase(clause, verbRaw, atIdx) {
  const toks = tokensOf(clause);
  const i = (typeof atIdx === 'number' && atIdx >= 0) ? atIdx : toks.indexOf(verbRaw);
  if (i < 0) return null;
  return toks.slice(i + 1);
}

// Rule 1 above: is ANY token in the object phrase device-shaped?
function phraseNamesDevice(words) {
  return (words || []).some((w) => isDeviceObject(w));
}

// Rule 2 above: is the object phrase recognisable as ordinary English?
function phraseIsInnocent(words) {
  return (words || []).some((w) => INNOCENT_OBJECTS.has(w));
}

// Does the ambiguous verb leading this clause actually govern a device? Returns
// true (⇒ refuse) for a device-shaped object AND for an object we cannot read as
// everyday English — fail closed, per the block above.
function clauseGovernsDevice(clause, verbRaw, atIdx) {
  const words = objectPhrase(clause, verbRaw, atIdx);
  if (words === null) return false;               // verb not found — nothing to judge
  const meaningful = words.filter((w) => !DETERMINERS.has(w) && !FILLER.has(w));
  if (!meaningful.length) return false;           // bare verb, no object → English
  if (phraseNamesDevice(meaningful)) return true; // 1. device-shaped anywhere
  if (phraseIsInnocent(meaningful)) return false; // 2. clearly innocent English
  return true;                                    // 3. unrecognised → fail closed
}

// ── Carrier verbs (verb shielding) ──────────────────────────────────────────
// "run write memory", "execute erase startup-config", "perform a reload of sw2".
// The leading word is a harmless carrier — it says HOW to do the thing, never
// WHAT — so judging only the leading word read these as neither read nor write
// and let them fall through to the read parser, which found no read command and
// replied "I could not find a read command". The change was never refused out
// loud. Same class as the sequencing adverbs already handled in FILLER: a word
// standing in front of the real verb must never shield it.
//
// So when a clause opens with a carrier, the clause is SCANNED for the first
// real verb behind it. If that verb is a read ("run show version"), the clause
// is a read and the scan stops — which also keeps "run show boot system" a read
// instead of tripping on the write-verb homonym "boot".
const CARRIER_VERBS = new Set([
  'run', 'runs', 'ran', 'running', 'execute', 'executes', 'executed',
  'executing', 'perform', 'performs', 'performed', 'performing', 'issue',
  'issues', 'issued', 'issuing', 'trigger', 'triggers', 'triggering',
  'initiate', 'initiates', 'initiating', 'try', 'tries', 'trying', 'attempt',
  'attempts', 'attempting', 'send', 'sends', 'sending', 'fire', 'fires',
]);

// Scan a clause from `start` for the first read verb or write verb and classify
// from there. Returns null when the clause names neither.
//
// `excuseEvents` is false for a carrier scan on purpose: "perform a reload of
// sw2" puts a determiner in front of "reload", which the event-noun test would
// normally read as prose ("the reload happened"). Behind a carrier it is the
// OBJECT OF AN ORDER, not a past event, so the excuse does not apply.
function scanClauseForCommand(clause, sep, start, excuseEvents) {
  const toks = tokensOf(clause);
  for (let i = start; i < toks.length; i++) {
    const w = toks[i];
    if (READ_VERBS.includes(w)) return { kind: 'read', word: w };
    const base = writeBaseOf(w);
    if (!base) continue;
    if (base === 'write' || base === 'wr') {
      const after = toks.slice(i + 1).join(' ');
      if (SOFT_VERBS.write.test(after)) return null;   // "write me a report"
      return { kind: 'write', word: w, base };
    }
    const prev = i > 0 ? toks[i - 1] : null;
    if (excuseEvents && isEventReference({ word: base, prev, bare: i === toks.length - 1 }, sep)) continue;
    if (HARD_WRITE.has(base)) return { kind: 'write', word: w, base };
    if (AMBIGUOUS_WRITE.has(base)) {
      if (clauseGovernsDevice(clause, w, i)) return { kind: 'write', word: w, base };
      continue;   // everyday English — keep looking behind it
    }
  }
  return null;
}

// Classify ONE clause: 'read', 'write', or null (neither). This is the single
// place command-vs-English is decided, so checkIntent and splitIntent can never
// disagree. For a write it returns the ORIGINAL word (its real tense) so the
// refusal quotes the operator back verbatim, plus the lemma for internal logic.
function classifyClause(clause, sep) {
  const shape = commandShape(clause);
  const raw = shape.word;
  if (!raw) return { kind: null };
  if (READ_VERBS.includes(raw)) return { kind: 'read', word: raw };
  // VERB SHIELDING: a carrier verb ("run", "execute", "perform") in front of the
  // real verb must not hide it. Scan behind the carrier for the first real verb.
  if (CARRIER_VERBS.has(raw)) {
    const toks = tokensOf(clause);
    const at = toks.indexOf(raw);
    const inner = scanClauseForCommand(clause, sep, at + 1, false);
    if (inner) return inner;
    return { kind: null };
  }
  const base = writeBaseOf(raw);
  if (!base) return { kind: null };
  // 'write'/'wr' keep the document-author exception ("write me a report" is a
  // Doc-Writer job, "write mem" / "write erase" is not).
  if (base === 'write' || base === 'wr') {
    const toks = tokensOf(clause);
    const after = toks.slice(toks.indexOf(raw) + 1).join(' ');
    if (SOFT_VERBS.write.test(after)) return { kind: null };
    return { kind: 'write', word: raw, base };
  }
  // An event-noun reference ("the upgrade", "after restart", "its reboot") is
  // prose, not an order — judged on the lemma so any tense is covered.
  if (isEventReference({ word: base, prev: shape.prev, bare: shape.bare }, sep)) return { kind: null };
  if (HARD_WRITE.has(base)) return { kind: 'write', word: raw, base };
  if (AMBIGUOUS_WRITE.has(base)) {
    if (clauseGovernsDevice(clause, raw)) return { kind: 'write', word: raw, base };
    return { kind: null };   // everyday English, not a device command
  }
  return { kind: null };
}

// Does this plain-English request ASK for a state change?
// Returns { destructive, keyword, clause } — keyword/clause are what the
// refusal message quotes back, so the user is told exactly what was refused.
function checkIntent(text) {
  const raw = String(text || '');
  for (const { text: clause, sep } of clauseParts(raw)) {
    const c = classifyClause(clause, sep);
    if (c.kind === 'write') {
      return { destructive: true, keyword: c.word, clause: clause.trim() };
    }
  }
  return { destructive: false };
}

// ── "Is this a change?" — the last-chance read, for the refusal SINK ────────
// checkIntent judges the verb that LEADS each clause, which is the right test
// for "should this be refused before anything runs". But when the read parser
// has already failed to find a read command, the honest question changes from
// "does this lead with a write verb" to "was the operator asking for a change at
// all" — because the alternative reply ("I could not find a read command in
// that") tells an operator who asked for a change the wrong thing entirely.
//
// So this is a WIDER scan, used ONLY at that sink: any clause whose first real
// verb — wherever it sits — is a write. A read verb anywhere in the clause wins
// first (it is a read that simply did not parse), and event-noun references
// ("after the reload", "since the upgrade") are still prose.
function looksLikeChangeAsk(text) {
  const raw = String(text || '');
  for (const { text: clause, sep } of clauseParts(raw)) {
    const c = scanClauseForCommand(clause, sep, 0, true);
    if (c && c.kind === 'read') continue;
    if (c && c.kind === 'write') {
      return { destructive: true, keyword: c.word, clause: clause.trim() };
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
    // The leading-verb reading first — it is the strict one, and it owns the
    // event-noun and soft-verb exceptions.
    let c = classifyClause(clause, sep);
    // REVIEWER FIX (same class as the carrier/adverb shields): when the leading
    // word is neither read nor write, the real verb may simply be sitting behind
    // ordinary words that are not on the filler list — "maybe we should reload
    // sw2", "i was wondering if you could reload sw2". Judged by the leading word
    // alone those clauses classified as NOTHING, so a read alongside them ran and
    // the change was dropped without a word — the silent substitution this file
    // exists to prevent. So the clause gets the same WIDER scan the refusal sink
    // uses: its first real verb, wherever it sits. A read still wins.
    if (!c.kind) {
      const wide = scanClauseForCommand(clause, sep, 0, true);
      if (wide) c = wide;
    }
    if (c.kind === 'read') { readClauses.push(clause.trim()); continue; }
    if (c.kind === 'write' && !change) change = { keyword: c.word, clause: clause.trim() };
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
  splitIntent, clausesOf, clauseParts, commandShape, classifyClause,
  looksLikeChangeAsk, clauseGovernsDevice, scanClauseForCommand,
  INNOCENT_OBJECTS, CARRIER_VERBS,
  READ_VERBS, STATE_CHANGING, HARD_WRITE, AMBIGUOUS_WRITE,
  DEVICE_OBJECT_WORDS, WRITE_FORM_TO_BASE, isDeviceObject,
  EVENT_NOUNS, DETERMINERS, SUBJECT_PRONOUNS,
  // Exported so the SSH sidecar's mirrored rules can be parity-checked against
  // these (sources/ssh-runner.smoke.js). Drift between the two layers must fail
  // a test, not sit silently until someone tightens one side only.
  PRINTABLE_ASCII, PRINTABLE_ASCII_MIN, PRINTABLE_ASCII_MAX,
  CHAIN_CHARS, CHAIN_CHAR_LIST,
};
