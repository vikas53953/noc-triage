# CW-14 — adopt an agent runtime; stop hand-rolling the loop — CONTRACT (pinned 2026-09-05, NOT YET BUILT)

Vikas's ask, HIS WORDS (2026-09-05): "leverage multiple frameworks … the Anthropic SDK, the Anthropic
agent runtime framework, or the OpenAI framework. There is no point in building each and every thing. At
the end of the day we are building a tool wherein we have an agent runtime, a frontend, a backend, a
database layer … leverage the framework when it comes to agent runtime, orchestration or any other layer,
because there is no point in building the loop, tool calling and other things — those things are already
built. Use those." And later: "use the agentic framework … rather than building it from scratch. I really
don't want to make that mistake again."

Plus decision 7 (same day): Anthropic stays the model provider for now; "in the next iteration plug in the
other vendors like OpenAI and OpenCode — many really cheap options — I'm just building the product."

This is HANDOFF law 9 (adopt frameworks) and law 10 (provider-agnostic, cheap-first) turned into a wave.

## What we hand-rolled today (the mistake to stop repeating)

| Hand-written today | Where | What a runtime gives us instead |
|---|---|---|
| plan → delegate → gather → synthesize loop | `sources/jarvis.js` (~2,200 lines) | the agent loop, tool calling, parallel tool calls, retries |
| "who answers this" routing | `jarvis.js` planner + `live-agents.js` roster | agents + **handoffs** (Jarvis → Router-Expert is a handoff) |
| MCP client + registry | `sources/mcp-client.js`, `sources/mcp-connector.js` (CW-8/13) | MCP servers as first-class tools (stdio + hosted) |
| streaming chunks, 280-cap, say_delta | `jarvis.js` + `claude.js` + `conduct.js` | streamed run events |
| investigation rounds | `sources/investigation.js` (CW-7) | a run loop with `maxTurns` + our round observer as a hook |
| reflexion / lessons | `sources/reflexion.js` (CW-11) | stays ours (product logic), invoked as tools/hooks |
| provider wrapper | `sources/claude.js` (official Anthropic SDK, CW-10) | a provider adapter: model is config |

What is NOT hand-rolled and must SURVIVE unchanged (the laws — every reviewer checks these):
conduct gate (ask-first, `sources/conduct.js`), permission gate (`sources/approvals.js`, deny = zero wire),
read-only guardrail (`sources/guardrails.js`), scrubber (`sources/session-log.js`), evidence tagging
(`evidenceId`), verdict self-check, spend store, presence (CW-12), the chat envelope
(`docs/copilot-cw9-bridge-contract.md`), and the WS surface the two pages already speak. The runtime
sits INSIDE those boundaries; it never becomes a way around one.

## The pick (Vikas can veto in one word)

**Runtime: the OpenAI Agents SDK for JavaScript** — npm `@openai/agents` (0.17.x as of 2026-09-05) with
`@openai/agents-extensions` (`aisdk` adapter) so the model comes from the **Vercel AI SDK provider
packages**: `@ai-sdk/anthropic` today (Anthropic stays, decision 7), `@ai-sdk/openai`, OpenRouter or any
other provider tomorrow as a config line. Why this one, against the alternatives:

| Option | Handoffs (our squad) | MCP stdio (NetClaw) | Multi-provider | Runs in our plain-Node app | Verdict |
|---|---|---|---|---|---|
| **OpenAI Agents SDK (JS)** | first-class | first-class (`MCPServerStdio`) | via `aisdk()` adapter | yes | **pick** |
| Vercel AI SDK alone (`ai` 7.x) | no agent/handoff model (you write the orchestration) | yes (`experimental_createMCPClient`) | native, best | yes | fallback if the adapter path disappoints; it is already the model layer under the pick |
| Anthropic SDK Tool Runner (`client.beta.messages.toolRunner`) | no | hosted MCP connector only (URL servers), not stdio | Anthropic only | yes | contradicts decision 7 |
| Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) | subagents | yes | Anthropic only | it is the Claude Code harness (files/bash/edit) — wrong shape for a NOC copilot | no |
| Anthropic Managed Agents | multi-agent sessions | yes | Anthropic only; Anthropic-hosted sandbox | moves the loop off our box | no (decision 7 + we host) |

Honest risks of the pick, and what the spike measures: (1) tool-call fidelity through the `aisdk`
adapter with Anthropic models (parallel tool calls, structured outputs — our planner relies on strict
JSON); (2) the adapter's streaming events vs our `say_delta` + 280-cap; (3) how our permission gate hooks
into tool execution (the SDK's tool `needsApproval` / run hooks vs our `approvals.gate`); (4) token/spend
accounting per call (our spend store reads `usage`). Any of these failing → fallback to Vercel AI SDK
alone with our thin orchestration, still no hand-rolled loop.

## Stages (each = a PR with a DIFFERENT-agent adversarial review, laws-first)

| Stage | Deliverable | Done when |
|---|---|---|
| **A. Spike** (this wave) | `sources/runtime/` — one Jarvis ask end-to-end on the runtime: agent "Jarvis" with handoffs to the engineer agents, tools = our existing gate-wrapped reads (`live.gatherWithEvidence`) and `mcp:netclaw-catc:*` via `MCPServerStdio`, model = `aisdk(anthropic('claude-sonnet-5'))` for tests (spend rule) | the 4 flagship behaviours pass on the runtime with the SAME chat envelope on the wire: ask-first on a vague problem; a real delegated read with `evidenceId`; an honest write refusal with zero wire; a streamed answer ≤280 chars. A feature flag `JARVIS_RUNTIME=agents` selects it; default stays `legacy`. |
| **B. Parity + cut-over** | every path in `jarvis.js` (bridge/investigation rounds, reflexion, lessons, predictions) runs on the runtime; presence + spend + scrubber wired as run hooks | 24/24 e2e coverage map (`docs/e2e-coverage.md`) green on `JARVIS_RUNTIME=agents`; live on the PC; flag flips default |
| **C. Delete the loop** | `jarvis.js` planner/synthesis/loop code removed; `claude.js` becomes the provider config seam | `npm test` green with the hand-rolled loop gone; PROJECT/HANDOFF updated |
| **D. Second provider** (decision 7) | `MODEL_PROVIDER=openai|openrouter|anthropic` + per-purpose model map (cheap model for probes, better one for verdicts) | the same 4 flagship behaviours pass on a non-Anthropic provider; spend panel shows per-provider cost |

## Non-negotiables for the builder
- The runtime is a dependency, not a fork: no patched copies of framework code in the repo.
- Every tool the runtime can call is one of OUR gate-wrapped functions or an MCP tool through OUR
  connector posture (vetted read-only, redaction, audit). The runtime never gets a raw device/appliance
  client.
- Ambiguity → ask stays the FIRST step of every run (the conduct gate runs before the agent loop starts).
- The wire (WS envelopes, `say_delta`, presence, receipts) does not change — an old page must not notice.
- Tests are deterministic (scripted model via the provider's test transport) plus the LIVE proof on the PC.
- Spend rule: all testing on `claude-sonnet-5`; default model stays as configured in `.env.local`.

## Needs Vikas
- Veto/confirm the pick (one word). If "Vercel only" or "Anthropic only", the table above says what changes.
- For stage D: an OpenAI or OpenRouter key in `.env.local` on the PC (never in the repo).
