# QA findings spec — noc-triage live-app audit (2026-08-17)

Source: 5 parallel QA persona agents on the LIVE app (intent-probing, code+honesty wire-up, adversarial,
senior-operator, stranger-UI). ~120 live interactions. **Zero fabrications found** — every wrong answer
was a wrong target or a wrong refusal, always disclosed. **Every safety law held under direct attack**
(no write reached the wire; deny ran nothing; no secret/traversal). The problems are a deterministic
shell around a genuinely good LLM brain. Fix by CLASS, one reviewed PR each, operator-experience pass on
every review. Static-binding + ambiguity laws in HANDOFF.md govern all of this.

## THE ROOT CAUSE (one sentence)
A layer of hardcoded keyword/phrase logic sits IN FRONT OF and AROUND the real intent planner and
*answers, refuses, or picks a device* before intent runs — the exact thing the "no static bindings" law
forbids. Deterministic code must only ever REFUSE-FOR-SAFETY; never classify, answer, or route.

---

## CLASS 1 — Kill the deterministic answer/route shell (BLOCKER, biggest)
The planner (jarvis.js) is correct when it runs. These intercept before/around it and must be removed or
demoted to the planner:
- **Phrase table answers real questions** (server.js ~1025-1137, dispatched ~1162): "good morning, sw1 is
  dropping packets" → **daily standup**; "brief me on the wan outage" → standup; "how did we do on the
  upgrade" → **weekly report**; "hey jarvis" → canned Pong. REMOVE the phrase dispatcher; these go to the planner.
- **Capability gate over-refuses reads** (capabilities.js checkAsk, ~239): "copy the running config off sw1"
  → "change not wired"; "update me on the ticket status" → "tickets not wired"; "give me a handover summary"
  → out-of-scope (bridge advertises handover); "check if the fabric is clean" → "drift not wired" (keyword
  `clean`), while "is the fabric healthy?" answers perfectly. FIX: the gate may refuse ONLY an unambiguous
  imperative request to PERFORM an unbuilt ability; anything a question/read → pass through to the planner.
- **Keyword substitutes a different read** (NO_STORE): "run show running-config on sw2 to snapshot it" →
  returned inventory/version instead; the command never ran. REMOVE.
- **Keyword forces a source** (ACI_WORDS): a delegated ask for vManage overlay + ACI came back APIC-only. REMOVE.
- **Dead intent table** (server.js ~842-901): 9 intents computed, 3 used — delete the dead branches.
- Minors: canned "🏓 Pong" on the word `ping`; "reasoning model declined" shown after a device really was read.
**Fix:** deterministic layer refuses writes only; ALL interpretation/answering/routing flows through the
LLM planner over the capability roster. Verify with every sentence above → reaches real reasoning.

## CLASS 2 — Ambiguity asks + device targeting from intent, not regex (BLOCKER)
(Overlaps the in-flight fix/ambiguous-device-asks branch — fold these in.)
- **Unnamed/ambiguous target runs anyway** (live-agents.js resolveTargetDevice ~526: "first reachable"
  default; jarvis plan schema has NO clarify option): "show version" / "sw" / "swl" / "10.10.20.99" /
  "the switch with the problem" → ran on sw1, never asked. FIX: plan schema gains a CLARIFY action;
  ambiguous/none/multi-candidate → ask, listing real inventory; auto-run only on a unique match.
- **Named device dropped by regex** (live-agents.js DEVICE_MENTION ~459, over the planner's REWORDED text):
  "show version on sw2" hit sw1 because the planner said "on the switch named sw2" and the regex needs a
  preposition+digit token. FIX: device identity comes from the planner's STRUCTURED output (it knows the
  device), never a regex over its prose. This is the durable fix for PR #38's fragility.
- **No conversation memory** (jarvis.js passes only the current question): "show version on sw2" → "now its
  uptime?" answered sw1. FIX: per-session/triage context remembers the resolved device until changed.

## CLASS 3 — Triage intake must understand, not bounce (BLOCKER)
Plain-words incidents (how they actually arrive) get 422: "branch 3 users report slow internet since 2pm",
"users can't reach the file server", "voice calls breaking up", "finance can't reach payroll from Pune" →
all rejected "re-file it". The SAME sentence in Jarvis chat is handled beautifully — the console
contradicts itself. FIX: intake routes through the same intent understanding; ambiguous → ask which
site/front (ambiguity law), never reject the operator.

