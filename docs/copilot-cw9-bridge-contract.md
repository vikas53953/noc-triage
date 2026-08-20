# CW-9 — Bridge Conduct (V2 split terminal) — PINNED CONTRACT

Vikas approved the prototype 2026-08-20 (docs/prototypes/bridge-call-prototype.html, look = **V2 split
terminal**; all 7 elements liked). This wave makes the live Jarvis chat behave like a real P1 bridge:
Jarvis = chief of staff / call leader. Two agents build in parallel in OWN CLONES against this contract.
Laws (HANDOFF.md) apply in full: intent-first (no keyword routing), ambiguity → ask, never fabricate,
deterministic code = safety only, XSS-escape at every display sink, secrets scrubbed.

**Class law for this wave:** ONE conduct layer shared by EVERY operator entry point (chat, triage intake,
any future path). The 2026-08-19 failure was a per-path fix (triage got ask-first, chat did not) — that
class of gap is the defect being fixed. No path-specific behavior rules.

## Evidence this fixes (squad/data/chat/chat-history.json, 2026-08-19)
"hey jarvis facing issue in epg" → Jarvis engaged 2 engineers, swept the estate, posted walls of raw agent
text, and said "You didn't name the EPG, so I can't chase a specific one yet" only at the END. Required
conduct: ask those 3 narrowing questions FIRST, run nothing, engage only who is needed after the answer.

## Pinned message envelope (WS broadcast + chat-store persistence; ADDITIVE — old fields keep working)
```js
msg = {
  role: 'jarvis' | 'operator' | 'agent' | 'system',
  kind: 'say' | 'ask' | 'roster' | 'finding' | 'verdict' | 'change',
  text: String,                    // jarvis say/ask: SHORT — hard cap 280 chars, enforced in code
  questions: [String],             // kind:'ask' — max 3, real narrowing questions from the planner
  roster: { engaged:   [{ agent, why }],          // one-line why each
            stoodDown: [{ agent, why }] },        // kind:'roster'
  finding: { agent, line,          // line: one-sentence meaning, hard cap 200 chars
             cli: { host, command, output,        // output: RAW (scrubbed of secrets), escape at sink
                    transport: 'ssh'|'cmdrunner'|'api' } },   // NEVER mislabel the transport
  verdict: { cause, confidence, rounds },         // kind:'verdict'
  change:  { id, steps: [String], state: 'held-for-approval' } // kind:'change'
}
```

## BACKEND — branch `feat/cw9-bridge-be` (clone ~/noc-cw9be)
OWNS: sources/jarvis.js, sources/investigation.js, sources/conduct.js (new), server.js chat routes,
sources/live-agents.js (evidence envelope only), sources/chat-store.js (persist new fields).
1. **One understanding gate.** Extract/point the existing triage understand step (triage.js ctx.understand)
   and the chat path at the SAME conduct module. Underspecified problem report in chat → planner returns
   up to 3 narrowing questions, kind:'ask', thread enters awaiting-info, ZERO agent engagement, ZERO reads.
   The operator's answer resumes the same understanding (remembered for the conversation, like PR #46).
   The LLM decides specificity — no keyword/regex tests (intent-first law).
2. **Brevity is code, not prompt-hope.** Jarvis say/ask text capped at 280 chars in the composition layer;
   agent raw output may NEVER appear in `text` — it travels only in finding.cli.output.
3. **Every read produces finding.cli** (host, exact command or API read, raw scrubbed output, honest
   transport label). Command Runner reads are transport:'cmdrunner' — never dressed up as SSH.
4. **Roster message** when engagement is decided: engaged + stood-down with one-line why each.
5. **Round-by-round:** reuse the CW-7 investigation loop for chat problem-reports; each round = one short
   jarvis 'say' (what we now know + next check) + finding messages as evidence arrives.
6. **Verdict → change:** when the cause is fixable, draft via the CW-2 change engine, kind:'change',
   state 'held-for-approval'. Never auto-apply (gate law unchanged).
7. **Kill canned walls:** the "you didn't name the X" end-of-dump pattern must be impossible — the gate (1)
   fires before any engagement. Unsupported asks get one honest LLM-composed line naming what IS possible;
   deterministic refusals remain for SAFETY only (writes/guardrail — unchanged).
8. Tests: extend existing suites; deterministic via stubbed planner (cover: vague chat ask → questions, no
   engagement; answer → scoped roster; finding envelope shape; caps enforced; canned-dump regression).
   One live-LLM pass on JARVIS_MODEL=claude-sonnet-5 replaying the EPG transcript verbatim.

## FRONTEND — branch `feat/cw9-bridge-fe` (clone ~/noc-cw9fe)
OWNS: public/desk.html (and public/index.html only if chat renders there too). Visual reference =
docs/prototypes/bridge-call-prototype.html, **V2** (chat left + persistent terminal right).
1. **Split layout:** chat column left; sticky terminal pane right showing a running SSH-style session —
   each finding.cli appends a block: header `host · transport`, prompt+command line, colored output
   (prompts blue, errors red, warnings amber), dark screen, mono, horizontal scroll inside the pane.
2. **Envelope rendering:** ask = blue-edge bubble + question list; roster = bridge card (engaged green
   pills, stood-down struck-through grey + "not relevant"); finding = one-line collapsed card in chat
   (expand = same CLI block inline); verdict = green cause card; change = amber "held for approval" card.
3. **Answering:** replying while the thread is awaiting-info posts to the resume endpoint (backend keeps
   route names stable; FE reads them from this contract's companion note in the PR if they must move).
4. XSS-escape every sink (raw cli output!). Reload restores both chat and the terminal session from
   chat-store. Mobile: terminal pane stacks under the chat. No regression to existing desk panels.

## Process (both agents)
Own clone (`git clone https://github.com/vikas53953/noc-triage "$HOME/noc-cw9be|fe"`), branch, PR — do NOT
merge. A DIFFERENT agent reviews live with an operator-experience pass: replay "hey jarvis facing issue in
epg" → must get narrowing questions and zero sweeps; walls of text = review blocker. Merge order: BE then
FE. After merge: restart :3000, live verify, evidence to Vikas as a visual page. Spend-wise: all live-LLM
testing on claude-sonnet-5.
