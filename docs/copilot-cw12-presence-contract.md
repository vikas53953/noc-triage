# CW-12 — Live Presence ("who is typing") — CONTRACT (recorded 2026-08-20; BUILT 2026-09-05, see the "As built" note at the end)

Vikas's ask, HIS WORDS (2026-08-20 ~23:45 IST): "when i send some questions to jarvis... down in the chat
it should be showing who is typing, like when we type in whatsapp or in ms chat. it should be showing that
the question has been picked up, like by showing the emojis on the message. whenever jarvis or any agent is
writing, it should be showing who is writing in the application so that it feels like the application is
alive and any user does not feel like it is silent."

## Scope (design sketch — builder refines, laws in HANDOFF.md apply)
1. **Message receipt** — the operator's just-sent message gets a small state marker: sent → picked up
   (Jarvis has started on it) → answered. Like WhatsApp ticks / an emoji reaction on the message.
2. **Typing indicators** — a presence line at the bottom of the chat: "Jarvis is typing…" while a reply is
   being composed (the CW-10 say_delta stream already signals exactly this window), and
   "Router-Expert is checking…" while a delegated agent's probe is in flight (live-agents already emits
   status — surface it as presence, per agent, with the agent's name).
3. **TRUTH RULE (the class law for this wave):** presence must be driven by REAL events only — a "typing"
   indicator may only show while a model call or agent read is actually in flight, and must clear the
   moment it ends (including error/abort paths). A fake pulsing indicator on a dead request is a
   fabrication-class defect. Wire it to the same signals that already exist:
   - say_delta start/done (CW-10) → Jarvis typing
   - ctx.status('agent','active',...) transitions (server.js broadcast) → agent working presence
   - approvals gate wait → "waiting for your approval" presence (honest, not "typing")
4. Additive WS envelope (suggested): {type:'presence', data:{actor, state:'picked-up'|'typing'|'checking'|
   'waiting-approval'|'done', messageId?}} — old clients ignore it. Receipt markers ride the operator
   message envelope additively.
5. Both pages (desk + classic) via the shared public/cw9-bridge.js module. XSS-escape actor names.

## Process (same as every wave)
Contract → BE/FE split, own clones/branches, PRs, DIFFERENT-agent adversarial review (operator-experience
pass: does it FEEL alive without ever lying about activity?), merge BE first, restart :3000, live verify,
visual evidence page. Tests: presence appears only during real in-flight work; clears on done/abort/error;
never survives a reload as a ghost.

## As built (2026-09-05, Claude Code web session)
- Wire shape shipped exactly as suggested in 4, plus `thinking` (a model call in flight that is not yet
  streaming), `since`, `label` (the real status/purpose string, title-only) and `reason` on `done`
  (done | error | aborted | denied | expired). Pinned in `sources/presence.js`.
- Signals: claude.js `setActivityListener` (start/stream/end of EVERY model call, end from `finally`);
  `updateAgentStatus` for engineer agents (Jarvis excluded — its active spans include waiting on others);
  the approvals gate broadcast for waits. Receipts: `picked-up` fires right before the handler runs;
  `answered` is derived on the page from the server's `requestId` stamp on the reply. No "read" state.
- Truth belts: the init snapshot carries only live flights (10-minute expiry, honest `expired` reason);
  a socket drop clears the line; nothing is persisted; restored ticks that are not `answered` are swept.
- Tests: sources/presence.cw12.test.js, sources/desk.cw12.ui.test.js. Fixture: test/cw12-fixture.js.
