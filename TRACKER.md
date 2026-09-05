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

## 2026-08-20 — VERDICT IN: build V2 (his words: "i want v2 to build — V2 (split terminal)")
- All 7 prototype elements LIKED: ask-first opening, short messages, bridge roster, SSH terminal output,
  round-by-round narrowing, fix under change management, the 3-look choice.
- BUILD = CW-9 "bridge conduct" wave: contract docs/copilot-cw9-bridge-contract.md. Backend (feat/cw9-bridge-be)
  + UI (feat/cw9-bridge-fe) in parallel own clones, PR each, DIFFERENT-agent review, merge, restart :3000,
  live verify. Fable orchestrates; Opus executes. Jarvis test model = claude-sonnet-5 (spend-wise).
- Class law for this wave: ONE conduct layer shared by EVERY operator entry point (chat + triage intake +
  future paths) — never a per-path fix again.

## 2026-08-20 — CW-9 BACKEND (feat/cw9-bridge-be) built
- ONE conduct layer: sources/conduct.js — the shared understanding gate + the pinned envelope with the
  hard caps in CODE (jarvis text ≤280, finding.line ≤200, ≤3 questions). Chat (jarvis.ask) and the triage
  intake (triage ctx.understand) both go through it now — no more per-path conduct.
- Vikas's EPG failure replayed LIVE on claude-sonnet-5: "hey jarvis facing issue in epg" → one 275-char ask
  with 3 real narrowing questions, ZERO engagements, ZERO reads. The answer resumes the same understanding.
- Bridge: roster message (engaged + stood-down, one-line why each; the loop may task ONLY the engaged) →
  CW-7 investigation loop round-by-round (one short say + finding evidence per round) → verdict → CW-2
  change record held-for-approval (never applied).
- Every read now carries finding.cli {host, command, raw scrubbed output, honest transport} — Command
  Runner is 'cmdrunner', never dressed as ssh; anything else is 'api'. Raw output never enters message text.
- 24 suites / 918 assertions green (new sources/conduct.cw9.test.js: 71; CW-7 suite grew by 8).

## 2026-08-20 — CW-9 backend FIX-FIRST pass (reviewer blockers 1-3, high 4-6, medium 7-10)
- Roster truth: agents now carry the SOURCE SYSTEMS they really read (live.AGENT_SOURCES). A stand-down is
  only claimed when no engaged agent reads that agent's systems; overlap is stated out loud; a round that
  reads a stood-down system anyway triggers an honest correction. Never-connected agents are off the card.
- Narration from evidence: each round is described by the checks it actually produced, diffed against every
  earlier round ("returned the same picture — nothing new"); repeated evidence is not re-posted; the probe
  QUESTION is never printed as if it were what ran.
- Evidence attribution: session-log contexts NEST and every wire record is stamped with its evidence scope
  id at write time; the collector keeps only its own records (watermark sweep deleted). Proved live: a
  delegation that read nothing came back with 0 entries while a concurrent real read kept its 2.
- ONE gate, first: capabilities.checkAsk is now a POST-gate ctx.screen; a parked thread is resumed by ANY
  reply (a write ask inside the answer is refused out loud AND the answer still resumes).
- Abandon/new-topic on resume are LLM-judged (replyIntent); garbage planner output fails SAFE; thin proceed
  is stated out loud; cli output capped 4000 with honest marker; IOS space-separated secrets scrubbed;
  triage keeps its 4th question and now posts kind:'ask'; operatorTz carried on HTTP; change steps = record.
- 24 suites / 966 assertions green (CW-9 suite 119). Live Sonnet: EPG ask-first 0 reads; abandonment opens
  no bridge; concurrent delegations do not swap evidence; roster claims no false stand-down.

## 2026-08-20 — CW-9 backend re-review pass (F1, F2, M1-M4, L1)
- F1: a change ask can no longer be met with silence. The dead isDeviceCliRequest-gated branch is gone;
  the shared conduct layer screens the operator's own text (LLM `changeAsk` primary + guardrails.splitIntent
  backstop) on EVERY path, refuses out loud, and still lets the rest of the message be understood. The
  change is kept OUT of `understood`, so the investigation never spends rounds chasing it (M4 root cause).
- F2: scrubber now treats key/secret/community as secret-bearing with or without an encoding digit, plus the
  positional `snmp-server host … <community>` form; algorithm names and free-text (description/remark/banner)
  lines survive. All 12 reviewer forms + 6 more scrub; real evidence untouched.
- M1: round dedupe signs on normalised identity (volatile query params stripped, params sorted) AND an output
  hash — a cache-busting timestamp can no longer make a repeat look like a new check.
- M2: the overlap line names each agent's OWN shared systems. M3: drift test asserts every builder's touched
  sources are declared in AGENT_SOURCES. L1: thin-proceed keeps the assumption + the invitation, full text in
  a structured `assumption` field.
- 24 suites / 1026 assertions green (CW-9 suite 179). Live Sonnet: bare write refused (0 reads); mixed
  answer+write → refusal before roster, bridge opened, understood free of the reload; cache-busted repeat →
  "nothing new", 1 finding.