## CLASS 4 — Guardrail must judge the command, not English words (MAJOR)
Write-refusal trips on ordinary words in prose: the planner's own "if **no** target was named" →
`Refused — "no"`; unit-confirmed "no rush", "no more", "clear it up", "copy the report" refuse. (Real
writes still correctly refused — this is false-positive only.) FIX: the write blacklist matches command
verbs in command position, not any substring in free text; keep the class-based real-write refusal intact.

## CLASS 5 — Error & permission-gate hardening (MEDIUM)
- **Gate fails OPEN** (approvals.js `m === 'ask' ? 'ask' : 'auto'`): POST mode "deny"/"lockdown"/garbage →
  silently returns `auto` (least safe) with 200, while HANDOFF + /api/capabilities advertise a "deny" mode.
  FIX: implement a real global deny/lockdown; unknown value → safest state (deny) + error, never auto.
- **Stack-trace leaks**: `{"command":12345}` → HTTP 500 full trace w/ absolute paths (server.js ~642, no
  type guard); malformed JSON → verbose body-parser trace. FIX: type-guard inputs + one global Express
  error handler returning a clean message.

## CLASS 6 — Silent dropped turns (BLOCKER, reliability)
"show ip int brief on sw2" and follow-ups: plan emitted, Config-Keeper tasked, then NOTHING (2 of 3 runs) —
no output, no error, no denial. A copilot that silently ignores you is worse than none. FIX: trace the
delegation→execution→broadcast path; every tasked read must return output, an error, or an honest denial.

## CLASS 7 — Smaller correctness/UX (MAJOR/MINOR)
- Unknown alert severity → silently **P3** (lowest, loosest SLA): "catastrophic" → P3. FIX: unknown → highest or ask.
- `plan.note` sliced at 400 chars (jarvis.js:202) truncates "what can you do" and every plan rationale mid-sentence.
- "what can you do?" is framed as a FAILURE rather than an honest capability list.
- Prose sent as CLI: "ping toward the data center" → `% Invalid input` on a real switch (should be intent, not literal).
- P3 bridge auto-closed ~40s in, then rejected the operator's note.
- "who's on this incident?" → "nothing can see human assignment" though bridge roles are built & exposed.

## CLASS 9 — Siloed brains: Jarvis can't see the app's own state (BLOCKER)
- Jarvis chat cannot see incidents THIS app minted: asked about INC-20260817-013 (in /api/incidents with
  a full verdict) → "I have no record… it's not wired into me today." Chat brain and triage brain are
  separate silos. A shift handover ask is refused while the capability card advertises "the handover
  write-up". FIX: give the chat planner read access to the app's own incidents/verdicts/roles so it can
  answer about, hand over, and continue real incidents. This is the backbone of the copilot vision.
- One GLOBAL jarvis session: a second operator's questions land in another's context (seen live). FIX:
  per-operator/per-conversation session isolation (ties to CW-1's name identity).

## CLASS 10 — Output accuracy of the generated docs (MAJOR)
- Leadership doc CONTRADICTS the engine: omits hypothesis/confidence/next-steps and says "what broke:
  license-not-synced (83, chronic)" — the opposite of the engine's own "chronic, not the cause" verdict.
  FIX: the leadership doc is generated FROM the committed verdict (hypothesis, confidence, next steps), not
  a separate alarm scrape.
- GET /doc/leadership 404s (the stored key is `slt`); dual-clock (not raw UTC) in docs; ServiceNow export
  listed ACI tenants True_Test/PROD as affected CIs on a WAN ticket (wrong scope).

## CLASS 8 — UI stranger-sweep (pending 5th agent; fold in on arrival)
Known so far: agent-roster names truncate ("Moni...", "Net...", "Inciden..."). Full button/tab/mobile/theme
/persistence sweep completing.

---

## Fix sequencing (autonomous)
1. CLASS 2 (ambiguity/targeting) — branch already in flight; extend to structured-output device + memory.
2. CLASS 1 (kill the shell) — the big one; largest behavior win; do after CLASS 2 so targeting is solid first.
3. CLASS 3 (intake) + CLASS 4 (guardrail homonyms) — same "understand not keyword" family, can pair.
4. CLASS 5 (error/gate) + CLASS 6 (dropped turns) — hardening; CLASS 6 is a blocker, prioritize with 1.
5. CLASS 7 minors — batch. CLASS 8 — after the sweep lands.
Each: builder in own clone → adversarial review WITH operator-experience pass → merge → live-verify → TRACKER++.
