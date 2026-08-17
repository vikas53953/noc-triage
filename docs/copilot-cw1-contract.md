# CW-1 pinned contract — Desk shell + identity + capability honesty

Both CW-1 agents build to THIS. Neither changes it unilaterally; a needed change is reported back first.

## Split
- BACKEND agent owns: sources/capabilities.js (new), name middleware + `/api/capabilities` route in
  server.js (minimal additive edits), audit-log extension in session-log.js. NOT public/*.
- UI agent owns: public/desk.html (new file, the entire cockpit). NOT server.js/sources/*.

## Operator identity
- Client stores the operator name once (localStorage) and sends header `X-Operator-Name` on every request.
- Backend middleware: if the header is present, req.operator = scrubbed name (printable, ≤64 chars);
  actions recorded by existing stores/activity include `operator` when set. No auth in v1 (Gate-1 decision).
- Missing header on a state-changing copilot call → 428 `{error:"Tell me your name first."}` (read-only GETs pass).

## Capability map
- GET /api/capabilities → `{ abilities: [ {key, label, plain, available, reason?} ] }`
  - available:false MUST carry `reason` (e.g. "Teams not connected — needs a webhook").
  - The map is the single source of truth in sources/capabilities.js; server routes and honest
    refusals both read from it. Initial keys: ask, run-command, change (available:false reason "change
    engine arrives in CW-2"), drift (false, CW-2), tickets (false, CW-3), teams (false, CW-4 + webhook),
    investigate, bridge.
- Honest refusal: an ask outside the map returns/renders "I can't do that yet — here's what I can do"
  + the available list. Never a wrong answer, never a silent dead-end.

## Desk (public/desk.html) — Direction C cockpit, per the approved mock
- Three panes: LEFT work queue (real GET /api/incidents; severity stripes; SLA state), CENTER Jarvis
  conversation (wired to the REAL existing chat/triage APIs — read server.js and reuse what index.html
  uses; no new endpoints), RIGHT evidence board (tabs: findings / command output / change wrap
  (placeholder "arrives in CW-2") / drift (placeholder) / bridge).
- Name gate on first visit → header set on all fetches; every rendered action stamped "by <name>".
- Honest states everywhere: empty, loading, error, not-connected. XSS-escape every sink. Both themes.
- Link to/from the classic console (index.html adds ONE nav link — the UI agent may add that single
  anchor to index.html as its only touch there).
- Live updates: reuse the existing broadcast/SSE/websocket mechanism index.html uses.

## Laws (unchanged, absolute)
Real data or honest absence. Deny = zero wire calls. Read-only guardrail until CW-2's change engine.
Secrets scrubbed. Operator tz on times. Audit: every copilot action logged {who, what, device?, result}.
