// capabilities.js — THE single source of truth for what Jarvis can actually do.
//
// Plain words: this file is the honest list of Jarvis's abilities. Two jobs read
// from it and nothing else:
//   1. GET /api/capabilities — what the desk shows the operator ("here is what I
//      can do"), including the abilities that are NOT built yet and WHY.
//   2. Honest refusals — when an ask UNAMBIGUOUSLY asks Jarvis to PERFORM an
//      ability that is not built or not connected, Jarvis says so in plain words
//      and shows what it CAN do, instead of guessing or dead-ending.
//
// LAW: an ability with available:false MUST carry a plain-words `reason`. Never a
// wrong answer, never a silent dead-end, never a hardcoded refusal string
// somewhere else in the code — every refusal is built FROM this map.
//
// WHAT THE FIRST VERSION GOT WRONG (review of PR #42, fixed here as a class):
// it matched on the PRESENCE of a verb, so "why did sw1 reload last night?" —
// a read-only question about the past — was refused as a change request, and
// "show me the reload reason on sw1" (literally a show command) went the same
// way. A verb-presence regex cannot separate "do X" from "why did X happen".
// So the decision is now made on INTENT, in this order:
//   1. Is it a read-only command/question? → allowed, always, no further tests.
//   2. Is it a question ABOUT state or the past? → allowed (pass through).
//   3. Does it IMPERATIVELY ask us to perform an unbuilt ability, on a real
//      object? → honest refusal with that ability's reason.
//   4. Anything else → PASS THROUGH to real reasoning. When in doubt we pass
//      through: a wrong refusal is a regression; a pass-through just gets real
//      thinking. The only exception is an ask with nothing to do with this NOC
//      at all ("order me a pizza"), which is refused as out of scope.
//
// `match` is internal routing only; it is never sent to the browser.

