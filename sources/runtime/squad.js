// runtime/squad.js — CW-14 stage A: the squad as framework AGENTS + TOOLS.
//
// Plain words: the same roster the legacy planner reasons over (ctx.roster() —
// the engineer agents plus every connected MCP tool) becomes, here, one Agent
// per engineer with Jarvis holding a HANDOFF to each, and a small set of tools
// whose `execute` is one of OUR gate-wrapped functions:
//
//   delegate_read({agentId, question, device, incidentId})
//       → ctx.gather(...)  — the SAME delegated read jarvis.js makes
//         (live.gatherWithEvidence: permission gate + read-only guardrail +
//         session log + terminal evidence). The tool result the model sees is
//         the finding's text plus its evidence block, tagged with a stable
//         evidenceId, so the answer can cite it and a reviewer can trace it.
//   mcp__<server>__<tool>({question, args_json})
//       → mcp.gather(id, question, {args})  — every MCP call keeps the CW-8
//         connector posture (vetting, read-only classification, redaction,
//         audit). The runtime NEVER gets the SDK's own MCP client. A tool the
//         connector classifies as a WRITE is built with needsApproval:true so
//         the run PAUSES before it executes; stage A always rejects that pause
//         (approve-first stays with the change engine).
//
// HONESTY BY CONSTRUCTION. Every execute is wrapped: a throw, a hang, a null or
// an empty result becomes an explicit, honest "no reading" string the model is
// told is not evidence — never a fabricated reading, never a silent drop.
// There is no write tool. The runtime cannot change a device because nothing
// it can call can.

const conduct = require('../conduct');
const mcp = require('../mcp-connector');

// Same bound as jarvis.js: a delegated read that hangs must still resolve to a
// finding the operator can read.
const GATHER_TIMEOUT_MS = Math.max(1000, Number(process.env.JARVIS_GATHER_TIMEOUT_MS) || 90000);

let evidenceSeq = 0;
// Same id shape live-agents.js uses for its evidence scopes (`ev-…`), so a
// reader of the session log and a reader of the chat see one vocabulary.
function newEvidenceId() {
  return `ev-${Date.now().toString(36)}-${(++evidenceSeq).toString(36)}`;
}

