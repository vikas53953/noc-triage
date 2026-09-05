// cw14-runtime-spike.mjs — CW-14 stage-A de-risk (2026-09-05): OpenAI Agents SDK + aisdk adapter + @ai-sdk/anthropic,
// NOT part of npm test until stage A adds the dependencies. Run: node test/cw14-runtime-spike.mjs
// (needs @openai/agents, @openai/agents-extensions, ai, @ai-sdk/anthropic, zod installed).
// fully OFFLINE against a mock Anthropic transport. Proves: tool loop, handoff, approval interrupt
// (our permission gate seam), and a REAL stdio MCP server (NetClaw catc-mcp) as tools.
import { Agent, run, tool, handoff, MCPServerStdio, setTracingDisabled } from '@openai/agents';
import { aisdk } from '@openai/agents-extensions/ai-sdk';
import { createAnthropic } from '@ai-sdk/anthropic';
import { z } from 'zod';
setTracingDisabled(true);

// ── mock Anthropic Messages API (JSON + SSE) ──
const calls = [];
let script = [];   // each entry: {tool:{name,input}} | {text} — consumed per request
function msg(content, stop) { return { id: 'msg_' + calls.length, type: 'message', role: 'assistant', model: 'claude-sonnet-5', content, stop_reason: stop, usage: { input_tokens: 42, output_tokens: 7 } }; }
function sse(m) {
  const ev = [['message_start', { type: 'message_start', message: { ...m, content: [], stop_reason: null } }]];
  m.content.forEach((c, i) => {
    if (c.type === 'text') { ev.push(['content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } }]); ev.push(['content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: c.text } }]); }
    else { ev.push(['content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: c.id, name: c.name, input: {} } }]); ev.push(['content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(c.input) } }]); }
    ev.push(['content_block_stop', { type: 'content_block_stop', index: i }]);
  });
  ev.push(['message_delta', { type: 'message_delta', delta: { stop_reason: m.stop_reason }, usage: { output_tokens: 7 } }]);
  ev.push(['message_stop', { type: 'message_stop' }]);
  return new Response(ev.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}
const mockFetch = async (url, init) => {
  const body = JSON.parse(init.body);
  calls.push({ url: String(url), model: body.model, tools: (body.tools || []).map((t) => t.name), stream: !!body.stream, lastRole: body.messages.at(-1).role,
    lastTypes: [].concat(body.messages.at(-1).content).map((c) => (typeof c === 'string' ? 'string' : c.type)) });
  const step = script.shift() || { text: '(script exhausted)' };
  const m = step.tool ? msg([{ type: 'tool_use', id: 'tu_' + calls.length, name: step.tool.name, input: step.tool.input }], 'tool_use') : msg([{ type: 'text', text: step.text }], 'end_turn');
  return body.stream ? sse(m) : new Response(JSON.stringify(m), { status: 200, headers: { 'content-type': 'application/json' } });
};
const anthropic = createAnthropic({ apiKey: 'sk-ant-mock-not-real', fetch: mockFetch, baseURL: 'http://mock.local/v1' });
const model = aisdk(anthropic('claude-sonnet-5'));

let pass = 0, fail = 0; const ok = (n, c, x) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (x ? ' — ' + x : '')); } };

// ── 1. tool loop: Jarvis calls our gate-wrapped read, then answers ──
const reads = [];
const readDevice = tool({ name: 'read_device', description: 'Read a device (goes through OUR gate + guardrail + audit).', parameters: z.object({ device: z.string(), command: z.string() }),
  execute: async ({ device, command }) => { reads.push({ device, command }); return `evidence[e1] ${device}> ${command}\nIOS-XE 17.12.01`; } });
const routerExpert = new Agent({ name: 'Router-Expert', instructions: 'You read routers.', model, tools: [readDevice] });
const toRouter = handoff(routerExpert);
const jarvis = new Agent({ name: 'Jarvis', instructions: 'Squad lead. Delegate reads.', model, tools: [readDevice], handoffs: [toRouter] });
console.log('  info handoff tool name =', toRouter.toolName);

script = [{ tool: { name: 'read_device', input: { device: 'sw1', command: 'show version' } } }, { text: 'sw1 runs IOS-XE 17.12.01 — one real read, nothing invented.' }];
calls.length = 0;
const r1 = await run(jarvis, 'is sw1 healthy?');
ok('tool loop: the model asked for our tool, the SDK ran OUR function, then the model answered', reads.length === 1 && reads[0].device === 'sw1' && /17\.12\.01/.test(r1.finalOutput || ''), JSON.stringify({ reads, out: r1.finalOutput }));
ok('…the Anthropic provider was called twice (tool turn + answer) with our tool + the handoff advertised', calls.length === 2 && calls[0].tools.includes('read_device') && calls[0].tools.includes(toRouter.toolName), JSON.stringify(calls.map((c) => c.tools)));
ok('…and the second request carried the tool_result back (the loop is the SDK\'s, not ours)', calls[1].lastTypes.includes('tool_result'), JSON.stringify(calls[1]));
ok('…usage is surfaced for our spend store', !!(r1.rawResponses && r1.rawResponses[0] && r1.rawResponses[0].usage), JSON.stringify(r1.rawResponses && r1.rawResponses[0] && r1.rawResponses[0].usage));