const ABILITIES = [
  {
    key: 'ask',
    label: 'Ask about the network',
    plain: 'Ask me anything about the estate in plain words — health, alarms, devices, why something looks wrong — and I read the real sources to answer.',
    example: 'what is the health of the campus estate right now?',
    available: true,
  },
  {
    key: 'run-command',
    label: 'Run a read-only command on a device',
    plain: 'I can run read-only commands (show / ping / traceroute / dir / more) on a device and show you the real output.',
    example: 'run show version on sw1',
    available: true,
  },
  {
    // CW-2 REALITY, and the map has to tell it. The change engine is BUILT and
    // every step of its wrap runs for real — the permission gate, the
    // before-capture, the after-capture, the diff, the validation, the rollback
    // plan. What does not exist is a WRITE TRANSPORT to the kit we are actually
    // connected to: Catalyst Center answers 403 "Role does not have valid
    // permissions" to every configuration-write API on this sandbox account
    // (Command Runner is a read-only endpoint by design), and the SSH path stays
    // read-only until CW-5.
    //
    // So `available` stays FALSE — because "make a change on a device" is what
    // the operator would be promised, and that promise cannot be kept on any
    // device we can currently reach. Marking it true because the engine exists
    // would be the map lying about the estate. `engineBuilt` says the other half
    // of the truth, so the desk can show the wrap and the honest freeze.
    key: 'change',
    label: 'Make a change on a device',
    plain: 'Push a config change with the full safety wrap — approval, before/after capture, diff, validation and a rollback plan.',
    example: 'set the description on GigabitEthernet1/0/3 on sw2',
    available: false,
    engineBuilt: true,
    reason: 'The change engine is built and every safety step runs for real, but there is no write path to any device I am connected to: '
      + 'the Catalyst Center sandbox account is read-only (it answers 403 "Role does not have valid permissions" to every configuration-write API), '
      + 'and the SSH path stays read-only until CW-5. I will run the whole wrap and freeze honestly at the apply step rather than pretend a change landed.',
  },
  {
    key: 'nautobot-sot',
    label: 'Check a device against the source of truth (Nautobot)',
    plain: 'Compare a device\'s live state against what Nautobot says it SHOULD be, and report every difference (intended vs actual) — never overwriting either side, never inventing drift.',
    example: 'does sw2 match the source of truth?',
    dynamic: 'nautobot',
    available: false,
    engineBuilt: true,
    reason: 'Nautobot not connected — set NAUTOBOT_URL + NAUTOBOT_TOKEN (a read-only API token). '
      + 'The client and the reconcile engine are built; until connected no state is compared and no in-sync/drift verdict is invented.',
  },
  {
    key: 'packet-analysis',
    label: 'Analyze a packet capture',
    plain: 'Hand me a packet capture (.pcap) and I read the real packets — top talkers, protocol mix, TCP resets/retransmit hints and obvious errors. Metadata only; I never dump payloads.',
    example: 'analyze this capture — who are the top talkers and are there resets?',
    available: true,
    engineBuilt: true,
  },
  {
    key: 'batfish-validation',
    label: 'Validate a change offline (Batfish)',
    plain: 'Before any device is touched, check a proposed config change against a network model — parse health, undefined references, and whether it breaks who-can-reach-what — and report clean / issues honestly.',
    example: 'would this ACL change on sw2 break reachability?',
    dynamic: 'batfish',
    available: false,
    engineBuilt: true,
    reason: 'Batfish not connected — set BATFISH_HOST (needs a Batfish service, e.g. Docker batfish/allinone). '
      + 'The client and the parse→verdict engine are built and every analysis is real once the service is set; '
      + 'until then no config is analysed and no verdict is invented (never a fake clean/issues).',
  },
  {
    key: 'drift',
    label: 'Check a device against its baseline',
    plain: 'Compare a device\'s live config against its saved baseline and report every deviation — including which recorded change explains it.',
    example: 'check sw2 against its baseline',
    available: true,
  },
  {
    // CW-3: the built-in ticket queue is live. The queue is the SINGLE SOURCE OF
    // TRUTH for tickets; ServiceNow (CW-6) becomes a mirror that syncs when
    // connected, never a second truth. INTENT-FIRST: chat never creates a ticket
    // directly — an "open a ticket for X" ask reaches the planner, which composes
    // a PROPOSAL the operator confirms; the confirm is what actually creates it.
    key: 'tickets',
    label: 'Raise and track tickets',
    plain: 'Create, assign and close tickets from the conversation, with one built-in queue as the single source of truth.',
    example: 'open a P2 for the branch-3 slowness',
    available: true,
  },
  {
    // CW-4 REALITY: the Teams bridge is BUILT and every POST is real. What gates
    // `available` is whether a webhook exists to post THROUGH: `TEAMS_WEBHOOK`.
    // Unset → available:false with the honest "add a webhook" reason and NOTHING
    // is posted; set → available:true and posts are real. `engineBuilt:true`
    // always (like CW-2's change) so the desk can show the wiring is done and the
    // only missing piece is Vikas's webhook. `available` is resolved dynamically
    // from the env in publicShape — a late-set webhook flips it without a restart.
    // HONEST ONE-WAY LIMIT: Incoming Webhooks are post-only; reading replies needs
    // a Teams bot/flow to feed POST /api/copilot/teams/inbound.
    key: 'teams',
    label: 'Post updates to Teams',
    plain: 'Post bridge updates into a Microsoft Teams channel. One-way for now (Incoming Webhooks are post-only); replies need a Teams bot/flow to feed them back.',
    example: 'post this bridge update to the Teams channel',
    dynamic: 'teams',
    available: false,
    engineBuilt: true,
    reason: 'Teams not connected — add a webhook (set TEAMS_WEBHOOK to a Microsoft Teams Incoming Webhook URL). '
      + 'The bridge is built and every post is real once the webhook is set; until then nothing is posted (never a fake "sent ✓"). '
      + 'Note: Incoming Webhooks are one-way (post only) — reading replies back needs a Teams bot/Power-Automate flow to feed them into the bridge.',
  },
  {
    // CW-6 REALITY: the two-way ServiceNow sync is BUILT and every Table API call
    // is real. What gates `available` is whether an instance + creds exist to sync
    // THROUGH: SNOW_INSTANCE + SNOW_USER + SNOW_PASS. Any missing → available:false
    // with the honest "add instance + creds" reason and NOTHING is synced (never a
    // fabricated INC); all three set → available:true and syncs are real.
    // `engineBuilt:true` always (like CW-2/CW-4) so the desk shows the wiring is
    // done and the only missing piece is Vikas's ServiceNow instance + creds.
    // Resolved dynamically in publicShape so late-set creds flip it without a
    // restart; the credential VALUES never enter the shape — only the boolean.
    // The internal queue stays the single source of truth; SNOW is a mirror. The
    // structured ServiceNow EXPORT (artifacts.js) remains the fallback when unset.
    key: 'servicenow',
    label: 'Sync tickets to ServiceNow',
    plain: 'Push an internal ticket to a real ServiceNow incident and pull its state back — the internal queue stays the source of truth; ServiceNow is a mirror.',
    example: 'open a ServiceNow ticket for this incident',
    dynamic: 'servicenow',
    available: false,
    engineBuilt: true,
    reason: 'ServiceNow not connected — add instance + creds (set SNOW_INSTANCE, SNOW_USER and SNOW_PASS in .env.local). '
      + 'The two-way sync is built and every Table API call is real once all three are set; until then nothing is synced (never a fabricated INC number). '
      + 'The internal queue stays the single source of truth, and the structured ServiceNow export stays available as the fallback.',
  },
  {
    // CW-7: investigate is now the ITERATIVE LOOP, not a one-shot triage. Jarvis
    // grills the problem (asks the operator when it is too vague and runs nothing
    // until answered), then probes round by round — each round it picks the single
    // highest-value read-only check, delegates it to the right agent through the
    // permission gate, and narrows the hypotheses + a confidence score from the
    // REAL report — stopping when the root cause is isolated (confidence), when it
    // hits the safety round cap (honest best guess), or when it is stuck (says what
    // it needs). A config fix comes back as an approve-first change proposal.
    key: 'investigate',
    label: 'Investigate a problem end to end',
    plain: 'Give me a symptom and I investigate it as a loop — I grill it until it is specific, then probe round by round with the right agents, narrowing the hypotheses and a confidence score from each real report, until I isolate the root cause (or hit the round cap and say so honestly) and plan the fix.',
    example: 'why is branch-3 slow since 2pm — investigate it',
    available: true,
  },
  {
    // CW-8 REALITY: the generic MCP connector is BUILT — it connects to declared
    // MCP servers over stdio, lists their tools, and exposes each as a gated,
    // read-only-by-default delegation target for Jarvis. What gates `available` is
    // whether ANY server is actually connected with tools right now (resolved
    // dynamically in publicShape, so a late-configured/reconnected server flips it
    // without a restart). None connected → available:false with the honest reason
    // and Jarvis has NO MCP tools (nothing fabricated). `engineBuilt:true` always,
    // like CW-2/4/6 — the wiring is done; the only missing piece is a configured,
    // security-vetted server. Server creds live in config/env only, never here.
    key: 'external-tools',
    label: 'Call external MCP tools',
    plain: 'Connect to external MCP tool servers and let Jarvis call their read-only tools — through the same permission gate and audit as a device read. Write-looking tools are approve-first, never auto-run.',
    example: 'pull the device list from the NetClaw MCP server',
    dynamic: 'mcp',
    available: false,
    engineBuilt: true,
    reason: 'No MCP tools connected — configure a server. The connector is built (stdio transport, tool discovery, the permission gate, read-only posture and audit all run); '
      + 'until a server is declared and connects, Jarvis has no MCP tools and invents none. Server credentials live in config/env only, never logged.',
  },
  {
    // CW-10 item 5. Jarvis's REASONING calls (never a probe) carry Anthropic's
    // server-side web_search + web_fetch, so mid-investigation it can check a
    // vendor advisory or release note. What comes back is a WEB source and is
    // labelled as one in chat — it never enters finding.cli and is never shown
    // as something a device reported. Availability is HONEST and dynamic: it is
    // false until a real call has proved the account accepts the tool types, and
    // it flips back to false for good the first time the account rejects them.
    key: 'web-research',
    label: 'Check vendor docs and known bugs on the web',
    plain: 'Mid-investigation I can look up vendor documentation, release notes and known-bug advisories, and I always say which web page a claim came from — a web page is never presented as a reading from your network.',
    example: 'is there a known bug in IOS-XE 17.12 affecting EPG learning?',
    dynamic: 'web-research',
    available: false,
    engineBuilt: true,
    reason: 'The server-side web search/fetch tools have not been confirmed on this Anthropic account yet — the wiring is done and the first reasoning call that uses them decides it. If the account rejects them the capability stays off and Jarvis says so rather than guessing at a vendor bug.',
  },
  {
    key: 'bridge',
    label: 'Run the incident bridge',
    plain: 'Keep the bridge: roles (commander, scribe, joiners), SLA clocks, the running timeline and the handover write-up.',
    example: 'who is on the bridge and what is the SLA clock?',
    available: true,
  },
];

