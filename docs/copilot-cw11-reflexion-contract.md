# CW-11 — Reflexion (Jarvis checks its own work) — PINNED CONTRACT

Vikas approved all four parts + guardrails + sequencing 2026-08-20 (design page
https://claude.ai/code/artifact/6dc0bf4f-ebb1-4943-8ccb-e79672bb41a0 — every section LIKED). His words:
"reflexion is the most important thing when it comes to the networking kind of stuff wherein it is going
to reflect on its own work. if there is any problem with what it is doing, it automatically gets reflected."

SEQUENCE: build AFTER CW-9 fix cycles merge + live-verify, and AFTER CW-10 production plumbing
(official Anthropic SDK + prompt caching + streaming + token accounting — approved same day).
All laws in HANDOFF.md apply; CW-9's conduct layer (sources/conduct.js) and envelope are the substrate.

## Part 1 — Round reflection
After each investigation round, compare the round's evidence set against prior rounds. Nothing new →
Jarvis says so honestly in one short line and changes approach (different check/agent/system), never
narrates fake progress. Builds directly on the PR #73 fix "narration composed from per-round evidence
diffs" — this part formalizes the change-approach step.

## Part 2 — Verdict self-check
Before committing a verdict: one bounded pass that traces EVERY claim to a specific evidence record from
THIS incident (per-delegation-tagged records from the PR #73 fix). Unsupported claim → downgraded to
"suspected — unverified" or dropped; the verdict card shows verified vs suspected separately. Second lock
on never-fabricate.

## Part 3 — Prediction follow-through
Verdicts already carry if/then + confidence. After a change is applied (via the CW-2 engine, approval
gate unchanged), Jarvis runs the check that should prove the "then". Prediction holds → verdict confirmed,
one line. Prediction fails → Jarvis states plainly the hypothesis was wrong, reopens the investigation
carrying the falsified hypothesis as context, and continues (never closes on hope). Where no write path
exists (observer sandbox), offer the follow-through check for the OPERATOR to trigger after their manual
fix — honest about why it can't apply the change itself.

## Part 4 — Lessons memory
On incident close: write one short lesson file (squad/lessons/<INC-id>.md): cause, which check found it
fastest, what wasted time, symptom keywords. On new triage/bridge: consult lessons for similar symptoms
(LLM judges similarity — no keyword matching per intent-first law) and say so ("similar to INC-…, checking
X first"). Desk gets a small Lessons panel (list + delete). Lessons are scrubbed like all persisted data.

## Guardrails (pinned — reviewers must verify these)
- BOUNDED: exactly one reflection pass per round and one per verdict. No loops.
- EVIDENCE-GROUNDED: reflection compares claims to real records; it never creates a claim without a read.
- SILENT WHEN CLEAN: no gap found → no extra chat message.
- LESSONS ARE FACTS NOT RULES: a lesson biases where to look first; it never bypasses the ask-first gate,
  never auto-runs anything, never overrides ambiguity law.

## Process
Same as every wave: backend/UI split against this contract, own clones, PRs, DIFFERENT-agent adversarial
review with operator-experience pass (key probes: identical-evidence rounds, unsupported verdict claim,
failed prediction, second incident with a similar symptom), merge, restart :3000, live verify, evidence
page to Vikas. Live-LLM tests on claude-sonnet-5 (spend-wise).
