# What each document here is for

One line per file: its plain-words role, and whether it still describes the
world as it is (**current**) or is a record of something finished (**historical**).

Two rules for reading anything in this folder:

- **[`../HANDOFF.md`](../HANDOFF.md) is the source of truth for what is built.**
- **[`../PIPELINE.md`](../PIPELINE.md) is the source of truth for the Jarvis
  Copilot expansion.** Where a spec below disagrees with those two, they win.

*Jargon note: a "contract" file here is an agreement pinned before building, so
two people (or two AI agents) can build the two halves of a feature at the same
time without stepping on each other.*

## Contracts — the agreed seam between the back end and the screen

| File | What it is for | State |
|---|---|---|
| [`triage-contract.md`](triage-contract.md) | The agreed shape of triage: which web addresses exist and which live messages the server pushes to the browser during a bridge. | **Current** — describes the shipped triage. |
| [`transparency-contract.md`](transparency-contract.md) | The agreed way the console shows what each agent is doing, so a watcher can follow every step. | **Historical** — the bugs it lists ("roster stuck idle", "Live Activity blank") were fixed and merged. Keep it as the shape of the live-message events, read the bug list as a past state. |
| [`copilot-cw1-contract.md`](copilot-cw1-contract.md) | The pinned split for the first Copilot build wave: operator name tag, the capability map, and the new cockpit screen. | **Planned, not built.** Nothing it names exists in the repo yet — no `public/desk.html`, no `sources/capabilities.js`. It also refers to an SSH registry from PR #40; HANDOFF lists the SSH sidecar as still upcoming. Treat as a build order, not a description. |

## Specs — what a piece of work had to achieve

| File | What it is for | State |
|---|---|---|
| [`copilot-design.md`](copilot-design.md) | The system design for the Jarvis NOC Copilot: every part, chosen or skipped, with the reason. | **Current plan, not yet built.** PIPELINE.md has it at Gate 3, awaiting a green light. Note it plans a change engine that can write to devices — today's console is read-only. |
| [`triage-intelligence-spec.md`](triage-intelligence-spec.md) | The seven gaps that turned the console from a health poll into real diagnosis (use the symptom, baselines, alarm grouping, config diffs, ranked blind spots, a committed hypothesis). | **Historical — delivered.** HANDOFF lists all seven as built and merged. Useful as the "why" behind the triage brain. |
| [`roadmap-build-spec.md`](roadmap-build-spec.md) | The build order for the six roadmap features Vikas picked. | **Mostly delivered.** Waves 1–4 are merged per HANDOFF; change-context and two-way ServiceNow are still ahead. ⚠️ **Out of date in one place:** it says "Anthropic credits EXHAUSTED" — HANDOFF records them topped up on 2026-08-17, so Jarvis reasoning is live. |
| [`qa-bugs-spec.md`](qa-bugs-spec.md) | Every bug found in the full end-to-end QA sweep, ranked by severity, with how each was reproduced. | **Historical — cleared.** GOAL.md records all majors and minors fixed and merged. Read it as the record of what was checked, not an open list. |
| [`chat-ux-spec.md`](chat-ux-spec.md) | Exactly how the chat should look and behave (right/left bubbles, chevron-only collapse, no echo receipts). | **Historical — delivered.** The "OBSERVED" halves describe the old broken state; the "REQUIRED" halves are what shipped. |

## Not in this folder, but worth knowing

| File | Role | State |
|---|---|---|
| [`../README.md`](../README.md) | What the app is, how to run it, and how we work on it. | Current |
| [`../HANDOFF.md`](../HANDOFF.md) | The state of the build and what comes next. Any session can resume from it. | Current — the source of truth |
| [`../PIPELINE.md`](../PIPELINE.md) | The Copilot expansion: stages, approvals, decisions, open gates. | Current — the source of truth for that thread |
| [`../GOAL.md`](../GOAL.md) | The overnight QA mission brief from 2026-08-17. | **Historical** — it ends "MISSION COMPLETE". Its "Non-negotiable" rules still stand; its task list does not. |
| [`../.env.example`](../.env.example) | Every setting the app reads, with a plain-words note on each and no real values. | Current |

## Known naming drift (not fixed here, on purpose)

`package.json` still calls this project `mission-control`, the name of the
earlier dashboard this console grew out of. Changing it touches a file the build
agents are working in, so it is flagged rather than edited. The project is
**noc-triage**.
