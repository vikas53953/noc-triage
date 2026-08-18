# TRACKER — noc-triage live dashboard

**Single source of truth for anyone (any agent, any session) picking this up.** Read this + HANDOFF.md
first. Vikas is AWAY; work is FULLY AUTONOMOUS — no waiting for his approval. Fix the CLASS not the case.
Every reviewable thing he sees = a visual HTML page. Never fabricate. Keep this file updated every turn.

Last updated: 2026-08-17 ~22:40 IST · driver: Fable session 7d4aaef3

## Mode & standing orders (Vikas, 2026-08-17)
- FULLY AUTONOMOUS. Do not wait for approval/permission. Run QA from every angle, write a spec report,
  turn it into a spec file, implement every feedback item, verify live, keep going.
- On session/quota limit: a self-resume schedule is armed (ScheduleWakeup, ~hourly). On reset, RESUME
  automatically from this TRACKER — do not sit idle, do not wait for Vikas.
- Whenever Vikas says/gives anything → immediately add it to "Vikas's asks" below as a to-do, in HIS words.
- Two product laws (in HANDOFF.md): (1) No static bindings — intent-first agentic routing; deterministic
  code = safety only. (2) Ambiguity → ask, never assume; reviewers run an operator-experience pass.

## Quota / heartbeat
- Session limit resets ~19:00–19:50 IST (observed 2026-08-17). Self-resume wakeup armed.
- If you are a fresh resume: check `git log`, `gh pr list`, this TRACKER, then continue the top pending item.

## Vikas's asks (his words → status)
| # | Ask (his words) | Status |
|---|---|---|
| 1 | Take over the Opus session, continue the work | DONE — took over, handoff secured |
| 2 | Build the roadmap features he picked | IN PROGRESS (waves) |
| 3 | Jarvis NOC Copilot — anyone asks anything, Jarvis acts (commands/changes/tickets/bridge/etc.) | IN PROGRESS — Gates 1-3 approved, CW-1 live, CW-2 building |
| 4 | Keep pushing GitHub + docs inside repo updated | ONGOING — every merge/decision pushed |
| 5 | Polish repo + every info | DONE (PR #41 merged) |
| 6 | Fix: "show version on sw" guessed sw1 — must ASK which switch | DONE — PR #46 merged + LIVE-VERIFIED: "show version on sw" now lists sw1-sw4 and asks, runs nothing |
| 7 | Spawn QA agents, test from EVERY angle, don't wait for me | IN PROGRESS — 3/5 QA reports in (wireup, intent, adversarial). Root cause = deterministic keyword layer over the real LLM planner. Adversarial: all SAFETY laws held; gate fails-open on bad mode value + 2 stack-trace leaks. 2 running. |
| 8 | Full autonomous; self-resume on quota reset; live to-do tracker | DONE — this file + wakeup armed |

## Build waves (copilot) — see docs/copilot-design.md
- CW-1 desk + identity + capability honesty — MERGED + live 2026-08-17
- CW-2 change engine + drift — BOTH HALVES BUILT (backend #45, UI #44), integrated review running. Finding: sandbox is observer-role, no write path — engine real, apply honestly frozen no-write-path.
- CW-3 ticket queue · CW-4 Teams (needs webhook) · CW-5 SSH wiring · CW-6 ServiceNow (needs creds) — queued

## Open PRs / branches
- #44 CW-2 UI (open, waits for CW-2 backend to integrate-review together)
- fix/ambiguous-device-asks (building — Vikas ask #6)
- CW-2 backend (building)

## Merged today (all adversarially reviewed + live-verified)
#38 CLI routing · #39+#37 Wave 4 correlation · #40 SSH engine · #41 repo polish · #42+#43 CW-1

## Needs Vikas (non-blocking, honest-if-absent until supplied)
- DevNet sandbox reservation creds (real SSH show output) · Teams webhook (CW-4) · ServiceNow creds (CW-6)

## In flight right now (agents)
- 5 QA persona agents on live :3000 (intent / stranger / adversarial / operator / wireup) → findings → spec
- fix/ambiguous-device-asks builder · CW-2 backend builder · CW-2 UI done (#44)

## QA RESULT (5 testers, ~120 live interactions, 2026-08-17)
- Zero fabrications. Every safety law HELD under attack. Root cause = deterministic keyword/phrase shell
  around a genuinely-good LLM planner that answers/refuses/guesses before intent.
- Spec: docs/qa-findings-spec.md (10 fix classes). Visual verdict for Vikas:
  https://claude.ai/code/artifact/2a90e159-c90e-47bf-9712-d7dd8658b497
- Fix classes → tasks #6 (kill shell, blocked by ambiguity+CW-2), #7 (wire chat to own incidents+session
  isolation), #8 (intake+guardrail homonyms), #9 (error/gate+dropped turns), #10 (correctness+docs).

## Next actions (autonomous queue)
1. [DONE] Compile QA spec + visual verdict page
2. Review + merge ambiguity fix (Class 2) — operator-experience pass — IN FLIGHT
3. Integrate-review CW-2 (#45+#44), merge, verify live — IN FLIGHT
4. Fold in stranger-UI sweep when it lands (Class 8)
5. THEN Class 1 (kill shell) on clean master, then #7/#8/#9/#10 — each own PR, reviewed, live-verified
6. Keep TRACKER + HANDOFF + GitHub current every turn

## 2026-08-18 update
- OVERNIGHT LAUNCHER ARMED: Windows task "noc-triage-autoresume" fires every 30m, runs
  autonomous-resume.ps1 → fresh claude session resumes from TRACKER (survives quota wall; skips if a
  session is already alive). Earlier failure: same-session ScheduleWakeup can't beat a session-wide limit.
- CW-2 both halves fixed after review (BE 14869f7 guardrail object-less write hole + mixed-message;
  UI fd3dbb7 history gated on engineBuilt + plural /changes route). FINAL integrated re-review running.
- Ambiguity fix PR #46 review resumed (was near done: memory works, checking isolation + named-device-through-planner).

## QA fix-classes in flight (2026-08-18)
- #6 Class 1 — BUILT (PR #47), adversarial+operator-experience review running. Phrase-table front door removed, capability gate narrowed to safety-only, NO_STORE/ACI_WORDS gone, structured device field added.
- #8 Class 3+4 (plain-words intake + guardrail homonyms/inflections) — BUILDING (fix/intake-and-guardrail) — disjoint files
- #10 Class 10 (leadership doc from verdict, /doc 404, ServiceNow CI scope) — BUILDING (fix/doc-accuracy) — disjoint files
- #7 Class 9 (chat sees own incidents + session isolation) — QUEUED behind #6 (shares jarvis.js/server.js)
- #9 Class 5+6 (error/gate hardening + silent dropped turns) — QUEUED behind #6 (shares server.js)
- Stranger-UI sweep — re-running (browser)
- Merge order to avoid conflicts: land #6 first, then #8/#10, then #7/#9.

## Follow-up hooks logged (apply after Class 1 merges — it owns server.js)
- Class 10: add 'leadership' to server.js:2483 doc allow-list + names map (leadership: 'Leadership summary')
  so the /doc/leadership URL alias works (slt already works). artifacts.js already leadership-aware.