## 2026-08-20 — CW-9 backend final gate (scrubber rewrite + probe-prose medium)
- Scrubber is now ONE ordered pass (sources/session-log.js): free-text line guard (description/remark/
  banner/!/prose) → separator forms → ONE token scan (keyword → syntax words → VALUE) → positional
  snmp-server host/community forms. Fixes the racing-rules root cause: the marker can no longer land on a
  syntax word while the secret survives, and prose is never eaten. New forms are one-line additions.
- Closed: vrrp/standby authentication [text], wpa-passphrase, passphrase 0. Fixed false redactions:
  pre-shared-key local|remote, authentication md5 key-string (VRRP+HSRP), wpa psk set-key ascii 0.
- New sources/scrubber.cw9.test.js: table-driven, 109 assertions (38 secret forms incl. the reviewer's
  round-3 nine + round-2 twelve, 17 survivors, 6 prose lines, a whole-config case, sanity).
- Medium: probe prose no longer burns a round — a possessive ("sw1's config") makes the next word a noun,
  and a past-tense reporting verb within 3 tokens ("showed no aaa") is quoted output, not an order. Real
  writes still refuse, including an order after quoted speech in the same sentence.
- 25 suites / 1145 assertions green.
## 2026-08-20 — CW-9 build state
- Backend PR #73 (feat/cw9-bridge-be) BUILT: sources/conduct.js one shared gate (chat + triage), envelope
  + caps in code, finding.cli w/ honest transport, roster, CW-7 loop reuse, verdict→held change. 24 suites
  918 assertions green. LIVE Sonnet check: EPG ask → 3 questions, 0 engagements, 0 reads.
- UI PR #72 (feat/cw9-bridge-fe) BUILT: V2 split terminal on desk, envelope cards on both consoles,
  XSS-tested live on :3111, reload-safe, 24 suites green. Built against pinned envelope (fixture-driven).
- Independent adversarial reviews IN FLIGHT: rev of #73 (clone noc-rev73, :3113, incl. #72 seam check) and
  rev of #72 (clone noc-rev72, :3112). Report-only; Fable merges on approve. MERGE ORDER: #73 then #72,
  then restart :3000, integrated live verify (EPG replay), visual evidence page to Vikas.

