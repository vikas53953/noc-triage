# Jarvis NOC Copilot — the project brief (start here)

**Project name: Jarvis NOC Copilot.** GitHub repo: **vikas53953/noc-triage** (the repo keeps its
old codename so nothing on disk or in the Windows auto-resume task breaks). If you only remember one
word, remember **Jarvis** — the squad lead that runs the console.

This file is the one-page answer to "what is this, where is it, where are we, what next".
Written 2026-09-05 from everything on GitHub (this repo, `mission-control`, `node-one`) and the last
Claude Code session on Vikas's PC ("Build CW-3 tickets feature and verify live LLM"). For the
detailed build state read `HANDOFF.md`; for the day-by-day log read `TRACKER.md`.

## What it is, in plain words

A web console a NOC/SOC engineer walks into when the network breaks. You type the problem in plain
English ("DC apps slow since 2pm"). A small squad of AI agents each read the part of the network they
own — Catalyst Center (campus), ACI (data-centre fabric), SD-WAN (WAN) — and post what they actually
found. **Jarvis**, a real Claude model, reads all of it, asks you a question when the ask is vague,
delegates real read-only checks, and commits to a ranked verdict with a way to prove or disprove it.

Think of it as a **bridge call with a memory and a conscience**: every claim traces to a real command
output, every command is gated and read-only, secrets are scrubbed before anything hits disk, and if
a source is not connected the console says "not connected" instead of inventing a number.

Two screens in one app:

| Screen | URL | What it is |
|---|---|---|
| **Desk** (the real console, "Direction C cockpit") | `http://localhost:3000/desk.html` | Work queue left, Jarvis chat centre, evidence board right, SSH-style session pane |
| Classic console | `http://localhost:3000/` | The older triage view, kept working, shares the same modules |

Stack: plain Node 18+ and Express, WebSockets for live push, no build step, JSON stores, one test
runner (`npm test`, 33 suites, ~1800 assertions, must stay green).

## Where everything lives

| Where | What |
|---|---|
| **GitHub `vikas53953/noc-triage`** (master) | The single source of truth. Everything below is pushed here. |
| Vikas's PC `C:\Users\vikasmit\noc-triage` | The working clone that ran on `:3000`. Also `~/noc-x` style clones used by builder agents. |
| `.env.local` on the PC (gitignored) | Cisco DevNet sandbox logins + `ANTHROPIC_API_KEY`. Never on GitHub. |
| Windows task `noc-triage-autoresume` | Every 30 min it relaunched a Claude Code session to resume from TRACKER. Disable it if it gets in the way (`schtasks /change /tn noc-triage-autoresume /disable`). |
| Claude Code artifacts (links in PIPELINE.md / TRACKER.md) | The Gate 1–3 review pages and the per-wave evidence pages Vikas approved. |

**Visibility note (found 2026-09-05):** HANDOFF and README describe the repo as private, but GitHub
lists `vikas53953/noc-triage` as **public**. A secret scan of the tree found nothing (only sandbox
hostnames and `.env.example` placeholders), so nothing leaked — but decide on purpose: make it
private in repo settings, or keep it public and treat it that way.

## Lineage — how this project came to be

1. **`mission-control`** (July–Aug 2026, public) — the first chat-first dashboard for a squad of ten
   network agents. Its big finding: most agent answers were simulated. Vikas's decision on 2026-08-14:
   *real read-only reads against Cisco DevNet always-on sandboxes, no fabricated data, ever.*