// ── The vocabulary this NOC works in ────────────────────────────────────────
// Anything that names kit, a front, a symptom or the console itself. Used only
// to spot an ask that has nothing to do with this NOC at all.
// CLASS 9: the incident-id SHAPES this console mints (INC-YYYYMMDD-NNN, trg-…) and
// the shift-handover vocabulary are part of this NOC's language — an ask that
// quotes one ("summarise INC-20260817-013", "give me a shift handover") must never
// be bounced as off-topic, since reading this console's own incidents is now built.
const NOC_VOCAB = /\b(inc-\d+|trg-[a-z0-9]+|handover|hand[\s-]?off|verdict|hypothesis|bgp|ospf|isis|eigrp|mpls|vlan|stp|spanning[\s-]?tree|route|routing|prefix|peer|neighbou?r|interface|port|uplink|switch|router|firewall|fortigate|f5|load[\s-]?bal|vip|pool|vpn|tunnel|ipsec|wan|lan|sd-?wan|aci|fabric|apic|vmanage|catalyst|dnac|sw\d+|leaf|spine|edge|core|access[\s-]?point|wireless|wifi|subnet|ip\b|dns|dhcp|ntp|snmp|syslog|latency|jitter|throughput|bandwidth|packet|cpu|memory|disk|uptime|reload|version|config|inventory|topology|fault|alarm|alert|health|estate|network|device|node|link|circuit|site|branch|campus|datacent(?:re|er)|server|host|outage|incident|triage|bridge|ticket|queue|console|dashboard|desk|agent|jarvis|netops|sentinel|monitor|baseline|drift|compliance|change|maintenance|window|log|error|down|slow|flap)\b/i;

