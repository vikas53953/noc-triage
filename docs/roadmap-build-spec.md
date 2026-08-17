# Roadmap build — 6 features Vikas picked (2026-08-17)

Picked (WANT): Alert-driven ingestion · Cross-domain correlation · Two-way ServiceNow ·
Change-context injection · Multi-incident + on-call · Bridge roles + SLA clocks.
Honesty rules unchanged (real data or honest not-connected; deny=zero wire calls; secrets scrubbed;
Jarvis Opus 5). Features share triage.js + index.html → SEQUENTIAL waves; within a wave, split
backend vs public/index.html to a pinned contract so two agents run in parallel on disjoint files.

## External dependencies (build interface + honest "connect your X" state; go live when provided)
- Anthropic credits EXHAUSTED → correlation reasoning + Jarvis LLM offline until topped up. Deterministic parts still build/verify.
- Two-way ServiceNow → needs a ServiceNow instance URL + API creds (env). Build the client + a "not connected" state.
- On-call paging → needs a PagerDuty/Opsgenie/Slack webhook (env). Build the notifier + "not configured" state.

## Build order (each: backend+UI to contract → different-agent review → merge → restart → next)
1. **Bridge roles + SLA clocks** (no blocker) — triage roles (incident commander / scribe / joiners /
   current owner + handoff), an operator ACK action stamping MTTA (ack time), per-severity SLA target
   + live countdown on the bridge header with breach warning, and a post-incident lifecycle roll-up
   (ack → verdict → close) in the record/docs. Operator-entered roles (no auth yet).
2. **Alert-driven ingestion** — an inlet (POST /api/alerts webhook + a mappable shape for vManage/
   Catalyst/SNMP/Splunk-style alerts) that AUTO-OPENS a triage with severity mapped from the alert;
   a visible "alert-triggered" marker + source on the triage. Honest: no synthetic alerts unless a real
   inbound arrives; a test/sample inlet clearly labelled.
3. **Multi-incident + on-call** — concurrent bridges + a queue/incident-list view; dedupe check ("is this
   new complaint explained by an open incident?"); on-call notifier interface (webhook) + approval-timeout
   default rather than stalling. Notifier honest "not configured" until a webhook is set.
4. **Cross-domain correlation** — an L4 pass that correlates fronts by time: co-occurring fault/alarm/
   config events within a window → a single ranked root-cause candidate ("WAN alarm + fabric fault + app
   latency all started ~T"). Deterministic co-occurrence first; the LLM narrates it when credits are back.
5. **Change-context injection** — surface recent changes into the bridge: reuse config-store diffs
   (already real) + a maintenance-window/suppression list; a "was there a change?" answer from records.
   External change sources (FortiManager) = interface + not-connected.
6. **Two-way ServiceNow** — a ServiceNow client: create/update the INC via API, write the verdict as a
   work note, pull the CMDB CI. Env: SNOW_INSTANCE/SNOW_USER/SNOW_PASS. Honest not-connected until set;
   the existing structured export stays as the fallback.

## Preserve (all waves)
The whole current app: triage brain, permission gate, guardrail, secret scrubbing, Evidence Split Console
+ professional chat, reload persistence, timezone anchoring, incident id, time-to-verdict, honesty,
XSS escaping, zero console errors.

## STATUS
- 2026-08-17: Wave 1 (bridge roles + SLA) MERGED (PR#31 be, #32 fe, + key reconcile). Verified: roles round-trip, ack/MTTA, per-severity SLA, breach, lifecycle roll-up. Wave 2 (alert ingestion) starting.
