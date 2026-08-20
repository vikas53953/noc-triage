# CW-10 — Production Plumbing — PINNED CONTRACT

Vikas approved 2026-08-20 (architecture verdict page, all sections LIKED; "go ahead with remaining task"
at ~15:50 IST — he reviews everything at ~23:30 IST). Laws in HANDOFF.md apply in full. CW-9's conduct
layer is UNTOUCHABLE product logic: this wave replaces PLUMBING under it, never behavior. Any behavioral
diff visible in chat output (beyond streaming) is a defect.

## Scope (6 items + 2 LOW leftovers)
1. **Official Anthropic SDK** (`@anthropic-ai/sdk`, JS): replace the hand-rolled HTTP client + hand-rolled
   transient-retry in the claude wrapper (sources/*claude*). Keep the EXISTING wrapper surface
   (claude.reason etc.) so jarvis.js/conduct.js call sites stay stable — swap the internals. Typed errors:
   RateLimitError/APIConnectionError/etc. mapped to the wrapper's existing honest-failure semantics.
   Model policy unchanged: default claude-opus-5, JARVIS_MODEL env override (tests on claude-sonnet-5).
   Thinking: adaptive default (omit the param on opus-5; pass {type:"adaptive"} where needed). NEVER pass
   temperature/top_p (400 on opus-5). json_schema outputs stay via output_config.format.
2. **Prompt caching**: restructure request assembly so the big stable system prompts are byte-stable and
   FIRST, volatile content (timestamps, per-turn state) LAST; add cache_control {type:"ephemeral"} on the
   stable system block. Audit for silent invalidators (Date.now()/uuid in system, unsorted JSON, varying
   tool lists). Verify with usage.cache_read_input_tokens > 0 on the second call of a conversation.
3. **Streaming**: SDK .stream() for Jarvis's user-facing answers; broadcast incremental text over the
   existing WS as a new additive envelope kind:'say-delta' {messageId, delta, done} — the final buffered
   message stays the authoritative record (old clients that ignore deltas still work). FE: render deltas
   progressively in the chat bubble, replace with the final message on done. Never stream raw agent
   evidence — only Jarvis's composed text.
4. **Token accounting**: after every model call, record {ts, conversationId|incidentId, purpose
   (understand|plan|probe|synthesize|...), model, input_tokens, output_tokens, cache_read, cache_creation}
   to sources/spend-store.js (JSON, rotated). Endpoint GET /api/spend/summary (per-day + per-purpose +
   per-model totals). Desk: small "Spend" panel (totals today / this week, per-purpose bars). NEVER log
   prompt contents in the spend store.
5. **Server-side web search + fetch**: add web_search_20260209 + web_fetch_20260209 (max_uses caps) to
   Jarvis's REASONING calls only (not probes), so Jarvis can check vendor docs/known bugs mid-investigation.
   Results are labeled honestly in chat as web sources ("per cisco.com/...") — never presented as device
   evidence, never entering finding.cli. Capability map entry web-research available:true. If the API
   rejects the tool on the account, degrade honestly (capability off), never crash.
6. **Compaction**: beta header compact-2026-01-12 + context_management edits [{type:"compact_20260112"}]
   on the long-conversation paths; ALWAYS append full response.content back (compaction blocks preserved).
   If the beta errors, fall back silently to current behavior.
7. **LOW leftovers**: (a) scrubber: short device-error prose over-scrub case from the final review (see
   PR #73 last review comment); (b) FE cosmetic F4: non-string array members render as [object Object] —
   render a safe stringified form.

## Hard rules
- Conduct/guardrails/gate/scrubber behavior identical (their suites must pass untouched).
- All 26 suites green + new suites for: wrapper-over-SDK (mock transport), spend store, delta envelope,
  cache-hit verification (skippable when no API key). Live checks on claude-sonnet-5 only (spend-wise):
  one streamed bridge answer, one cache-hit proof, one web-search answer labeled as web source.
- package.json gains @anthropic-ai/sdk (first runtime dep — justified, it IS the adopt-don't-build law).
  npm install must work offline-tolerant (vendor the lockfile).
- Split: BE branch feat/cw10-plumbing-be (items 1,2,4-be,5,6,7a) / FE branch feat/cw10-plumbing-fe
  (items 3-fe, 4-panel, 7b) against this envelope. BE merges first.

## Process
Own clones (~/noc-cw10be, ~/noc-cw10fe), PRs, DIFFERENT-agent adversarial review (behavior-parity focus:
diff chat output vs pre-CW-10 master on the same stubbed inputs), merge, restart :3000, live verify,
evidence folded into Vikas's 23:30 review page.