// A device or a config object — what a change would actually be made TO.
const CHANGE_OBJECT = /\b(sw\d+|router|switch|device|node|firewall|interface|loopback|lo\d+|gigabit|gig\d|port|vlan|trunk|route|ntp|snmp|acl|bgp|ospf|eigrp|description|ip[\s-]?add(?:ress)?|config(?:uration)?|ios|image|firmware|software|version|line[\s-]?card|module|password|user|banner|hostname)\b/i;

// Verbs that ASK US TO ACT, per ability. Nothing here is judged on its own — a
// verb only counts when it is the request's own verb (see isImperativeRequest).
// NOTE (Class 1 — no over-refusing): a few verbs are DELIBERATELY not here.
// "copy" is dropped from change — "copy the running config off sw1" is a read
// (show running-config), and the write form ("copy flash:a flash:b") is caught
// by the write-refusal guardrail (sources/guardrails.js), not by this gate.
// "update" is dropped from tickets/teams — "update me on the ticket status" is a
// QUESTION, not "update the ticket"; the ambiguous verb was refusing reads. Only
// unambiguous imperatives to PERFORM an unbuilt ability belong here.
const ACT_VERBS = {
  change: /(?:re)?configure|provision|deploy|push|apply|commit|rollback|roll[\s-]?back|upgrade|downgrade|patch|reload|reboot|restart|bounce|erase|wipe|shut(?:down)?|no[\s-]?shut|add|set|remove|delete|change|modify|unconfigure|enable|disable|install|write[\s-]?mem/,
  drift: /check|compare|audit|validate|verify|diff|re[\s-]?baseline|baseline/,
  tickets: /raise|open|create|log|file|close|assign|escalate[\s-]?to/,
  teams: /post|send|share|notify|message|ping|escalate/,
  // CW-6: "push/sync/open a ServiceNow incident". Only an imperative aimed at a
  // ServiceNow object counts (see ACT_OBJECTS.servicenow) — a question about a
  // ticket is never caught here.
  servicenow: /push|sync|open|create|raise|log|file|mirror|escalate/,
};

