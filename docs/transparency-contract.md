# Transparency bugfix contract (v2.1) — the seam between backend events and UI rendering

Vikas found, using the live app, that the console hides what's happening. Fix so ANY tier
(L1/L2/L3/SME/L4/Principal/manager) watching can follow exactly what each agent does and how
Jarvis routes — fully technical, nothing assumed. Two agents build to THIS contract:
BACKEND (server.js + sources/*) emits; FRONTEND (public/index.html) renders. Do not change
the contract unilaterally.

## Bug → fix map
1. Roster stuck "idle": backend ALREADY emits `agent_status`; frontend has NO handler. FE must
   render a live status light (active/green ↔ idle) that flips the instant an agent is engaged
   or Jarvis delegates to it, and back to idle when done — like the mission-control green light.
2. Live Activity panel blank: backend ALREADY emits `activity_new`; frontend has NO handler.
   FE must render the running activity feed into the Live Activity panel.
3. Jarvis CLI empty: Jarvis makes no device calls so it has no session_record. BACKEND must
   capture Jarvis's reasoning as session records so clicking Jarvis's CLI shows how/where it
   routed. FE renders them in the existing CLI/session view.
4. Commands not shown in chat: during a Jarvis delegation each engaged agent must "share its
   screen" IN THE CHAT — the check it's about to run, the exact command/API call, the raw
   output, and its reasoning/conclusion. BACKEND emits this detail; FE renders it richly
   (technical, escaped, collapsible if long). Plus Jarvis's final "how I concluded" reasoning.

## WS events (backend → client)  — all wrapped as {type, data, timestamp}, broadcast() already does this
- `agent_status`  data: { agentId, status: "active"|"idle", note?: string }
  Emit `active` the moment an agent is engaged / delegated-to / starts a read; `idle` when its
  turn ends. Cover EVERY engagement path (direct message, triage tier turn, Jarvis delegation,
  retry). Class fix — wrap the read/turn, don't sprinkle per-caller.
- `agents_updated` data: { agents: [{id,name,status,...}] }  (already emitted; FE may use either
  agent_status for deltas or agents_updated for full refresh — render both).
- `activity_new`  data: { source, text, ts }  — one line per meaningful event (engaged, ran X,
  delegated to Y, verdict). FE appends to the Live Activity panel.
- `session_record` data: existing shape { agent, host?, command, raw, interpretation, ok, status,
  durationMs, ts, ... }. BACKEND additionally emits jarvis-tagged reasoning records:
    { agent: "jarvis", kind: "reasoning", command: <step label: "INTENT"|"PLAN"|"DELEGATE →
      router-expert"|"SYNTHESIS">, raw: <the real detail: the parsed intent, the chosen agents +
      the exact sub-question sent to each, the final synthesis text>, interpretation: <why this
      step / why these agents>, ok: true, ts }
  So Jarvis's CLI shows its full routing chain. Never fabricate — these are the real plan/routing
  actually produced by the Claude call.
- `command_share` (NEW) data: { agent, tier, purpose, command, raw, reasoning, conclusion, ts }
  Emitted by the backend for each real check an engaged agent runs during a delegation/triage:
    purpose   = what this check is FOR ("confirm ACI fabric health")
    command   = the exact command / API request issued (real)
    raw       = the real raw output/response (secret-scrubbed, reuse Phase B scrubber)
    reasoning = why run it, what it would tell us
    conclusion= what the real output means (derived from raw, no invention; "unread/unreachable"
                if the read failed)
  FE renders each as a technical block in the CHAT stream (screen-share feel), escaped, so all
  tiers can follow. This is IN ADDITION to the existing summary chat_message.

## Honesty (unchanged, absolute)
Every command/raw/number is real (from an actual read) or the block says "not connected /
unread / unreachable" with the real error. No fabricated commands, output, or reasoning. Secret
scrubbing (passwords/tokens/usernames) applies to `raw` in session_record AND command_share.

## Preserve
Everything already working: Evidence Split Console look, light/dark, maximize, collapse,
refresh-restore, permission gate (deny = zero wire calls, writes blocked), artifacts+docs,
Jarvis real reasoning, XSS escaping on every sink (incl. the new command_share + jarvis records),
rate limits, read-only guardrail. L4 = "L4 / Principal Engineer".
