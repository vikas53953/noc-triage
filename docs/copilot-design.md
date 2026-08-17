# Jarvis NOC Copilot — system design (Stage 4, for Gate 3)

Charter: PIPELINE.md (Gate 1 approved — 8 abilities; Gate 2 approved — Direction C cockpit).
This document is the machine copy; Vikas's review copy is the Gate 3 HTML page.

## The map — every component, chosen or skipped

| Component | Choice | One-sentence job |
|---|---|---|
| Screens | `public/desk.html` (NEW — the cockpit) + existing `public/index.html` untouched | Three panes: work queue left, Jarvis chat center, evidence board right; cross-links to the classic console. The classic console is NOT rewritten in v1 — loose coupling, design-for-deletion. |
| Capability map | `sources/capabilities.js` (NEW) | THE single source of truth of what Jarvis can do; drives honest "can't do that yet" refusals AND request routing — one list, both jobs. |
| Command execution | existing Command Runner path + PR #40 SSH registry, routed by per-device `transport` | One choke point executes every read; the guardrail + permission gate live AT the choke point (lesson bought by PR #38's review: per-caller gates get bypassed). |
| Change engine | `sources/change-runner.js` (NEW) | The ONLY path that can write to a device: gate → pre-capture → apply → post-capture → diff → validation → rollback artifact; if any step can't run, the change doesn't. Full access per Vikas's Gate-1 decision. |
| Validation/deviation | reuse `config-store.js` baselines + diff | "Is sw2 clean?" = live config vs baseline; re-baseline is an operator action, recorded. |
| Ticket queue | `sources/tickets.js` + `ticket-store.js` (NEW) | Internal queue is the single source of truth; ServiceNow (Wave 6) becomes a mirror that syncs when connected — never a second truth. |
| Teams | `sources/teams.js` (NEW) | Posts bridge updates to a Teams incoming webhook and surfaces replies; honest "not connected" until Vikas supplies the webhook. |
| Identity | name-tag middleware in `server.js` (operator name header set once by the desk) | Every action/record/change/ticket carries the operator's name; no auth in v1 (Gate-1 decision); SSO bolts on later at the same middleware seam. |
| Memory/DB | existing per-fact JSON stores pattern | One store per fact (tickets, changes), same as chat-store/incident-store; no database until scale demands it — simplest thing that works. |
| Keys/login | SKIPPED (Gate-1 decision: open + name tag) | Revisit when real multi-user arrives; the name middleware is the seam. |
| Hosting | localhost:3000 as today | ASSUMPTION (named): colleagues reach it via Vikas's machine on the LAN; cloud hosting is a separate future decision. |
| Watchtower | extend `session-log.js` + activity feed with a structured copilot audit log (`who, what, device, result, artifacts`) | Never skippable; every copilot action greppable in one place; wired FIRST in the build wave. |
| Security | guardrail + permission gate at execution choke points; registry-derived scrubbers; XSS-escape every sink | Boundaries, not callers — the class rule all three reviews reinforced. |
| Pipes | Catalyst Center, SSH sidecar, Teams webhook, ServiceNow API | Each behind its own adapter file with an honest not-connected state. |

## Principles, named
- **One job per file:** each new capability is its own source file; desk.html is a separate screen, not index.html growth.
- **One source of truth per fact:** capability map (what Jarvis can do), ticket-store (tickets), config-store (baselines); mirrors never own facts.
- **Simplest thing that works:** JSON stores, no DB; webhook before bot framework; name header before auth.
- **One-direction data flow:** desk → API → engine → stores → broadcast back; the UI never mutates state locally.
- **Security at boundaries:** gates/guardrails/scrubbers at the choke points where wire/DOM/disk are touched, never sprinkled per caller.
- **Observability built in:** the audit log lands in the same wave as each capability, not after.
- **Loose coupling:** classic console untouched; adapters own their external systems; the cockpit consumes existing APIs.
- **Design-for-deletion:** desk.html, change-runner, tickets, teams are each removable without touching the triage core.

## Build waves (sequential, shared-file law; each = backend+UI agents to a pinned contract, adversarial review, merge, live verify)
- **CW-1 Desk shell + identity + capability honesty:** desk.html cockpit (chat center wired to existing Jarvis chat API, queue left from /api/incidents + tickets stub, evidence right), name middleware + stamping, capabilities.js + honest refusals. DEPends on: PR #38 merged.
- **CW-2 Change engine + deviation:** change-runner five-step wrap behind the gate, deviation reports in the evidence pane, audit log entries. Depends on: CW-1.
- **CW-3 Ticket queue:** tickets.js + store + queue pane UI + conversational create/assign/close. Depends on: CW-1.
- **CW-4 Teams:** teams.js webhook post + reply surfacing, honest not-connected; bridge roster in desk. Needs from Vikas: Teams webhook.
- **CW-5 SSH wiring:** route transport:ssh devices through PR #40's runner at the choke point. Depends on: PR #40 merged; real success needs sandbox reservation creds.
- **CW-6 ServiceNow mirror (= roadmap Wave 6):** snow client + one-way then two-way sync of the internal queue. Needs from Vikas: instance + creds.
- Parked roadmap **Wave 5 (change-context injection)** folds into CW-2's evidence pane (recent changes surface next to deviations).

## Bars (from Gate 1, unchanged)
≥18/20 exam right-or-honestly-declined · 0 fabrications · 100% changes fully wrapped · 0 CLI dead-ends ·
≤5s first response · 100% name-stamped.
