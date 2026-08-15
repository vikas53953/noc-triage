# OVERNIGHT GOAL — NOC Console v2 (autonomous build 2026-08-15 → morning)

Vikas approved the v2 spec (all blocks liked) and left for the day. Build this to
completion overnight, fully autonomous. Treat it as THE goal. Do not fake anything.
He reviews in the morning. Spec page: https://claude.ai/code/artifact/8aa8a643-d08d-4cea-a0aa-ea564fe351fe

## The product (approved)
Turn the read-only Evidence Split Console (already the app's look, on master) into a
REAL interactive agentic NOC where the user is a PARTICIPANT, not a spectator, and an
engineer can see EVERYTHING — the actual CLI session (login + commands + raw device
output/logs) and the reasoning that makes sense of it, the way a real SME/Principal
Engineer works. No simulation, no fabricated data or capability.

## Non-negotiable rules (inherited)
- Real live reads only; a source that's down shows "suspect" with the real error.
- Read-only device access enforced by guardrails; refusals spoken.
- No agent answers a question it can't; capability = verb AND subject.
- Every user/server string escaped in the DOM. Rate limits, origin checks intact.
- 127.0.0.1 bind. .env.local never committed.

## Build phases (sequential — server.js + public/index.html are shared, so ONE build
## agent per phase, then a DIFFERENT agent reviews, then integrate, then next phase)

- [x] PHASE A — INTERACTIVE + bug fix  (DONE — merged to master 2f87b02, reviewed MERGE)
      - Fix "stuck on bridge": agents return to idle the moment a triage closes (root cause
        in sources/triage.js runBridge finally — make it per-triage, not global roster).
      - User can message ANY agent directly and get a real live-data answer (or honest can't-answer).
      - User can POST into an open triage bridge (add context / direct an engineer); it appears
        in the bridge and the flow reacts.
- [x] PHASE B — ENGINEER SEES EVERYTHING (the CLI/logs view) + ACI retry  (DONE — merged, reviewed MERGE; secret-scrub fix for usernames)
      - A real CLI/session view: show the actual login + each command run + its RAW device
        output (the real reads), per agent, plus the agent's interpretation alongside — like
        reading logs at the CLI. This is the heart of "how an SME thinks". Watchtower law.
      - ACI (and any down source): a "retry / manage" control in the UI to re-attempt the
        connection/read from a down front, surfacing the real result.
- [ ] PHASE C — REAL PERMISSION GATE
      - Before an agent runs a command it ASKS; user approves once / approves all reads for
        this triage / denies. Default per spec (Vikas liked it): auto-approve safe reads with a
        visible scrollable approval log; still only read-only commands are ever offered.
- [ ] PHASE D — ARTIFACTS + DOCUMENTATION folders
      - Per-triage ARTIFACTS: full timeline, every command + raw output, evidence-board history,
        verdict — browsable after the fact.
      - Per-triage DOCUMENTATION auto-written: an SLT/leadership plain-words summary AND an
        engineer-technical writeup; both saved and browsable by anyone.
- [ ] PHASE E — JARVIS AGENTIC DELEGATION (gated on Vikas's API-key answer)
      - Talk to Jarvis in plain words; Jarvis reasons about WHO to delegate to, hands each
        agent its piece, gathers findings, answers. Real reasoning.
      - DECISION (Vikas, 2026-08-15 as he left): REAL CLAUDE API. No rule-router.
      - KEY STATUS: no Anthropic key found on the machine (checked env, both .env.local files,
        Windows Credential Manager, claude settings — presence only, value never logged).
        So: BUILD the genuine Anthropic integration (Jarvis reasons/delegates via a real Claude
        call), reading ANTHROPIC_API_KEY from .env.local; use the `claude-api` skill for correct
        model id + SDK; key never in code/logs. It can be built + code-reviewed but NOT run live
        until Vikas adds the key. When the key is ABSENT, the UI shows an honest "Jarvis needs
        your API key to think" state — NEVER a rule-router pretending to be reasoning. Activating
        the key turns real Jarvis on. Flag this prominently on the morning page.
      - LLM integration: read the `claude-api` skill BEFORE writing any Claude call. Key in OS
        keychain / gitignored .env.local, never in code or logs.
- [ ] FINAL — integration review of the whole thing live + a visual "what I built overnight"
      page for Vikas (writeable, feedback layer) with TEST IT steps and honest what's-done/what's-not.

## Process (unattended-safe)
- One build agent per phase (owns server.js + public/index.html for that phase), then a
  DIFFERENT agent reviews live with fresh evidence, fix if blockers, then merge to master.
- Worktree isolation has been flaky here → build agents run in the MAIN checkout on a
  feature branch (git checkout -b), return to master at the end; reviewers read-only.
- Each phase merged to master before the next starts (shared files → no parallel same-file work).
- After each merge, tick this file and commit it, so a resume after any quota gap knows where it is.
- Quota/limit gap: if agents fail due to usage limits, resume when capacity returns and keep going.

## Status log (append as phases complete)
- 2026-08-15 eve: goal set; console-app look merged to master (foundation); Phase A starting.
- 2026-08-15 ~21:xx: Phase A merged (interactive: message any agent, operator posts into bridge; stuck-on-bridge fixed). Reviewed MERGE, live-verified. Phase B starting.
- 2026-08-15 ~23:xx: Phase B merged (real CLI/session log with actual command+raw output+SME interpretation; real ACI retry; username-scrub fix). Reviewed MERGE. Phase C starting.