## 2026-08-20 — CW-9 UI review verdict: FIX-FIRST (builder fixing)
- PR #72 review (live, Playwright, own clone): 1 HIGH — same-origin resume guard bypassable via backslash
  (`/\evil/` treated as protocol-relative; live cross-origin exfil of operator's typed answer proven).
  4 MEDIUM: malformed-envelope renders vanish/kill hydrate replay; classic console still paints empty
  bubbles; 2.79MB cli output blocks main thread 1.5s + silently breaks the 250k persist cap; terminal pane
  stuck 340px (prototype says minmax(340,480)) + 1240px stack threshold too low. 2 LOW (awaiting not
  restored on reload; duplicated helpers w/ divergent escapers).
- XSS held everywhere; transport honesty, reload, one-shot resume, mobile, regressions all clean.
- UI builder resumed with class-level fix orders (URL-origin resolution not char blocklists; shared
  fallback-bubble render/hydrate guard; render+persist caps with honest truncation; prototype minmax).
- CW-10 "production plumbing" wave PROPOSED to Vikas (official Anthropic SDK + prompt caching + streaming
  + token accounting; NO LangChain/LangGraph/Agent-SDK): verdict page
  https://claude.ai/code/artifact/7988f6d1-6f24-4b23-a9cc-5ddd86158bbd — awaiting his yes/no.
- Backend review (PR #73) still running.

## 2026-08-20 — CW-9 backend review verdict: FIX-FIRST (builder fixing)
- PR #73 review (live on :3113, Sonnet, WS harness + wire-call diffing): conduct WORKS (EPG replay = ask,
  0 reads; deny = 0 calls; write-injection refused+audited; caps enforced; no keyword routing) BUT the
  bridge "says more than it does":
  BLOCKERS: (1) roster lies — "stood down" agent's systems still read by the engaged agent; (2) round
  narration asserts drill-downs that never ran (3 rounds, byte-identical evidence); (3) evidence cross-talk
  — apiEvidenceSince() sweeps the GLOBAL log, one delegation carried another's record = fabrication.
  HIGH: gate not in front of capabilities.checkAsk (answer to parked questions swallowed, thread orphaned);
  resume can't reach problemReport (abandon → bridges the OLD problem); thin-flag returned but never read.
  MED: garbage planner fails open; finding.cli.output uncapped (267KB chat store); scrubber misses IOS
  space-separated secrets; intake silently 4→3 questions.
- Builder resumed with class-level fix orders (roster derived from actual read-set; narration composed FROM
  per-round evidence diffs; per-delegation evidence tagging at write time; ONE gate first on every entry;
  LLM-judged resume/abandon; fail-safe planner; shared truncation convention with the FE fix; IOS scrubber
  class fix). Both PRs now in fix cycles; re-reviews before any merge.

## 2026-08-20 — Vikas verdict on architecture page (HIS WORDS)
- LIKED all sections. Ask: "i really think reflexion is the most important thing when it comes to the
  networking kind of stuff wherein it is going to reflect on its own work. if there is any problem with
  what it is doing, it automatically gets reflected... i really want reflexion to be part of jarvis"
- CW-10 "production plumbing" (SDK+caching+streaming+token accounting) = APPROVED (liked recommendation).
- NEW wave CW-11 "Reflexion" — design page sent for his sign-off before build. Sequence: CW-9 fixes →
  CW-10 plumbing → CW-11 reflexion.

## 2026-08-20 — Vikas ask: "anything else we can take from Anthropic/OpenAI/open source so we don't
## write this whole code ourselves?" (HIS WORDS)
- Answered on the architecture page (new "Adopt instead of build" section, same URL). Verdicts: ADOPT
  community MCP servers for all NEW integrations (we have the CW-8 doorway — stop hand-writing adapters),
  ADOPT Anthropic server-side web search/fetch + compaction (fold into CW-10, near-zero code), keep the
  netclaw-style open-source pull pattern, NO to OpenAI Agents SDK/Swarm (second provider, zero gain),
  Managed Agents LATER. Proposed standing rule for HANDOFF: new integrations arrive as vetted MCP servers,
  not hand-written adapters — awaiting his 👍.

## 2026-08-20 — CW-9 UI fixes pushed (8700cce), re-review in flight
- All 6 findings fixed at class level: resolveResume() URL-origin resolution (new shared public/cw9-bridge.js,
  checked at arrival/restore/send, 6 attacks → 0 off-origin); arr() guards + try/catch render + per-message
  hydrate; classic-console honest placeholder (no empty bubbles); display/persist caps w/ honest truncation
  (1532ms → 37ms, store fresh); minmax(340px,.6fr) + 1599px stack threshold (1440x950 now readable);
  awaiting restored on reload + helpers deduped into shared module. 100 checks green, live-verified :3111.
- Independent reviewer re-attacking (fresh bypasses, tampered localStorage, degenerate shapes). BE builder
  still fixing PR #73.

## 2026-08-20 — Vikas LIKED "Adopt instead of build" → standing rule installed
- HANDOFF.md law added: new integrations = security-vetted MCP servers via CW-8 connector, hand-write only
  when no trustworthy server exists; prefer Anthropic server-side features (web search/fetch, compaction).
- CW-10 scope now: official SDK + Tool Runner, prompt caching, streaming, token accounting, web search/fetch,
  server-side compaction.

## 2026-08-20 — CW-9 backend fixes pushed (5c02cdb), re-review in flight
- All findings fixed: AGENT_SOURCES roster truth (stand-down only when systems untouched, overlap named,
  honest correction on violation); narration diffed per-round by source|command (repeats say "nothing new");
  per-delegation evidenceId tagging, watermark sweep DELETED (concurrent + race test green); gate now first
  on every entry (capability screen behind it); LLM-judged replyIntent (answer/new-topic/abandon); thin
  proceed states its assumption; planner fails safe; cli.output 4000 cap; IOS scrubber forms; intake 4th
  question restored. 24 suites 966 assertions green; live Sonnet EPG replay clean.
- Both re-reviews now running (UI reviewer re-attacking 8700cce; BE reviewer re-attacking 5c02cdb).
  Merge order on double-approve: #73 then #72 → restart :3000 → my own live verify → evidence page to Vikas.

## 2026-08-20 — Vikas standing order re-affirmed (HIS WORDS, he's at the office)
- "make sure you are fully in autonomous mode. if my quota is going to get full... agents and you will
  automatically pick up that work... rather than waiting for me to come and jump in and tell you 'quota
  has been reset, now start working.' i really don't want that."
- MECHANISM (verified live 2026-08-20 12:0x): Windows task "noc-triage-autoresume" is ARMED and running
  (every 30 min, survived the reboot; last run 11:48, absolute-path claude launch, work-product liveness
  check). If this session dies at the quota wall, a fresh session auto-launches, reads this TRACKER +
  the CLI task list, and resumes the top in-flight item WITHOUT waiting for Vikas. Never ask him to
  announce a reset.
- CLI task list created (7 tasks): #1 PR73 re-review→merge, #2 PR72 re-review→merge, #3 live verify +
  evidence page, #4 CW-10, #5 CW-11, #6 launch video v3 (open), #7 waiting-on-Vikas creds.
- CW naming for any resumer: CW = "Copilot Wave" — OUR feature-wave numbering (CW-1..CW-11), NOT PR numbers.

## 2026-08-20 — CW-9 UI re-review: APPROVE (fixes held under fresh attack)
- 51-shape fuzz + 11 live attack envelopes vs resolveResume → 0 off-origin posts; tampered-localStorage
  restore rejected; 30 malformed shapes → 0 vanished/0 throws; 2.79MB output 1532ms→35ms, store fresh,
  honest truncation note; layout reads like an SSH session at 1920 + stacks at 1440; 8 fresh XSS classes
  → 0 hits; 24 suites green (CW-9 suite 100 checks). Honest-placeholder deviation explicitly APPROVED.
- 3 tiny pre-merge polish items sent to builder (trim-notice wiped on reload; resolveResume normalize;
  resume.field allowlist). Mobile ~20px scroll confirmed PRE-EXISTING on master (logged, not this PR).
- Note: gh rejects self-approve (same token) — verdict comments with "VERDICT: APPROVE" are the approval
  signal on this repo.
- Waiting: BE re-review (PR #73) → then merge #73, #72, restart :3000, live verify, evidence page.

## 2026-08-20 — CW-9 BE re-review: FIX-FIRST round 3 (2 must-fix + 4 med)
- Verified fixed live: roster truth (+ drift backstop fires), narration-from-evidence (partial overlap names
  only NEW), per-delegation attribution (race + nested clean, watermark gone), abandon path, thin flag,
  fail-safe planner, caps. 966 assertions green. Reviewer also caught + killed a stale server (EADDRINUSE)
  from the prior review before judging — evidence is from the real build.
- MUST FIX: (1) honest-write-refusal branch UNREACHABLE on chat surface (isDeviceCliRequest gate) — write
  asks now silently ignored (safe but silent; violates honest-refusal law); (2) scrubber misses plaintext
  `key <secret>` forms (tacacs/radius/snmp community/isakmp). MED: cache-buster defeats round dedupe;
  overlap line prints wrong agent's systems; AGENT_SOURCES needs a drift-failing test; wasted rounds
  downstream of (1). Builder on round 3.
- Seam with #72 re-confirmed (field=text matches, truncation precedence correct). BE still merges first.

## 2026-08-20 (post-reset) — CW-9 BE final review: FIX-FIRST on ONE item (scrubber)
- Reviewer (fresh clone :3114, verified own PID) closed everything else: 7 fresh write attacks all honest-
  refusal-first w/ 0 wire; dedupe holds incl. unknown param names (output hash); roster per-agent lists
  exact; drift test proven to fail on an undeclared read; 1026 assertions green; EPG replay clean; #72 seam
  exact match. Noted honestly: euphemism screening rides the LLM changeAsk (deterministic backstop narrower
  than PR body claims).
- SCRUBBER blocker, root cause = two keyword rules race, first lacks NOT_A_SECRET + free-text guard:
  5 forms leak (vrrp/standby auth, wpa-passphrase, passphrase 0), 4 falsely redact the syntax word while
  the secret survives (ipsec pre-shared-key, md5 key-string, wpa psk ascii), and description/remark/banner
  prose gets over-scrubbed. Builder on surgical final fix (single-pass ordered rules, value-not-syntax
  redaction, table-driven tests). Then scrubber-only verify → merge train.
- Session-limit note: the wall killed the reviewer mid-run pre-2pm; resumed immediately post-reset.

## 2026-08-20 ~15:45 — CW-9 SHIPPED ✅ (merged + live-verified)
- Final BE verdict APPROVE (3 review rounds, every finding closed under fresh attack). MERGED: #72 then #73
  (order raced; seam verified compatible both ways; package.json test lists merged keeping both). Master
  green: 26 suites, full chain exit 0.
- LIVE VERIFY on merged :3000 (Sonnet, by Fable directly): "hey jarvis facing issue in epg" → kind:ask,
  3 questions, ZERO reads. Answer → roster (Router-Expert engaged w/ why, NetOps/Config-Keeper stood down,
  honest overlap disclosure), round 1 = 7 real checks w/ cli evidence (host·api·GET·output), round 2 =
  "same picture — nothing new", honest stop: tenant absent from the reset DevNet sandbox — no fabrication,
  0 write calls audited.
- :3000 restarted clean on DEFAULT Opus for Vikas (killed 4 stray server processes first).
- Evidence page to Vikas: https://claude.ai/code/artifact/033ae37f-aaf6-41f1-a607-aa885b010a2c
- Tasks #1-3 complete. NEXT: await Vikas's hands-on confirm → CW-10 (contract first). Two LOW review
  leftovers ride along in CW-10 (short-device-error prose over-scrub; FE cosmetic F4).

## 2026-08-20 ~16:00 — CW-10 BUILD LAUNCHED (Vikas: "don't wait for me... do all the remaining work",
## reviews everything ~23:30 IST)
- Contract pinned: docs/copilot-cw10-plumbing-contract.md. BE builder (feat/cw10-plumbing-be: SDK swap
  keeping wrapper surface, prompt caching, spend store + /api/spend/summary, web search/fetch on reasoning
  calls w/ honest web-source labeling, compaction w/ silent fallback, say-delta streaming, scrubber LOW)
  + FE builder (feat/cw10-plumbing-fe: delta rendering, Spend panel, [object Object] LOW) running in
  parallel clones. Review axis = BEHAVIOR PARITY with pre-CW-10 master. BE merges first.
- After CW-10: CW-11 Reflexion (contract already pinned). Evidence for both folds into ONE 23:30 review
  page for Vikas.

## 2026-08-20 ~16:30 — CW-10 both halves BUILT, reviews in flight
- BE PR #74: sources/claude.js rewritten on @anthropic-ai/sdk (same wrapper surface), spend-store +
  /api/spend/summary, web search/fetch on reasoning only (live: web answer cited bst.cisco.com and said
  "WEB-only answer — nothing here is a reading from our live devices"), compaction plumbed w/ fallback,
  say_delta streaming (own WS type — NOT chat_message; FE informed). 30 suites green, 26 pre-existing
  UNTOUCHED. Live: 7 deltas ✅, cache_read 2802 tokens ✅.
- FE PR #75: createStream in shared cw9-bridge.js (accumulate/dup/gap/settle), Spend panel w/ honest
  empty state, 7b fix, both delta transports accepted. 27 suites green, browser-verified on :3121.
- Adversarial reviews launched (rev74 :3115 behavior-parity focus; rev75 :3116 stream-abuse focus).
  Merge order BE→FE on approve, then restart :3000, live verify, then CW-11 build.

## 2026-08-20 ~17:15 — CW-10 reviews: both FIX-FIRST, builders fixing in parallel
- BE #74: parity PROVEN (conduct/guardrails zero-diff, EPG + reload byte-identical vs master baseline
  server; live cache hit; spend store attack-clean; web answer honest). 2 blockers: interrupted stream
  orphans a partial preview (fix: aborted:true closing delta) + delta preview exceeds the 280 cap (stream
  must be strict prefix of capped final). 6 minors (tool-rejection detection, 529 kills compaction, spend
  edge cases).
- FE #75: mid-review fixes held under attack; XSS clean everywhere. 3 blockers: empty-text final DELETES
  the streamed answer; Spend panel pushes incident queue out of the column at small shells; unreadable
  spend shapes render as honest-zero (false). +1 should-fix (post-done claim deletes answer).
- Both builders on fixes; FE also adopting the aborted:true contract. Re-reviews after push; BE merges first.

## 2026-08-20 ~18:30 — CW-10 BOTH APPROVED; one joint pre-merge commit each
- BE #74 APPROVE (14-scenario abort attack clean, cap law holds — never over 280, never mid-word; parity
  still byte-identical; all minors closed). Reviewer required an HONESTY correction: "never shrinks/strict
  prefix" claim is false (clip() reflows at sentence boundaries; 279→267 observed) — test+PR body must say
  the truth; reflow itself judged acceptable.
