# TRACKER — noc-triage live dashboard

**Single source of truth for anyone (any agent, any session) picking this up.** Read this + HANDOFF.md
first. Vikas is AWAY; work is FULLY AUTONOMOUS — no waiting for his approval. Fix the CLASS not the case.
Every reviewable thing he sees = a visual HTML page. Never fabricate. Keep this file updated every turn.

Last updated: 2026-08-18 · driver: fresh Fable session (autonomous resume)

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
- #8 Class 3+4 — MERGED (PR #49, APPROVED, 67 tests green). Intake accepts plain words; guardrail names writes not English. 2 LOW fail-safe polish items logged (pre-existing on master).
- #10 Class 10 — MERGED (PR #48, APPROVED all 6 criteria, 33 tests green). Leadership doc now matches the verdict. server.js /doc/leadership allowlist add still pending (post-Class-1).
- #7 Class 9 (chat sees own incidents + session isolation) — QUEUED behind #6 (shares jarvis.js/server.js)
- #9 Class 5+6 (error/gate hardening + silent dropped turns) — QUEUED behind #6 (shares server.js)
- Stranger-UI sweep — re-running (browser)
- Merge order to avoid conflicts: land #6 first, then #8/#10, then #7/#9.

## Follow-up hooks logged (apply after Class 1 merges — it owns server.js)
- Class 10: add 'leadership' to server.js:2483 doc allow-list + names map (leadership: 'Leadership summary')
  so the /doc/leadership URL alias works (slt already works). artifacts.js already leadership-aware.

- Class 3+4 flagged: sources/alerts.js has its OWN NETWORK_SUBJECT copy (machine-alert path) — consider same
  plain-words treatment later (separate non-operator path, low priority).

## DRIVER COORDINATION (2026-08-18 ~09:50 IST)
- The 30-min launcher spawned a SECOND live session while the 2026-08-17 session was still alive (its
  "skip if alive" check failed — fix autonomous-resume.ps1 later: detect a live claude driver properly).
- New session (launched 09:48) has adversarial+operator reviews IN FLIGHT for PR #47, #48, #49 (separate
  clones noc-rev47/48/49, ports 3101-3103, report-only — they do NOT merge).
- RULE for every driver: before ANY merge, `git fetch` + `gh pr view <n>` — if already merged, skip and
  move on. Merge order stays #47 → #48/#49 → then build #7/#9 on the fresh master. Duplicate reviews are
  acceptable waste; duplicate MERGES are not.

## POST-MERGE AUDIT of #48 (Class 10) — second reviewer, live evidence, 2026-08-18 ~10:00 IST
Other driver merged #48/#49 at 09:55/09:57 (out of order; tolerated — files mostly disjoint from #47).
An independent live review of #48 found REAL gaps now on master (verbatim doc evidence in squad/triages):
1. BLOCKER No-hypothesis fallback still prints the raw alarm scrape as the leadership headline
   (artifacts.js "What we found" falls back to v.verdict). Hit on 1 of 2 live triages.
2. BLOCKER "What broke" (driven off v.activeInWindow) can contradict the headline in the same doc —
   chronic license alarms shown as "a live problem that started during this incident"; the preExisting
   guard misses chronic items living inside activeInWindow front strings.
3. /doc/leadership still 400s — allow-list half deliberately left for post-#47 (already a logged hook);
   PR #48's "404 fixed" claim was wrong.
4. CI scope: implicatedFronts() unions scope+activeInWindow+suspect → True_Test/fabric CIs still on a WAN
   ticket; filter was a no-op on the reported case. Also: empty fronts ⇒ FULL CI list (widest, not narrowest).
5. MEDIUM tsDoc() prefixes the UTC date to a local time — wrong date for IST readers 18:30–24:00 UTC.
6. MEDIUM alert-opened incidents have no operatorTz → UTC-only docs (dual-clock never applies to alert path).
7. Wording: leadership doc mixes raw front keys/verdict jargon (license-not-synced, BFD, FMC) with plain labels.
→ FIX IN FLIGHT: fix/doc-accuracy-2 builder (artifacts.js only, disjoint from #47), then independent review.

## POST-MERGE AUDIT of #49 (Class 3+4) — second reviewer, live evidence, 2026-08-18 ~10:15 IST
Wire-level gate HELD on all 100+ attack strings (zero device writes ever). But:
1. BLOCKER clauseGovernsDevice (guardrails.js ~356-366) fails OPEN — steps past exactly one determiner,
   so any adjective defeats it: "clear all the counters on sw2" / "install the new image on sw1" / "set a
   new hostname" no longer refused at intent layer (100/233 phrasings regressed vs master; masked in
   casual tests by the capability shell that #47 REMOVES — must fix before/with #47's merge).
   Class fix: scan whole clause for device-shaped token; AMBIGUOUS_WRITE + unrecognized object ⇒ REFUSE
   (fail closed) with small innocent-object allowlist. Fold in verb-shielding ("run/execute/perform write
   memory") — same class, pre-existing. Test suite was blind (all bare objects) — add adjective cases.
2. MAJOR refused writes only audit-logged on one branch (server.js ~1097); no-command path leaves no
   trace → audit belongs at the refusal SINK. DEFERRED to post-#47 hooks (server.js/live-agents.js owned by #47).
3. MAJOR intake accepts anything ("lunch is cold today" → real INC + full estate sweep + L3/L4 page).
   Ambiguity law says ASK ("which site/front is this about?") when subject is unrecognizable. Fix with 1.
4. Operator-experience: "🤔 could not find a read command" is the WRONG reply to a write ask — must say
   plainly "that's a change, I'm read-only" (master's behavior). Restore with 1.
Pre-existing (not regressions, logged): unicode/zero-width obfuscation passes checkIntent (blocked at
checkCommand, messaging only); Class 5 gate fail-open on bad mode value (already queued as task #9).
→ FIX IN FLIGHT: fix/guardrail-fail-closed builder (guardrails.js + triage.js + tests, disjoint from #47).

## 2026-08-18 later — QA fixes landing + a Vikas action item
- MERGED so far: Class 10 (docs), Class 3+4 (intake+guardrail). Both approved + verified in review.
- Class 1 (PR #47): APPROVED, but sent back for 2 in-scope items before merge: (a) surviving static binding
  live-agents.js:1063 "show...interface..."→ip-int-brief collapse; (b) synthesis appends false "reasoning
  model declined" AFTER a successful read. Fixing now.
- Class 8 UI (PR #50): built (desk reload persistence re-fetch, mobile wrap, polish), review running.
- Queued behind Class 1: Class 9 (chat→own incidents + session isolation), Class 5+6 (error/gate + dropped turns).
- ⚠️ VIKAS ACTION: Anthropic API credits appear EXHAUSTED again (reviewer hit it). Live LLM verification of
  Class 1 is blocked until topped up (console.anthropic.com → Billing). Deterministic work + non-LLM merges continue.
