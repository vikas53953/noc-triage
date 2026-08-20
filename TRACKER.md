# TRACKER — noc-triage live dashboard

**Single source of truth for anyone (any agent, any session) picking this up.** Read this + HANDOFF.md
first. Vikas is AWAY; work is FULLY AUTONOMOUS — no waiting for his approval. Fix the CLASS not the case.
Every reviewable thing he sees = a visual HTML page. Never fabricate. Keep this file updated every turn.

Last updated: 2026-08-19 · driver: Fable session · panel+banner+synthesis-fix+launch MP4 shipped

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
| 9 | Create a demo video to launch; cover ALL features (he rejected the GIFs+page as "not a launch video", pointed to Creatify) | DONE (2026-08-19 v2) — built a REAL 1080p H.264 MP4 with ffmpeg (kit at demo-captures/video/make-video.sh): intro card → 4 live scenes (which-switch, verdict, tickets, capabilities panel) → CTA, burned captions + soft music, NO watermarks. Delivered as file. Creatify declined (needs his login/pay/terms; makes generic avatar video not the real product). Open offer: square/vertical cut, longer version. |
| 10 | "I can't see any of the new features on localhost:3000" | DONE — root cause: features live on /desk.html, he was on old root page. Shipped: ⚙ Capabilities panel on desk (every feature + integration w/ live/off light, read from status endpoints) + "Where Everything Lives" map (artifact ca59340d). NetFlow honestly flagged NOT built (we have syslog+SNMP+pcap). |
| 11 | Giant "Not yet" banner irritating + "write-up declined by model" keeps showing | DONE — banner shrunk to one-line pointer to the panel. "declined" root-caused: Opus5 safety classifier refuses to SUMMARISE findings carrying device config/creds/HTML. SAFE fix: redact secrets+markup, retry ONCE on SAME model, else one calm line. CAUGHT+REMOVED a sub-agent bypass that switched to a permissive model to defeat the refusal. |

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
- **CREDITS RELOADED — planner live again (verified 2026-08-19).** Ran real Sonnet planner flows during
  demo capture (triage verdict, ambiguity-ask, live show-version, investigation loop) — all worked. Vikas's
  guidance stands: use cheaper models (JARVIS_MODEL=claude-sonnet-5) for testing to spend wisely.
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

