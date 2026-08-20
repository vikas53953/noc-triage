// CW-9 — bridge conduct: ask-first, the pinned envelope, the roster, terminal evidence.
//
// The failure under test is REAL (squad/data/chat/chat-history.json, 2026-08-19):
//   operator: "hey jarvis facing issue in epg"
//   Jarvis:   engaged 2 engineers → swept the APIC → posted walls of raw agent text
//             → "You didn't name the EPG, so I can't chase a specific one yet" AT THE END.
//
// After CW-9 that exact input must produce: a SHORT ask message with up to 3
// narrowing questions, ZERO engagements and ZERO reads — and the operator's
// answer must resume the same understanding and scope the bridge.
//
// Deterministic and offline: the reasoning is a SCRIPTED planner injected into
// the shared conduct gate (conduct.setPlanner) plus a stubbed claude.reason for
// the roster call, exactly like the CW-7 loop tests. No API key, no credits, no
// network. When credits are available the SAME code runs with the real planner.

const conduct = require('./conduct');
const jarvis = require('./jarvis');
const claude = require('./claude');
const session = require('./session-log');
const live = require('./live-agents');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`); }
}
function section(t) { console.log(`\n${t}`); }

// ── The harness ─────────────────────────────────────────────────────────────
const ROSTER = [
  { id: 'router-expert', name: 'Router-Expert', connected: true, sees: ['ACI fabric health', 'EPG/tenant objects'] },
  { id: 'netops', name: 'NetOps', connected: true, sees: ['Catalyst campus inventory'] },
  { id: 'config-keeper', name: 'Config-Keeper', connected: true, sees: ['device CLI via Command Runner'] },
];

const said = [];            // every ctx.say: { agent, text, env }
const gathers = [];         // every delegated read
let bridgeCreated = null;   // the investigation the bridge opened
let changesProposed = [];

function resetHarness({ gatherFinding } = {}) {
  said.length = 0; gathers.length = 0; changesProposed = [];
  bridgeCreated = null;
  conduct._threads.clear();
  jarvis.init({
    say: (agent, text, env) => said.push({ agent, text, env: env || null }),
    status: () => {},
    log: () => {},
    nameOf: (id) => (ROSTER.find((a) => a.id === id) || {}).name || id,
    roster: () => ROSTER.slice(),
    abilities: () => [],
    gather: (agentId, question, device, incidentId) => {
      gathers.push({ agentId, question, device, incidentId });
      return Promise.resolve(gatherFinding
        ? gatherFinding(agentId, question)
        : { agentId, name: agentId, connected: true, stance: 'evidence', text: 'a real reading', cli: [] });
    },
    investigate: {
      create: (input) => { bridgeCreated = input; return { id: 'INV-TEST-001', ...input }; },
      run: async () => ({ id: 'INV-TEST-001' }),
    },
    proposeChange: (input) => { changesProposed.push(input); return { id: 'chg-test-1', status: 'proposed' }; },
  });
}

// A scripted conduct planner: the LLM half, replaced by a script.
function scriptPlanner(steps) {
  let n = 0;
  const calls = [];
  return {
    calls,
    planner: {
      available: () => true,
      understand: async (input) => { calls.push(input); return steps[Math.min(n++, steps.length - 1)]; },
    },
  };
}

const kinds = () => said.map((m) => m.env && m.env.kind).filter(Boolean);
const withKind = (k) => said.filter((m) => m.env && m.env.kind === k);

// Stub the reasoning model. `handlers` maps a marker found in the system prompt
// to the JSON the call should return.
const realReason = claude.reason;
const realHasKey = claude.hasKey;
function stubClaude(handlers) {
  claude.hasKey = () => true;
  claude.reason = async ({ system }) => {
    for (const [marker, payload] of Object.entries(handlers)) {
      if (String(system).includes(marker)) {
        return { refused: false, text: typeof payload === 'string' ? payload : JSON.stringify(payload) };
      }
    }
    throw new Error(`no stub for this reasoning call: ${String(system).slice(0, 60)}`);
  };
}
function restoreClaude() { claude.reason = realReason; claude.hasKey = realHasKey; }

const EPG = 'hey jarvis facing issue in epg';
const VAGUE = {
  problemReport: true, specific: false,
  understood: 'Something is wrong with an EPG, but which one is not stated.',
  hypotheses: [],
  questions: [
    'Which EPG (and which tenant/application profile) is affected?',
    'What exactly is failing — no endpoints learned, contract drops, or something else?',
    'When did it start, and did anything change around then?',
  ],
  relevantFronts: ['fabric'],
};
const SPECIFIC = {
  problemReport: true, specific: true,
  understood: 'EPG Prod-App in tenant Retail lost east-west reachability since about 14:00.',
  hypotheses: [{ id: 'h1', text: 'a contract or filter was changed on the EPG' }],
  questions: [],
  relevantFronts: ['fabric'],
};

// ════════════════════════════════════════════════════════════════════════════
section('THE 2026-08-19 FAILURE — "hey jarvis facing issue in epg" must ASK FIRST:');
(async () => {
  const { planner, calls } = scriptPlanner([VAGUE]);
  conduct.setPlanner(planner);
  resetHarness();
  stubClaude({ 'PLAN': { intent: 'x', symptom: {}, delegations: [], standDown: [], note: '', selfAnswer: null } });

  await jarvis.ask(EPG, { conversationId: 'c1' });

  ok('the gate ran the understanding step', calls.length === 1);
  ok('exactly ONE message came back', said.length === 1, `${said.length} messages`);
  ok('it is an ASK', kinds()[0] === 'ask', kinds().join(','));
  ok('it carries up to 3 narrowing questions', (said[0].env.questions || []).length === 3);
  ok('ZERO agents engaged (no roster message)', withKind('roster').length === 0);
  ok('ZERO reads run', gathers.length === 0);
  ok('no finding / verdict / change was posted', withKind('finding').length + withKind('verdict').length + withKind('change').length === 0);
  ok('the ask text is short (≤280)', said[0].text.length <= conduct.TEXT_MAX, `${said[0].text.length} chars`);
  ok('the questions are IN the message (old clients see them too)', /Which EPG/.test(said[0].text));
  ok('no end-of-dump "you didn\'t name the EPG" scolding',
    !/did ?n[o']t name/i.test(said[0].text));
  ok('the thread is parked awaiting the answer', Boolean(conduct.pending('c1')));

  // ── the answer resumes the SAME understanding and scopes the bridge ───────
  section('THE ANSWER resumes the same understanding and scopes the call:');
  const two = scriptPlanner([SPECIFIC]);
  conduct.setPlanner(two.planner);
  said.length = 0; gathers.length = 0;
  stubClaude({
    'opening a P1 bridge': { engaged: [{ agentId: 'router-expert', why: 'owns the ACI fabric where the EPG lives' }],
      stoodDown: [{ agentId: 'netops', why: 'nothing here points at the campus edge' }] },
  });

  await jarvis.ask('Prod-App in tenant Retail, since about 2pm', { conversationId: 'c1' });

  ok('the understanding was RESUMED, not restarted (original problem kept)',
    two.calls[0].problem === EPG, two.calls[0].problem);
  ok('the operator\'s answer was carried into it', (two.calls[0].answers || []).length === 1);
  ok('a roster message was posted', withKind('roster').length === 1);
  const roster = withKind('roster')[0].env.roster;
  ok('the engaged set is named with a why each',
    roster.engaged.length === 1 && roster.engaged[0].agent === 'Router-Expert' && roster.engaged[0].why.length > 0);
  ok('stood-down agents are named with a why each',
    roster.stoodDown.length === 1 && roster.stoodDown[0].agent === 'NetOps' && roster.stoodDown[0].why.length > 0);
  ok('the bridge reused the CW-7 investigation loop', Boolean(bridgeCreated));
  ok('the loop was seeded with the understanding (no second grill)',
    bridgeCreated.understood === SPECIFIC.understood);
  ok('the loop may only task the ENGAGED agents', JSON.stringify(bridgeCreated.agents) === JSON.stringify(['router-expert']));
  ok('every bridge message is ≤280 chars', said.every((m) => m.text.length <= conduct.TEXT_MAX));

  // ── a message that is NOT a problem report is never grilled ───────────────
  section('NOT a problem report → the gate stays out of the way (no canned questions):');
  const three = scriptPlanner([{ problemReport: false, specific: true, understood: 'a greeting', hypotheses: [], questions: [], relevantFronts: [] }]);
  conduct.setPlanner(three.planner);
  resetHarness();
  stubClaude({ 'Principal Engineer of a live NOC': {
    intent: 'greeting', symptom: { timeAnchor: null, scope: null, rawSymptom: 'hi' },
    delegations: [], standDown: [], note: '', selfAnswer: 'Hello — here is what I can do…' } });

  await jarvis.ask('hi jarvis', { conversationId: 'c2' });
  ok('no ask message for a greeting', withKind('ask').length === 0);
  ok('the normal (plan) path answered it', said.length === 2 && /Hello/.test(said[1].text), said.map((s) => s.text).join(' | '));
  ok('nothing was read', gathers.length === 0);

  // ── the plan path posts a roster + findings, never a wall of text ─────────
  section('PLAN path — roster + findings with terminal evidence, no raw dump in the text:');
  const RAW = 'Cisco IOS XE Software, Version 17.12.01prd9\n' + 'x'.repeat(3000);
  const four = scriptPlanner([{ problemReport: false, specific: true, understood: 'a direct command', hypotheses: [], questions: [], relevantFronts: [] }]);
  conduct.setPlanner(four.planner);
  resetHarness({
    gatherFinding: (agentId) => ({
      agentId, name: 'Config-Keeper', connected: true, stance: 'evidence',
      text: `Ran "show version" live on sw2:\n${RAW}`,
      cli: [{ host: '10.10.20.176', command: 'show version', output: RAW, transport: 'cmdrunner',
        line: 'Ran "show version" on sw2 over Catalyst Center Command Runner.' }],
    }),
  });
  stubClaude({
    'Principal Engineer of a live NOC': {
      intent: 'run show version on sw2',
      symptom: { timeAnchor: null, scope: null, rawSymptom: 'show version' },
      delegations: [{ agentId: 'config-keeper', question: 'run show version on sw2', device: 'sw2', incidentId: null }],
      standDown: [{ agentId: 'netops', why: 'inventory is not what was asked for' }],
      note: '', selfAnswer: null,
    },
    'giving the operator your answer': 'sw2 is on 17.12.01prd9.',
  });

  await jarvis.ask('run show version on sw2', { conversationId: 'c3' });

  const findings = withKind('finding');
  ok('a roster message named who is engaged and who stood down',
    withKind('roster').length === 1 && withKind('roster')[0].env.roster.stoodDown.length === 1);
  ok('one finding per real read', findings.length === 1);
  const f = findings[0].env.finding;
  ok('finding.line is ONE sentence, ≤200 chars', f.line.length <= conduct.LINE_MAX && !/\n/.test(f.line));
  ok('finding.cli carries the host', f.cli.host === '10.10.20.176');
  ok('finding.cli carries the exact command', f.cli.command === 'show version');
  ok('finding.cli carries the RAW output', f.cli.output === RAW);
  ok('finding.cli labels the transport HONESTLY (cmdrunner, never ssh)', f.cli.transport === 'cmdrunner');
  ok('the raw output NEVER appears in any message text', said.every((m) => !m.text.includes('x'.repeat(300))));
  ok('every jarvis message is ≤280 chars', said.every((m) => m.text.length <= conduct.TEXT_MAX));

  // ── the bridge closes with a verdict and a HELD change ────────────────────
  section('VERDICT → change record, held for approval (never applied):');
  resetHarness();
  const observer = jarvis._test.bridgeObserver();
  observer.onRound({ id: 'INV-1' }, {
    round: 1, agent: 'Router-Expert',
    probe: { agentId: 'router-expert', question: 'read the EPG contracts' },
    report: { agentName: 'Router-Expert', stance: 'evidence', text: 'contract missing',
      cli: [{ host: 'apic', command: 'GET /api/class/fvAEPg.json', output: '{"imdata":[]}', transport: 'api', line: 'No EPG objects returned.' }] },
    hypotheses: [{ id: 'h1', text: 'a contract was removed', status: 'standing' }], confidence: 0.4, status: 'ok',
  });
  ok('a round narrates as ONE short say', withKind('say').length === 1 && withKind('say')[0].text.length <= conduct.TEXT_MAX);
  ok('the round\'s evidence arrives as a finding with its API read',
    withKind('finding').length === 1 && withKind('finding')[0].env.finding.cli.transport === 'api');

  observer.onUpdate({
    id: 'INV-1', status: 'resolved', rootCause: 'the Prod-App contract was removed', confidence: 0.9,
    rounds: [1, 2], fixPlan: { summary: 'restore the contract', proposal: { device: 'apic', commands: ['restore contract Prod-Web'], reason: 'restore east-west' } },
  });
  const verdicts = withKind('verdict');
  ok('a verdict message closes the bridge', verdicts.length === 1);
  ok('the verdict carries cause / confidence / rounds',
    verdicts[0].env.verdict.cause.length > 0 && verdicts[0].env.verdict.confidence === 0.9 && verdicts[0].env.verdict.rounds === 2);
  const changes = withKind('change');
  ok('a change record was drafted through the change engine', changesProposed.length === 1);
  ok('the change message is held-for-approval', changes.length === 1 && changes[0].env.change.state === 'held-for-approval');
  ok('the change carries its steps and id',
    changes[0].env.change.id === 'chg-test-1' && changes[0].env.change.steps[0] === 'restore contract Prod-Web');

  // ── caps are code, not prompt-hope ───────────────────────────────────────
  section('CAPS are enforced in code, not hoped for in a prompt:');
  const longText = 'word '.repeat(200);
  ok('say text is capped at 280', conduct.envelope.say(longText).text.length <= 280);
  ok('ask text is capped at 280', conduct.envelope.ask(longText, []).text.length <= 280);
  ok('a cap never cuts mid-word', !/\w-?…$/.test(conduct.envelope.say(longText).text.replace(' …', '')));
  ok('at most 3 questions survive', conduct.envelope.ask('x', ['a', 'b', 'c', 'd', 'e']).questions.length === 3);
  ok('finding.line is capped at 200', conduct.envelope.finding({ agent: 'a', line: longText }).finding.line.length <= 200);
  ok('a finding line cannot smuggle a wall of text through newlines',
    !/\n/.test(conduct.envelope.finding({ agent: 'a', line: 'one\n' + 'raw '.repeat(200) }).finding.line));
  ok('finding.cli output is NOT capped (the terminal shows the real read)',
    conduct.envelope.finding({ agent: 'a', line: 'x', cli: { host: 'h', command: 'c', output: 'y'.repeat(5000), transport: 'ssh' } })
      .finding.cli.output.length === 5000);

  section('THE ASK stays readable — whole questions only, never a dangling "3.":');
  {
    const long = [
      'Which EPG, tenant and application profile is affected, and on which leaf or site does it show up first?',
      'What exactly is failing — endpoints not learned, contract drops, the EPG itself faulted, or something else entirely?',
      'When did it start, and did anything change around that time (a contract, a VLAN, a migration, a maintenance window)?',
    ];
    const seven = scriptPlanner([{ ...VAGUE, questions: long }]);
    conduct.setPlanner(seven.planner);
    resetHarness();
    stubClaude({});
    await jarvis.ask('something is up with an epg', { conversationId: 'fit' });
    const msg = said[0];
    ok('the ask still fits the 280 cap', msg.text.length <= conduct.TEXT_MAX, `${msg.text.length}`);
    ok('no question is cut mid-sentence into a dangling number', !/\n\d+\.\s*$/.test(msg.text) && !/…$/.test(msg.text));
    ok('every question that IS shown is shown whole',
      msg.text.split('\n').filter((l) => /^\d+\./.test(l)).every((l) => long.some((q) => l.endsWith(q))));
    ok('the envelope still carries ALL 3 questions', msg.env.questions.length === 3);
  }

  section('TRANSPORT honesty — a Command Runner read is never dressed as SSH:');
  ok('cmdrunner stays cmdrunner', conduct.transportOf('cmdrunner') === 'cmdrunner');
  ok('command-runner normalises to cmdrunner', conduct.transportOf('command-runner') === 'cmdrunner');
  ok('ssh stays ssh', conduct.transportOf('ssh') === 'ssh');
  ok('an unknown label falls back to api, never ssh', conduct.transportOf('mystery') === 'api');
  ok('a missing label falls back to api', conduct.transportOf(undefined) === 'api');

  section('ONE gate for EVERY entry point (chat + triage intake share this module):');
  const five = scriptPlanner([VAGUE]);
  conduct.setPlanner(five.planner);
  const intake = await conduct.understand({ problem: 'network is slow', priorAnswers: [], operatorTz: 'Asia/Kolkata' });
  ok('the triage intake goes through the same module + planner', five.calls.length === 1);
  ok('the intake shape triage.js expects is unchanged',
    intake.specific === false && Array.isArray(intake.questions) && Array.isArray(intake.relevantFronts));
  ok('the intake also caps the questions at 3', intake.questions.length <= 3);

  section('BOUNDED grilling — the operator is never looped forever:');
  const six = scriptPlanner([VAGUE, VAGUE, VAGUE]);
  conduct.setPlanner(six.planner);
  const a1 = await conduct.assess({ conversationId: 'loop', text: 'something is broken' });
  const a2 = await conduct.assess({ conversationId: 'loop', text: 'not sure' });
  const a3 = await conduct.assess({ conversationId: 'loop', text: 'still not sure' });
  ok('it asks', a1.decision === 'ask' && a2.decision === 'ask');
  ok(`it stops asking after ${conduct.MAX_ASK_ROUNDS} rounds and works with what it has`, a3.decision === 'proceed');
  ok('and it says so honestly (thin)', a3.thin === true);

  section('NO PLANNER (no key / no credits) — the gate steps aside, it never invents a question:');
  conduct.setPlanner(null);
  const none = await conduct.assess({ conversationId: 'nokey', text: 'anything' });
  ok('decision is unavailable', none.decision === 'unavailable');
  ok('no questions were invented', !none.questions);

  section('TERMINAL EVIDENCE — a real API read comes back as cli evidence:');
  const before = session.all().length;
  const collected = await live.collectCliEvidence(async () => {
    session.record({ host: 'sandboxapic.cisco.com', method: 'GET', path: '/api/class/fvAEPg.json',
      res: { ok: true, status: 200, body: '{"imdata":[]}' }, durationMs: 12 });
    return 'done';
  });
  ok('the collected read is returned as evidence', collected.cli.length === 1, JSON.stringify(collected.cli));
  ok('it carries the real host', collected.cli[0].host === 'sandboxapic.cisco.com');
  ok('it carries the raw body', collected.cli[0].output.includes('imdata'));
  ok('an API read is labelled api (not ssh, not cmdrunner)', collected.cli[0].transport === 'api');
  ok('the session log itself is untouched by collection', session.all().length === before + 1);

  section('CHAT-STORE — the new envelope fields survive persistence:');
  const chatStore = require('./chat-store');
  const payload = chatStore.scrubValue({
    type: 'incoming', agent: 'jarvis', text: 'short line', kind: 'finding',
    finding: { agent: 'Config-Keeper', line: 'ran show version on sw2',
      cli: { host: '10.10.20.176', command: 'show version', output: 'Version 17.12.01prd9', transport: 'cmdrunner' } },
  });
  ok('kind survives', payload.kind === 'finding');
  ok('the finding envelope survives', payload.finding.cli.command === 'show version');
  ok('the transport label survives', payload.finding.cli.transport === 'cmdrunner');

  restoreClaude();
  conduct.setPlanner(null);
  console.log(`\nCW-9 bridge conduct: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('CW-9 test harness error:', err);
  process.exit(1);
});
