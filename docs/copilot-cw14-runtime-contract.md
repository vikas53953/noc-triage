# CW-14 — adopt an agent runtime; stop hand-rolling the loop — CONTRACT (pinned 2026-09-05; stage A built, PR #81)

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

## Spike result (2026-09-05, offline, scratchpad → `test/cw14-runtime-spike.mjs`) — every named risk retired

Mock Anthropic transport (JSON + SSE) under `@ai-sdk/anthropic` → `aisdk()` → `@openai/agents` 0.17.0:

| Risk | Result |
|---|---|
| (1) tool-call fidelity through the adapter with an Anthropic model | the model's `tool_use` ran OUR function, the SDK sent the `tool_result` back, the model answered — the loop is the SDK's; parallel tools not yet exercised |
| handoffs | Jarvis → Router-Expert (generated tool `transfer_to_Router_Expert`) → read → answer; `lastAgent` is Router-Expert |
| (3) permission gate seam | a tool with `needsApproval: true` PAUSES the run with an interruption before executing; `state.reject()` resumes with the tool never run — this is exactly `approvals.gate` deny = zero wire |
| MCP stdio | `MCPServerStdio` spawned the real NetClaw catc-mcp, listed its 10 tools, the model called `catc_find` and got the real local-catalogue result. (Stage A will NOT use the SDK's MCP client directly — every MCP call still goes through our connector posture — but it proves the shapes agree.) |
| (2) streaming | `run(..., {stream:true})` yields `raw_model_stream_event` text deltas (our `say_delta`) plus item/agent events (our presence) |
| (4) spend | `rawResponses[i].usage` carries input/output tokens |

12/12 checks. Not proven offline: structured outputs for the planner's strict JSON (stage A measures), and behaviour parity on the 4 flagship behaviours (stage A's bar).

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

## Stage A — as built (PR #81, branch `feat/cw14-runtime-a`)

`sources/runtime/` behind `JARVIS_RUNTIME=agents` (default stays `legacy`); `server.js` hands the runtime
the IDENTICAL `jarvisCtx` object `jarvis.init` gets, so the wire is the same seam.

| File | What it is |
|---|---|
| `sources/runtime/index.js` | the front door `ask()`: conduct gate FIRST (same ask / refusal envelopes as `jarvis.js`), capability screen, then `run()` on the SDK with `stream:true`, `maxTurns`, an outer abort bound; streamed deltas through the same 280-cap discipline; presence via `claude.activity`; approval pauses rejected and said; the honest failure line on any error; **tracing disabled before the first run** |
| `sources/runtime/squad.js` | the roster as Agents: Jarvis (tools = `delegate_read` + one `mcp__<server>__<tool>` per connected MCP roster entry, handoffs to every engineer); each engineer (one tool, `read_as_<id>`, bound to itself). Every execute is one of OUR gate-wrapped reads (`ctx.gather` → live-agents, or `mcp.gather` with `approved:false`); a write-classified MCP tool is built with `needsApproval:true` so the run pauses — stage A always rejects. Every tool has an `errorFunction` in the app's honest words. Model settings: `maxTokens 3000`, top-level `cache_control` (prompt caching) |
| `sources/runtime/model.js` | the provider seam (law 10): `MODEL_PROVIDER` → Vercel AI SDK provider → `aisdk()`; stall timeout on the provider fetch; usage → spend store in claude.js's record shape (each response once); a test transport seam |
| `sources/runtime.cw14.test.js` | 89 deterministic checks, offline: the 4 flagship behaviours, MCP pause/reject, error paths, spend, provider seam, the flag, and §10 = every round-1 review finding |

Review round 1 (adversarial, different agent — it hit its quota before a verdict; findings taken from its
transcript) found, and 22f3634 fixed at class level: the SDK's tracing exporter posting spans to OpenAI when
`OPENAI_API_KEY` is set; no timeout on a hung model call; spend double-counted on a pause/resume; the
"@Name — question" line and status flip firing before argument validation (with SDK boilerplate reaching
the model); an engineer able to read as another engineer and its answer posted as Jarvis; `max_tokens`
128000 + no caching; the raw key in a cache signature. Round 2 reviewed the fixes.

Known, accepted for stage A (stage B items): the server-side presence span during a handed-off engineer's
model call is attributed to Jarvis while the deltas are the engineer's (the FE shows both); the model does
not get the legacy planner's strict-JSON plan step (the runtime plans by calling tools); no `thinking`
block on runtime calls yet; the legacy path's "🧠 Let me think…" bubble has no runtime equivalent (the
runtime streams the model's own narration instead).

Needs the PC (real key): one ask with `JARVIS_RUNTIME=agents` in `.env.local` — expect the same desk
behaviour as legacy, plus `[Jarvis] Runtime → tool …` lines in the activity log; confirm the provider
accepts the top-level `cache_control` on the configured model (if it 400s, unset it in
`squad.js modelSettingsFor` and say so in TRACKER).
