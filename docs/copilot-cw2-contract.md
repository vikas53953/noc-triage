# CW-2 pinned contract — Change engine + drift checks

Both CW-2 agents build to THIS. A needed change is reported back first, never drifted into.

## Split
- BACKEND agent owns: sources/change-runner.js (new), drift endpoint logic (reuse config-store),
  capabilities.js updates (change + drift become available), guardrails.js pre-work fix, audit entries.
  Minimal additive edits to server.js routes. NOT public/*.
- UI agent owns: public/desk.html evidence-pane "Change wrap" and "Drift" tabs (replacing the CW-1
  placeholders) + the chat cards for change progress. Nothing in server.js/sources/*.

## Pre-work (backend, BEFORE the change engine — reviewer-logged debts that CW-2 leans on)
1. guardrails class fix: checkIntent must judge the COMMAND CLAUSE, not free prose/rationale — a
   delegated sub-question whose justification says "after the upgrade" must not be refused. (Bug class:
   verb-presence in non-command text.)
2. Compound "read then change" asks ("reload sw1 then show me the version") must get the honest
   "I ran/will run the read; I will NOT do the change" — capability refusal for the write half spoken
   out loud, read half still honored where safe.

## The change engine (the ONLY path that can write to a device)
- POST /api/copilot/change  { device, commands[], reason }  (operator name required — 428 rule applies)
- Pipeline, atomic, in order — if ANY step cannot run, the change does not happen and the record says why:
  1. GATE — permission mode auto/ask/deny via the existing approvals seam (deny = zero wire calls);
     the approval record shows device + exact commands + reason + operator.
  2. PRE-CAPTURE — running-config snapshot via the existing transport (Command Runner; SSH devices when
     CW-5 wires them) stored with the change record.
  3. APPLY — config push via Catalyst Center's config path for DNAC devices. Where NO write transport
     exists for a device, the engine must say exactly that ("no write path to this device yet") — never
     simulate success. Honest capability truth per device.
  4. POST-CAPTURE — snapshot again.
  5. DIFF + VALIDATION — pre/post diff, plus a health read (device reachable, no new criticals) →
     validation verdict recorded.
  6. ROLLBACK ARTIFACT — the exact commands to restore pre-state, stored with the record; a
     POST /api/copilot/change/:id/rollback replays them through the SAME engine (gate included).
- Change record: {id, ts, who, device, commands, reason, approval, pre, post, diff, validation,
  rollback, status: proposed|approved|denied|applied|failed|rolled-back} in its own store
  (change-store.js), every transition audited. Secrets scrubbed in all persisted text.
- LAW: full change access per Gate-1 decision, but EVERY change fully wrapped; a wrap step failure
  freezes the change with an honest status, never a silent half-change.

## Drift checks
- GET /api/copilot/drift/:device → compare live running-config vs the config-store baseline:
  {device, baselineTs, driftLines[{added|removed, line}], explainedBy? (change record id), verdict:
  clean|drifted|no-baseline}. "no-baseline" is an honest state, not an error.
- POST /api/copilot/drift/:device/rebaseline (operator-named, audited).
- If a drift line matches a change record's diff, say "explained by change chg-X (by <who>)".

## UI (desk evidence pane)
- Change wrap tab: the five-step vertical rail (approved mock's design) driven by REAL change records —
  live step progress, the diff, validation verdict, and a Rollback button (confirm dialog) that calls
  the real rollback route. Honest failure states per step.
- Drift tab: real drift results, plain-words verdict line first, the line-diff under it, re-baseline
  action, "explained by" links to the change record.
- Chat: "change vlan 20 name on sw2" style asks route to a change PROPOSAL card (device, commands,
  reason) the operator confirms before the engine runs — chat never fires a change directly.
- All operator actions stamped; capabilities map now shows change + drift available (their examples
  updated); everything XSS-escaped; both themes.

## Verification bar (both agents)
Live on the DNAC sandbox: a real harmless change (e.g. an interface description on sw2) through the full
wrap — approval, pre, apply, post, diff showing exactly the one line, validation pass, then a REAL
rollback restoring pre-state (diff empty after). Deny case = zero wire calls. No-write-path device case
honest. Drift: clean baseline → change → drift explained by the change → rebaseline → clean.
