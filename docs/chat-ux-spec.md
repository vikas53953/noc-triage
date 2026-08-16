# Chat & Live Activity — professional UX spec (Fable drove the live app, 2026-08-16)

I (Fable) opened http://localhost:3000, sent real messages, and inspected the rendered DOM.
These are OBSERVED facts (current) vs REQUIRED. Implement to this exactly — do not reinterpret.
Reference feel: MS Teams / Webex chat, and Claude Code's collapsed "thinking" (chevron only).

## 1. User's own message — kill the "You → Agent" label AND actually right-align it
OBSERVED: the user row renders `🧑‍💻 You → Jarvis   12:37:24   hey` (and `You → Config-Keeper …`),
and it is NOT visually right-aligned (measured leftGap=0, rightGap=0 — it spans full width despite a
`msg-right` class).
REQUIRED (Teams/Webex): the user's OWN message is a bubble hugging the RIGHT edge (max ~65% width),
containing ONLY the message text + a small timestamp. Remove the whole `You → <Agent>` sender line —
no "You", no "→", no recipient name. Right-alignment must actually render. Agent/Jarvis responses stay
LEFT with agent icon + name + tier badge + timestamp.

## 2. Remove the "Command received" echo bubbles
OBSERVED: every send produces a separate `✅ Command received: "hey"` bubble (2 present) on top of the
real answer.
REQUIRED: drop the "Command received" echo entirely. The user's own bubble already shows what they sent;
the agent's real answer follows. No receipt echo.

## 3. Collapse control = chevron ONLY. No word labels. No step count.
OBSERVED: collapsibles read `▸ Config-Keeper  6 steps  Intent: domain_status — "show version on sw1"  12:38:23  show all`
and the chat toggle text is `show technical detail`.
REQUIRED: the collapse affordance is JUST a chevron (▸ collapsed / ▾ expanded). Remove ALL of:
"show all", "show technical detail", and the "N steps" count. The collapsed summary line is minimal and
clean — agent name + a short human purpose + time — nothing else. In Live Activity: same, just a clean
one-line collapsed entry with a chevron; no "N steps", no "show all".

## 4. What's INSIDE the expand — the engineer view, deduped. NOT internal bookkeeping.
OBSERVED (expanding a block): duplicated internal noise — e.g.
`Dashboard  Command to Config-Keeper: show version on sw1` (twice) · `Config-Keeper  Received command: …`
(twice) · `Intent: domain_status …` (twice) · `Config read — live data returned` (twice). The exact
command + raw output is only woven into prose, not presented cleanly.
REQUIRED: expanding shows the ENGINEER view, clean and DE-DUPLICATED — for each real check the agent ran:
  • **Command** — the exact command / API call actually run (e.g. `show version` via Command Runner, or
    `GET /api/node/class/fabricNode.json`).
  • **Reasoning** — why this check was run / what it would tell us.
  • **Output** — the real raw device/API response (scrubbed of secrets), scroll-contained if long.
  • **Conclusion** — what the real output means (or an honest "unreachable/unread" + the real error).
Remove ALL internal-bookkeeping lines ("Received command", "Command to X", "Intent: …", "live data
returned") and remove the duplication. Any engineer/SME/manager reading it must be able to follow exactly
what was run, why, what came back, and the conclusion — fully technical, nothing assumed.

## 5. The command MUST show for DIRECT agent questions too, not only triage delegations
OBSERVED: a direct "show version on sw1" to Config-Keeper produced prose + noisy activity blocks, but NOT
a clean command block. The real command/output must be surfaced for every agent read — direct AND
delegated. If the backend only emits `command_share` during delegation, extend it to direct reads too
(or render the equivalent from the session log). Real data only.

## Preserve (must not regress)
Evidence Split Console identity; light+dark themes; the triage split-console + evidence board + escalation
strip + verdict card (L4 = "L4 / Principal Engineer"); permission gate (deny=zero wire calls, writes
blocked); History/artifacts/docs; CLI drawer; maximize; Live Activity collapse; refresh-restore; Jarvis on
Opus 5; honesty (real command/output or honest unreachable, nothing invented); XSS escaping on every sink;
zero app console errors.

## Acceptance test (reproduce LIVE before claiming done — Fable will re-verify in the browser)
1. Send "hey" → your bubble on the RIGHT, no "You →" label, no "Command received" echo; Live Activity
   gets ONE clean collapsed line (chevron only, no "N steps"/"show all").
2. Ask Config-Keeper "show version on sw1" → response LEFT bubble; expand via chevron → shows the exact
   `show version` command + reasoning + the REAL raw output + conclusion, deduped, zero bookkeeping noise.
3. Run a Jarvis delegation → each engineer's real command block in the same clean, deduped format.
4. Both themes legible; zero console errors; nothing removed (all real detail reachable).