2. **`noc-triage`** (Aug 2026) — the rebuild on that rule. Triage engine, baselines, alarm grouping,
   config diffs, permission gate, read-only guardrail, ServiceNow export. Then the **Jarvis NOC
   Copilot** expansion (Vikas's ask, 2026-08-17): "anyone comes in and asks any question related to
   network and Jarvis should be able to answer" — built as Copilot Waves CW-1 … CW-11.
3. **`node-one`** (from 2026-08-21, private) — a *separate* project: "Node One", a mission and safety
   control plane above Claude Managed Agents (TypeScript, pnpm monorepo). Not part of this one.

## What is built (all merged on master, all live-verified on the PC)

| Wave | What it added | Evidence |
|---|---|---|
| Triage waves 1–6 + QA | Triage brain, baselines, top-3 alarm groups, config diffs, blind spots, ranked hypothesis, incidents/SLA/MTTA, alert intake, correlation, ServiceNow export | `docs/triage-intelligence-spec.md`, `docs/qa-bugs-spec.md` |
| CW-1 | Desk cockpit, operator name tag, capability map + honest "can't do that yet" | PRs #42/#43 |
| CW-2 | Change engine (pre/post/diff/rollback) — apply honestly frozen (observer sandbox), drift reports | `docs/evidence/cw2-ui/` |
| CW-3 | Built-in ticket queue (single source of truth) with conversational create/assign/close | `sources/tickets.js` |
| CW-4 / CW-6 | Microsoft Teams webhook, ServiceNow two-way mirror — both honest "not connected" until creds | `sources/teams.js`, `sources/servicenow-client.js` |
| CW-5 | SSH engine via Python sidecar (needs sandbox SSH creds) | `sources/ssh-runner.js` |
| CW-7 | Investigation loop: rounds of real checks until confirmed / capped | `sources/investigation.js` |
| CW-8 | MCP connector for vetted external tools (none wired yet) | `sources/mcp-connector.js` |
| NetClaw A1–A8 | Catalyst Center catalogue, syslog/SNMP feeds, Batfish, pcap, Nautobot — honest-if-absent | `docs/netclaw-assessment.md` |
| CW-9 | Bridge conduct: ask-first on every path, pinned chat envelope, V2 split terminal, honest roster, evidence-diffed narration, write refusals | PRs #72/#73, `docs/shots/cw9-*` |
| CW-10 | Official Anthropic SDK, prompt caching, streaming (`say_delta`), spend meter, web search on reasoning only, compaction | PRs #74/#75, `docs/shots/cw10-*` |
| CW-11 | Reflexion: round reflection, verdict self-check (verified vs suspected), prediction follow-through, lessons memory | PRs #76/#77, `docs/shots/cw11-*` |

The **laws** (never regressed, every reviewer checks them): intent-first routing, ask-before-assume,
never fabricate, permission gate + read-only guardrail, secrets never persist, short messages
(280-char cap), adopt-don't-hand-write integrations, timezone honesty. Full text in `HANDOFF.md`.

## Where we are (2026-09-05)

- Last commit on master: **2026-08-20** ("Cursor handoff"). Nothing in flight. Everything pushed.
- Vikas paused Claude Code builds on 2026-08-20 at ~90% weekly quota and planned to continue in
  Cursor; no Cursor commits landed. The project has been idle since.
- 2026-09-05: quota reset; work resumes in Claude Code on the web. This container has no
  `ANTHROPIC_API_KEY` and no DevNet reach, so live LLM/device verification still happens on the PC.
  Deterministic suites and browser fixtures run here.

## What is next (in order)

1. **CW-12 Live Presence** — recorded 2026-08-20 in Vikas's words, NOT built yet. Typing / "checking"
   indicators and message receipt states, driven only by real events (`say_delta`, agent status,
   approval waits). Contract: `docs/copilot-cw12-presence-contract.md`. **Started 2026-09-05.**
2. **CW-13** — vet and wire the first real external MCP server through the CW-8 connector.
   Needs Vikas's pick and approval.
3. Polish backlog — probe planner sometimes asks bare `ping`/`traceroute`; lesson chip dark until a
   first real lesson; two LOW review leftovers on PRs #74/#76; short-device-error over-scrub.
4. Parked, need Vikas's pick — FortiGate / F5 / threat feeds, RBAC/SSO, PDF/email export, HA front.

## What only Vikas can supply (each flips a built feature live)

`TEAMS_WEBHOOK` · `SNOW_INSTANCE/USER/PASS` · DevNet IOS-XE SSH creds (`SSH_IOSXE_USER/PASS`) ·
devices pointing syslog/traps at the console · write-capable sandbox creds (change apply +
prediction follow-through) · a vetted external MCP server · the repo visibility decision above.

## How to resume from any tool

```bash
git clone https://github.com/vikas53953/noc-triage && cd noc-triage
npm install && npm test          # must be green before touching anything
cp .env.example .env.local       # fill ANTHROPIC_API_KEY + DevNet creds on the PC
PORT=3000 node server.js         # open http://localhost:3000/desk.html
```

Then read, in order: `PROJECT.md` (this) → `HANDOFF.md` (laws, wave process, built map, NEXT) →
`TRACKER.md` tail (latest log) → the contract for the wave you are picking up. Work one wave at a
time on a branch, PR, a *different* agent reviews adversarially, merge, live-verify, log in TRACKER.

## Which document answers what

| Question | Read |
|---|---|
| What is this project and where are we | `PROJECT.md` (this file) |
| Exactly what is built, laws, process, next queue | `HANDOFF.md` |
| What happened on which day | `TRACKER.md` (append-only) |
| Copilot expansion stages, gates, Vikas's decisions | `PIPELINE.md` |
| System design of the Copilot | `docs/copilot-design.md` |
| The seam for a given wave | `docs/copilot-cwN-*-contract.md` |
| How to run it and how we work | `README.md` |
| What each file in `docs/` is | `docs/INDEX.md` |
