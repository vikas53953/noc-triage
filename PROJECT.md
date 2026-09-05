# Jarvis NOC Copilot — the project brief (start here)

**Project name: Jarvis NOC Copilot.** GitHub repo: **vikas53953/noc-triage** (the repo keeps its
old codename so nothing on disk or in the Windows auto-resume task breaks). If you only remember one
word, remember **Jarvis** — the squad lead that runs the console.

This file is the one-page answer to "what is this, where is it, where are we, what next".
Written 2026-09-05 from everything on GitHub (this repo, `mission-control`, `node-one`) and the last
Claude Code session on Vikas's PC; product structure corrected by Vikas the same day ("Build CW-3 tickets feature and verify live LLM"). For the
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
runner (`npm test`, 35 suites, ~2000 assertions, must stay green).

## Where everything lives

| Where | What |
|---|---|
| **GitHub `vikas53953/noc-triage`** (master) | The single source of truth. Everything below is pushed here. |
| Vikas's PC `C:\Users\vikasmit\noc-triage` | The working clone that ran on `:3000`. Also `~/noc-x` style clones used by builder agents. |
| `.env.local` on the PC (gitignored) | Cisco DevNet sandbox logins + `ANTHROPIC_API_KEY`. Never on GitHub. |
| Windows task `noc-triage-autoresume` | Every 30 min it relaunched a Claude Code session to resume from TRACKER. Disable it if it gets in the way (`schtasks /change /tn noc-triage-autoresume /disable`). |
| Claude Code artifacts (links in PIPELINE.md / TRACKER.md) | The Gate 1–3 review pages and the per-wave evidence pages Vikas approved. |

**Visibility (decided by Vikas 2026-09-05): the repo stays PUBLIC.** The only rule is that no API
key, password or credential may ever be visible. Real values live only in `.env.local` (gitignored);
a secret-scan test in `npm test` fails the build if a key-shaped string lands in the tree.

## One product, two interfaces (Vikas, 2026-09-05)

This is **one product** with two front doors, not a predecessor and a successor:

| Interface | Repo | When the user is there |
|---|---|---|
| **1. Mission Control** | `vikas53953/mission-control` | The first screen after onboarding — the everyday home: chat with the squad, see status, ask questions. |
| **2. NOC Triage / Jarvis desk** | `vikas53953/noc-triage` (this repo) | The room the user walks into **when they choose to** — an incident, a bridge, a deep investigation, tickets, changes. |

Both are built on the same rule (2026-08-14): real read-only reads against Cisco DevNet sandboxes, no
fabricated data, ever. All the Copilot waves (CW-1 … CW-12) landed in this repo; Mission Control has not
been touched since 2026-08-15. Joining the two into one onboarding → home → triage flow is future work
that needs Vikas's design call (see "What is next").

Not part of this product: **`node-one`** (from 2026-08-21, private) — "Node One", a mission and safety
control plane above Claude Managed Agents (TypeScript, pnpm monorepo). A separate project.

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
| CW-13 | NetClaw's ready-made MCP servers adopted as our integration library (first: Catalyst Center, all 514 read-only operations) behind an env boundary, redaction and a pinned read-only vetting record | PR #80 (3 review rounds), `docs/copilot-cw13-netclaw-contract.md` |
| Polish P1 | Law-1 leftovers removed (canned @mention ack, Jarvis-attributed relay, dead simulators), watcher honesty, phone-width header | PR #79 |
| CW-12 | Live presence: "Jarvis is typing…", "Router-Expert is checking…", "waiting for your approval", receipt ticks sent → picked up → answered — driven by real events only, never persisted | PR #78 (3 review rounds), `docs/shots/cw12-*` |

The **laws** (never regressed, every reviewer checks them): intent-first routing, ask-before-assume,
never fabricate, permission gate + read-only guardrail, secrets never persist, short messages
(280-char cap), adopt-don't-hand-write integrations, timezone honesty. Full text in `HANDOFF.md`.

## Where we are (2026-09-05, end of session)

- The project was idle from 2026-08-20 (Vikas paused at ~90% weekly quota; no Cursor commits landed).
- 2026-09-05: resumed in Claude Code on the web. Named, centralised (this file), and **CW-12 Live
  Presence shipped** — built, adversarially reviewed over three rounds, merged as PR #78.
- Master is green: 38 suites (incl. the public-repo secret guard). In flight: CW-14 stage A (Jarvis on the OpenAI Agents SDK behind a flag).
- The cloud container has no `ANTHROPIC_API_KEY` and no DevNet reach, so the live-LLM parts of CW-12
  were proven with a mock endpoint; the streamed "typing" and a real device "checking" are still to be
  eyeballed on the PC.

## What is next (in order)

1. **Eyeball CW-12 on the PC** with the real key: pull master, restart `:3000`, open the desk, ask
   Jarvis something that streams. Paste `test/cw12-fixture.js` into the browser console and run
   `cw12All()` to see every state without waiting on a device.
2. **CW-14 — the agent runtime** (Vikas 2026-09-05: "use the agentic framework … I really don't want to
   make that mistake again"). Stage A in flight: Jarvis on the OpenAI Agents SDK with a provider
   adapter (Anthropic today, OpenAI/OpenRouter next) behind `JARVIS_RUNTIME=agents`. Contract:
   `docs/copilot-cw14-runtime-contract.md`. Vikas may veto the pick in one word.
3. **CW-13b — the next NetClaw servers** for our other agents (ACI, SD-WAN, syslog/SNMP feeds, ISE,
   Meraki, F5, Check Point, Fortinet, NVD). Same seam, one vetting record each. Needs Vikas's order.
   On the PC: run `scripts/netclaw-setup.ps1` and enable `netclaw-catc` to see CW-13 live.
4. Polish backlog — probe planner sometimes asks bare `ping`/`traceroute`; lesson chip dark until a
   first real lesson; two LOW review leftovers on PRs #74/#76; short-device-error over-scrub. (Done
   2026-09-05 in Polish P1: dead Law-1 code, canned @mention lines, badge, phone-width header.)
5. **Join the two interfaces** — onboarding → Mission Control (home) → NOC Triage (on demand): one
   operator identity, one way in, cross-links both ways. Needs Vikas's design call on what "onboarding"
   means in v1 (name tag only, as today, or a real sign-in).
6. Parked, need Vikas's pick — FortiGate / F5 / threat feeds, RBAC/SSO, PDF/email export, HA front.

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