- FE #75 APPROVE (empty-final, layout backstop, EMPTY-vs-UNREADABLE all verified; id-less path gone; abort
  seam settles instantly).
- JOINT pre-merge fix in flight (both reviewers converged): discard:true on SAFETY-DECLINED aborts — FE
  wipes the partial (screen + localStorage; reviewer proved declined text persisted through reload); plain
  errors keep the honest partial. Then merge #74 → #75 → restart :3000 → live verify → CW-11.

## 2026-08-20 ~20:20 — CW-10 SHIPPED ✅ (merged + live-verified)
- #74 then #75 merged (package.json test lists merged keeping all 31 suites; chain exit 0 on master).
- LIVE VERIFY on merged :3000 (Sonnet): streamed synthesis = 4 say_delta chunks, preview 277 ≤ 280 cap,
  word-boundary clean, final chat_message settles the SAME messageId (len 278). /api/spend/summary live
  (2 calls, tokens + cache_creation recorded, no prompt text). Capability answer path correctly non-streamed.
- :3000 restarted on DEFAULT Opus for Vikas. Task #4 complete. CW-11 builders launching next (contract
  docs/copilot-cw11-reflexion-contract.md).

## 2026-08-20 ~22:00 — CW-11 both halves BUILT; reviews running
- BE PR #77: sources/reflexion.js + lessons.js. Round reflection LIVE-verified ("Round 3 added nothing
  new... confirmed dead ground" + changed approach + avoidAgentIds + deterministic repeat-refusal);
  verdict self-check (verified/suspected/causeSupported from causeEvidenceIds — builder self-caught a
  string-match defect); prediction follow-through parked on every closing path + POST check endpoint
  (observer-honest); lessons via scrubber + LLM similarity (no keywords). 32 suites 1649 assertions green.
  Honest not-proven-live: different-agent round landing + failed-prediction reopen (sandbox has no real
  fault / no write path — same limitation as CW-9/10).
