# PIPELINE — Jarvis NOC Copilot mode

**The ask (Vikas's words, 2026-08-17):** "anyone comes in and access the noc-triage and ask any
question related to network and jarvis should be able to answer — it could be running commands /
doing checks, doing changes taking pre/ post/ compare/ config validations/ deviations, getting on
BL, investigating the issue with teams, handling tickets, or it could be anything related to
noc-soc operations."

Existing product: the triage console (waves process, see HANDOFF.md). This pipeline covers the
COPILOT expansion only. Three build agents are in flight on other features (CLI routing fix,
Wave 4 correlation backend, SSH sidecar) — they land under the existing wave process, not here.

## Stage scoreboard

| # | Stage | Status | Artifact |
|---|-------|--------|----------|
| 0 | Intake + scoreboard | DONE 2026-08-17 | this file |
| 1 | Unknowns (blindspot pass, 1 Q/message) | DONE 2026-08-17 (5 Qs answered; 3 items resolved by rec) | answers ledger below |
| 2 | Requirements (PRD, measurable bars) | **GATE 1 APPROVED** (Vikas 2026-08-17: all 8 abilities LIKED, no changes) | https://claude.ai/code/artifact/6cac1f65-0135-44ed-8aad-d1d6d1faa4e6 |
| 3 | Mocks (2–4 clickable directions) | **GATE 2 APPROVED — DIRECTION C (cockpit)** (Vikas 2026-08-17). A's command-bar can layer on later. | A: https://claude.ai/code/artifact/aa326803-34e8-4a26-accc-3c7e65b0534e · B: https://claude.ai/code/artifact/da36930a-e48f-42c6-b45d-e80ef2c0dc36 · C: https://claude.ai/code/artifact/ca5748c2-0ce0-499f-8e3e-292f5ba2e702 |
| 4 | System design + plan | **GATE 3 APPROVED — GREEN LIGHT** (Vikas 2026-08-17: all 10 blocks LIKED). Copilot = new desk view INSIDE noc-triage, classic console untouched. | docs/copilot-design.md · https://claude.ai/code/artifact/01462d72-6177-4506-99dc-1a09c625880d |
| 5 | Build (wave process, worklaw) | IN PROGRESS — CW-1 building (backend + UI agents to pinned contract) | docs/copilot-cw1-contract.md |
| 6 | Review (plan-vs-built audit) | not started | |
| 7 | QA (stranger test + log sweep) | not started | |
| 8 | Ship | not started | → HARD GATE 4 |
| 9 | Learn | not started | |

## Open questions (asked one at a time)

| # | Question | Recommendation | Answer |
|---|----------|----------------|--------|
| 1 | Do we relax the read-only law so Jarvis can make config CHANGES (pre/post/compare/rollback), and under what gate? | Yes, sandbox-only + per-change approval | **FULL CHANGE ACCESS** (Vikas, 2026-08-17, overrode rec) — changes allowed wherever Jarvis has a path, gated by the existing auto/ask/deny permission mode; mandatory pre-capture, post-capture, diff, and rollback artifact on EVERY change |
| 2 | Who uses it — access model? | Shared access + operator name, no SSO in v1 | **OPEN + NAME TAG** (Vikas, 2026-08-17) — no logins in v1; every action/question/change stamped with the operator's name; SSO/RBAC later |
| 3 | "Getting on BL / investigating with teams" — what does that mean physically in v1? | In-app bridge room (existing bridges + roles), no external chat/voice yet | **IN-APP ROOM + REAL CHAT INTEGRATION** (Vikas, 2026-08-17) — multi-person named bridge in-app, plus Jarvis posts/reads a real chat channel; voice parked |
| 4 | Which chat platform for the bridge integration? | Telegram (bot already exists on this machine) | **MICROSOFT TEAMS** (Vikas, 2026-08-17, overrode rec) — needs a Teams webhook/bot registration from his M365 tenant; build the integration + honest "not connected" state until he supplies it |
| 5 | Ticket handling scope — is ServiceNow (Wave 6) the ticket surface? | Yes; copilot adds conversational create/update/close on top of Wave 6, no internal queue system | **BUILT-IN TICKET QUEUE + ServiceNow sync** (Vikas, 2026-08-17, overrode rec). Design law to avoid two truths: the INTERNAL queue is the single source of truth; ServiceNow is a mirror that syncs when connected. |

### Stage-1 items resolved by recommendation (approve/veto at Gate 1, not re-asked)
- Capability honesty: Jarvis keeps a live capability map; anything outside it gets an explicit
  "I can't do that yet — here's what I can do" (class rule, covers all unknown asks).
- Validation/deviation gold standard: the baseline snapshots in config-store (operator can re-baseline).
- Success bars: proposed as numbers in the PRD (Gate 1 page).

## Known blindspots to cover in stage 1 (queue, not yet asked)
- Who are the users? (just Vikas today vs real eng/SME logins → RBAC/SSO scope)
- "Getting on BL / investigating with teams" — what does that physically mean in v1 (bridge page in-app vs real chat/voice integration)?
- Tickets: is Wave 6 ServiceNow the ticket surface, or more (assignment, queues)?
- Capability honesty: what Jarvis says when asked something it can't do yet
- Config validation/deviation: against what gold standard? (baseline snapshots exist in config-store)
- Success bar as a number (e.g. % of a sample question list answered/actioned correctly)

## Deviations
(none yet)