## PR #47 REVIEW VERDICT (Class 1) — FIX-FIRST, 2026-08-18 ~10:20 IST
Core claims verified live BEFORE the API credits died: phrase table gone, NO_STORE/ACI_WORDS gone,
ambiguity-ask works on the normal path (sw → lists sw1-sw4, runs nothing, remembers choice), real sw2
read, write refusals with zero wire calls, deny = zero calls (9 records before/after), scrubbing + XSS held.
Findings → fix on the PR branch (fix/intent-first-no-shell), builder IN FLIGHT:
- B1 BLOCKER live-agents.js ~420: planTarget (planner's structured device field) trusted unconditionally —
  bypasses ambiguity ask; plan "sw3" + text "sw2" → ran sw3 captioned "the device you named"; audit record
  false too. Class fix: planTarget is a hint to RECONCILE with the text, never a target to trust; never
  caption a plan-supplied device as operator-named.
- B2 server.js: standup/roll-call/weekly-report/help now dead code (~200 lines, zero callers). "what can
  you do?" costs an LLM call (and dies without credits). Re-land help as explicit app-fact surface;
  wire or delete the other three.
- B3 capabilities.js:126: 'update' silently dropped from change verbs with NO net (not in STATE_CHANGING) —
  "update the ios image on sw1" gets planner prose, not the change card. Restore or add to STATE_CHANGING.
- B4 live-agents.js ~248: router-expert dual-source = two sequential permission prompts for one question;
  deny #1 doesn't stop #2. Make it one gated unit.
- Pre-existing logged: resumeClarification (server.js ~1043) replays the PARKED command even when the
  operator sends a DIFFERENT fresh command ("show running-config on sw3" after park → runs show version).
  Fix in same pass if cheap (it's ambiguity-law adjacent). Also polite-imperative regex gap ("just quickly").
- Post-#47 hooks folded INTO this fix pass (branch owns server.js): /doc/leadership allow-list line;
  audit-log at the refusal SINK (from #49 audit MAJOR 2).
- LIMITATION: planner-path adversarial set NOT fully re-runnable until API credits topped up — logged in
  Needs Vikas. Merge gate: deterministic evidence + tests + reconcile logic unit-proven; planner re-run when credits return.

## 2026-08-18 later — QA fixes landing + a Vikas action item
- MERGED so far: Class 10 (docs), Class 3+4 (intake+guardrail). Both approved + verified in review.
- Class 1 (PR #47): APPROVED, but sent back for 2 in-scope items before merge: (a) surviving static binding
  live-agents.js:1063 "show...interface..."→ip-int-brief collapse; (b) synthesis appends false "reasoning
  model declined" AFTER a successful read. Fixing now.
- Class 8 UI (PR #50): built (desk reload persistence re-fetch, mobile wrap, polish), review running.
- Queued behind Class 1: Class 9 (chat→own incidents + session isolation), Class 5+6 (error/gate + dropped turns).
- ⚠️ VIKAS ACTION: Anthropic API credits appear EXHAUSTED again (reviewer hit it). Live LLM verification of
  Class 1 is blocked until topped up (console.anthropic.com → Billing). Deterministic work + non-LLM merges continue.

## 2026-08-18 — Class 1 MERGED
- Class 1 (intent-first, PR #47) MERGED to master + deterministically verified (shell gone, findings 1&3
  fixed: substitution block deleted, synthesis false-refusal removed). LIVE LLM re-verify PENDING credits.
- Class 10 server.js follow-up applied: /doc/leadership now aliases to slt.
- Class 9 (chat sees own incidents + per-operator session isolation) BUILDING (fix/chat-sees-incidents).
- Class 5+6 QUEUED behind Class 9 (both touch server.js — sequential).
- Class 8 UI (PR #50) MERGED + review-verified live (reload persistence, XSS-on-restore safe, mobile, contrast). 2 non-blocking minors logged.
- MERGED QA classes so far: 10, 3+4, 1, 8. Remaining: 9 (queued), 5+6 (queued).

## 2026-08-18 — autonomous resume (fresh session): loose ends from dead builders picked up
- FOUND: two in-flight builders from earlier sessions died without pushing — fix/guardrail-fail-closed
  (never pushed) and fix/chat-sees-incidents (Class 9, never pushed). fix/doc-accuracy-2 WAS pushed
  (59e6b22, artifacts.js + 271 test lines) but has NO PR and NO review.
- VERIFIED ON MASTER: the #49-audit BLOCKER is live and now UNMASKED (guardrails.js:361 clauseGovernsDevice
  still steps past one determiner only; #47's merge removed the shell that hid it). Wire gate still blocks
  real writes; intent-layer refusal fails open on adjectives. → TOP PRIORITY.
- IN FLIGHT NOW (2 agents, disjoint files, own clones):
  1. Builder: fix/guardrail-fail-closed — fail-closed clause scan + verb shielding + intake asks on
     unrecognizable subject + honest "that's a change" refusal message + audit-log at refusal SINK
     (post-#47 hook folded in). Clone noc-guardfix. Will open PR, not merge.
  2. Reviewer: fix/doc-accuracy-2 — adversarial review vs the 7-item #48 audit, live check on :3105 via
     deterministic alert path (LLM credits still exhausted), merge if it holds. Clone noc-docrev2.
- AFTER those: guardrail PR gets independent review + merge → THEN Class 9 rebuild (fix/chat-sees-incidents,
  shares server.js) → THEN Class 5+6. resumeClarification replay bug + polite-imperative regex gap stay
  queued (ambiguity-law adjacent, log in Class 9/5+6 scope if cheap).

## 2026-08-18 — PR #51 MERGED (doc-accuracy-2, all 7 #48-audit items verified)
- Reviewer verdict: items 1-4,6 FIXED with line+test evidence; item 5 honest (labelled UTC, right date).
  52 doc tests + 67 guardrail tests green. Adversarial sweep (empty/null verdicts, invalid tz, site-only
  scope) clean. Live-checked on :3105 via deterministic alert path (no LLM).
- Reviewer ALSO found+fixed a real defect at class level: alert-opened docs claimed "N new alarms appeared
  during this incident" from sdwan's default rolling-24h split. Now all timing claims gate on
  verdict.window.timeAnchor; undated ⇒ honest "cannot say when they started". +6 tests.
- FOLLOW-UP LOGGED: triage.js frontIsActive() has the same rolling-24h weakness UPSTREAM (engine's own
  activeInWindow split soft on undated bridges) — doc layer no longer amplifies it; fix in engine later.
- Residual (deliberate): next-steps / could-not-see sections pass engine strings verbatim (DNAC_*, FMC).
- Honest limits: populated what-broke path unit-tested only (clone had no source creds); LLM hypothesis
  path pending credits (regression guard in place).

## 2026-08-18 — PR #52 BUILT (guardrail fail-closed), independent review IN FLIGHT
- Branch fix/guardrail-fail-closed, PR #52 open (NOT merged). Delivered all 5 scope items:
  whole-clause fail-closed scan + INNOCENT_OBJECTS allowlist; carrier-verb shielding (run/execute/perform
  write ⇒ refuse, "run show boot system" stays read); intake asks on unrecognizable subject (422, no INC);
  honest "that is a change… I am read-only" at the no-command sink; single audit record at the refusal
  SINK (writeRefusal/auditRefusedWrite, per-branch log removed). Tests 67→166 green; npm test script added.
- Builder-flagged follow-up: Jarvis conversational surface only gets the deterministic screen when
  isDeviceCliRequest — conversational change asks route to the change-proposal path (pre-existing; verify in review).
- Reviewer (own clone noc-rev52, port 3106) running adversarial sweep with FRESH attack strings; merges if it holds.
- LLM-path verification still pending credits (deterministic-only evidence).

## 2026-08-18 ~14:20 — autonomous resume (fresh session)
- Prior session's #52 reviewer died before reporting (only PR comment = Codex usage-limit noise, not a
  review). RELAUNCHED independent adversarial reviewer (Opus, clone noc-rev52, port 3106, fresh attack
  strings, deterministic paths only — LLM credits still exhausted). It merges #52 only if it holds.
- FIXED the duplicate-session launcher bug (logged 09:50): autonomous-resume.ps1 alive-check looked for
  node.exe, but claude runs as claude.exe → matched nothing → stacked sessions. Class fix: detect a live
  driver by WORK PRODUCT (newest of .git HEAD/FETCH_HEAD/index, TRACKER.md, autoresume.log modified
  <30 min ago ⇒ skip), not process names — also immune to idle/stale claude.exe windows blocking resume
  forever. Dry-run verified (fresh fetch ⇒ skip=True; syntax OK).
- Next after #52 verdict: Class 9 rebuild (fix/chat-sees-incidents, shares server.js), then Class 5+6.

## 2026-08-18 ~14:35 — PR #52 MERGED (guardrail fail-closed) — FIXED-THEN-MERGED
- Independent reviewer verified all 5 scope items LIVE over a real WebSocket on :3106 (fresh attack
  strings): fail-closed object scan, carrier verbs, intake 422-asks with zero incidents created, honest
  "that is a change… I am read-only" wording, audit-at-sink. Zero device writes reached the wire, ever.
- Reviewer found + fixed 3 pre-existing fail-open holes INSIDE the PR's class (branch 4816ddb):
  (1) punctuation inside the verb ("re-load sw2") dodged the verb lookup — no refusal, no audit;
  (2) WORST: change-ask alongside a read silently dropped ("maybe we should reload sw2, and show me the
  version" ran the read, reload vanished) — splitIntent judged only clause-leading words; now wider scan;
  (3) compound refusals lost when the read half throws — refusal moved to the decision point, record now
  says "only the read half was run". Master gave 0 audits on all 8 probes; now all refuse + audit.
- Tests 166 → 198 green (npm test). One accepted fail-closed false positive: past-tense narration
  ("somebody rebooted it last week") — gated behind isDeviceCliRequest, never reaches an operator.
- Builder-flagged follow-up confirmed PRE-EXISTING (screenThis line byte-identical to master).
- NOT verified (honest): LLM planner paths (credits exhausted) + real device reads (no sandbox creds in
  clone) — judged at guardrail/refusal layer only. Re-run planner adversarial set when credits return.
- Now on master: 3a1f999. QA classes DONE: 1, 3+4, 8, 10 + guardrail follow-up. Remaining: 9, 5+6.
- NEXT: Class 9 builder launching (fix/chat-sees-incidents, own clone, fresh master).

## 2026-08-18 — Class 9 built + launcher fixed
- Class 9 (chat sees own incidents + per-operator session isolation) BUILT — PR #53 (10 files, 251 tests pass).
  IN REVIEW with special focus: must NOT regress Class 1's shell removal (shared files) + new id/handover
  vocab must be pass-through not keyword-answer. LLM-path awaits credits.
- Class 5 (permission gate fail-open → fail-closed + real deny mode) BUILDING (fix/gate-fail-closed, approvals.js).
- Class 6 (global error handler + silent dropped turns, server.js) QUEUED behind Class 9+5 (server.js).
- AUTO-RESUME LAUNCHER FIXED: root cause was bare `claude` (PATH-stripped in scheduled task → 6-byte silent
  death). Now absolute path (proven starts, 348 bytes real output) + fail-loud HEAD-before/after check so a
  sandboxed/hallucinated session logs "NOT resumed" instead of faking success. RESIDUAL (not fixable here):
  account session-quota wall blocks ALL sessions until reset — needs account capacity/credits (Vikas's lever).
- MERGED QA classes: 1, 3+4, 8, 9, 10. Class 5 (#54) in review. Class 6 (error handler + dropped turns) BUILDING (fix/errors-and-dropped-turns). Pending server.js wirings after #54 merges: gate route (3 lines).

## 2026-08-18 — Class 5 MERGED (6/6 QA classes only Class 6 left)
- Class 5 (gate fails closed + real deny mode) MERGED (PR #54 approvals.js + I applied the server.js route
  wiring in the same push, per reviewer). LIVE-VERIFIED by me: deny stays deny, garbage→400, never auto.
- Full test suite 7 files green (exit 0).
- MERGED QA classes: 1, 3+4, 5, 8, 9, 10. ONLY Class 6 (error handler + dropped turns) left — BUILDING.
- Note for Class 6 merge: it edits server.js; I just edited the /api/approvals/mode route (lines ~2511) —
  resolve that region if it conflicts.

## 2026-08-18 — ALL 7 QA CLASSES MERGED ✅
- Class 6 (clean error handling + no silent dropped reads) MERGED (PR #55). LIVE-VERIFIED: non-string
  command → 400 no leak; malformed JSON → 400 no leak. Full suite 9 files green (347 checks).
- COMPLETE QA fix set merged: 1 (keyword shell), 3+4 (intake+guardrail), 5 (gate fail-closed), 6 (errors
  +dropped turns), 8 (UI), 9 (chat sees incidents), 10 (docs). Each: built → adversarial review + operator-
  experience pass → merged → verified.
- ONLY remaining: LIVE-LLM verification pass of the whole intent-first system, gated on Anthropic credit
  top-up (console.anthropic.com → Billing). Deterministic + non-LLM behavior all verified.
- Copilot waves: CW-1, CW-2 done. Next feature waves (when resumed): CW-3 tickets, CW-4 Teams (needs
  webhook), CW-5 SSH wiring, CW-6 ServiceNow (needs creds).

## 2026-08-18 — AUTONOMOUS FEATURE-WAVE BUILD (Vikas away, "build all, test at end")
- Building now: CW-3 tickets (backend feat/cw3-tickets-be + UI feat/cw3-tickets-fe, contract docs/copilot-cw3-contract.md)
  and CW-5 SSH-live (feat/cw5-ssh-live, per-device transport at the choke point) — parallel (disjoint files).
- Sequenced AFTER (share server.js/capabilities/desk.html): CW-4 Teams, then CW-6 ServiceNow.
- Credits still out → agents do deterministic verification; the big LIVE-LLM test is the END batch when Vikas
  is back with credits (his instruction: "test all at once at the end").
- Needs Vikas for LIVE (built honest-if-absent): CW-4 Teams webhook, CW-5 DevNet sandbox creds, CW-6 ServiceNow creds.
- Merge discipline: land CW-3 + CW-5, then CW-4, then CW-6; resolve shared-file conflicts at merge.

## 2026-08-18 — CW-5 MERGED
- CW-5 SSH-live MERGED (PR #57, APPROVED, tests green). Per-device transport at the choke point; sw1-sw4 stay
  Command Runner (no regression); SSH devices honest "auth needed" until Vikas adds DevNet sandbox creds.
  Minor follow-up logged: ambiguity device list doesn't offer SSH sandboxes (discoverability). Human should do
  a one-time real-creds SSH dial before relying on SSH output in prod.
- CW-3 tickets (backend #56 + UI #58) in integrated review.
- NEXT after CW-3 merges: CW-4 Teams, then CW-6 ServiceNow.

## 2026-08-18 — CW-3 MERGED; CW-4 launching
- CW-3 tickets MERGED (PRs #56+#58, re-review APPROVED after double-escape fix). Live-verified: TKT-…001
  raw "AT&T", 428 without name, 11 suites green.
- CW-4 Teams launching (backend feat/cw4-teams-be + UI feat/cw4-teams-fe, contract docs/copilot-cw4-contract.md).
  HONEST: Teams Incoming Webhook is ONE-WAY (post only); real two-way reply reading needs a Teams bot —
  building POST for real + an honest inbound endpoint for a future bot/flow. Needs Vikas's TEAMS_WEBHOOK for live.
- LAST wave after CW-4: CW-6 ServiceNow.

## 2026-08-18 — CW-4 MERGED; CW-6 (LAST wave) launching
- CW-4 Teams MERGED (PRs #59+#60, APPROVED — honest not-connected, real POST when webhook set, secret never
  leaks, one-way limit stated). Needs Vikas's TEAMS_WEBHOOK for live.
- CW-6 ServiceNow (LAST) launching (backend feat/cw6-servicenow-be + UI feat/cw6-servicenow-fe, contract
  docs/copilot-cw6-contract.md). Internal queue = truth; SNOW mirrors; honest not-connected until Vikas adds
  SNOW_INSTANCE/USER/PASS.
- After CW-6: ALL copilot waves CW-1..CW-6 done. Then the ONE big end-to-end live test when Vikas is back
  with credits + (optionally) the webhook/SNOW/sandbox creds for the live integrations.

## 2026-08-18 — ALL CW-1..CW-6 DONE; CW-7 investigation loop (NEW, Vikas)
- ALL copilot waves CW-1..CW-6 MERGED + verified (474 tests green). Only end-to-end live-LLM test pending credits.
- NEW feature request (Vikas): CW-7 iterative investigation loop — Jarvis grills the problem, probes agents
  round by round ("check this, report back"), narrows hypotheses, stops on confidence OR ~6-round cap OR
  honest-stuck, then plans the fix (change proposal via CW-2). Decision: confidence + safety-cap model.
  Contract docs/copilot-cw7-contract.md. Backend+UI pair. LLM-heavy → deterministic verify (stubbed planner)
  now, real multi-round test on credits.

## 2026-08-18 — master branch protected
- GitHub branch protection on master: force-push BLOCKED, deletion BLOCKED, direct pushes STILL ALLOWED
  (no required-PR/status-checks — keeps the autonomous merge-then-push flow). Safety net against history rewrite/wipe.

## 2026-08-19 — NetClaw pull: A1/A2/A4 building (Vikas approved A1→A2→A4)
- Assessment: docs/netclaw-assessment.md + visual page https://claude.ai/code/artifact/ccdf5935-1fb2-41f1-a208-086a217135f3
- CW-8/A1: MCP connector for Jarvis (mcp-client.js + jarvis/server/capabilities) — the unlock. Contract
  docs/copilot-cw8-contract.md. Behind the gate, read-only, honest-if-no-servers, proven vs a stub MCP server.
- A2: grow catalyst-center.js from netclaw catc read catalogue (pure Node, no MCP, Apache-2.0 attribution).
- A4: native Node syslog + SNMP-trap live feeds → live-events store the bridge reasons over; honest not-receiving.
- Parallel on mostly-disjoint files (A1+A4 share server.js — A4 keeps its block minimal/separable). Credits
  out → deterministic build/verify; Jarvis choosing an MCP tool + live feed reasoning = end test on credits.
- Note: NOT auto-wiring any real external MCP server yet — security vetting first (per assessment).

## 2026-08-19 — NetClaw pull progress
- A2 (Catalyst Center adapter, 11 live reads) MERGED (PR #65, APPROVED). catalyst-center.js additive; live-verified.
- A1 (CW-8 MCP connector, PR #67) in security review — hand-rolled zero-dep client, gated, read-only, honest, 552 tests.
- A4 (live feeds, PR #66) in review — native syslog+trap UDP receivers.
- CW-7 UI (PR #64) final race-fix confirm running.

## OVERNIGHT STATE (2026-08-19, Vikas asleep — keep building autonomously)
IN FLIGHT (resume by reading each PR's review comment, then merge-on-approve → restart :3000 → verify):
- CW-7 UI (PR #64): final race-fix confirm running → on APPROVE merge, CW-7 investigation loop COMPLETE.
- A1 MCP connector (PR #67): security review running → merge on approve (unlock for external tools).
- A4 live feeds (PR #66): community-scrub class fix in flight → re-verify → merge.
- A2 (PR #65): MERGED.
MERGE ORDER when several approve together: they share server.js/package.json — merge one, resolve the
trivial test-list/require conflicts (keep BOTH sides), npm test must stay green, then next.
AFTER these land: netclaw A5 (batfish offline change-validation) + A6 (packet capture / Nautobot) are the
next candidates IF Vikas confirms; do NOT start them unprompted — they're bigger and he only greenlit A1/A2/A4.
STANDING: credits OUT → deterministic verify only; the big live-LLM end-to-end test is Vikas's when credits
return. Never fabricate. Fix the class. Update TRACKER + push every step. Master protected (no force-push).

## 2026-08-19 — ALL WORK MERGED + a stability hardening
- CW-7 investigation loop COMPLETE (PR #64 UI merged, race fixed). All 7 QA classes + 7 copilot waves +
  netclaw A1/A2/A4 = DONE. 17 test suites green.
- Reviewer flagged a latent server crash (exit 1) after the watcher sees a COPILOT_AUDIT.log write. Could NOT
  reproduce on a normal audit write (server stayed alive). Root-cause class: the process-level uncaughtException
  guard called broadcast(), which can throw mid-fault and defeat the guard → exit 1. FIXED: reportSystemError
  is now bulletproof (every part wrapped; a throwing broadcast/log can never crash the guard). So a stray async
  error anywhere (watcher/audit/broadcast) can no longer take the server down. Pushed.
- REMAINING (all need Vikas): live-LLM end-to-end test (credit top-up); optionally TEAMS_WEBHOOK, SNOW creds,
  SSH sandbox creds, real syslog/trap device pointing, and a vetted real external MCP server. Nothing blocking.
- Next candidates from netclaw assessment (NOT started — need Vikas's OK): A5 batfish, A6 packet/Nautobot.

## 2026-08-19 — remaining NetClaw pull (Vikas greenlit "go with remaining")
- A5 Batfish (offline change-validation, pairs with change engine) + A8 Nautobot (source-of-truth reconcile)
  BUILDING (feat/a5-batfish, feat/a8-nautobot). A6 packet-capture QUEUED behind (shares server.js).
- All honest-if-absent (need Batfish service / Nautobot creds). Credits out → deterministic verify + stub
  endpoints now; LLM path later. Each: build → adversarial review → merge → verify → TRACKER++.
- Overnight autonomous; launcher armed. Vikas asleep. No blocking questions.

## 2026-08-20 — Fable picked up after reboot; Vikas's bridge-call brief (HIS WORDS)
- Vikas: understand-first "is not working" in CHAT — "i said 'i'm not able to access this epg'… it keeps on throwing me the same answer… not asking me any questions". EVIDENCE FOUND in squad/data/chat/chat-history.json: "hey jarvis facing issue in epg" → Jarvis planned 2 engineers, swept, dumped walls of text, asked "you didn't name the EPG" only at the END. Root class: ask-first landed on triage intake only, NOT the Jarvis chat path; raw agent dumps posted verbatim into chat.
- Vikas wants the real NOC bridge experience: Jarvis = chief of staff / call leader — understands problem, asks until narrowed, engages only required teams round-by-round, then fix under change management. SHORT messages ("no one is going to read that chat"). Command output shown like an SSH session — black screen in the chat. Kill static-feeling lines ("i cannot do that…", "you did not name the epg…").
- HIS PROCESS ORDER: prototype FIRST, his go-ahead + feedback, ONLY THEN build the real feature.
- Prototype delivered (3 looks: bridge chat / split terminal / war-room ticker), replaying his EPG test:
  https://claude.ai/code/artifact/3a0a9d67-634f-4d87-a20a-42227fcd426c — AWAITING HIS VERDICT. Do NOT build until he approves.
- Pickup report page: https://claude.ai/code/artifact/9535c85a-e802-4583-9db9-54d5a718ffb0
