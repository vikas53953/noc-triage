# CW-6 pinned contract — Two-way ServiceNow

Both CW-6 agents build to THIS. The INTERNAL ticket queue (CW-3) is the SINGLE SOURCE OF TRUTH;
ServiceNow is a MIRROR that syncs when connected. HONEST "not connected" until Vikas supplies creds.

## Split
- BACKEND owns: sources/servicenow-client.js (new), the sync logic hooked into tickets.js/ticket-store.js
  (the snow:{} mirror slot already exists on the ticket model), ServiceNow routes + capabilities update in
  server.js (block adjacent to CW-4's), audit. NOT public/*.
- UI owns: public/desk.html — the ServiceNow mirror line on a ticket becomes live (synced INC number +
  link + last-sync + honest not-connected), plus a "push to ServiceNow" / "pull updates" action. NOT server/sources.

## Config & honesty
- `SNOW_INSTANCE` (e.g. dev12345.service-now.com), `SNOW_USER`, `SNOW_PASS` in .env.local. Any missing →
  the feature reports `connected:false`, syncs nothing (never fakes an INC number). All three present →
  real ServiceNow Table API calls (Basic auth over HTTPS).
- SECRET: creds never logged, never returned by any API (only connected boolean + last-sync status +
  the real INC sys_id/number which is not a secret). Scrub creds from everything persisted.
- capabilities.js: `servicenow` available:false + reason "ServiceNow not connected — add instance + creds"
  when unset; available:true when all set; engineBuilt:true always.

## Backend (servicenow-client.js + sync)
- Real ServiceNow Table API (/api/now/table/incident): create INC from an internal ticket, update it
  (state/work notes/assignment), and pull its current state back. Basic auth; honest error on 401/403/timeout.
- The INTERNAL ticket is truth: a sync PUSHES the internal ticket to ServiceNow (create if snow.id null,
  else update) and records snow:{id, number, syncedAt}; a PULL reads the SNOW incident and surfaces its
  state/worknotes as a mirror WITHOUT overwriting internal truth unless the operator confirms a merge.
  Conflict (both changed) → surface honestly, never silently clobber.
- Routes: GET /api/copilot/servicenow/status {connected, lastSync}; POST /api/copilot/tickets/:id/snow/push
  (operator-named) → creates/updates the SNOW INC, returns {number, url}; POST …/snow/pull → mirror state.
- PINNED pull response shape (the UI reads EXACTLY this — do not drift):
  `{ ok, connected, conflict, mirror:{ stateLabel, updatedOn, worknotes[] }, ticket }`.
  The persisted `ticket.snow.{mirror, conflict, mirroredAt}` carries the same so a RELOAD still shows a
  pending conflict. The UI must render mirror columns from `mirror.*` (and from `ticket.snow.mirror` on load),
  never invented top-level fields.
- Honest not-connected: every route with no creds → {connected:false}, does nothing, no fake INC.
- INTENT-FIRST: no keyword routing; a chat "open a ServiceNow ticket for this" goes via the planner +
  confirm, calling the push tool — never a keyword trigger. Auto-sync (optional) only on explicit operator opt-in.

## UI
- On a ticket's detail: the ServiceNow slot shows real synced INC number + link + last-sync when connected,
  honest "not connected — add instance + creds" otherwise; a "Push to ServiceNow" / "Pull updates" action
  (operator-confirmed); a clear conflict state if both sides changed. XSS-escape; both themes; mobile.

## Laws
Real sync or honest not-connected — NEVER a fabricated INC number/sync; internal queue is truth; creds are
secrets (never shown); audit every sync {who, ticket, snow-number, result}; deny/gate unaffected.

## Verify (deterministic; a real sync needs Vikas's SNOW instance — mark pending)
No creds → status connected:false, push/pull honest "not connected" (no INC created), capabilities
unavailable with reason. With a stub/dummy SNOW endpoint (a local catcher returning a fake sys_id/number)
→ push creates + records snow:{id,number,syncedAt}, pull mirrors state, conflict surfaced not clobbered.
Creds never in any response/log. UI shows real INC link when connected, honest otherwise. Full suite green
+ new servicenow tests. The structured ServiceNow EXPORT (existing artifacts.js) stays as the fallback.
