# QA bug spec — NOC Triage (full end-to-end sweep)

Single source of truth for the fix loop. Every bug below was reproduced live against the
running app (`PORT=3290 node server.js`, Jarvis on Opus 5, real Cisco DevNet sandboxes) via
WebSocket + REST, and cross-checked against the source. Vikas's already-reported majors/minors
(GOAL.md) are folded in so nothing is tracked in two places.

**Method:** drove direct chat to all agents, Jarvis delegation, P1/P2/P3 triage, permission
gate, ServiceNow export, re-triage+diff, and every negative/edge input. Pixel screenshots were
blocked by the MetaMask extension, so UI checks that need visual measurement are tagged
**SUSPECT (needs browser confirm)** with the exact re-check step — never asserted as broken.

**Headline result:** the app is honest end-to-end. No blocker found. No fabricated data anywhere
— every garbage/typo/off-topic/denied path runs nothing and says so. The open majors are about
*answering the specific question* and *ITSM/persistence correctness*, not about invention.

Bug id scheme: `B#` = behavioral/logic, tagged severity. Roadmap items (new features) are OUT of
this spec — see the one-line pointer at the end.

---

## BLOCKERS
None. No crash, no data fabrication, no unescaped XSS, no gate bypass, and zero server-log errors
or unhandled rejections across every flow exercised.

---

## MAJORS