// A tool name the provider accepts (^[a-zA-Z0-9_-]{1,64}$). Stable for a given
// roster id, so the model sees the same tool from one run to the next.
function toolNameFor(id) {
  const parsed = mcp.parseToolId(id);
  const base = parsed ? `mcp__${parsed.server}__${parsed.tool}` : String(id);
  return base.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

function noResponse(agentId, name, text) {
  return { agentId, name: name || agentId, connected: true, stance: 'unreachable', text };
}

// The bounded, honest read. Mirrors jarvis.js gatherGuarded: timeout → "no
// response", rejection → "could not complete", null/empty → "came back empty".
async function gatherGuarded(ctx, { agentId, question, device, incidentId }) {
  const name = (ctx.nameOf && ctx.nameOf(agentId)) || agentId;
  const secs = Math.round(GATHER_TIMEOUT_MS / 1000);
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(noResponse(agentId, name,
      `No response — ${name} did not return anything within ${secs}s. The device or source did not answer in time, ` +
      `so I have no reading to show for this. Nothing was invented, and nothing was sent to any device on a guess. ` +
      `Try again, or narrow it to one device.`)), GATHER_TIMEOUT_MS);
  });
  const work = Promise.resolve()
    .then(() => ctx.gather(agentId, question, device || null, incidentId || null))
    .catch((err) => noResponse(agentId, name,
      `The read could not complete — ${err && err.message ? err.message : 'an unexpected error'}. ` +
      `No reading to show, and nothing was invented.`));
  try {
    const f = await Promise.race([work, timeout]);
    if (!f || typeof f !== 'object') {
      return noResponse(agentId, name,
        `No response — ${name} returned nothing at all for this. The read did not complete, so there is nothing to show.`);
    }
    if (!String(f.text || '').trim()) {
      return { ...noResponse(agentId, f.name || name,
        `No response — ${f.name || name} came back empty for this. There is nothing to show, and nothing was invented.`),
        stance: f.stance && f.stance !== 'evidence' ? f.stance : 'unreachable' };
    }
    return f;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// The finding as ENVELOPES (one per terminal block, or one honest line when
// the read produced no terminal evidence) — exactly what jarvis.js emitFindings
// posts, plus the additive evidenceId so the desk / a reviewer can tie the
// model's answer back to the read. Old clients ignore the extra field.
function findingEnvelopes(name, finding, evidenceId) {
  const cli = finding && Array.isArray(finding.cli) ? finding.cli : [];
  if (!cli.length) {
    return [{ ...conduct.envelope.finding({ agent: name, line: finding.text, cli: null }), evidenceId }];
  }
  return cli.map((e) => ({
    ...conduct.envelope.finding({ agent: name, line: e.line || `${name} ran "${e.command}" on ${e.host}.`, cli: e }),
    evidenceId,
  }));
}

// What the MODEL is handed back as the tool result: the finding's text, its
// stance (evidence / denied / not-connected / unreachable — said plainly so a
// non-reading is never mistaken for one), and the capped evidence blocks.
function renderForModel(name, finding, evidenceId, envelopes) {
  const stance = String((finding && finding.stance) || 'evidence');
  const head = `evidence[${evidenceId}] ${name} (${stance})`;
  const note = stance === 'evidence'
    ? ''
    : `\nNOTE: this is NOT a reading — it is an honest "${stance}" outcome. Report it as such; do not infer any device state from it.`;
  const blocks = envelopes
    .map((env) => env.finding && env.finding.cli)
    .filter(Boolean)
    .map((c) => `--- terminal evidence ${evidenceId} · ${c.host} · ${c.transport}${c.source ? ` · ${c.source}` : ''} ---\n${c.host}> ${c.command}\n${c.output}`);
  return `${head}\n${String((finding && finding.text) || '').trim()}${note}${blocks.length ? `\n${blocks.join('\n')}` : ''}`;
}

// Wrap ANY execute so a throw is an honest string the model reads as a
// failure, never a fabricated result and never an exception that strands the
// run. The SDK has its own default error function; this one is ours so the
// wording is the app's ("no reading, nothing invented") on every path.
function honest(name, fn) {
  return async (...args) => {
    try {
      const out = await fn(...args);
      if (out == null || !String(out).trim()) {
        return `evidence[none] ${name}: the tool returned nothing. There is no reading to show, and nothing was invented.`;
      }
      return String(out);
    } catch (err) {
      return `evidence[none] ${name}: the tool could not complete — ${err && err.message ? err.message : 'an unexpected error'}. ` +
        `No reading to show, and nothing was invented. Say so to the operator; do not guess.`;
    }
  };
}

function rosterLine(a) {
  const head = `- ${a.id} (${a.name})` + (a.connected ? '' : ' [NOT CONNECTED]');
  const sees = a.sees && a.sees.length ? `\n    sees: ${a.sees.join('; ')}` : '';
  const note = a.note ? `\n    note: ${a.note}` : '';
  return head + sees + note;
}

const JARVIS_INSTRUCTIONS =
`You are Jarvis, the L4 / Principal Engineer of a live NOC (network operations) squad, on a bridge call.
The operator talks to you in plain words.

YOU HAVE NO NETWORK DATA OF YOUR OWN. The only way to learn anything about the network is the
delegate_read tool (a real, gated read by one named engineer) or a listed MCP tool. Never state a
device fact you did not get back from a tool result in THIS conversation. If a tool result says
"not connected", "denied", "unreachable" or "no response", report exactly that — never fill the
gap with a guess. Every tool result is tagged evidence[<id>]; you may cite those ids.

Delegate the SMALLEST set of reads that answers the question. Ask each engineer a concrete
sub-question they can actually see (their "sees" list below). For a question that is entirely one
engineer's domain you may hand off to that engineer instead. Never ask for a change: this path is
read-only, every write is refused before it reaches a device, and any change goes through the
change engine, approve-first.

Answer the operator SHORT — one or two plain sentences (hard cap 280 characters, enforced by the
console). The raw readings are already on the operator's screen as evidence cards; do not repeat
them. Say what the evidence shows and what it does not.`;

function engineerInstructions(a) {
  return `You are ${a.name} (${a.id}), an engineer on a live NOC squad, handed a question by Jarvis.
You can see ONLY: ${(a.sees && a.sees.length) ? a.sees.join('; ') : 'nothing listed'}.
${a.connected ? '' : 'You are NOT CONNECTED to any live source right now — say so plainly; never invent a reading.\n'}
To read anything, call delegate_read with agentId "${a.id}" and a concrete question. Never state a
device fact that did not come back from a tool result tagged evidence[<id>]. Answer SHORT (under
280 characters): what the reading shows, and what it does not.`;
}

/**
 * Build the squad for one run.
 *   ctx      — the host ctx (roster / nameOf / gather / abilities …)
 *   model    — the aisdk-wrapped model from runtime/model.js
 *   hooks.onFinding(agentId, name, finding, evidenceId, envelopes)
 *            — called with every delegated read's envelopes (the runtime posts
 *              them on the wire as `finding` messages).
 * Returns { jarvis, engineers, idOfAgent(name), agentOfTool(name), toolIds, mcpTools }.
 */
async function build(ctx, { model, hooks } = {}) {
  const { Agent, tool, handoff } = await import('@openai/agents');
  const { z } = await import('zod');
  const onFinding = (hooks && typeof hooks.onFinding === 'function') ? hooks.onFinding : () => {};

  const roster = (ctx.roster && ctx.roster()) || [];
  const engineersOnRoster = roster.filter((a) => a && a.id && !mcp.isMcpId(a.id));
  const mcpOnRoster = roster.filter((a) => a && a.id && mcp.isMcpId(a.id));
  const ids = engineersOnRoster.map((a) => a.id);

  // ── delegate_read: the gate-wrapped delegated read ─────────────────────
  const delegateRead = tool({
    name: 'delegate_read',
    description:
      'Ask ONE named squad engineer to make ONE real, read-only check and report back with terminal evidence. ' +
      'Goes through the permission gate, the read-only guardrail and the session log. ' +
      'Returns the finding text plus an evidence[<id>] block; a denied / not-connected / unreachable outcome is reported honestly.',
    parameters: z.object({
      agentId: ids.length ? z.enum(ids) : z.string(),
      question: z.string().describe('The concrete sub-question for that engineer, in plain words.'),
      device: z.string().nullable().describe('The exact device hostname for a device-CLI read, or null.'),
      incidentId: z.string().nullable().describe('One of this console\'s own incident ids when the question is about it, or null.'),
    }),
    execute: honest('delegate_read', async ({ agentId, question, device, incidentId }) => {
      const name = (ctx.nameOf && ctx.nameOf(agentId)) || agentId;
      const evidenceId = newEvidenceId();
      const finding = await gatherGuarded(ctx, { agentId, question, device, incidentId });
      const shown = (finding && finding.name) || name;
      const envelopes = findingEnvelopes(shown, finding, evidenceId);
      try { onFinding(agentId, shown, finding, evidenceId, envelopes); } catch (e) { /* display never breaks the read */ }
      return renderForModel(shown, finding, evidenceId, envelopes);
    }),
  });

  // ── MCP tools: one per connected roster entry, through OUR connector ────
  const toolIds = new Map();     // tool name → roster id
  const mcpTools = [];
  for (const entry of mcpOnRoster) {
    const name = toolNameFor(entry.id);
    if (toolIds.has(name)) continue;
    toolIds.set(name, entry.id);
    const readOnly = entry.readOnly === true;
    mcpTools.push(tool({
      name,
      description:
        `${entry.name}: ${(entry.sees || []).join('; ') || 'external MCP tool'}. ` +
        (readOnly
          ? 'Read-only; runs through the MCP connector (gate + audit).'
          : 'Looks like a WRITE — it is never auto-run; calling it pauses for approval and stage A always declines.'),
      parameters: z.object({
        question: z.string().describe('What you want to learn from this tool, in plain words.'),
        args_json: z.string().describe('The tool\'s arguments as a JSON object string, or "{}".'),
      }),
      // A write-classified tool PAUSES the run before executing (the SDK's
      // approval interruption) — the runtime rejects it, so it never runs.
      needsApproval: !readOnly,
      execute: honest(name, async ({ question, args_json }) => {
        let args = {};
        if (args_json && String(args_json).trim() && String(args_json).trim() !== '{}') {
          try { const o = JSON.parse(args_json); if (o && typeof o === 'object' && !Array.isArray(o)) args = o; }
          catch (e) { return `evidence[none] ${name}: the arguments were not a JSON object — nothing was called, nothing was invented.`; }
        }
        // approved:false ALWAYS on this path: the connector refuses a write
        // itself even if the pause above were ever bypassed. Belt and braces.
        const evidenceId = newEvidenceId();
        const finding = await mcp.gather(entry.id, question, { args, who: 'jarvis', approved: false });
        const envelopes = findingEnvelopes(entry.name, finding, evidenceId);
        try { onFinding(entry.id, entry.name, finding, evidenceId, envelopes); } catch (e) { /* display never breaks the call */ }
        return renderForModel(entry.name, finding, evidenceId, envelopes);
      }),
    }));
  }

  // ── The engineers: one Agent each; Jarvis holds a handoff to every one ──
  const engineers = engineersOnRoster.map((a) => new Agent({
    name: a.name || a.id,
    instructions: engineerInstructions(a),
    model,
    tools: [delegateRead],
  }));
  const idOfName = new Map(engineersOnRoster.map((a) => [a.name || a.id, a.id]));

  const jarvis = new Agent({
    name: 'Jarvis',
    instructions:
      `${JARVIS_INSTRUCTIONS}\n\nSquad roster (the only things that can see the network):\n` +
      (roster.length ? roster.map(rosterLine).join('\n') : '(nobody on the roster — nothing can be read right now; say so)') +
      `\n\nWhat you can do yourself, for a greeting or a "what can you do" ask:\n` +
      abilitiesText((ctx.abilities && ctx.abilities()) || []),
    model,
    tools: [delegateRead, ...mcpTools],
    handoffs: engineers.map((e) => handoff(e)),
  });

  return {
    jarvis, engineers, mcpTools, toolIds,
    idOfAgent: (name) => idOfName.get(name) || null,
    agentOfTool: (name) => toolIds.get(name) || null,
  };
}

function abilitiesText(list) {
  if (!Array.isArray(list) || !list.length) return '(capability list unavailable)';
  return list.map((a) => {
    const state = a.available ? 'AVAILABLE' : (a.engineBuilt ? 'BUILT, NOT CONNECTED' : 'NOT YET');
    const why = !a.available && a.reason ? `  (why not: ${a.reason})` : '';
    return `- ${a.label} [${state}]: ${a.plain}${why}`;
  }).join('\n');
}

module.exports = {
  build,
  _test: { gatherGuarded, findingEnvelopes, renderForModel, honest, toolNameFor, newEvidenceId, GATHER_TIMEOUT_MS },
};