// The object each unbuilt ability must be aimed AT before it can claim an ask.
const ACT_OBJECTS = {
  change: CHANGE_OBJECT,
  drift: /\b(baseline|drift|deviation|compliance|golden[\s-]?config|clean\b)\b/i,
  tickets: /\b(ticket|tickets|case|servicenow|snow|jira|change[\s-]?request|incident[\s-]?record)\b/i,
  teams: /\b(teams|ms[\s-]?teams|microsoft[\s-]?teams|slack|channel|webhook)\b/i,
  // A ServiceNow object specifically — NOT the bare word "ticket" (that is the
  // internal queue, which is always available). Only "servicenow"/"snow" names
  // the mirror, so "open a ticket" stays an internal-queue ask.
  servicenow: /\b(servicenow|service[\s-]?now|snow)\b/i,
};

// Read-only commands: the verbs the guardrail already allows through to a device.
const READ_ONLY_COMMAND = [
  /\b(?:run|execute|issue|send|give me|get me)\b[\s\S]{0,40}\b(show|ping|traceroute|trace ?route|dir|more)\b/i,
  /\bshow\s+(?:me\s+)?(?:the\s+)?[a-z]/i,
  /\b(ping|traceroute)\b\s+\S+/i,
  /\b(dir|more)\s+(?:flash|bootflash|disk|nvram)/i,
];

