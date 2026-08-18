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
    key: 'drift',
    label: 'Check a device against its baseline',
    plain: 'Compare a device\'s live config against its saved baseline and report every deviation — including which recorded change explains it.',
    example: 'check sw2 against its baseline',
    available: true,
  },
  {
    key: 'tickets',
    label: 'Raise and track tickets',
    plain: 'Create, assign and close tickets from the conversation, with one queue as the single source of truth.',
    example: 'raise a ticket for this incident',
    available: false,
    reason: 'The ticket queue arrives in CW-3 — for now I record actions in the audit log, not as tickets.',
  },
  {
    key: 'teams',
    label: 'Post updates to Teams',
    plain: 'Post bridge updates into a Microsoft Teams channel and surface the replies back here.',
    example: 'post this bridge update to the Teams channel',
    available: false,
    reason: 'Teams is not connected — it needs a webhook, and the wiring arrives in CW-4.',
  },
  {
    key: 'investigate',
    label: 'Investigate a problem end to end',
    plain: 'Give me a symptom and I run a full triage — real reads across every front, blind spots, and a ranked hypothesis with confidence.',
    example: 'investigate why the branch sites are dropping packets',
    available: true,
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
const NOC_VOCAB = /\b(bgp|ospf|isis|eigrp|mpls|vlan|stp|spanning[\s-]?tree|route|routing|prefix|peer|neighbou?r|interface|port|uplink|switch|router|firewall|fortigate|f5|load[\s-]?bal|vip|pool|vpn|tunnel|ipsec|wan|lan|sd-?wan|aci|fabric|apic|vmanage|catalyst|dnac|sw\d+|leaf|spine|edge|core|access[\s-]?point|wireless|wifi|subnet|ip\b|dns|dhcp|ntp|snmp|syslog|latency|jitter|throughput|bandwidth|packet|cpu|memory|disk|uptime|reload|version|config|inventory|topology|fault|alarm|alert|health|estate|network|device|node|link|circuit|site|branch|campus|datacent(?:re|er)|server|host|outage|incident|triage|bridge|ticket|queue|console|dashboard|desk|agent|jarvis|netops|sentinel|monitor|baseline|drift|compliance|change|maintenance|window|log|error|down|slow|flap)\b/i;

// A device or a config object — what a change would actually be made TO.
const CHANGE_OBJECT = /\b(sw\d+|router|switch|device|node|firewall|interface|loopback|lo\d+|gigabit|gig\d|port|vlan|trunk|route|ntp|snmp|acl|bgp|ospf|eigrp|description|ip[\s-]?add(?:ress)?|config(?:uration)?|ios|image|firmware|software|version|line[\s-]?card|module|password|user|banner|hostname)\b/i;

// Verbs that ASK US TO ACT, per ability. Nothing here is judged on its own — a
// verb only counts when it is the request's own verb (see isImperativeRequest).
const ACT_VERBS = {
  change: /(?:re)?configure|provision|deploy|push|apply|commit|rollback|roll[\s-]?back|upgrade|downgrade|patch|reload|reboot|restart|bounce|erase|wipe|shut(?:down)?|no[\s-]?shut|add|set|remove|delete|change|update|modify|unconfigure|enable|disable|install|write[\s-]?mem|copy/,
  drift: /check|compare|audit|validate|verify|diff|re[\s-]?baseline|baseline/,
  tickets: /raise|open|create|log|file|close|assign|escalate[\s-]?to|update/,
  teams: /post|send|share|notify|message|ping|update|escalate/,
};

// The object each unbuilt ability must be aimed AT before it can claim an ask.
const ACT_OBJECTS = {
  change: CHANGE_OBJECT,
  drift: /\b(baseline|drift|deviation|compliance|golden[\s-]?config|clean\b)\b/i,
  tickets: /\b(ticket|tickets|case|servicenow|snow|jira|change[\s-]?request|incident[\s-]?record)\b/i,
  teams: /\b(teams|ms[\s-]?teams|microsoft[\s-]?teams|slack|channel|webhook)\b/i,
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

// Lead-ins that sit in front of a real imperative ("please …", "can you …").
const IMPERATIVE_LEAD = /^\s*(?:hey\s+jarvis[,\s]+|jarvis[,\s]+|@\w+[,\s]+)?(?:(?:please|pls|kindly)\s+)?(?:(?:can|could|would|will)\s+(?:you|we)\s+(?:please\s+)?|(?:i|we)\s+(?:need|want|would like)\s+(?:you\s+)?to\s+|go\s+ahead\s+and\s+|now\s+|then\s+|let'?s\s+)?/i;

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
  // "…, please reload it" / "can you upgrade sw1" mid-sentence.
  const polite = new RegExp(`\\b(?:please|kindly|can you|could you|would you|i need you to|i want you to|go ahead and)\\s+(?:please\\s+)?(?:${verbs.source})\\b`, 'i');
  return polite.test(t);
}

function isReadOnlyCommand(text) {
  const t = normalize(text);
  return READ_ONLY_COMMAND.some((re) => re.test(t));
}

function isQuestionAboutState(text) {
  return QUESTION_LEAD.test(normalize(text)) || /\?\s*$/.test(normalize(text));
}

// The browser-facing shape. Routing internals never leave this module.
function publicShape(a) {
  const out = { key: a.key, label: a.label, plain: a.plain, example: a.example, available: !!a.available };
  if (!a.available) out.reason = a.reason;
  // Half-built is a real state and the map must be able to say it: the change
  // engine exists and runs, but there is no write path to reach a device with.
  // Hiding that would make the desk unable to show a wrap it can genuinely run.
  if (a.engineBuilt) out.engineBuilt = true;
  return out;
}

function list() { return ABILITIES.map(publicShape); }
function availableAbilities() { return ABILITIES.filter((a) => a.available).map(publicShape); }
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
  for (const key of ['change', 'drift', 'tickets', 'teams']) {
    const a = byKey(key);
    if (!a || a.available) continue;
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

  if (question) return { allowed: true, ability: matchAsk(t) };

  // 4. Nothing about this NOC at all → honest out-of-scope refusal.
  if (!NOC_VOCAB.test(t)) return { allowed: false, ability: null, text: refusalFor(null) };

  // 5. In doubt → pass through to real reasoning.
  return { allowed: true, ability: matchAsk(t) };
}

module.exports = {
  list, available: availableAbilities, get, matchAsk, refusalFor, checkAsk,
  // exposed for tests//review of the intent split
  _internals: { isReadOnlyCommand, isQuestionAboutState, isImperativeRequest, requestedUnbuiltAbility },
};
