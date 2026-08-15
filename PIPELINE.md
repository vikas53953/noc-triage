# PIPELINE — NOC Triage (Evidence Split Console)

**Project:** `noc-triage` — a real NOC/SOC incident-triage app. Forked from
mission-control 2026-08-15 to carry its hardened read-only live-data engine
(`sources/` adapters + guardrails + workspace/origins/ratelimit security).
mission-control (the network-squad dashboard) stays a SEPARATE untouched project.

**Repo:** https://github.com/vikas53953/noc-triage (PRIVATE), branch `master`.

## The product (approved by Vikas, Gate 1 + Gate 2, 2026-08-15)
An issue comes in (P1/P2/P3). Jarvis (the **L4 / Principal Engineer**) opens a
triage bridge and pulls the relevant tier engineers. Each investigates from its
own front with REAL live data. The screen is the **Evidence Split Console**
(mock direction C, all 5 sections liked):
- Left: bridge conversation as narration.
- Right: an **evidence board** — one card per network front (Campus / Fabric /
  WAN / Incidents / blind-spot fronts hatched grey) that fills in and re-colours
  (green/amber/red) live as engineers post.
- Top: escalation progress strip L1 → L2 → L3 → L4.
- Chat window MAXIMIZE button; Live Activity COLLAPSE button.
- Light AND dark theme toggle.

### NOC tiers (from Gate 1)
- **L1** Monitor-Eye — acknowledge, basic live sweep, escalation call.
- **L2** NetOps, Incident-Handler — investigation tier, live front findings.
- **L3** Router-Expert, Config-Keeper — SMEs, device-deep (real `show` via
  Command Runner / fabric analysis).
- **L4 / Principal Engineer** Jarvis — runs the bridge, correlates, posts the
  verdict + next checks + blind spots. Named "L4 / Principal Engineer", NOT
  "Manager" (Vikas's instruction 2026-08-15).

### Rules carried from mission-control (non-negotiable)
- No fabricated data or capability. Every number traces to a live read seconds
  earlier, or the agent says "not connected" / "I can't answer that, ran nothing".
- Read-only enforced in code (guardrails). Refusals spoken, naming what was refused.
- Not-connected engineers stay OFF the bridge, named as blind spots.

## Stage table
| # | Stage | Status |
|---|-------|--------|
| 0 | Intake | done — forked, repo created |
| 1 | Unknowns | done — Gate 1 approved (tiers, flow, staffing) |
| 2 | Requirements | done — Gate 1 page approved |
| 3 | Mocks | done — Gate 2, Vikas picked C (Evidence Split Console) |
| 4 | Design | folded into build brief (Vikas said proceed) |
| 5 | Build | IN PROGRESS — branch feat/evidence-split-console |
| 6 | Review | pending — different agent |
| 7 | QA | pending |
| 8 | Ship | pending — visibility + auth decisions |

## Answered forks
- Triage start: MANUAL (Vikas opens with severity + description).
- Bridge flow: TWO ROUNDS (front findings → L4 correlation verdict).
- Staffing: SEVERITY DECIDES (P1 all-hands; P2/P3 relevant fronts).
- Live data from day one (Option A — reuse the hardened engine).
- Known nit inherited: "triage my landlord problem" dictionary overlap — fix here.