// A question about what IS or what HAPPENED — never a request to do something.
// "why did sw1 reload last night?", "did anyone change the bgp config?",
// "what's going on?", "is sw2 healthy?" all land here.
const QUESTION_LEAD = /^\s*(?:hey\s+jarvis[,\s]+|jarvis[,\s]+|@\w+[,\s]+)?(?:so\s+|and\s+|but\s+)?(?:why|what|whats|what's|when|who|whom|whose|which|where|how|did|do|does|is|are|was|were|has|have|had|can you tell|could you tell|any|anything|anyone|tell me|show me|explain|walk me)\b/i;

// ── Lead-ins that sit in front of a real imperative ─────────────────────────
// FIXED AT CLASS LEVEL (QA, logged): the old pattern allowed at most ONE fixed
// softener, so "just quickly upgrade sw1" was not recognised as the imperative
// it plainly is — the adverb pair in front of the verb hid it — while "please
// upgrade sw1" was. Operators got a different answer for the same request
// depending on how politely they phrased it. Adding "just quickly" as a phrase
// would only move the seam; the real rule is that ANY RUN of softeners, address
// terms and request wrappers can precede the verb, in any order and any number.
// So the lead-in is now a repeating group, and a new politeness phrase is one
// word added to a list rather than a new branch.
//
// Note what is NOT here: no verb, and no subject noun. Only words that modify
// HOW or WHEN something is asked for, never WHAT is asked for — so stripping
// them can never change which ability a request names.
const LEAD_WORD =
  '(?:please|pls|plz|kindly|just|simply|quickly|quick|real\\s+quick|fast|swiftly|briefly|' +
  'now|right\\s+now|then|next|first|firstly|also|again|soon|urgently|asap|immediately|' +
  'straightaway|promptly|maybe|perhaps|possibly|actually|really|honestly|basically|' +
  'hey|hi|hello|yo|ok|okay|so|and|but|well|sorry|for\\s+me|for\\s+us|if\\s+you\\s+can|' +
  'when\\s+you\\s+can|when\\s+you\\s+get\\s+a\\s+chance)';

// The wrapper forms that turn a bare verb into a polite request.
const LEAD_WRAPPER =
  '(?:(?:can|could|would|will|shall|should)\\s+(?:you|we|u)\\s+|' +
  '(?:i|we)\\s+(?:need|want|would\\s+like|\'?d\\s+like)\\s+(?:you\\s+)?to\\s+|' +
  '(?:need|want)\\s+(?:you\\s+)?to\\s+|go\\s+ahead\\s+and\\s+|' +
  'let\'?s\\s+|let\\s+us\\s+|do\\s+me\\s+a\\s+favou?r\\s+and\\s+)';

const ADDRESS = '(?:hey\\s+jarvis|hi\\s+jarvis|jarvis|@\\w+)[,\\s]+';

const IMPERATIVE_LEAD = new RegExp(
  `^\\s*(?:${ADDRESS})?(?:(?:${LEAD_WORD}|${LEAD_WRAPPER})[,\\s]*)*`, 'i');

function normalize(text) {
  return String(text || '').trim().replace(/\s+/g, ' ');
}

// Is THIS ask an imperative request to perform `verbs`? The verb has to be the
// request's own verb — at the start of the sentence, or straight after a lead-in
// like "please" / "can you" / "I need you to". A verb that merely appears in a
// question about the past ("why did sw1 reload") is not a request to act.
function isImperativeRequest(text, verbs) {
  const t = normalize(text);
  const lead = IMPERATIVE_LEAD.exec(t);
  const rest = lead ? t.slice(lead[0].length) : t;
  const anchored = new RegExp(`^(?:${verbs.source})\\b`, 'i');
  if (anchored.test(rest)) return true;
  // "…, please reload it" / "can you upgrade sw1" mid-sentence. Same class fix:
  // any run of softeners may sit between the polite marker and the real verb
  // ("…, could you just quickly reload it"), not one fixed "please".
  const polite = new RegExp(
    `\\b(?:please|kindly|can\\s+you|could\\s+you|would\\s+you|will\\s+you|` +
    `i\\s+need\\s+you\\s+to|i\\s+want\\s+you\\s+to|go\\s+ahead\\s+and)\\s+` +
    `(?:${LEAD_WORD}[,\\s]+)*(?:${verbs.source})\\b`, 'i');
  return polite.test(t);
}

function isReadOnlyCommand(text) {
  const t = normalize(text);
  return READ_ONLY_COMMAND.some((re) => re.test(t));
}

function isQuestionAboutState(text) {
  return QUESTION_LEAD.test(normalize(text)) || /\?\s*$/.test(normalize(text));
}

// A greeting ("hi", "hey jarvis", "morning", "thanks") or a bare META ask about
// Jarvis itself ("help", "what can you do", "who are you", "commands",
// "capabilities") is NOT an out-of-scope request — it is the operator TALKING to
// Jarvis, and it must reach the planner to get a warm capability answer, never the
// flat "I can't do that yet" refusal. This ONLY recognises the shape so the gate
// lets it through; it composes no answer (the planner does that, intent-first).
// Both patterns are anchored to the end of the message, so a greeting word that
// merely opens a real request ("morning, why is sw1 down?") does NOT match here —
// that stays a normal ask.
const GREETING = /^(?:hey|hi|hiya|heya|hello|hell?oo+|yo|howdy|greetings|sup|good\s*(?:morning|afternoon|evening|day)|mornin[g']?|afternoon|evening|thanks|thank\s+you|thx|ty|cheers)\b[\s,!.]*(?:jarvis|there|team|all|everyone|folks|mate|buddy)?[\s,!.]*$/i;
const META_ASK = /^(?:(?:hey|hi|hello)\s+jarvis[,\s]+)?(?:help|commands?|capabilit(?:y|ies)|menu|options|what\s+can\s+you\s+(?:do|help\s+with)|what\s+do\s+you\s+do|what\s+are\s+you(?:\s+able\s+to\s+do|\s+capable\s+of)?|who\s+are\s+you|what\s+can\s+i\s+ask(?:\s+you)?)\b\s*[?.!]*\s*$/i;
function isGreetingOrMeta(text) {
  const t = normalize(text);
  return !!t && (GREETING.test(t) || META_ASK.test(t));
}

// Some abilities are gated on a live env fact, not a static flag — Teams is
// available exactly when TEAMS_WEBHOOK is set (resolved fresh so a late-set
// webhook flips the map without a restart). Deciding this here, in the one place
// that builds the browser shape, keeps the honesty rule in a single seam. The
// webhook VALUE never enters the shape — only the boolean it implies.
function resolveAvailable(a) {
  if (a.dynamic === 'teams') {
    const raw = process.env.TEAMS_WEBHOOK;
    return !!(raw && String(raw).trim());
  }
  if (a.dynamic === 'servicenow') {
    // Available exactly when all three creds are present. The VALUES never leave
    // env — only the boolean they imply reaches the browser shape.
    const set = (v) => !!(v && String(v).trim());
    return set(process.env.SNOW_INSTANCE) && set(process.env.SNOW_USER) && set(process.env.SNOW_PASS);
  }
  if (a.dynamic === 'mcp') {
    // Available exactly when ≥1 MCP server is connected with tools. Lazy require
    // so capabilities.js has no load-order dependency on the connector, and the
    // connector never has to require capabilities back (no cycle).
    try { return require('./mcp-connector').anyToolsConnected(); }
    catch (e) { return false; }
  }
  if (a.dynamic === 'batfish') {
    try { return require('./batfish').connected(); } catch (e) { return false; }
  }
  if (a.dynamic === 'web-research') {
    // True only once a real call has come back with the web tools accepted;
    // false the moment the account rejects them. Never a guess.
    try { return require('./claude').webResearch().available; } catch (e) { return false; }
  }
  if (a.dynamic === 'nautobot') {
    try { return require('./nautobot').connected(); } catch (e) { return false; }
  }
  return !!a.available;
}

// The browser-facing shape. Routing internals never leave this module.
function publicShape(a) {
  const available = resolveAvailable(a);
  const out = { key: a.key, label: a.label, plain: a.plain, example: a.example, available };
  if (!available) out.reason = a.reason;
  // Half-built is a real state and the map must be able to say it: the change
  // engine exists and runs, but there is no write path to reach a device with.
  // Hiding that would make the desk unable to show a wrap it can genuinely run.
  if (a.engineBuilt) out.engineBuilt = true;
  return out;
}

function list() { return ABILITIES.map(publicShape); }
function availableAbilities() { return ABILITIES.filter(resolveAvailable).map(publicShape); }
function get(key) {
  const a = ABILITIES.find((x) => x.key === key);
  return a ? publicShape(a) : null;
}
function byKey(key) { return ABILITIES.find((x) => x.key === key) || null; }

// Which UNBUILT ability is this ask asking us to perform? Requires BOTH an
// imperative request AND the ability's own object in the sentence, so
// "restart the triage" is not read as a device change, and "why did sw1 reload"
// is not read as anything but a question.
function requestedUnbuiltAbility(text) {
  const t = normalize(text);
  for (const key of ['change', 'drift', 'tickets', 'teams', 'servicenow']) {
    const a = byKey(key);
    if (!a || resolveAvailable(a)) continue;
    if (!ACT_OBJECTS[key].test(t)) continue;
    if (!isImperativeRequest(t, ACT_VERBS[key])) continue;
    // "check sw1 against its baseline" is drift; "check sw1" alone is not.
    return a;
  }
  return null;
}

// Which ability does this ask belong to? Kept for callers that want the label;
// returns the ability (available or not), or null when nothing covers it.
function matchAsk(text) {
  const t = normalize(text);
  if (!t) return null;
  if (isReadOnlyCommand(t)) return byKey('run-command');
  const unbuilt = requestedUnbuiltAbility(t);
  if (unbuilt) return unbuilt;
  if (/\b(triage|investigate|troubleshoot|diagnose|root[\s-]?cause|rca|outage|impact|escalate)\b/i.test(t)) return byKey('investigate');
  if (/\b(bridge|commander|scribe|joiner|hand[\s-]?over|handoff|sla|mtta|mttr|war room)\b/i.test(t)) return byKey('bridge');
  if (NOC_VOCAB.test(t) || isQuestionAboutState(t)) return byKey('ask');
  return null;
}

// The honest refusal, built FROM the map — never hardcoded anywhere else.
function refusalFor(ability) {
  const can = availableAbilities();
  const lines = [];
  if (ability && !ability.available) {
    lines.push(`🚫 I can't do that yet — ${ability.label.toLowerCase()} is not wired up.`);
    lines.push(`Why: ${ability.reason}`);
  } else {
    lines.push(`🚫 I can't do that yet — that is outside what I am wired to do.`);
    lines.push(`I would rather say so than guess at an answer.`);
  }
  lines.push('');
  lines.push(`**Here's what I can do right now:**`);
  can.forEach((a) => lines.push(`• **${a.label}** — ${a.plain}`));
  const soon = ABILITIES.filter((a) => !a.available);
  if (soon.length) {
    lines.push('');
    lines.push(`**Not yet:**`);
    soon.forEach((a) => lines.push(`• ${a.label} — ${a.reason}`));
  }
  return lines.join('\n');
}

// A CHANGE-intent ask does not get the flat "I can't do that yet" refusal — the
// change ENGINE is built, and the desk answers a change ask with a proposal card
// the operator confirms. Two responses to one ask (a card that says "run this"
// next to Jarvis saying "I can't") is a mixed message; the review flagged it.
//
// So for a change ask the map speaks the SAME language as the card: this is a
// change, it does not fire from chat, here it is as a proposal to confirm, and
// it will go through the full wrap (and freeze honestly if there is no write
// path). The refusal is NOT suppressed into silence — that would leave a desk
// without the card mute — it is REPLACED by the one coherent proposal message.
// `changeProposal:true` lets the server log it as an offered proposal, not a
// refusal, and lets a caller that already draws a card skip the text if it wants.
function changeProposalText() {
  const change = byKey('change');
  const lines = [];
  lines.push(`📝 That is a change — and changes never fire straight from chat.`);
  lines.push(`I have set it up as a **proposal**: check the device, the exact commands and the reason, then confirm it to run.`);
  lines.push('');
  lines.push(`Every confirmed change goes through the full safety wrap — permission gate, before/after capture, diff, validation and a rollback plan.`);
  if (change && change.engineBuilt && !change.available) {
    lines.push('');
    lines.push(`Honest heads-up: ${change.reason}`);
  }
  return lines.join('\n');
}

// THE routing seam: "should this ask be refused, and what do I say?"
//   { allowed:true,  ability }               → carry on to real reasoning.
//   { allowed:false, ability|null, text }    → say text, touch no device.
//   { allowed:false, changeProposal:true }   → a change ask: ONE proposal message
//                                              (not a refusal), the card is the answer.
// Only two things are ever refused: an unambiguous request to perform an
// ability that is not built, and an ask with nothing to do with this NOC.
// Everything else passes through — when in doubt, real reasoning answers it.
function checkAsk(text) {
  const t = normalize(text);
  if (!t) return { allowed: true, ability: null };

  // 1. A read-only command is always allowed — it is the one thing we can
  //    definitely do, and it must never be mistaken for a change.
  if (isReadOnlyCommand(t)) return { allowed: true, ability: get('run-command') };

  // 2. A question about what is or what happened is always allowed.
  const question = isQuestionAboutState(t);

  // 3. An unambiguous request to perform an unbuilt ability → honest refusal.
  //    A question wins over a verb ("why did sw1 reload") unless the question
  //    form is wrapped around a real request ("can you reload sw1?").
  const unbuilt = requestedUnbuiltAbility(t);
  if (unbuilt) {
    // A change ask is answered by the proposal flow, not a contradicting refusal.
    if (unbuilt.key === 'change') {
      return { allowed: false, changeProposal: true, ability: publicShape(unbuilt), text: changeProposalText() };
    }
    return { allowed: false, ability: publicShape(unbuilt), text: refusalFor(unbuilt) };
  }

  // 3b. A greeting or a bare meta/help ask about Jarvis itself is answered warmly
  //     by the planner with a capability list — never the flat "I can't do that
  //     yet". Placed AFTER the unbuilt-ability check so a genuine unbuilt ask
  //     ("post this to teams") still gets its honest refusal, and BEFORE the
  //     out-of-scope net below so "hi" / "help" are not bounced as off-topic.
  if (isGreetingOrMeta(t)) return { allowed: true, ability: get('ask') };

  if (question) return { allowed: true, ability: matchAsk(t) };

  // 4. Nothing about this NOC at all → honest out-of-scope refusal. But only when
  //    NOTHING covers it: an ask that names no raw NOC vocab yet clearly maps to a
  //    real ability ("give me a handover summary" → the bridge) must pass through,
  //    not be bounced as off-topic. When in doubt, real reasoning answers it.
  if (!NOC_VOCAB.test(t) && !matchAsk(t)) return { allowed: false, ability: null, text: refusalFor(null) };

  // 5. In doubt → pass through to real reasoning.
  return { allowed: true, ability: matchAsk(t) };
}

module.exports = {
  list, available: availableAbilities, get, matchAsk, refusalFor, checkAsk,
  // exposed for tests//review of the intent split
  _internals: { isReadOnlyCommand, isQuestionAboutState, isImperativeRequest, requestedUnbuiltAbility, isGreetingOrMeta },
};
