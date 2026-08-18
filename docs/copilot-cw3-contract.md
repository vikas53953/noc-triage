# CW-3 pinned contract — Built-in ticket queue

Both CW-3 agents build to THIS. Internal queue is the SINGLE SOURCE OF TRUTH for tickets (Gate-1 decision);
ServiceNow (CW-6) becomes a mirror that syncs when connected — never a second truth.

## Split
- BACKEND owns: sources/tickets.js + sources/ticket-store.js (new), ticket routes + capabilities update in
  server.js (minimal additive block), audit entries. NOT public/*.
- UI owns: public/desk.html ticket-queue pane + the chat proposal/confirm for ticket actions. NOT server/sources.

## Data model (ticket-store.js — one store per fact, JSON like incident-store)
ticket = { id: 'TKT-YYYYMMDD-NNN', ts, createdBy, severity(P1-P4), title, description, status:
  open|assigned|in-progress|resolved|closed, assignee|null, incidentId|null (link to a triage/incident),
  worknotes:[{ts, who, text}], history:[{ts, status, by}], snow:{ id|null, syncedAt|null } (CW-6 mirror slot) }
Secrets scrubbed in all persisted text. Operator name required (CW-1 X-Operator-Name; 428 if missing on writes).

## Backend API
- GET  /api/copilot/tickets            → { tickets:[...] }  (open/recent; filterable by status/assignee)
- GET  /api/copilot/tickets/:id        → full ticket
- POST /api/copilot/tickets            → create { severity, title, description, incidentId? } → ticket
- POST /api/copilot/tickets/:id/assign → { assignee }
- POST /api/copilot/tickets/:id/status → { status } (validated transitions; closing needs a resolution note)
- POST /api/copilot/tickets/:id/note   → { text } appends a work note
- capabilities.js: `tickets` flips available:true with an example ("open a P2 for the branch-3 slowness").
- INTENT-FIRST: chat "open a ticket for X" reaches the planner; the planner composes a ticket PROPOSAL from
  real context — chat NEVER creates a ticket directly. Do NOT add keyword routing; the capability + a
  create tool is what the planner uses. The desk confirm actually POSTs.

## UI (desk ticket-queue pane)
- A queue pane (its own tab or left-column section): real GET /api/copilot/tickets — severity stripe, status
  chip, assignee, linked incident. Click a ticket → detail with work notes + actions (assign, status, note).
- Chat: a ticket-intent ask → a PROPOSAL card (severity, title, description, linked incident) with an
  explicit "Create ticket" confirm; never fires directly. Every action operator-stamped.
- Honest empty/loading/error states; XSS-escape every sink; both themes; mobile.
- "Create from this incident" affordance on an incident → prefills a ticket linked to it.

## Laws
Real data or honest empty; never fabricate a ticket/assignee; deny/permission unaffected (tickets are app
state, not device wire calls); audit every ticket transition {who,what,ticket,result}; internal queue is truth.

## Verify (deterministic; LLM path awaits credits — mark pending)
Create → appears in GET; assign → assignee set + audit; status transitions validated (can't close without
resolution note); work note appends with operator; link to a real incident; 428 without operator name;
XSS payload in title/description escaped. Desk: queue renders real tickets, proposal card confirms create,
actions work, honest states. Full test suite green + new ticket tests.