- FE PR #76 fixed after FIX-FIRST (per-ROW lesson honesty — mixed/unreadable states; bridge-path marker
  passthrough; claim corrected; fixture race). 1687 assertions. Field-name pinning to #77 in flight.
- BE adversarial review launched (guardrails-as-laws focus incl. lesson-as-instruction injection attack).
  Then: FE re-verify → merge #77 → #76 → restart :3000 → live verify → Vikas's combined 23:30 page.

## 2026-08-20 ~23:05 — CW-11 MERGED (PRs #77 + #76); live verify in progress
- Final BE fixes verified (confirmed/reopened flags, NAMED_WRITE_SURFACES gate class fix, lookFirst routed
  into the probe planner as a first-round bias + mustChange now in the real prompt). Master: 33 suites,
  159+ per-suite assertions all green, exit 0.
- Live verify running on :3000 (Sonnet): packet-loss problem → ask-first → answer → investigation rounds
  live (Round 1: 3 new checks + findings). Awaiting repeated-round reflection + verdict split + lesson.

## 2026-08-20 ~23:30 — CW-11 SHIPPED ✅; DAY REVIEW PAGE DELIVERED
- Live verify on merged :3000 (Sonnet): packet-loss report → ask-first → 6 real rounds (each varied its
  checks — mustChange working) → honest cap stop ("stopping rather than claiming a false certainty").
  Nothing-new line verified in builder+reviewer live runs. Desk restarted on default Opus.
  Spend meter live: 19 calls, 26.8k in / 17.8k out, 59.2k cache-read today.
