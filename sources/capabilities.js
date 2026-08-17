// capabilities.js — THE single source of truth for what Jarvis can actually do.
//
// Plain words: this file is the honest list of Jarvis's abilities. Two jobs read
// from it and nothing else:
//   1. GET /api/capabilities — what the desk shows the operator ("here is what I
//      can do"), including the abilities that are NOT built yet and WHY.
//   2. Honest refusals — when an ask matches nothing on this list, or matches an
//      ability that is not built/connected yet, Jarvis says so in plain words and
//      shows what it CAN do, instead of guessing or dead-ending.
//
// LAW: an ability with available:false MUST carry a plain-words `reason`. Never a
// wrong answer, never a silent dead-end, never a hardcoded refusal string
// somewhere else in the code — every refusal is built FROM this map.
//
// `match` is internal routing only; it is never sent to the browser.

const ABILITIES = [
  {
    key: 'ask',
    label: 'Ask about the network',
    plain: 'Ask me anything about the estate in plain words — health, alarms, devices, why something looks wrong — and I read the real sources to answer.',
    available: true,
    match: [
      /\b(bgp|ospf|isis|eigrp|mpls|vlan|stp|spanning[\s-]?tree|route|routing|prefix|peer|neighbou?r|interface|port|uplink|switch|router|firewall|fortigate|f5|load[\s-]?bal|vip|pool|vpn|tunnel|ipsec|wan|lan|sd-?wan|aci|fabric|apic|vmanage|catalyst|dnac|sw\d|leaf|spine|edge|core|access[\s-]?point|wireless|wifi|subnet|ip\b|dns|dhcp|ntp|snmp|syslog|latency|jitter|throughput|bandwidth|packet|cpu|memory|disk|uptime|reload|version|inventory|topology|fault|alarm|alert|health|estate|network|device|node)\b/i,
      /\b(what'?s|whats|what is|how is|how'?s|why is|why'?s|show me|tell me|give me|status|going on|happening|any (issues|problems|alarms|alerts))\b/i,
    ],
  },
  {
    key: 'run-command',
    label: 'Run a read-only command on a device',
    plain: 'I can run read-only commands (show / ping / traceroute / dir / more) on a device and show you the real output.',
    available: true,
    match: [
      /\b(run|execute|issue|send)\b[\s\S]*\b(show|ping|traceroute|trace ?route|dir|more)\b/i,
      /\bshow\s+(version|run|running[\s-]?config|ip|interface|inventory|log|clock|vlan|cdp|lldp|mac|arp|bgp|ospf|process|env|module|power|tech)/i,
      /\b(ping|traceroute)\b\s+\S+/i,
    ],
  },
  {
    key: 'change',
    label: 'Make a change on a device',
    plain: 'Push a config change with the full safety wrap — before/after capture, diff, validation and a rollback plan.',
    available: false,
    reason: 'The change engine arrives in CW-2 — until then I am read-only and will not touch a device configuration.',
    match: [
      /\b(configure|config(?:ure)? (?:the|a|this)?\s*\w*\b|provision|deploy|apply[\s-]?config|push[\s-]?config|commit[\s-]?change|rollback|roll[\s-]?back|upgrade|downgrade|patch|reload|reboot|restart|erase|wipe|write[\s-]?mem|copy[\s-]?run|shut(?:down)?\b|no[\s-]?shut)\b/i,
      /\b(add|set|enable|disable|remove|delete|change|update|modify|unconfigure|bring[\s-]?(?:up|down))\b[\s\S]*\b(interface|loopback|lo\d+|gigabit|gig\b|vlan|trunk|route|ntp|snmp|acl|bgp|ospf|eigrp|description|ip[\s-]?add(?:ress)?|password|user|config|firmware|ios|image|software)\b/i,
    ],
  },
  {
    key: 'drift',
    label: 'Check a device against its baseline',
    plain: 'Compare a device\'s live config against its saved baseline and report every deviation.',
    available: false,
    reason: 'Drift and deviation reports arrive in CW-2, alongside the change engine.',
    match: [
      /\b(drift|deviation|deviate|out of compliance|non[\s-]?compliant|compliance check|against (?:the )?baseline|vs (?:the )?baseline|re[\s-]?baseline|is \S+ clean\b)\b/i,
    ],
  },
  {
    key: 'tickets',
    label: 'Raise and track tickets',
    plain: 'Create, assign and close tickets from the conversation, with one queue as the single source of truth.',
    available: false,
    reason: 'The ticket queue arrives in CW-3 — for now I record actions in the audit log, not as tickets.',
    match: [
      /\b(ticket|tickets|raise a (?:ticket|case)|open a (?:ticket|case)|servicenow|snow\b|incident record|change request|\bcase\b|assign (?:it|this) to|close the ticket|jira)\b/i,
    ],
  },
  {
    key: 'teams',
    label: 'Post updates to Teams',
    plain: 'Post bridge updates into a Microsoft Teams channel and surface the replies back here.',
    available: false,
    reason: 'Teams is not connected — it needs a webhook, and the wiring arrives in CW-4.',
    match: [
      /\b(teams|ms teams|microsoft teams|slack|chat channel|post (?:it |this )?(?:to|in) the channel|notify the (?:team|channel)|webhook)\b/i,
    ],
  },
  {
    key: 'investigate',
    label: 'Investigate a problem end to end',
    plain: 'Give me a symptom and I run a full triage — real reads across every front, blind spots, and a ranked hypothesis with confidence.',
    available: true,
    match: [
      /\b(triage|investigate|troubleshoot|diagnose|root[\s-]?cause|rca\b|why (?:is|are|did|has)|look into|dig into|find out why|impact|outage|incident|escalate|p1\b|p2\b|p3\b)\b/i,
    ],
  },
  {
    key: 'bridge',
    label: 'Run the incident bridge',
    plain: 'Keep the bridge: roles (commander, scribe, joiners), SLA clocks, the running timeline and the handover write-up.',
    available: true,
    match: [
      /\b(bridge|commander|incident commander|scribe|joiner|hand[\s-]?over|handoff|sla\b|mtta|mttr|time to verdict|roll[\s-]?call|standup|stand[\s-]?up|status update for (?:leadership|management)|war room)\b/i,
    ],
  },
];

// The browser-facing shape. `match` never leaves this module.
function publicShape(a) {
  const out = { key: a.key, label: a.label, plain: a.plain, available: !!a.available };
  if (!a.available) out.reason = a.reason;
  return out;
}

function list() {
  return ABILITIES.map(publicShape);
}

function availableAbilities() {
  return ABILITIES.filter((a) => a.available).map(publicShape);
}

function get(key) {
  const a = ABILITIES.find((x) => x.key === key);
  return a ? publicShape(a) : null;
}

// Which ability does this ask belong to? Specific (and not-yet-built) abilities
// are tested BEFORE the broad ones, so "upgrade sw1 IOS" is recognised as a
// CHANGE (honestly refused with the CW-2 reason) and never smuggled through as a
// general question. Returns the ability (available or not) or null for "nothing
// on my list covers this".
const MATCH_ORDER = ['change', 'drift', 'tickets', 'teams', 'run-command', 'investigate', 'bridge', 'ask'];

function matchAsk(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  for (const key of MATCH_ORDER) {
    const a = ABILITIES.find((x) => x.key === key);
    if (a && a.match.some((re) => re.test(t))) return a;
  }
  return null;
}

// The honest refusal, built FROM the map — never hardcoded anywhere else.
// `ability` is the not-yet-built ability that was matched, or null when nothing
// on the list covers the ask.
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

// One call for the routing seam: "should this ask be refused, and what do I say?"
// { allowed:true, ability } → carry on. { allowed:false, ability|null, text } → say text.
function checkAsk(text) {
  const ability = matchAsk(text);
  if (ability && ability.available) return { allowed: true, ability: publicShape(ability) };
  return {
    allowed: false,
    ability: ability ? publicShape(ability) : null,
    text: refusalFor(ability),
  };
}

module.exports = { list, available: availableAbilities, get, matchAsk, refusalFor, checkAsk };
