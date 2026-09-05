# Jarvis NOC Copilot (`noc-triage`) — an honest NOC/SOC triage console

> **New here or coming back after a break? Read [`PROJECT.md`](PROJECT.md) first** — the one-page
> brief: what this is, where everything lives, where we are, and what is next.

When something breaks on the network, this is the room you walk into.

You describe the problem in plain English — "DC apps slow since 2pm" — pick a
severity, and the console opens a **triage bridge**: a small team of agents
each look at the part of the network they own, post what they actually found,
and **Jarvis** (the squad lead, a real Claude model) reads all of it and commits
to a ranked best guess with a way to prove or disprove it.

The one rule the whole project is built around: **never make anything up.**
If a source is not connected, not readable, or unreachable, the console says so
and stops. It will not fill the gap with a plausible-looking report.

*Jargon note: "triage" = deciding fast what is actually wrong and who should act.
A "bridge" = the call/room where that happens. A "front" = one area of the
network (campus, fabric, WAN).*

## Screenshot

_Not captured yet._

<!-- TODO: save a screenshot of the console at localhost:3000 to docs/screenshot.png,
     then replace the line above with:
     ![Evidence Split Console](docs/screenshot.png)
     Keep it commented out until the file exists — GitHub renders a broken image otherwise. -->

## Run it