- Day review page for Vikas: https://claude.ai/code/artifact/19b4b194-39bd-48ee-8f2c-26c58f73449a
  (3 waves, 6 PRs, 14 review rounds, 33 suites green, hands-on script, CW-12 recommendation = vet first
  real external MCP server).
- Polish backlog logged: probe planner bare ping/traceroute asks; 2 LOW leftovers; lesson consult chip
  dark until first real lesson.

## 2026-08-20 ~23:50 — Vikas final feedback + Cursor handoff (HIS WORDS)
- NEW FEATURE RECORDED (CW-12, not built): "it should be showing who is typing, like when we type in
  whatsapp or in ms chat... showing that the question has been picked up, like by showing the emojis on
  the message... whenever jarvis or any agent is writing, it should be showing who is writing... so that
  it feels like the application is alive." Contract: docs/copilot-cw12-presence-contract.md.
- Vikas: weekly quota ~90% exhausted → STOPPING Claude Code builds; he will continue in CURSOR.
  HANDOFF.md fully rewritten as the deep-dive pickup doc (laws, wave process, complete built map, key
  files, NEXT queue, creds list, operational notes incl. how to disable the auto-resume task).
- Everything pushed. Nothing in flight. Desk live on :3000 (default Opus).

## 2026-09-05 — RESUMED in Claude Code (web) after a 16-day pause; project named + centralised
- Vikas: weekly quota reset; "pick the project, understand it, write it all down on GitHub, name it,
  then build". Session link pointed at the 2026-08-18 "CW-3 tickets" session (bridge on his PC).
- Located the project across GitHub: THIS repo (last commit 2026-08-20), predecessor mission-control,
  and node-one (separate project — a Managed-Agents control plane, NOT this one). No Cursor commits
  ever landed after the 08-20 handoff; nothing was in flight.
- NAMED: **Jarvis NOC Copilot** (repo stays noc-triage). PROJECT.md written as the one-page brief and
  linked from README/HANDOFF/docs/INDEX. package.json name drift (mission-control) fixed.
- FOUND: GitHub lists the repo PUBLIC while HANDOFF/README said private. Secret scan clean. Decision
  needed from Vikas (make private, or keep public knowingly).
- Environment: Claude Code web container — 33 suites green here (node 22). No ANTHROPIC_API_KEY and no
  DevNet reach in the container, so live-LLM/device verification stays on the PC; fixtures + suites +
  headless browser run here.
- NEXT: CW-12 Live Presence (contract docs/copilot-cw12-presence-contract.md) — building now.

## 2026-09-05 — CW-12 Live Presence BUILT (branch feat/cw12-presence → PR), review in flight
- One agent built both halves sequentially (cloud container, no parallel clones needed). Backend:
  sources/presence.js tracker + claude.js setActivityListener (start/stream/end of every model call, end
  from finally) + server.js wiring (thinking/typing, agent checking, approval waiting, picked-up receipt,
  clientMessageId echo, init snapshot). Frontend: createPresence/receiptHtml in the shared module; presence
  line + ticks on desk and classic; hidden when empty; socket drop clears; reload seeds from snapshot only.
- Tests: 35 suites green (new: presence.cw12 51 assertions incl. real SDK path on mock transport;
  desk.cw12.ui 89). Browser (headless Chromium, real server): no-key flow → picked-up + answered tick;
  fake-key + mock 401 (400ms hold) → "Jarvis is thinking…" visible in flight, done(error), line hidden,
  key never in a WS frame; fixtures, XSS, reload-ghost, socket-drop all held. Shots docs/shots/cw12-*.png.
- Bug caught by the browser pass, fixed before PR: desk.html's own hoisted `var CW9B` shadowed the
  module at the CW-12 block's position → use window.CW9B there (class: any block above that line must).
- Known/pre-existing, not this wave: 390px horizontal overflow (header name tag + capabilities drawer),
  identical with the line hidden or shown. Header badge still reads "COCKPIT · CW-3" (cosmetic, backlog).
- Not proven live here (needs Vikas's PC: real key + DevNet creds): streamed `typing` and agent
  `checking` — seams unit-proven, page path fixture-proven.
- Adversarial reviewer (different agent) launched against :3123 (no key) and :3124 (mock 401).

## 2026-09-05 — CW-12 review round 1: FIX-FIRST (1 HIGH, 3 MED, 3 LOW) → all fixed at class level
- HIGH "Answered ticks before anything is answered" (tick was inferred from ANY reply stamped with the
  requestId — "let me think…", narrowing questions, rosters, the @mention relay). FIX (class): the server
  now sends a one-shot `answered` receipt from the ONE seam that owns the request end (handler promise
  settled, server.js `settle`), the page ticks ONLY on that receipt, and holds it until a reply is on
  screen; a request that ended on kind:ask ticks REPLIED "needs your answer", never "Answered".
- MED "Sent ✓ survives a failed send" → NOT SENT ✕ on HTTP-refused / unreachable (desk).
- MED "mirror typing flight can strand" → noteDelta runs before the stream store can reject a piece,
  and the recorded message (same messageId) settles the mirror flight (both pages).
- MED "10-minute belt only on snapshot" → sweep on an unref'd 30s timer; age counts from the last
  re-state (`touched`) so long live work is never cut off; window 15 min.
- LOW multi-operator → classic ticks only ids THIS page minted (history / other operators: no tick).
- LOW background calls → flights with no requestId name their purpose ("Jarvis is thinking — lessons").
- LOW mobile shot → replaced with the Jarvis-tab shot at 390px.
- Verified: 35 suites green (presence.cw12 59, desk.cw12.ui 116); browser 34/34 on :3123 incl. the
  reviewer's repros (interim reply → still picked-up; ask → replied; stranded stream settles on the
  recorded message); live 18/18 on :3124 (mock 401). Re-review requested.

