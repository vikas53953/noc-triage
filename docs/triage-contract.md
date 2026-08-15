# Triage contract — the seam between backend and UI

Both the triage engine (backend) and the Evidence Split Console (UI) build to
THIS document. Neither may change it unilaterally — if a change is needed, it is
flagged for the coordinator. This is what lets the two halves be built in parallel.

## REST
- `POST /api/triage` body `{ severity: "P1"|"P2"|"P3", description: string }`
  → `{ triageId }`. Starts a triage. Rate-limited like other endpoints.
- `GET /api/triage/:id` → full current triage object (for reconnect/refresh).
- `GET /api/triage` → list of recent triages (id, severity, title, status, openedAt).

## WebSocket events (server → client), all carry `triageId`
Emitted in real time as the bridge runs. `type` field values:

1. `triage_opened`
   `{ type, triageId, severity, title, description, openedAt,
      staffed: [{ agent, tier }],           // tier ∈ "L1"|"L2"|"L3"|"L4"
      blindSpots: [{ front, reason }],       // agents NOT on the bridge
      fronts: ["campus","fabric","wan","incidents", ...] }`  // board cards to render, in order

2. `triage_progress`  — escalation strip state
   `{ type, triageId, tier, status }`        // status ∈ "pending"|"active"|"done"

3. `triage_message`   — one post on the bridge (chat narration, left side)
   `{ type, triageId, agent, tier, severity, round,   // round ∈ 1|2
      text, ts }`

4. `triage_evidence`  — one evidence-board card update (right side)
   `{ type, triageId, front, state, detail, source, ts }`
   // state ∈ "waiting"|"clean"|"degraded"|"suspect"|"blind"
   // front matches a value from `fronts`; "blind" = hatched grey, no data source
   // detail = short live fact ("4/4 reachable, health 100"); source = e.g. "Catalyst Center"

5. `triage_verdict`   — L4 correlation (Round 2 close)
   `{ type, triageId, verdict, impact, nextChecks: [string], blindSpots: [{front,reason}], ts }`

6. `triage_closed`    `{ type, triageId }`  // engineers return to idle

## Front → source mapping (backend fills, UI just renders)
- campus     → Catalyst Center (inventory, health)
- fabric     → ACI (leaf/spine, faults)
- wan        → SD-WAN vManage (devices, alarms)
- incidents  → Catalyst issues + ACI faults (combined)
- blind spots (state "blind"): firewall (no FMC), loadbalancer (F5, no Cisco sandbox),
  security (no CVE feed) — named, never invented.

## Tiers (roles)
- L1 Monitor-Eye — ack + basic sweep + escalation call (round 1 opener).
- L2 NetOps, Incident-Handler — investigation (round 1).
- L3 Router-Expert, Config-Keeper — SME device-deep (round 1, P1/P2 only).
- L4 Jarvis — **displayed as "L4 / Principal Engineer"**, never "Manager". Runs the
  bridge, posts `triage_verdict` in round 2.

## Honesty rules (inherited, non-negotiable)
- Every `detail`/`text` number came from a live read seconds earlier, or the front is
  `blind` / the agent says it is not connected. No invented data, ever.
- Not-connected engineers never post `triage_message`; they appear only as blindSpots.
- If a live read fails mid-bridge, that front's evidence state is `suspect` with the real
  error in `detail` (e.g. "APIC login failed (ETIMEDOUT)") — never faked clean.

## Severity → staffing
- P1: all connected tiers (L1+L2+L3+L4).
- P2: L1+L2+L3.
- P3: L1+L2 (L4 still posts the verdict).
