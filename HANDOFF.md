# noc-triage — HANDOFF (any tool — Claude Code, Cursor, anything — resumes from this + TRACKER.md)

Live, honest NOC/SOC triage console for Vikas. Private repo **vikas53953/noc-triage**.
Run: `cd C:\Users\vikasmit\noc-triage && npm install && PORT=3000 node server.js` → open
**http://localhost:3000/desk.html** (the real console; the root page is the older classic view).
Tests: `npm test` (33 suites, ~1800 assertions, must stay green — chain exits non-zero on any failure).
`.env.local` (gitignored) holds Cisco DevNet sandbox creds + `ANTHROPIC_API_KEY`.
Jarvis default model `claude-opus-5`; ALL testing uses `JARVIS_MODEL=claude-sonnet-5` (Vikas's spend rule).

## Laws (absolute, never regress — every reviewer checks these)
1. **No static bindings — intent first** (Vikas 2026-08-17): the LLM understands intent and routes;
   deterministic code is for SAFETY ONLY (refusals, gates, scrubbing). Keyword→answer shortcuts are defects.
2. **Ambiguity → ask, never assume**: underspecified ask → Jarvis runs NOTHING and asks (the conduct layer
   enforces this on EVERY entry path — chat and triage share ONE gate in sources/conduct.js).
3. **Never fabricate**: real data or an honest "not connected / unread / unreachable / nothing new".
   Narration is composed FROM evidence (per-round diffs), never from intent. Verdicts trace every claim to
   evidence ids from THIS incident; unsupported = "suspected — unverified".
4. **Permission gate**: deny = ZERO wire calls; writes blocked BEFORE the gate; write asks in any phrasing
   get an honest out-loud refusal (never silence, never execution). Read-only guardrail (show/ping/traceroute/dir/more).
5. **Secrets never persist**: session-log scrubber covers 40+ IOS/SNMP/WPA/TACACS forms (table-driven tests
   in sources/scrubber.cw9.test.js — new forms are one-line additions). XSS-escape every DOM sink.
6. **Short messages**: Jarvis chat text hard-capped (conduct.TEXT_MAX=280) in code, including the
   streamed preview. Raw evidence lives in collapsible cards + the terminal pane, never text walls.
7. **Adopt, don't hand-write, integrations** (2026-08-20): new integrations = security-vetted MCP servers
   through the CW-8 connector; prefer Anthropic server-side features (web search/fetch, compaction).
8. Timezones: bare clock times anchored in operatorTz, most-recent-past. Vikas reviews everything as a
   visual HTML page (feedback layer at ~/.claude/review-kit/feedback-layer.js) — never walls of text.

## How work is done (the wave process — follow it exactly)
One feature = one **CW wave** (CW = "Copilot Wave", OUR numbering, not PR numbers). Pin a contract in
docs/copilot-cwN-*-contract.md → backend + frontend built in PARALLEL in OWN CLONES (`git clone … ~/noc-x`;
worktrees are flaky on this machine) against the pinned envelope → PR each → a DIFFERENT agent adversarially
reviews (fresh attacks, live on a spare port, operator-experience pass: "would a senior NOC engineer accept
this?") → fix at CLASS level, re-review until "VERDICT: APPROVE" → merge BE first → restart :3000 → live
verify on the merged build → visual evidence page. NOTE: `gh pr review --approve` self-rejects (same
account) — the approval signal is a PR comment starting "VERDICT: APPROVE".

## What is BUILT + MERGED (all live-verified; state 2026-08-20 end of day)
- **CW-1..CW-8 + waves 1-6 + 7 QA classes + netclaw A1-A8** (see TRACKER history): desk + capability
  honesty, change engine (apply honestly frozen — observer sandbox), tickets, Teams (needs webhook),
  SSH engine (needs creds), ServiceNow (needs creds), CW-7 investigation loop, CW-8 MCP connector
  (no real external server wired yet — needs security vetting), Catalyst Center catalogue, syslog/SNMP
  feeds, Batfish/pcap/Nautobot (honest-if-absent).
- **CW-9 bridge conduct**: ask-first on every path (sources/conduct.js), pinned chat envelope
  (say/ask/roster/finding/verdict/change), V2 split terminal (chat left, SSH-style session pane right,
  shared module public/cw9-bridge.js), honest roster (stand-downs + "systems still get read" overlap
  disclosure, AGENT_SOURCES + drift test), per-delegation evidence tagging (evidenceId — no cross-talk),
  evidence-diffed round narration, honest write refusals at the conduct layer.
- **CW-10 plumbing**: sources/claude.js = official @anthropic-ai/sdk (same wrapper surface: hasKey/model/
  reason). Prompt caching (stable system first + cache_control; verified cache_read hits). Streaming:
  WS type `say_delta` {messageId, delta, done, aborted?, discard?}; final chat_message with same messageId
  is authoritative; discard:true (safety-declined) wipes preview from screen+localStorage. Spend store
  (sources/spend-store.js, GET /api/spend/summary, desk Spend panel — never stores prompt text). Web
  search/fetch on REASONING calls only, answers honestly labeled as web sources (never in finding.cli).
  Compaction plumbed w/ silent fallback.
- **CW-11 Reflexion** (sources/reflexion.js + lessons.js): round reflection (nothing-new line + changed
  approach + deterministic repeat-refusal, mustChange fed to the probe prompt); verdict self-check
  (verified[]/suspected[]/causeSupported from causeEvidenceIds; unsupported cause renders amber
  "Suspected — unverified"); prediction follow-through (parked on every close; POST
  /api/copilot/predictions/:id/check; failed → honest reopen); lessons memory (squad/lessons/*.md via
  scrubber, LLM similarity — no keywords, desk Lessons panel, lesson.lookFirst biases round 1 only,
  never bypasses ask-first). Reflection/lesson/prediction ride chat envelopes additively.

## Key files
server.js (routes, WS broadcast, gate wiring — NAMED_WRITE_SURFACES lists gated non-/api/copilot surfaces)
· sources/conduct.js (THE conduct layer: understanding gate, envelope, caps, write screening) ·
sources/jarvis.js (planner, delegation, synthesis+streaming, reflectionFlag) · sources/investigation.js
(round engine) · sources/reflexion.js · sources/lessons.js · sources/claude.js (SDK wrapper) ·
sources/spend-store.js · sources/live-agents.js (per-agent reads, AGENT_SOURCES) · sources/session-log.js
(scrubber — single ordered pass) · sources/guardrails.js · sources/approvals.js · sources/triage.js ·
public/desk.html + public/cw9-bridge.js/.css (shared UI module; dev fixtures in test/) · public/index.html
(classic view). Contracts: docs/copilot-cw9/10/11/12-*.md. Live state: TRACKER.md (append-only log).

## NEXT (in order, nothing in flight right now)
1. **CW-12 Live Presence** — RECORDED, NOT BUILT. Contract: docs/copilot-cw12-presence-contract.md
   (Vikas's words inside). Typing/working indicators + message receipt states, driven ONLY by real events.
2. **CW-13 candidate** — vet + wire the first real external MCP server through the CW-8 connector
   (Vikas saw the recommendation; not yet approved — ask him).
3. Polish backlog: probe planner sometimes asks bare "ping"/"traceroute" (Config-Keeper honestly refuses —
   wasted rounds); lesson consult chip dark until a first real lesson exists; 2 LOW review leftovers in
   PR #74/#76 comments; short-device-error prose over-scrub LOW.
4. Parked features (need Vikas's pick): FortiGate/F5/threat feeds, RBAC/SSO, PDF/email export, HA front.

## Needs Vikas (each flips a BUILT feature live; all honest-if-absent today)
TEAMS_WEBHOOK · SNOW_INSTANCE/SNOW_USER/SNOW_PASS · DevNet always-on IOS-XE sandbox SSH creds
(SSH_IOSXE_USER/PASS) · real devices pointing syslog/traps here (*_BIND=0.0.0.0) · write-capable sandbox
creds (change-apply + prediction follow-through live proof) · a vetted external MCP server.

## Operational notes
- Auto-resume: Windows scheduled task "noc-triage-autoresume" (every 30 min, autonomous-resume.ps1) —
  survives reboots/quota walls; a fresh session resumes from TRACKER without Vikas. If moving to Cursor,
  this task only launches Claude Code sessions — disable it (`schtasks /change /tn noc-triage-autoresume
  /disable`) if it would conflict, or leave it as a safety net.
- The :3000 node process gets reaped between sessions — relaunch when down. Kill strays first (multiple
  server.js processes have accumulated before): match node.exe with CommandLine like 'server.js'.
- DevNet sandboxes reset themselves — tenants/faults vanish; honest "not found" from Jarvis is CORRECT.
- git: master protected against force-push/deletion; merge-commit style; every merge pushed immediately.