## 2026-09-05 — CW-12 review round 2: FIX-FIRST (1 HIGH residual, 3 LOW) → fixed
- HIGH residual: `settle()` trusted any handler return; ping / help (reply on a timer) and the
  clarification-resume path (fire-and-forget read) returned nothing, so "answered" fired ~480ms early.
  FIX (class): settle FAILS CLOSED (non-thenable → no receipt, never 'done'); the rule "every handler path
  returns a promise that resolves after its last reply" applied — ping/help return a Promise resolved
  inside their timer, resumeClarification/pickCandidate return the read's own promise (say-only branches
  return a resolved promise), maybeForget and write refusals wrapped at the call site, live.handle wraps
  its sync not-connected/cannot-answer lines. Pinned in presence.cw12.test (66) + browser ping timeline
  (answered never before the Pong, on screen and on the wire).
- LOW: "Replied — asked you a question" (a fact, not an instruction; the resume route is separate).
- LOW: NOT SENT / REPLIED survive a reload (facts); SENT / PICKED-UP still swept.
- Info: dev hooks guard null. Pre-existing canned "On it — querying…" line noted for a Law-1 cleanup.
- Verified: 35 suites exit 0; browser 37/37 (:3123) + 18/18 (:3124). Round-3 re-review requested.

## 2026-09-05 — CW-12 review round 3: VERDICT: APPROVE ✅ (1 LOW honest gap fixed pre-merge)
- Reviewer re-ran wire ordering on 8 paths (ping, help, Config-Keeper read, write refusal, unknown
  @mention, no-key decline, mock-401 failure) — answered always after the last reply and the flight's
  done; early-resolve audit of every handler path found nothing. Browser: Sent 82ms → Picked up 1569ms →
  still Picked up while "On it" shows → Answered only in the same sample as the Pong.
- LOW fixed: the "never mind" cancel branch of resumeClarification returned a bare `true` (fail-closed →
  bubble stuck at Picked up); now Promise.resolve(true) like its siblings, pinned in the test.
- Info (not this wave): simulateStandup/SquadStatus/WeeklyReport/showJarvisHelp are dead code (Law-1
  leftovers); canned "On it — querying…" relay line can land after the answer. Both → polish backlog.
- Merging PR #78 (merge commit, repo convention).

## 2026-09-05 — CW-12 SHIPPED ✅ (PR #78 merged to master as c723f57)
- Master: 35 suites green. HANDOFF built map + NEXT, PROJECT.md, PIPELINE, docs/INDEX updated.
- Live verify on the PC (real key, DevNet) still owed: streamed "typing", agent "checking", ask-mode
  "waiting for your approval". Everything else proven in the cloud (mock 401 + fixtures + suites).
- Cloud session ends here. Nothing in flight. Next pick is Vikas's (see HANDOFF NEXT).

## 2026-09-05 — Vikas's decisions (HIS WORDS) + product model correction
- Product = ONE product, TWO interfaces: "mission control will be the first interface … as soon as the user
  gets onboarded … noc triage will be the second interface … used whenever the user wants to use it".
  PROJECT.md corrected; mission-control code deliberately NOT read this session (his ask).
- Repo: "you can make it public only, just make sure there is no API key or anything publicly visible".
- Provider: "fully based on the Anthropic API key … keep it as it is … for timing. In the next iteration I
  really want you to plug in the other vendors like OpenAI and OpenCode, because there are many really
  cheap options … I really don't want to go with many heavy, expensive models at this moment."
- MCP: "https://github.com/automateyournetwork/netclaw — use this … leverage this repo behind the scenes
  rather than building it ourselves." → CW-13 = NetClaw.
- Frameworks: "leverage multiple frameworks … the Anthropic SDK, the Anthropic agent runtime framework, or
  the OpenAI framework. There is no point in building each and every thing … agent runtime, a frontend, a
  backend, a database layer … leverage the framework when it comes to agent runtime, orchestration or any
  other layer." → HANDOFF laws 9 + 10; PIPELINE decisions 6–9.
- Testing CW-12: he wants the app started so he can test — the cloud container cannot expose a port
  (proxy does not carry WebSocket upgrades), so the live eyeball stays on his PC (commands in PROJECT.md).

## 2026-09-05 — Polish P1 SHIPPED ✅ (PR #79 merged as 15b0727, 2 review rounds → APPROVE)
- Round 1 FIX-FIRST caught a real one: the ≤480px header rules sat BEFORE the .capbtn base rule (dead in
  the cascade; second gear stacked; avatar clipped off-screen at 320–390). Class fix: cascade order + real
  markup + unshrinkable controls + a written 320px budget, proven headless at 7 widths × 2 themes. Also:
  Jarvis-attributed "📨" relay bubble removed; bare @mention asks (law 2); watcher self-write skip +
  status validation. Round 2 APPROVE (1 LOW: the 3s self-write window is time-based).
