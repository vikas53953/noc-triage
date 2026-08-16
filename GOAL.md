# OVERNIGHT MISSION — QA every feature → spec → fix (2026-08-17, Vikas asleep)

Vikas: "run the QA end-to-end of every feature, create a spec file, then implement."
Autonomous overnight. Treat as THE goal. No fabrication ever. He reviews a visual report in the morning.

## Loop (drive via the /loop wake; survive quota gaps — resume, never give up)
1. FINISH in-flight: fix/delegated-fields (agents drop mgmt IP / software version / EPGs on delegation) —
   review by a different agent, merge when it passes, tick here.
2. QA SWEEP — enumerate bugs across EVERY feature into docs/qa-bugs-spec.md (severity-ranked). Sources:
   - the comprehensive QA agent (WS/API + code + honest browser where it works),
   - Vikas's own QA report (below), and Fable's own browser DOM/WS ground-truth checks on key flows.
3. FIX in waves, collision-safe (one owner per file; different files run in parallel; shared files sequential):
   each fix → a DIFFERENT agent reviews live → merge to master → tick the spec → next.
4. After each merge, restart the localhost:3000 server so it stays live for Vikas.
5. Keep going until a full QA sweep passes clean OR capacity is exhausted (then resume on the next wake).
6. Morning: publish a writeable visual report (feedback layer) — every bug found, fixed/▢, with evidence.

## Known backlog (already reported — fold into the spec, fix these for sure)
- [DONE] Delegated agents drop fields → FIXED+merged (PR #21): EPGs, mgmt IPs, sw version now real; declines honestly for fields the adapter lacks.
- [done] Chat auto-scroll (real scroll container, near-bottom-aware) — merged; browser-confirm in the morning.
- ServiceNow export (Majors 1-3): State should be In-Progress/On-Hold when the verdict rests on an unverified
  blind spot (not Resolved); fix CI parsing (LF-101 split into "1"/"101"); strip tag artifacts (unread:/none/clean:/blind:).
- Reload persistence (Major 4): chat/DM + Live Activity survive a refresh (persist + restore).
- Timezone labeling (Major 5): every timestamp labelled UTC+local; the parsed-symptom window carries a TZ.
- Minors: markdown rendered in chat bubbles; @mention switches the To: chip + autocomplete; Re-check spinner;
  disabled Send state; actor mislabel ("Responded to @Jarvis" for a NetOps DM); leadership-doc slow load.
- Roadmap (features, NOT fixes — leave as a backlog for Vikas to prioritise, do NOT build overnight):
  alert-driven auto-triage, direct ServiceNow API, PagerDuty/Opsgenie paging, change-calendar correlation,
  persistent per-front baselines, multi-incident queue, SLA/cadence timers, recurring-issue detection,
  blind-spot connect wizard, RBAC/leadership viewer, PDF/email doc export.

## Non-negotiable (all fixes)
Honesty (real or honest-missing, never invented); permission gate (deny=zero wire calls, writes blocked);
read-only guardrail; secret scrubbing; Jarvis on Opus 5 (JARVIS_MODEL override kept); Evidence Split Console
identity + professional chat/collapse UX; XSS escaping on every sink; rate limits; the triage brain
(symptom filter/deltas/groups/config-finding/ranked blind spots/hypothesis) and ops lifecycle intact; zero console errors.

## Status log
- 2026-08-17 ~00:xx: mission set. delegated-fields fix in flight. QA sweep starting.
- 2026-08-17 ~00:xx: delegated-fields fix merged (PR #21, reviewed MERGE). QA sweep still running.