// ── 2. handoff: Jarvis transfers to Router-Expert, who reads and answers ──
script = [{ tool: { name: toRouter.toolName, input: {} } }, { tool: { name: 'read_device', input: { device: 'core-1', command: 'show ip bgp summary' } } }, { text: 'core-1: 2 BGP peers established.' }];
calls.length = 0; reads.length = 0;
const r2 = await run(jarvis, 'check bgp on core-1');
ok('handoff: Jarvis → Router-Expert → read → answer, last agent is Router-Expert', r2.lastAgent && r2.lastAgent.name === 'Router-Expert' && reads.length === 1 && /2 BGP peers/.test(r2.finalOutput || ''), JSON.stringify({ last: r2.lastAgent && r2.lastAgent.name, reads, out: r2.finalOutput }));

// ── 3. approval interrupt: a tool that needs approval pauses the run (our permission gate seam) ──
const applyChange = tool({ name: 'apply_change', description: 'A write — must be approved.', parameters: z.object({ device: z.string() }), needsApproval: true,
  execute: async ({ device }) => `applied on ${device}` });
const changer = new Agent({ name: 'Config-Keeper', instructions: 'x', model, tools: [applyChange] });
script = [{ tool: { name: 'apply_change', input: { device: 'sw2' } } }, { text: 'done' }];
calls.length = 0;
const r3 = await run(changer, 'reload sw2');
const intr = r3.interruptions || [];
ok('approval: the run PAUSES with an interruption before the write tool executes (zero wire)', intr.length === 1 && intr[0].rawItem && intr[0].rawItem.name === 'apply_change' && !r3.finalOutput, JSON.stringify({ n: intr.length, out: r3.finalOutput }));
if (intr.length) {
  const state = r3.state; state.reject(intr[0]);
  const r3b = await run(changer, state);
  ok('…rejecting it (our gate says deny) resumes without ever running the tool', !/applied on/.test(JSON.stringify(r3b.newItems.map((i) => i.rawItem))) && calls.length >= 2, JSON.stringify(r3b.finalOutput));
}

// ── 4. a REAL stdio MCP server (NetClaw catc-mcp) as tools, offline ──
const NETCLAW = '/home/user/automateyournetwork/netclaw/mcp-servers/catc-mcp/server.py';
const PY = '/tmp/claude-0/-home-user-netrok/30fd209a-2715-5ba6-9aa1-39105ad8bb21/scratchpad/catc-venv/bin/python';
const mcp = new MCPServerStdio({ name: 'netclaw-catc', command: PY, args: [NETCLAW], env: { PATH: process.env.PATH, HOME: process.env.HOME }, cacheToolsList: true });
await mcp.connect();
const mcpTools = await mcp.listTools();
ok('MCP: the SDK spawned the real NetClaw catc-mcp server and listed its 10 tools', mcpTools.length === 10 && mcpTools.some((t) => t.name === 'catc_find'), String(mcpTools.length));
const withMcp = new Agent({ name: 'Jarvis', instructions: 'x', model, mcpServers: [mcp] });
script = [{ tool: { name: 'catc_find', input: { query: 'health', limit: 2 } } }, { text: 'found 2 health operations' }];
calls.length = 0;
const r4 = await run(withMcp, 'what health reads exist?');
const toolOut = r4.newItems.find((i) => i.type === 'tool_call_output_item');
ok('MCP: the model called catc_find through the SDK and got the REAL local-catalogue result', !!toolOut && /LOCAL catalogue/.test(JSON.stringify(toolOut.rawItem)), toolOut && JSON.stringify(toolOut.rawItem).slice(0, 160));
ok('…and the provider request advertised the 10 MCP tools to the model', calls[0] && calls[0].tools.filter((t) => t.startsWith('catc_')).length === 10, JSON.stringify(calls[0] && calls[0].tools));
await mcp.close();

// ── 5. streaming events (for say_delta + presence) ──
script = [{ text: 'A short streamed answer.' }];
calls.length = 0;
const stream = await run(jarvis, 'hello', { stream: true });
const kinds = new Set(); let deltas = '';
for await (const ev of stream) { kinds.add(ev.type); if (ev.type === 'raw_model_stream_event' && ev.data && ev.data.type === 'output_text_delta') deltas += ev.data.delta; }
ok('streaming: run events expose text deltas (our say_delta) and item/agent events (our presence)', deltas.length > 0 && kinds.has('raw_model_stream_event'), JSON.stringify([...kinds]) + ' deltas=' + JSON.stringify(deltas));
ok('…the provider was asked to stream', calls[0] && calls[0].stream === true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