You need [Node.js](https://nodejs.org) 18 or newer.

```bash
npm install
cp .env.example .env.local     # Windows: copy .env.example .env.local
PORT=3000 node server.js       # Windows PowerShell: $env:PORT=3000; node server.js
```

Then open <http://localhost:3000>.

It starts fine with an empty `.env.local` — every source simply reports
"not connected" until you fill it in. Nothing breaks, and nothing is invented
in the meantime. See [`.env.example`](.env.example) for what each setting does;
every line there has a plain-words comment.

Two things are worth filling in first:

- **`ANTHROPIC_API_KEY`** — without it Jarvis reports itself offline instead of
  reasoning. Jarvis runs on Claude Opus 5 by default (`JARVIS_MODEL` overrides).
- **Cisco DevNet sandbox logins** (`DNAC_*`, `ACI_*`, `SDWAN_*`) — free accounts
  at [devnetsandbox.cisco.com](https://devnetsandbox.cisco.com). These are the
  real devices the agents read.

GitHub currently lists this repo as **public** (see the visibility note in `PROJECT.md`), so: real credentials
belong only in `.env.local`, which is gitignored.

## What it can do today

Everything below is built and merged on `master`.
[`HANDOFF.md`](HANDOFF.md) is the source of truth for build state — if this
list and HANDOFF ever disagree, HANDOFF wins.

**The console**
- Evidence Split Console UI — bridge narration on one side, an evidence board
  of live findings on the other.
- Professional chat: your message right, agents left, collapsible detail behind
  a chevron, markdown, auto-scroll.
- Chat and Live Activity survive a page reload.
- Timestamps anchored to the operator's own timezone, never a future window.

**The triage brain**
- Reads the actual complaint: pulls the time anchor ("since 2pm") and the scope
  ("DC, not campus") out of it, and filters evidence to that window and area.
- Baseline deltas — tells you what *changed* ("220 alarms, baseline 218, +2"),
  not just what exists.
- Top-3 alarm groups, marked chronic vs newly started.
- Running-config diffs, so "was there a change?" gets a real answer.
- Blind spots ranked by how likely they are to be hiding *this* symptom.
- A committed ranked hypothesis with an if/then test and a confidence level.
- Severity changes behaviour: P1 sweeps fronts in parallel, P3 walks them
  sequentially.

**Live reads (real devices, read-only)**
- Agents run real reads against Cisco DevNet sandboxes.
- Config-Keeper runs real CLI through Catalyst Center's Command Runner —
  verified live (`show version` on sw1 returned 17.12.01prd9).
- Jarvis is a real Claude model that delegates to the other agents.

**Operations lifecycle**
- Permission gate with three modes — auto / ask / deny — plus an approval log.
  Deny means zero calls reach the wire.
- Incident IDs (`INC-YYYYMMDD-NNN`) and a time-to-verdict clock.
- Bridge roles (incident commander, scribe, joiners), SLA countdown clocks,
  MTTA on acknowledgement, and an end-of-incident roll-up.
- Alert-driven intake: `POST /api/alerts` auto-opens a triage and marks it ⚡.
- Multiple incidents at once, with a `relatedTo` duplicate check.
- On-call notifier via `ONCALL_WEBHOOK` (honest "not configured" when unset)
  and an opt-in approval timeout (`APPROVAL_TIMEOUT_MS`, off by default).
- Cross-domain correlation — links a WAN alarm, a fabric fault, and an app
  symptom that all started around the same moment.
- Artifacts: leadership and engineer write-ups, plus a structured ServiceNow
  export.

## The safety rules (never relaxed)

- **Real data or an honest "not connected".** Never a fabricated number.
- **Permission gate.** In deny mode, zero calls go to the wire.
- **Read-only guardrail.** Only `show`, `ping`, `traceroute`, `dir` and `more`
  get through. Pipes, semicolons, redirects and write verbs (`config`, `write`,
  `erase`, `reload`, `copy`, `delete`, `clear`) are blocked before any request
  is built.
- **Secrets are scrubbed** from anything saved to disk. Logs record lengths,
  never values.
- **Every screen output is escaped** so device text can never run as code in
  the browser.

*Note on the roadmap: the Jarvis Copilot work (see below) has an approved
decision to allow gated configuration **changes** — pre-capture, post-capture,
diff and a rollback artifact on every one. That engine is **not built yet**.
Today the console is read-only.*

## Where the project is heading

The console is live and in use. Two threads of work run on top of it:

1. **Feature waves** on the existing console — the queue and its order live in
   [`HANDOFF.md`](HANDOFF.md) under "IN FLIGHT / NEXT" (CLI routing fix, an
   SSH sidecar for directly reachable devices, change-context injection,
   two-way ServiceNow).
2. **The Jarvis NOC Copilot** — a new "desk" view inside this same app where
   anyone can ask any NOC/SOC question and Jarvis acts on it. Its stage-by-stage
   status, approved decisions and open gates live in
   [`PIPELINE.md`](PIPELINE.md); the design is in
   [`docs/copilot-design.md`](docs/copilot-design.md). As of the last update it
   is at **Gate 3 (design approved-pending)** — no copilot code has shipped yet.

## Which file answers which question

| I want to know… | Read |
|---|---|
| What is this and how do I run it | this file |
| What is actually built right now, and what is next | [`HANDOFF.md`](HANDOFF.md) — **the source of truth for build state** |
| Where the Jarvis Copilot expansion stands, and what was decided | [`PIPELINE.md`](PIPELINE.md) — the source of truth for that pipeline |
| What every setting does | [`.env.example`](.env.example) |
| What each document in `docs/` is for | [`docs/INDEX.md`](docs/INDEX.md) |
| What the overnight QA mission was | [`GOAL.md`](GOAL.md) (historical) |

## How the code is laid out

| File / folder | Its job in plain words |
|---|---|
| `server.js` | The web server: routes, the live push to the browser, the agent registry, and working out which agent a question belongs to |
| `sources/triage.js` | The triage engine — roles, SLA clocks, incidents, duplicates, correlation |
| `sources/jarvis.js` | Jarvis's reasoning and how it hands work to the other agents |
| `sources/claude.js` | The connection to the Claude model |
| `sources/live-agents.js` | What each agent actually reads from the network |
| `sources/catalyst-center.js`, `aci.js`, `sdwan.js` | One adapter per platform |
| `sources/guardrails.js` | The read-only command allowlist |
| `sources/approvals.js` | The permission gate and its log |
| `sources/notifier.js` | On-call paging over a webhook |
| `sources/artifacts.js` | Records, written documents, and the ServiceNow export |
| `sources/*-store.js` | Small JSON stores — chat, baselines, configs, incidents |
| `public/index.html` | The whole console the browser loads |
| `origins.js`, `ratelimit.js`, `workspace.js` | Who may call the server, request budgets, and where files are written |

Plain Node and Express, WebSockets for live updates, no build step.

## How we work on this repo

This is the process every contributor and every AI session follows. It exists
because it has caught real mistakes.

- **One feature at a time, in waves.** Almost everything touches `server.js`,
  `sources/triage.js` or `public/index.html`, so features run sequentially. Two
  agents may run in parallel only when the work is split backend-vs-UI against
  a **pinned contract** (see the contract files in `docs/`) so they never touch
  the same file.
- **Own clone per worker.** Clone the repo somewhere of your own and work on a
  branch there — never in the main checkout, and never directly on `master`.
- **Pull request, then adversarial review by a *different* worker.** The
  reviewer checks the running app, not just the diff.
- **Live verification before merge.** No "done" without fresh evidence from a
  real run in the current session. Tests passing is not the same as working.
- **Fix the class, not the case.** A fix should close the whole category of
  problem, not the one instance that surfaced.
- **The laws are non-negotiable:** never fabricate data; the permission gate
  and read-only guardrail stay intact; secrets are scrubbed from everything
  persisted; every screen output stays escaped.

## License

MIT — see [LICENSE](LICENSE).
