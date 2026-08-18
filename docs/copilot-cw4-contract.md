# CW-4 pinned contract — Teams bridge integration

Both CW-4 agents build to THIS. Jarvis posts incident/bridge updates to a Microsoft Teams channel and
surfaces replies back into the bridge. HONEST "not connected" until Vikas supplies the webhook — the
integration ships fully working with an honest disabled state, activated when TEAMS_WEBHOOK is set.

## Split
- BACKEND owns: sources/teams.js (new), Teams routes + capabilities update in server.js (minimal additive
  block adjacent to CW-3's), notifier hook, audit. NOT public/*.
- UI owns: public/desk.html bridge presence + Teams echo panel. NOT server/sources.

## Config & honesty
- `TEAMS_WEBHOOK` (env, in .env.local) = a Microsoft Teams Incoming Webhook URL. Absent → the feature
  reports `connected:false` everywhere and posts nothing (never pretends). Present → real POSTs.
- Secret: the webhook URL is a secret — never logged, never returned by any API (only a boolean
  `connected` + last-post status). Scrub it from everything persisted.
- capabilities.js: `teams` stays `available:false` with reason "Teams not connected — add a webhook"
  when TEAMS_WEBHOOK is unset; flips to `available:true` when set. `engineBuilt:true` always (like CW-2).

## Backend
- sources/teams.js: `post({title, text, facts?, incidentId?})` → POSTs a Teams MessageCard/Adaptive Card
  to the webhook; returns {ok, connected, status}. On no webhook → {ok:false, connected:false} and
  posts NOTHING. On HTTP error → honest {ok:false, error} (scrubbed), never a fake success.
- Auto-posts on real bridge events (approval-needed / verdict committed / SLA breach) — reuse the
  notifier seam (like ONCALL_WEBHOOK) so it's one place, not sprinkled.
- Replies: Teams Incoming Webhooks are ONE-WAY (post only). A true two-way (reading replies) needs a
  Teams bot registration, which is out of scope for a webhook. So: build the POST path for real; for
  "surface replies", provide an honest interface + a `POST /api/copilot/teams/inbound` endpoint that a
  future bot/Power-Automate flow can call to inject a reply into the bridge — documented as "reply
  ingestion ready, needs a Teams bot/flow to feed it." Do NOT fake inbound replies. State this limit
  clearly (like CW-2's no-write-path honesty).
- Routes: `GET /api/copilot/teams/status` → {connected, lastPost}; `POST /api/copilot/teams/test` →
  (operator-named) posts a test card, honest result; `POST /api/copilot/teams/inbound` → inject a reply
  (for a future bot).
- INTENT-FIRST: no keyword routing. Auto-posts are event-driven; a chat "post this to Teams" reaches the
  planner which calls the post tool after confirm — never a keyword trigger.

## UI (desk bridge panel)
- A "Bridge & Teams" section: named people on the incident (roles/roster from existing bridge data) +
  a Teams status pill (connected / "not connected — add a webhook") + last-post echo + any injected
  inbound replies. Honest not-connected state; a "post update to Teams" action (operator-confirmed) when
  connected. XSS-escape every sink; both themes; mobile.

## Laws
Real posts or honest not-connected — NEVER a fake "sent to Teams ✓"; webhook is a secret (never shown);
audit every post {who, incident, result}; deny/gate unaffected (Teams is app egress, not device wire).

## Verify (deterministic; a real post needs Vikas's webhook — mark pending)
No webhook → status connected:false, test-post honest "not connected" (nothing sent), capabilities teams
unavailable with reason. With a dummy webhook (httpbin-style) → real POST fires, status shows lastPost,
capabilities flips available. Inbound endpoint injects a reply into the bridge. Webhook never appears in
any response/log. UI shows honest not-connected + roster. Full suite green + new teams tests.