### B1 — Delegated agents run a fixed canned sweep and ignore the field actually asked
- **Severity:** major (flagship; Vikas's in-flight "delegated agents drop EPGs / mgmt IP / sw version")
- **Feature:** Jarvis delegation → engaged agent's live read
- **Repro:** Direct-message Jarvis `list the EPGs configured in the ACI fabric`. Jarvis correctly
  plans and delegates to Router-Expert with a precise sub-question (list every EPG + tenant + app
  profile + BD/VRF + contracts). Router-Expert then issues `GET fabricNode.json`,
  `GET fabricHealthTotal.json`, `GET fvTenant.json` — and **stops**. It never queries the EPG
  class (`fvAEPg`). Jarvis honestly reports "I don't have the EPG list yet."
- **Expected:** the delegated read adapts to the sub-question — for an EPG ask, walk
  tenant→AP→EPG→BD→contract (the `auditTenant` walk that already exists in `aci.js`, used at
  live-agents.js:266) and return the EPGs. Likewise mgmt IP / serial / BGP / routes when asked.
- **Actual:** every builder answers a fixed summary regardless of the sub-question. `router-expert`
  only ever returns nodes+health+tenants (ACI) or device-states+alarms (WAN) — never EPGs, BDs,
  VRFs, contracts, BGP, or routes, despite being the routing/ACI SME. `config-keeper` returns
  hostname+software+reachability for all devices but never per-device mgmt IP or serial. `netops`
  returns reachability+platform+health only. So "mgmt IP of sw1" and "EPGs" via delegation are
  structurally unanswerable.
- **Likely file:** `sources/live-agents.js` — `DEBATE_BUILDERS` (lines 574–724); each `build(topic)`
  uses `topic` only to pick an ACI-vs-WAN branch and as a display label, never to shape the read.
- **Honesty-impact:** POSITIVE — it never invents the missing fields; Jarvis says "anything I said
  there would be invention." The bug is a *capability gap*, not a lie. Fix must keep that honesty.

### B2 — ServiceNow export marks the incident "Resolved" even when the verdict rests on an unread blind spot
- **Severity:** major (Vikas ServiceNow Major 1)
- **Feature:** ServiceNow / ITSM export
- **Repro:** `GET /api/triage/<id>/servicenow` after the flagship P1. State = `"Resolved"` while the
  verdict's most-likely cause is the **unread F5 load balancer** (a blind spot) and confidence is
  `"low"`.
- **Expected:** State should be `In-Progress` / `On-Hold` when the committed hypothesis depends on an
  unverified blind spot or confidence is low — not `Resolved`.
- **Actual:** State is a blind `closed → Resolved` map with no regard for confidence or blind-spot
  dependence.
- **Likely file:** `sources/artifacts.js:276` (`state: rec.status === 'closed' ? 'Resolved' : 'In Progress'`).
- **Honesty-impact:** HIGH — tells ITSM a P1 is resolved when root cause is unconfirmed and sits in
  an unread system.

### B3 — ServiceNow affected-CI parsing produces junk CIs from ACI fault DNs
- **Severity:** major (Vikas ServiceNow Major 2)
- **Feature:** ServiceNow export → Affected CIs
- **Repro:** Same export. `affectedCIs` contains `{ci:"1",class:"node"}`, `{ci:"101",class:"node"}`,
  and `{ci:"unknown",class:"tenant"}`.
- **Expected:** one CI `LF-101` (the leaf node name) and the real tenant name — human-readable CIs.
- **Actual:** the ACI fault's `node` field ("101") and pod ("1") from `topology/pod-1/node-101` are
  emitted as two bare-number CIs, and `tenant` resolves to `"unknown"`.
- **Likely file:** `sources/triage.js:1063-1064` (`add(f.tenant,'tenant')` / `add(f.node,'node')`),
  fed by fault objects in `sources/aci.js` whose `node`/`tenant` fields are raw ids, not names.
- **Honesty-impact:** medium — CIs are technically real ids but unusable/mislabelled in ServiceNow.

### B4 — Direct chat and Live Activity are wiped on page reload (no persistence/restore)
- **Severity:** major (Vikas Major 4)
- **Feature:** reload persistence
- **Repro:** Send direct messages / generate activity, then refresh the page. The chat stream and
  the Live Activity panel come back empty.
- **Expected:** chat/DM and Live Activity survive a refresh (persist + restore), as the in-progress
  triage already does.
- **Actual:** boot restores only triage/session/approvals/sources. There is **no `init` branch** in
  the WS `onmessage` handler (`public/index.html:2922-2954`), so the server's `init` snapshot
  (which carries recent activity + mention counts) is silently dropped, and nothing fetches chat
  history. Only the theme is persisted (localStorage).
- **Likely file:** `public/index.html` — WS `onmessage` (add `init` handling) + boot sequence
  (~line 3047) + `renderChat`/`pushActivity` need a persist+restore path.
- **Honesty-impact:** none (no invention) — pure data-loss UX bug.

### B5 — Timestamps are unlabeled local time while the engine speaks UTC (mixed, ambiguous)
- **Severity:** major (Vikas Major 5)
- **Feature:** timezone labeling
- **Repro:** Watch any chat/activity row — the clock is bare `HH:MM:SS`. The evidence/verdict text
  and the incident id say things like "14:00 UTC window" and `INC-20260816-...`.
- **Expected:** every timestamp labelled (UTC and/or local); the parsed-symptom window carries a TZ;
  incident-id date and the wall clock agree or are labelled.
- **Actual:** `tsClock()`/`nowClock()` (`public/index.html:1356-1363`) return `toTimeString()` local
  time with no label, so an operator can't tell UI-local from engine-UTC. The incident id uses the
  UTC date (`INC-20260816`) while the operator's local date was the 17th.
- **Likely file:** `public/index.html:1356-1363` (add labels), plus label the symptom window carried
  in the `triage_symptom` event.
- **Honesty-impact:** medium — mixing unlabeled zones can mislead about *when* something happened.

---

## MINORS

### B6 — Markdown not rendered in chat bubbles
- **Feature:** direct chat rendering. `renderChat` uses `escapeHtml(d.text)` only, never `mdToHtml`
  (`public/index.html:2385,2398`), so Jarvis's `**bold**`, `##`, and bullet lists appear as literal
  characters. A safe escaped-then-formatted renderer (`mdToHtml`, used for records) already exists.
- **Likely file:** `public/index.html:2385,2398`. Honesty-impact: none.

### B7 — @mention doesn't switch the "To:" chip or offer autocomplete
- **Feature:** direct chat targeting. Typing `@NetOps …` while the chip reads "To: Jarvis" still
  routes correctly server-side, but the chip stays "To: Jarvis" and there is no autocomplete — the
  UI misrepresents who will answer. No `input` listener parses `@name`.
- **Likely file:** `public/index.html` (`cmdInput` handlers near 2323-2329, 2428). Honesty-impact: low.

### B8 — Send button never disabled on empty input
- **Feature:** chat send affordance. `sendBtn` (`index.html:1025`) is never toggled disabled; empty
  send is a silent no-op (`if(!text) return;`). Spec asks for a disabled state.
- **Likely file:** `public/index.html` (add input→`sendBtn.disabled` wiring). Honesty-impact: none.

### B9 — "Re-check" sources button gives no spinner/loading feedback
- **Feature:** source health. `loadSources()` (`index.html:2875`) re-probes all three live sources
  (can take seconds) but never disables/spins the `srcRefresh` button — the per-source Retry button
  does. Looks unresponsive.
- **Likely file:** `public/index.html:2875-2883`. Honesty-impact: none.

### B10 — Activity actor mislabel ("Responded to @X")
- **Feature:** activity log attribution. `server.js:592` logs `[${toAgent.name}] Responded to
  @${fromAgent.name}` on the mention path; for an operator DM this reads as the wrong actor
  responding (Vikas: "Responded to @Jarvis" for a NetOps DM).
- **Likely file:** `server.js:547-592` (`handleMention`). Honesty-impact: low (mislabels who acted).

### B11 — Leadership (SLT) summary overstates "what broke"
- **Feature:** SLT doc. `slt.md` says "We found a live problem on 3 area(s)" and lists fabric/wan/
  incidents, even though the verdict correctly says fabric & incidents faults **pre-date** the
  window and are not the cause. Leadership would read 3 things as having broken during the incident.
- **Likely file:** `sources/artifacts.js` (SLT "What broke" builder). Honesty-impact: medium — the
  numbers are real but the framing over-counts pre-existing noise as new breakage.

### B12 — Escalation strip shows L3 stuck at "pending" for P3
- **Feature:** triage escalation strip. A P3 staffs L1+L2+L4 only (correct), but the strip emits
  `triage_progress tier=L3 pending` that never advances — it can look stalled.
- **Likely file:** `sources/triage.js` progress emission / `public/index.html` strip render.
  Honesty-impact: none. Confirmed live on the P3 run.

---

## SUSPECT — needs a human browser check (screenshots blocked by MetaMask)

- **S1 — User bubble right-alignment actually renders.** Code sets `msg msg-you msg-right`
  (`index.html:2382`) with CSS, but an earlier spec measured leftGap=rightGap=0. Re-check: send
  "hey", confirm the bubble hugs the right edge at ≤~65% width.
- **S2 — Live Activity truncation (issue 10).** Labels were cut to "Con…"/"Inte…". `act-who`/
  `act-msg` now carry `title=` tooltips (`index.html:1471-1473`) so hover reveals full text;
  confirm the panel min-width is wide enough that meaning isn't lost at a glance.
- **S3 — Down-sandbox → honest suspect/unreachable.** Code paths return `suspect`/`unreachable`
  with the real error and never fake clean; not force-tested (can't take a real Cisco sandbox
  down). Re-check by pointing one adapter at a dead host and running a triage.

---

## What works well / verified honest (do not regress)

- **Permission gate — deny = zero wire calls (LIVE-VERIFIED).** In `ask` mode, denying a direct
  `show version` produced **no** session records at all and an honest "ran nothing" message. Gate
  code (`sources/approvals.js:133-141`) never calls `executeFn` on deny. Writes are blocked by the
  guardrail before the gate.
- **Honesty on every bad input.** Empty/whitespace, CLI typo ("sohw vlan br"), off-topic ("weather
  in Paris"), unknown @mention ("@Batman") — all decline, create no task, touch no device, invent
  nothing.
- **XSS is escaped.** `<script>…</script> show version` renders as text; all chat sinks use
  `escapeHtml` (`index.html:2385,2395-2398`).
- **Secret scrubbing holds on disk.** Persisted running-configs show `secret «redacted:…»`,
  `snmp-server community «redacted:…»`, cert PEM `xxxx`; **zero** of the six real sandbox
  credential values appear in any persisted file.
- **Flagship triage is real diagnosis, not a health poll.** "DC apps slow since 2pm, campus fine"
  parsed the 14:00Z window + DC scope, flagged all 3 ACI faults as pre-dating the window (not the
  cause), led the WAN card with top-3 alarm groups (chronic vs 2 new), took an honest first config
  snapshot, and committed a ranked hypothesis that weights the **unread F5 load balancer** as the
  high-risk lead — with if/then next check + confidence + why. Incident id `INC-20260816-001`, MTTR
  clock present.
- **Severity changes behavior (LIVE-VERIFIED).** P1 = parallel, 15s timeouts, L1–L4. P3 = sequential
  "leisurely full walk", 60s timeouts, L1+L2+L4 (no L3). Confirmed on two runs.
- **Re-triage & diff (LIVE-VERIFIED).** Re-running the P1 produced a real front-by-front
  before/after with counts, fault new/cleared, config diff (no drift), and a hypothesis-changed
  flag — linked to the same incident id without burning a new number.
- **Direct reads return real data.** `show version on sw1` → real IOS-XE 17.12.1 + mgmt IP
  10.10.20.175 from Catalyst Command Runner, screen-shared as a `command_share` with real raw output.
- **Docs** (engineer.md / slt.md / servicenow) are generated from the real record, UTC-labelled,
  and carry the "nothing fabricated" provenance line.
- **Dedup + ack-echo.** Duplicate check rows collapse to one row with an `×N` counter
  (`triage.js:442-466`, `index.html:2144-2178`); the "Command received" echo is gone from all paths.
- **Zero server-log errors / unhandled rejections** across every flow (161 log lines, clean).

---

## Launch-readiness verdict
- **Personal / owner use:** READY — honest, stable, no data invention.
- **NOC team beta:** READY WITH FIXES — B2/B3 (ServiceNow correctness) and B4 (reload persistence)
  should land before real operators rely on the ITSM export or leave the tab open.
- **Mass/public:** NOT YET — plus single-point-of-scale unknowns below.

## Scale-unknowns (not bugs; flag before multi-user)
- Shared Cisco DevNet sandbox credentials + one Anthropic key — per-caller rate limits exist but
  the upstream sandboxes and key are a single shared quota.
- Triage/records/config snapshots persist to the local workspace filesystem (single instance,
  in-memory triage state) — no shared store, no multi-instance.

## Not tested
- Real down-sandbox behavior (S3), pixel-level UI/theme/a11y rendering (screenshots blocked),
  concurrent multi-operator triage.

## Roadmap pointer (features, NOT bugs — do not build here)
Alert-driven auto-triage, direct ServiceNow API, PagerDuty/Opsgenie paging, change-calendar
correlation, persistent per-front baselines, multi-incident queue, SLA timers, recurring-issue
detection, blind-spot connect wizard, RBAC/leadership viewer, PDF/email export — tracked in
GOAL.md, out of scope for this fix loop.
