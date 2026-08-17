# noc-triage — session handoff (any Claude session can resume from this)

Live, honest NOC/SOC triage console for Vikas. Private repo **vikas53953/noc-triage**.
Run: `cd C:\Users\vikasmit\noc-triage && PORT=3000 node server.js` → http://localhost:3000
`.env.local` (gitignored) holds Cisco DevNet sandbox creds + `ANTHROPIC_API_KEY` (credits topped up 2026-08-17).
Jarvis default model = `claude-opus-5` (`JARVIS_MODEL` env overrides). Never fake data — see "Laws".

## How work is done here (follow this)
- One coherent feature at a time, in WAVES. Each feature: split BACKEND vs `public/index.html` (UI) to a
  PINNED CONTRACT so two agents run in PARALLEL on DISJOINT files. Almost everything shares
  server.js / sources/triage.js / sources/jarvis.js / public/index.html, so features are SEQUENTIAL.
- Each agent works in its OWN clone (`git clone … "$HOME/noc-xxx"`), branch, PR — NOT the main checkout
  (worktree isolation is flaky on this machine). Build → a DIFFERENT agent reviews LIVE → merge → restart
  the :3000 server → verify → next. The :3000 background node process gets reaped between turns; relaunch
  when down.
- Vikas reviews finished work as a VISUAL HTML PAGE with the feedback layer
  (`~/.claude/review-kit/feedback-layer.js`, inlined). Short plain replies. One question at a time with a
  recommendation. Fix the CLASS, not the case. No "done" without fresh live evidence — he confirms, never discovers.

## Laws (absolute, never regress)
Real data or an honest "not connected/unread/unreachable" — NEVER fabricate. Permission gate: deny = ZERO
wire calls, writes blocked BEFORE the gate. Read-only guardrail (only show/ping/traceroute/dir/more).
Secrets scrubbed from everything persisted. XSS-escape every DOM sink. Timezone: bare clock times anchored
in the operator's tz (sent as `operatorTz`), most-recent-past, never a future window.

## What's BUILT + MERGED (on master)
Evidence Split Console UI (its own identity, not mission-control). Triage brain: symptom window/scope
parsing, baseline deltas, top-3 alarm groups (chronic vs new), running-config diff finding, blind spots
ranked by symptom, committed ranked hypothesis + if/then + confidence. Severity-driven cadence (P1 parallel
/ P3 sequential). Permission gate (auto/ask/deny) + approval log. Jarvis = real Claude (Opus 5) delegation.
Agents run REAL reads; **Config-Keeper runs real CLI via Catalyst Center Command Runner** (`runShowCommand`,
`getRunningConfig` in sources/catalyst-center.js — verified live: `show version` sw1 → 17.12.01prd9).
Artifacts + leadership/engineer docs + structured ServiceNow export. Incident id (INC-YYYYMMDD-NNN),
time-to-verdict. Reload persistence (chat + activity, sources/chat-store.js). Professional chat (right/left
bubbles, chevron collapse, markdown, auto-scroll). **Roadmap Wave 1** bridge roles + SLA clocks + MTTA +
lifecycle roll-up. **Wave 2** alert-driven ingestion (`POST /api/alerts` auto-opens a triage, ⚡ badge).
**Wave 3** multi-incident queue + `relatedTo` dedupe + on-call notifier (`ONCALL_WEBHOOK`, honest
not-configured) + opt-in approval timeout (`APPROVAL_TIMEOUT_MS`, default off). All reported QA bugs fixed
(timezone anchor, retry-404, silent-422, dup activity, MTTR→"time to verdict", etc.).

## IN FLIGHT / NEXT (sequence; shared files → mostly one at a time)
1. **CLI routing fix** (branch fix/cli-routing) — route any "run <show/ping> on <device>" to the Command
   Runner path (Config-Keeper) so it never dead-ends on NetOps/inventory ("no command-runner path").
   Class fix in server.js `detectAgentIntent` + jarvis routing + live-agents. Verify: ask JARVIS
   "show version on sw1" → real device output. (Was relaunched 2026-08-17.)
2. **Roadmap Wave 4 — cross-domain correlation** — UI done (PR **#37** open, feat/correlation-fe); BACKEND
   was stopped mid-build, REBUILD it (sources/triage.js + jarvis.js) per docs/roadmap-build-spec.md item 4:
   deterministic time co-occurrence across fronts → one ranked root-cause candidate; contract
   `correlation:{clusters,topCandidate,note}`. Credits are back so the LLM can narrate it.
3. **SSH/Netmiko backend** (Vikas approved) — a small Python sidecar (Scrapli/Netmiko) so agents can run
   CLI over SSH to DIRECTLY-REACHABLE DevNet sandboxes (the always-on IOS-XE box). The DNAC switches
   sw1–sw4 are NOT SSH-reachable (private behind DNAC) → they STAY on Command Runner. Read-only guardrail
   on both. Use the public always-on IOS-XE sandbox creds (public) unless Vikas supplies another.
4. **Roadmap Wave 5 — change-context injection** — surface recent changes (reuse config-store diffs +
   maintenance/suppression windows) into the bridge; external sources (FortiManager) = interface + not-connected.
5. **Roadmap Wave 6 — two-way ServiceNow** — real INC create/update via API + work notes + CMDB CI.
   NEEDS Vikas's ServiceNow instance URL + API creds (env SNOW_INSTANCE/SNOW_USER/SNOW_PASS); build the
   client + honest not-connected until set; the structured export stays as fallback.

## Roadmap the user picked (roadmap page: they WANT these): alert ingestion(done W2), cross-domain
## correlation(W4), two-way ServiceNow(W6), change-context(W5), multi-incident+on-call(done W3),
## bridge roles+SLA(done W1). Parked/backlog: FortiGate/F5/threat-feed coverage, HA-health front, RBAC/SSO,
## source-of-truth stamping, confidence-as-sortable, PDF/email doc export.

## Key files
server.js (routes, broadcast, agent registry, detectAgentIntent) · sources/triage.js (bridge engine,
roles/SLA/incident/dedupe/correlation) · sources/jarvis.js (Claude reasoning + delegation/routing) ·
sources/live-agents.js (per-agent reads; Config-Keeper CLI) · sources/catalyst-center.js (Command Runner)
· sources/aci.js, sdwan.js (adapters w/ timestamps+clustering) · sources/approvals.js (gate) ·
sources/notifier.js (on-call) · sources/chat-store.js (persistence) · sources/artifacts.js (records/docs/
ServiceNow) · baseline-store.js, config-store.js, incident-store.js. public/index.html (entire UI).
Specs: docs/roadmap-build-spec.md, triage-intelligence-spec.md, qa-bugs-spec.md, chat-ux-spec.md,
transparency-contract.md, triage-contract.md.
