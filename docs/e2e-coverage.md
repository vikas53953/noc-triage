# End-to-end live test coverage (2026-08-19) — every feature, by fresh agents on Sonnet

Goal: prove EVERY feature works live (or honestly says "not connected"), tested from a real operator's AND
a clueless-newcomer's perspective. Mark each PASS / FAIL / PARTIAL with real evidence. Never assume.

## The full feature list to cover
QA-era behaviour:
1. Intent-first routing (no keyword shell) — greetings, odd phrasings, homonyms
2. Ambiguity → ask (unnamed/prefix device "sw", "the core switch")
3. Named-device targeting (show version on sw2 → sw2), device-from-intent
4. Plain-words triage intake (no jargon) + honest garbage refusal
5. Guardrail: writes refused (chained/disguised/inflected), reads run; deny=zero-wire
6. Permission gate fail-closed (deny/garbage mode), real deny lockdown
7. Clean errors (bad input → 400, no stack leak); no silent dropped reads
8. Chat sees the app's own incidents + per-operator session isolation
9. Generated docs match the verdict (leadership/engineer/ServiceNow export)
10. Correlation (cross-domain), blind spots, hypothesis+confidence

Copilot waves:
11. Copilot Desk (/desk.html) — name gate, 3-pane cockpit, all tabs
12. Change engine (five-step wrap, honest no-write-path freeze, rollback)
13. Drift check vs baseline
14. Tickets (create/assign/status/note/close, queue, proposal card)
15. Teams bridge (honest not-connected; post when webhook set)
16. SSH-live transport routing (sw1-4 Command Runner; SSH honest auth-needed)
17. Two-way ServiceNow (honest not-connected; conflict never clobbered)
18. Investigation loop (grill → probe → narrow → cap/stuck/root-cause → fix proposal)

NetClaw pulls:
19. MCP connector (honest off; gated; read-only)
20. Catalyst Center reads (11 new: health/interfaces/vlans/sites/topology/…)
21. Live feeds (syslog/snmptrap honest not-receiving; parse when on)
22. Batfish (honest not-connected; advisory in change engine)
23. Nautobot SoT (honest not-connected; no phantom drift)
24. Packet-capture analysis (honest no-capture; parses a real pcap)

## Perspectives required per slice
- REAL OPERATOR: does the sensible NOC thing work end-to-end?
- NEWCOMER/RANDOM: type whatever a confused person types ("hi", "help", "what can you do",
  "is the internet down", "fix everything", emojis, a paragraph, a wrong device, a rude message) —
  does it stay honest, useful, and never fabricate/crash?

## Result table (each agent fills its slice; PASS/FAIL/PARTIAL + real evidence + repro)
(to be completed by the test agents)
