# CW-7 pinned contract — Iterative investigation loop

Jarvis stops being one-shot. It GRILLS the problem to understand it, then runs a probe→report→narrow
loop with the right agents until the root cause is isolated, then plans the fix. Termination model
(Vikas 2026-08-18): CONFIDENCE + SAFETY CAP.

## Split
- BACKEND owns: sources/investigation.js (new — the loop engine), the reasoning hooks in sources/jarvis.js
  (probe-planning + narrowing prompts), investigation routes + capabilities in server.js (block adjacent to
  CW-6's), audit. Reuse live-agents delegation + the permission gate + triage evidence — do NOT duplicate them.
  NOT public/*.
- UI owns: public/desk.html — the live investigation thread (rounds, shrinking hypotheses, confidence,
  root cause, proposed fix). NOT server/sources.

## The loop (investigation.js orchestrates; jarvis.js does the reasoning)
1. UNDERSTAND / GRILL: given a problem statement, Jarvis assesses if it's specific enough to investigate.
   If AMBIGUOUS (vague symptom, no scope/timeframe/target) → it asks the OPERATOR pointed clarifying
   questions to narrow it (ties to the ambiguity-ask law) and WAITS — does not investigate a guess. Once
   clear (or the operator answers), it states the understood problem + initial hypotheses.
2. PROBE LOOP (each round):
   a. Jarvis picks the HIGHEST-VALUE UNKNOWN — the check that would most narrow the current hypothesis set.
   b. It delegates a SPECIFIC read-only probe to the RIGHT agent ("Config-Keeper: show ip int brief on sw2",
      "Monitor-Eye: any interface-error alarms on the fabric since 2pm?"). Probes are read-only → auto-run
      under the EXISTING permission gate (deny still = zero wire, never bypass it). Reuse the CLI/read path.
   c. The agent reports back; Jarvis updates the hypothesis set (eliminates/confirms) + a confidence score.
   d. TERMINATION (confidence + safety cap):
      - confidence ≥ threshold (root cause isolated) → STOP, go to step 3.
      - round count ≥ CAP (env INVESTIGATION_MAX_ROUNDS, default 6) → STOP, report the best-supported
        hypothesis + what's still unknown, honestly (not a false certainty).
      - STUCK (no probe would narrow further / needs something unavailable) → STOP, say exactly what it
        needs (a device it can't reach, an operator input, creds) — honest, never fabricate a conclusion.
   e. else → next round.
3. PLAN THE FIX: on an isolated root cause, Jarvis composes a fix PLAN grounded in the evidence gathered.
   If the fix is a config change, it produces a change PROPOSAL routed through the CW-2 change engine
   (approve-first wrap) — it never applies directly. If the fix is manual/external, it's a clear plan.

## Laws (absolute)
- NEVER fabricate a probe result or a root cause — every narrowing step cites the real agent report it came
  from; an unproven hypothesis stays labelled unproven with its confidence.
- Read-only probes only in the loop; the write guardrail + permission gate are unchanged and reused (deny =
  zero wire). The loop cannot escalate privilege.
- Bounded: the round cap is a hard stop; the loop can never run away. Every round + probe + report is
  audited {who, round, probe, agent, result, confidence}.
- Intent-first: Jarvis decides the next probe from reasoning over the evidence — NOT a keyword/decision-tree
  table. No hardcoded "if symptom X then check Y" mapping; the LLM plans each probe. Deterministic code only
  orchestrates the loop (counting rounds, enforcing the cap/gate), never picks the probe.
- Honest under a dead LLM: if reasoning is unavailable (no credits), the loop says so and stops — never a
  canned investigation.

## Routes
- POST /api/copilot/investigate { problem, operatorTz? } (operator-named) → 202 `{ investigation, watch }`
  (the record is under `investigation`, NOT top-level `id`; read `investigation.id`).
- PINNED SHAPES (the UI reads EXACTLY these — do not drift; this closes the CW-7 field-drift class):
  - WS `investigation_update` = full record: `{id, problem, understood, status, questions[] (PLURAL —
    array of clarifying-question strings), answers[], hypotheses[{id,text,status}], confidence, rounds[],
    rootCause, fixPlan{summary, proposal?}, stuckReason, cap, threshold}`. status ∈ starting/awaiting-operator/
    investigating/resolved/capped/stuck/blocked/reasoning-unavailable.
  - WS `investigation_round` = `{id, round, probe:{agentId,agentName,question,device,rationale} (OBJECT —
    render probe.question + probe.agentName, not the object), agent, report:{agentName,stance,text} (OBJECT —
    render report.text), hypotheses[], confidence, status}`.
  - `fixPlan` = `{summary (string), proposal?:{device,commands[],reason,route:"POST /api/copilot/change"}}` —
    render summary as text; if proposal present, show a CW-2 approve button POSTing to proposal.route.
  The UI must render probe/report/fixPlan from their OBJECT fields (never stringify the object), read the
  clarifying questions from `questions[]` (plural), and read the new id from `res.investigation.id`.
- POST /api/copilot/investigate/:id/answer { text } → the operator's answer to a grill/clarifying question,
  resumes the loop.
- GET /api/copilot/investigate/:id → full record (problem, rounds, root cause, fix plan/proposal, status).
- capabilities: `investigate` becomes the loop (it currently exists as a one-shot ability — upgrade its
  behaviour; keep available:true; example "why is branch-3 slow since 2pm — investigate it").

## UI (desk investigation thread)
- A live thread: the understood problem, each round as a card (the probe asked, which agent, its real report,
  the hypotheses now standing + which were eliminated, the confidence bar climbing), an operator clarifying-
  question prompt when Jarvis grills (answer inline → resumes), and the final ROOT CAUSE + FIX PLAN (with the
  change proposal's approve button when it's a config fix). Honest "stuck — needs X" and "hit the round cap"
  states. XSS-escape every sink; both themes; mobile.

## Verify (deterministic now; live-LLM loop pending credits — mark clearly)
With the reasoning STUBBED (inject a scripted planner so the loop is testable without credits): a scripted
scenario runs N rounds, narrows a hypothesis set, hits the confidence stop → root cause + fix plan; a
scenario that never narrows → hits the round CAP and reports honestly; an ambiguous problem → grills the
operator and WAITS (no probe fired) until answered; deny mode → probes don't run (zero wire); every round
audited; no fabricated result. With a DEAD key → honest "reasoning unavailable, stopped." Full suite green +
new investigation tests. The real multi-round LLM investigation is the end-to-end test once credits return.