- Public-repo guard (secrets.public.test.js) wired into npm test → 37 suites.
- Vikas (mid-session, quota reset): keep building whether he is there or not; park anything needing him;
  where to test = his PC at http://localhost:3000/desk.html after git pull.

## 2026-09-05 — CW-14 contract pinned (runtime adoption); CW-13 round-2 review running
- Vikas (his words): NetClaw = the reference LIBRARY of ready-made integrations, not "an MCP server";
  frameworks for runtime/orchestration — "I really don't want to make that mistake again".
- CW-14 pick: OpenAI Agents SDK (JS, @openai/agents 0.17) + @openai/agents-extensions `aisdk` adapter →
  model from Vercel AI SDK providers (Anthropic today via @ai-sdk/anthropic, OpenAI/OpenRouter next).
  Alternatives weighed in the contract (Vercel-only fallback; Anthropic Tool Runner / Claude Agent SDK /
  Managed Agents rejected against decision 7). Stage A = spike behind JARVIS_RUNTIME=agents with the 4
  flagship behaviours as the bar; laws + WS wire unchanged. Vikas can veto in one word.
- CW-13 round 1 FIX-FIRST (3 HIGH: child inherited the whole parent env; stderr leaked into status;
  unpinned vetting) → fixed at class level (env boundary, redaction, toolNames + sha256 pin + pinned
  NetClaw commit, strict annotations, honest truncation, real live names). 38 suites green. Round 2 running.

## 2026-09-05 — CW-14 spike: 12/12 offline (test/cw14-runtime-spike.mjs)
- OpenAI Agents SDK 0.17 + aisdk adapter + @ai-sdk/anthropic against a mock Anthropic transport: tool loop,
  handoff (Jarvis → Router-Expert), approval interrupt before a write tool (= our gate seam, zero wire),
  the REAL NetClaw catc-mcp spawned as MCP tools (10 listed, catc_find answered), streamed deltas, usage.
  Every risk the contract named is retired; stage A build launched in its own clone (builder agent),
  branch feat/cw14-runtime-a, behind JARVIS_RUNTIME=agents.

## 2026-09-05 — CW-13 SHIPPED ✅ (PR #80 merged as 873cb31, 3 review rounds → APPROVE)
- Round 2 caught two more real ones: the redactor wiped the appliance hostname/username out of results
  (evidence corrupted, e.g. "adminStatus"); the byte-exact pin would void itself on Windows (autocrlf).
  Class fixes: secrecy by NAME + opt-in, token-bounded redaction, LF-normalised pin on the first script in
  args, malformed sha = drift, autocrlf-safe scripts. Round 3 APPROVE; 3 of 5 leftovers folded in pre-merge
  (escaped secret forms, interpreter-flag pin target, wider name rule + opt-in validation + pin how-to).
- Master: 38 suites green. Needs Vikas on the PC: scripts/netclaw-setup.ps1 + enable netclaw-catc, then
  "what does Catalyst Center say about sw1's compliance?" with the real key.
- In flight: CW-14 stage A (builder agent, own clone). Next pick for Vikas: CW-13b server order; CW-14 veto.

## 2026-09-05 — CW-14 stage A SHIPPED ✅ (PR #81 merged as a8834cc, 2 review rounds → APPROVE)
- Jarvis on an ADOPTED runtime (OpenAI Agents SDK 0.17 + aisdk adapter + @ai-sdk/anthropic) behind
  `JARVIS_RUNTIME=agents`, default legacy. Same conduct gate first, same envelope / say_delta / presence on
  the wire through the identical jarvisCtx; tools = our gate-wrapped reads only; MCP writes pause + reject.
- Round 1 (different agent; it hit its quota before a verdict — findings lifted from its transcript) found
  7 real ones, all HIGH/MED: the SDK's tracing exporter posting spans to OpenAI when OPENAI_API_KEY is set;
  a hung model call never aborted; spend double-counted on a pause/resume; "@NetOps —" line + status flip
  before argument validation with SDK boilerplate reaching the model; an engineer reading as another
  engineer and answering as Jarvis; max_tokens 128000 + no caching; raw key in a cache signature. Class
  fixes in 22f3634 (+22 checks). Round 2 (different agent) APPROVE with live proof on two servers; its two
  non-blocking leftovers folded in pre-merge (unknown tool → honest result to the model, run continues;
  key-shaped tokens scrubbed from provider error bodies). 41 suites green; runtime suite 93/93 ×3.
- Process note: `pkill -f` on a pattern that appears in your own shell's command line kills the shell
  (exit 144) — kill by pid from `pgrep -f "^node …"`. The public-repo guard caught a key-shaped test
  fixture of mine before it reached master (fixed: `sk-ant-fake-not-real-…`).
- Needs Vikas on the PC (one sitting): pull master, npm install, restart; eyeball CW-12; try
  `JARVIS_RUNTIME=agents` with the real key (watch for a 400 on top-level cache_control); NetClaw setup.
- Next: CW-14 stage B (parity + cut-over) unless Vikas vetoes the pick; CW-13b once he orders the servers.
