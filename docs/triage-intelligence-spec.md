# Triage intelligence spec — make it real triage, not a health poll (Vikas, 2026-08-16)

Vikas ran real triages and found the console runs the SAME fixed sweep for every complaint and
produces near-identical verdicts. The 7 gaps below turn it into diagnosis. Honesty rules unchanged:
every number/finding is a real read or an honest "not connected/unread/unreachable". No fabrication.

Build order: WAVE 1 (data layer, parallel, different files) → WAVE 2 (brain: triage.js + jarvis.js)
→ WAVE 3 (UI) + review. Each wave: build → different-agent review → merge.

## The 7 gaps
1. **Use the symptom.** Parse the complaint for a TIME ANCHOR ("since 2pm") and SCOPE ("DC, not
   campus"). FILTER evidence by them: ACI faults have `created`/`lastTransition`; vManage alarms have
   `entry_time`. "2 ACI faults, both >3 weeks old" ≠ "2 faults, one raised 13:58." Verdict must reflect
   what's IN the incident window and IN scope.
2. **Baseline / delta.** Standing noise (220 alarms) is chronic. Persist each sweep's per-front counts;
   lead with the delta: "wan: 220 alarms (baseline 218, +2 since last sweep)". Storage already exists
   (record.json per triage) — add a small per-front baseline store.
3. **Severity changes behavior.** P1 = sweep fronts in PARALLEL with aggressive timeouts, go straight
   to the impacted/in-scope front first. P3 = leisurely full sequential walk. The picker must change
   cadence/parallelism/timeouts, not just a label.
4. **Alarm aggregation.** Cluster alarms by device / site / severity / first-seen; lead with the top-3
   groups: "top 3 alarm groups: X (140, chronic), Y (60, chronic), Z (20, started 13:52)." One such line
   beats the whole raw count.
5. **Change correlation (the missing front).** Snapshot each device's running-config per run; diff vs the
   last snapshot. Turns Config-Keeper's honest "no drift claim" into a real finding: "no config change on
   sw1–sw4 in the incident window" (rules out a cause class) or "sw2 changed at 13:55 — inside the window."
6. **Rank blind spots by relevance to the complaint.** For "DC apps slow," the F5/load-balancer blind
   spot is the likely culprit's hiding place, not a gray footer. Jarvis weights blind spots per incident:
   "load-balancer blind spot is HIGH-RISK for this symptom — check F5 manually first."
7. **Jarvis commits.** Not "3 fronts degraded" (status) but a ranked HYPOTHESIS with a disambiguating
   if/then next step + confidence + why: "Most likely: fabric fault FF0104 in tenant X impacting DC
   east-west; check A — if clean, pivot to WAN path B. Confidence: medium, campus reads clean."

## WAVE 1 — data layer (parallel; each agent owns ONE area; expose pure functions, DO NOT wire triage.js)
### DATA-1 — sources/aci.js
Return per-fault objects: `{code, severity, created, lastTransition, tenant, node, descr}` (real APIC
faultInst fields). Add exports: `clusterFaults(faults)` → groups by severity+tenant with counts and
`newestTs`; `countByAge(faults, windowStart)` → {inWindow, older}. Keep existing behavior working.
### DATA-2 — sources/sdwan.js
Return per-alarm objects with `{severity, entry_time, device/host, site, type}` (real vManage alarm
fields). Add `clusterAlarms(alarms, {sinceTs})` → top-N groups by (type|device|site) each with
`{count, firstSeen, chronic:boolean, newCount}`; and a total count. Keep existing behavior.
### DATA-3 — NEW sources/baseline-store.js + NEW sources/config-store.js + sources/catalyst-center.js
- baseline-store: `record(front, count)` persists per-front counts (path-safe, under workspace);
  `previous(front)` → last count for delta. Gitignored data.
- config-store: `snapshot(device, runningConfig)` saves per-device config per run; `diff(device,
  newConfig)` → {changed:boolean, when, unified?}; honest if no prior snapshot.
- catalyst-center.js: add `getRunningConfig(deviceId)` via Command Runner (`show running-config`,
  read-only, guardrail-safe) so config-store has real input. Secret-scrub as elsewhere.

## WAVE 2 — brain (ONE agent: sources/triage.js + sources/jarvis.js + sources/live-agents.js)
Consume Wave-1 exports to implement gaps 1,2,3,5(diff-as-finding),6,7:
- jarvis.js: parse complaint → `{timeAnchor?: ts, scope?: [fronts/sites], rawSymptom}` (use the real
  Claude call — it already reasons; add structured symptom extraction to the plan schema). Rank blind
  spots by symptom relevance (gap 6). Synthesis must COMMIT: ranked hypothesis + if/then next step +
  confidence + why (gap 7) — strictly from real findings, honest when data is thin.
- triage.js: filter faults/alarms to the symptom window+scope (gap 1); severity-driven orchestration —
  P1 parallel + short timeouts + impacted-front-first, P3 sequential full walk (gap 3); attach deltas
  from baseline-store to each front (gap 2); run config diff and surface as a real finding (gap 5);
  emit the richer evidence (groups, deltas, in-window counts) on the existing events.
Everything stays honest: a filtered-out fault isn't hidden dishonestly — say "2 faults, both pre-date
the incident window" rather than dropping them silently.

## WAVE 3 — UI (public/index.html)
Render: per-front DELTA ("220 (baseline 218, +2)"); the top-3 ALARM GROUPS with chronic/new; the
CONFIG-DIFF finding; BLIND SPOTS ranked/weighted (high-risk highlighted) per the complaint; and the
VERDICT card as a committed HYPOTHESIS (ranked, if/then next check, confidence, why) instead of a
status line. Keep the Evidence Split Console look, collapse pattern, themes, escaping.

## Preserve (all waves)
Honesty (real or honest-missing, never invented), permission gate (deny=zero wire calls, writes
blocked), read-only guardrail, secret scrubbing, Evidence Split Console identity + collapse UX, Jarvis
on Opus 5, XSS escaping, rate limits, artifacts/docs, refresh-restore, zero console errors.

## Acceptance (reproduce LIVE; Fable re-verifies in browser)
- Report "DC apps slow since 2pm, campus fine" → verdict reflects the 2pm window + DC scope (faults
  older than the window are called out as pre-existing, not counted as the cause); campus not dwelt on.
- A front shows a DELTA vs baseline, not just an absolute count.
- WAN card leads with top-3 alarm groups (chronic vs new).
- Config-Keeper produces a real change finding ("no change in window" or "sw2 changed 13:55").
- Same complaint at P1 vs P3 behaves differently (parallel/fast vs full/sequential).
- Blind spots weighted by the symptom (load-balancer flagged high-risk for a DC-slow complaint).
- Jarvis commits to a ranked hypothesis + if/then next check + confidence, not "3 fronts degraded".

## Smaller fixes (issues 8-11, added by Vikas)
8. **Duplicate check lines.** Monitor-Eye (and others) post identical "check — read the X front" rows
   2-3× per front (retries rendered as separate identical rows). COLLAPSE consecutive identical check
   rows into ONE row with an attempt counter ("×3"). Fix at the source (don't emit dupes) and/or dedupe
   consecutive identical rows in the UI.
9. **Command-received echo.** The "✅ Command received: …" echo on every message doubles the scroll for
   zero info. REMOVE it everywhere (direct chat AND bridge). Reserve acknowledgements for genuinely SLOW
   operations only (a subtle "working…" while a long read runs) — never a receipt on every message.
   [NOTE: a prior PR removed it for direct chat; verify it's gone from ALL paths incl. the triage bridge.]
10. **Live Activity truncation.** Labels cut to "Con…", "Inte…". Give the Live Activity panel a wider
    min-width and/or a title tooltip so the full text is reachable. Don't truncate the meaning away.
11. **Ops lifecycle (NOC adoption).** Add:
    - **Incident ID** surfaced to the operator (stable, human-readable, e.g. INC-YYYYMMDD-NNN).
    - **MTTR clock** — a running timer from triage open → verdict/close, shown and stored.
    - **Re-triage & diff** — a "re-run this triage" action that runs the same triage again and shows the
      DELTA vs the last verdict ("what changed since the last verdict?": fronts that improved/worsened,
      new/cleared faults & alarms, config changes). Reuses record.json.
    - **ITSM export** — a ServiceNow-ready summary (structured: incident id, short description, severity,
      affected CIs, findings, verdict/hypothesis, next steps, MTTR) derived from the real record — a copy/
      download action alongside the existing slt.md/engineer.md.
    All real data only; honest where data is missing.

## Wave mapping (file ownership — avoids collisions)
- WAVE 1 (parallel): DATA-1 aci.js · DATA-2 sdwan.js · DATA-3 baseline-store.js + config-store.js + catalyst-center.js
- WAVE 2 (brain, sequential): triage.js + jarvis.js + live-agents.js — gaps 1,2(wire),3,4(wire),5,6,7 + issue 8 source-side (no dup emission)
- WAVE 3 (lifecycle, sequential after brain): triage.js + artifacts.js — issue 11 backend (incident id, MTTR, re-triage+diff, ServiceNow export)
- WAVE 4 (UI, after 2+3): public/index.html — display gaps 1-7 (deltas, groups, config-diff, ranked blind spots, hypothesis), issue 8 (collapse dup rows + counter), 9 (kill ack echo everywhere), 10 (truncation width/tooltip), 11 UI (incident id, MTTR clock, re-run button, export button)
- Then integration review + Fable re-verifies a real triage in the browser.
