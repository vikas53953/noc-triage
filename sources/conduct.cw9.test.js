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
// `sources` = the systems each agent's reads REALLY touch (live.AGENT_SOURCES).
// The roster-truth check works off these, so the fixture mirrors the real map.
const ROSTER = [
  { id: 'router-expert', name: 'Router-Expert', connected: true, sees: ['ACI fabric health', 'EPG/tenant objects'], sources: ['aci', 'sdwan'] },
  { id: 'netops', name: 'NetOps', connected: true, sees: ['Catalyst campus inventory'], sources: ['catalyst-center'] },
  { id: 'config-keeper', name: 'Config-Keeper', connected: true, sees: ['device CLI via Command Runner'], sources: ['catalyst-center', 'ssh'] },
  { id: 'monitor-eye', name: 'Monitor-Eye', connected: true, sees: ['Catalyst alerts', 'SD-WAN alarm counts'], sources: ['catalyst-center', 'sdwan'] },
  { id: 'firewall-pro', name: 'Firewall-Pro', connected: false, sees: [], sources: [] },
];

const said = [];            // every ctx.say: { agent, text, env }
const gathers = [];         // every delegated read
let bridgeCreated = null;   // the investigation the bridge opened
let changesProposed = [];
let screened = [];          // every message the capability screen saw

function resetHarness({ gatherFinding, screen } = {}) {
  said.length = 0; gathers.length = 0; changesProposed = []; screened = [];
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
    proposeChange: (input) => { changesProposed.push(input); return { id: 'chg-test-1', status: 'proposed', commands: input.commands }; },
    // The CW-1 capability screen, now POST-gate (reviewer finding #4).
    screen: (command) => { screened.push(command); return screen ? screen(command) : false; },
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
  {
    // Reviewer finding #8: a 20 KB raw body per finding moved the wall of text
    // into the terminal pane and blew up chat-history.json. The block is capped
    // with an HONEST marker that says how much was cut and where the full read is.
    const big = conduct.envelope.finding({ agent: 'a', line: 'x',
      cli: { host: 'h', command: 'c', output: 'y'.repeat(50000), transport: 'ssh' } }).finding.cli;
    ok('finding.cli output is capped', big.output.length < 50000 && big.output.length < 6000, `${big.output.length}`);
    ok('the cut is stated honestly, with the amount', /more chars truncated/.test(big.output));
    ok('and it names where the full read still lives', /\/api\/session/.test(big.output));
    ok('a small output is untouched',
      conduct.envelope.finding({ agent: 'a', line: 'x', cli: { host: 'h', command: 'c', output: 'short', transport: 'ssh' } })
        .finding.cli.output === 'short');
  }

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

  // ══════════════════════════════════════════════════════════════════════════
  // REVIEWER FIX-FIRST (2026-08-20) — one section per finding.
  // ══════════════════════════════════════════════════════════════════════════

  section('BLOCKER 1 — the roster cannot claim a stand-down that the reads contradict:');
  {
    const p = scriptPlanner([SPECIFIC]);
    conduct.setPlanner(p.planner);
    resetHarness();
    stubClaude({
      'opening a P1 bridge': {
        engaged: [{ agentId: 'router-expert', why: 'owns the ACI fabric and the SD-WAN overlay' }],
        stoodDown: [
          { agentId: 'monitor-eye', why: 'only reads Catalyst alerts and SD-WAN alarm counts' },
          { agentId: 'netops', why: 'nothing points at the campus edge' },
          { agentId: 'firewall-pro', why: 'not connected' },
        ],
      },
    });
    await jarvis.ask('EPG Prod-App in tenant Retail is unreachable since 14:00', { conversationId: 'r1' });
    const r = withKind('roster')[0].env.roster;
    const names = r.stoodDown.map((s) => s.agent);
    ok('an agent whose OWN systems the engaged agent reads is NOT announced as standing down',
      !names.includes('Monitor-Eye'), names.join(','));
    ok('an agent with no overlap still stands down honestly', names.includes('NetOps'));
    ok('a never-connected agent is not named on the card at all', !names.includes('Firewall-Pro'));
    ok('the overlap is stated out loud instead of being hidden',
      /Not on the call, but their systems still get read: Monitor-Eye \(sdwan\)/.test(withKind('roster')[0].text),
      withKind('roster')[0].text);
  }
  {
    // The runtime backstop: if a round reads a stood-down agent's system anyway,
    // Jarvis corrects the claim out loud rather than leaving it standing.
    resetHarness();
    const obs = jarvis._test.bridgeObserver({ stoodDown: [{ agent: 'NetOps', sources: ['catalyst-center'] }] });
    obs.onRound({}, {
      round: 1, agent: 'Router-Expert', probe: { agentId: 'router-expert', question: 'q' },
      report: { agentName: 'Router-Expert', stance: 'evidence', text: 't',
        cli: [{ host: 'dnac', command: 'GET /dna/intent/api/v1/network-device', output: '{}', transport: 'api', source: 'catalyst-center' }] },
      hypotheses: [], confidence: 0.2, status: 'ok',
    });
    ok('a stood-down system read anyway is CORRECTED out loud',
      said.some((m) => /Correction: I said NetOps was standing down/.test(m.text)), said.map((m) => m.text).join(' | '));
  }

  section('BLOCKER 2 — round narration is composed from the EVIDENCE, not the plan:');
  {
    resetHarness();
    const obs = jarvis._test.bridgeObserver();
    const sameCli = [{ host: 'apic', command: 'GET /api/class/fvAEPg.json', output: '{"imdata":[]}', transport: 'api', source: 'aci' }];
    const round = (n) => ({
      round: n, agent: 'Router-Expert',
      probe: { agentId: 'router-expert', question: `Drill into a completely different thing #${n}` },
      report: { agentName: 'Router-Expert', stance: 'evidence', text: 'same as before', cli: sameCli.map((e) => ({ ...e })) },
      hypotheses: [{ id: 'h1', text: 'contract removed', status: 'standing' }], confidence: 0.3, status: 'ok',
    });
    obs.onRound({}, round(1));
    obs.onRound({}, round(2));
    obs.onRound({}, round(3));
    const says = withKind('say');
    ok('round 1 reports the check that actually ran', /1 new check/.test(says[0].text), says[0].text);
    ok('a repeat round says plainly that nothing new came back',
      /returned the same picture as before — nothing new/.test(says[1].text), says[1].text);
    ok('and so does the third', /nothing new/.test(says[2].text));
    ok('the probe QUESTION is never printed as if it were what ran',
      !says.some((m) => /completely different thing/.test(m.text)));
    ok('identical evidence is not re-posted as a new finding', withKind('finding').length === 1,
      `${withKind('finding').length} findings`);
  }
  {
    resetHarness();
    const obs = jarvis._test.bridgeObserver();
    obs.onRound({}, { round: 1, agent: 'Config-Keeper', probe: { agentId: 'config-keeper', question: 'q' },
      report: { agentName: 'Config-Keeper', stance: 'denied', text: 'Read denied by the operator — ran nothing.', cli: [] },
      hypotheses: [], confidence: 0, status: 'blocked' });
    ok('a round that read nothing says so, and does not imply a check ran',
      /no reading came back \(denied\)/.test(withKind('say')[0].text), withKind('say')[0].text);
    ok('the honest no-evidence finding is still posted', withKind('finding').length === 1 && withKind('finding')[0].env.finding.cli === null);
  }

  section('BLOCKER 3 — evidence is attributed per delegation, even when reads overlap:');
  {
    // Delegation A reads NOTHING; delegation B reads one host. Run concurrently.
    let release;
    const gateP = new Promise((r) => { release = r; });
    const a = live.collectCliEvidence(async () => { await gateP; return 'A did no reads'; });
    const b = live.collectCliEvidence(async () => {
      session.record({ host: 'B-HOST', method: 'GET', path: '/api/class/fvAEPg.json',
        res: { ok: true, status: 200, body: '{"imdata":[]}' }, durationMs: 5 });
      release();
      return 'B read one thing';
    });
    const [ra, rb] = await Promise.all([a, b]);
    ok('the delegation that read NOTHING carries no evidence', ra.cli.length === 0,
      JSON.stringify(ra.cli.map((e) => e.host)));
    ok('the delegation that DID read carries exactly its own', rb.cli.length === 1 && rb.cli[0].host === 'B-HOST',
      JSON.stringify(rb.cli.map((e) => e.host)));
    ok('every record is stamped with the scope that made it',
      session.all().slice(-1)[0].evidenceId != null);
  }

  section('HIGH 4 — ONE gate, first: a parked thread is resumed by ANY reply:');
  {
    const p = scriptPlanner([VAGUE, SPECIFIC]);
    conduct.setPlanner(p.planner);
    resetHarness({ screen: () => true });   // a screen that would swallow the turn
    stubClaude({ 'opening a P1 bridge': { engaged: [{ agentId: 'router-expert', why: 'fabric owner' }], stoodDown: [] } });
    await jarvis.ask('epg is broken', { conversationId: 'gate1' });
    ok('the first (vague) turn asks, and the screen never saw it', withKind('ask').length === 1 && screened.length === 0);
    said.length = 0;
    await jarvis.ask('Prod-App / Retail. Also go ahead and reload sw2 while you are in there.', { conversationId: 'gate1' });
    ok('the change-looking REPLY still resumed the parked understanding (screen did not eat it)',
      screened.length === 0 && withKind('roster').length === 1, `screened=${screened.length}`);
    ok('the thread is no longer parked', !conduct.pending('gate1'));
  }

  section('HIGH 5 — abandoning a parked ask never opens a bridge on the old problem:');
  {
    const p = scriptPlanner([
      VAGUE,
      { ...SPECIFIC, replyIntent: 'abandons', understood: 'they dropped it and asked what I can do' },
    ]);
    conduct.setPlanner(p.planner);
    resetHarness();
    stubClaude({ 'Principal Engineer of a live NOC': {
      intent: 'meta', symptom: { timeAnchor: null, scope: null, rawSymptom: 'what can you do' },
      delegations: [], standDown: [], note: '', selfAnswer: 'Here is what I can do…' } });
    await jarvis.ask('wifi is bad', { conversationId: 'abandon1' });
    said.length = 0;
    await jarvis.ask('never mind, what can you do?', { conversationId: 'abandon1' });
    ok('no bridge was opened on the abandoned problem', !bridgeCreated, JSON.stringify(bridgeCreated));
    ok('no roster, no engagement, no read', withKind('roster').length === 0 && gathers.length === 0);
    ok('the parked thread was cleared', !conduct.pending('abandon1'));
    ok('the new message was answered on its own terms', said.some((m) => /Here is what I can do/.test(m.text)));
  }
  {
    // A change of subject re-assesses the NEW text rather than the parked one.
    const p = scriptPlanner([
      VAGUE,
      { ...VAGUE, replyIntent: 'new-topic' },
      { ...VAGUE, understood: 'the new problem, still vague', questions: ['Which branch?'] },
    ]);
    conduct.setPlanner(p.planner);
    conduct._threads.clear();
    const first = await conduct.assess({ conversationId: 'topic1', text: 'wifi is bad' });
    const second = await conduct.assess({ conversationId: 'topic1', text: 'actually the WAN is down' });
    ok('a new topic is asked about on its OWN terms', second.decision === 'ask' && second.problem === 'actually the WAN is down',
      `${second.decision} / ${second.problem}`);
    ok('the abandoned problem is gone', first.decision === 'ask' && conduct.pending('topic1').problem === 'actually the WAN is down');
  }

  section('HIGH 6 — proceeding on a thin problem is stated out loud:');
  {
    const p = scriptPlanner([VAGUE, VAGUE, { ...VAGUE, specific: false }]);
    conduct.setPlanner(p.planner);
    resetHarness();
    stubClaude({ 'opening a P1 bridge': { engaged: [{ agentId: 'router-expert', why: 'best guess owner' }], stoodDown: [] } });
    await jarvis.ask('something is broken', { conversationId: 'thin1' });
    await jarvis.ask('not sure', { conversationId: 'thin1' });
    said.length = 0;
    await jarvis.ask('still not sure', { conversationId: 'thin1' });
    ok('it proceeds (the grill is bounded)', Boolean(bridgeCreated));
    ok('and it SAYS it is proceeding on an under-specified problem',
      said.some((m) => /under-specified/.test(m.text)), said.map((m) => m.text).join(' | '));
    ok('naming what it assumed', said.some((m) => m.text.includes('proceeding on:')));
  }

  section('MEDIUM 7 — a garbage understanding fails SAFE, never into an estate sweep:');
  for (const [label, bad] of [['null', null], ['a number', 42], ['a string', 'yes'], ['schema drift', { foo: 'bar' }], ['an array', []]]) {
    conduct.setPlanner({ available: () => true, understand: async () => bad });
    const d = await conduct.assess({ conversationId: `bad-${label}`, text: 'the fabric is down' });
    ok(`${label} → unavailable (not "proceed")`, d.decision === 'unavailable' && d.reason === 'failed', d.decision);
  }
  {
    conduct.setPlanner({ available: () => true, understand: async () => null });
    resetHarness();
    stubClaude({});
    await jarvis.ask('the fabric is down', { conversationId: 'bad-jarvis' });
    ok('Jarvis says it could not reason, and engages nobody',
      said.length === 1 && /could not reason/.test(said[0].text) && !bridgeCreated && gathers.length === 0,
      said.map((m) => m.text).join(' | '));
  }

  section('MEDIUM 9 — the scrubber covers the IOS space-separated secret forms:');
  {
    const s = require('./session-log').scrub;
    ok('password 0 <secret>', s('username admin privilege 15 password 0 Cisco123!').includes('password 0 «redacted»'));
    ok('enable secret 5 <hash>', s('enable secret 5 $1$abcd$xyz').includes('secret 5 «redacted»'));
    ok('key-string <psk>', s('key-string mysharedkey') === 'key-string «redacted»');
    ok('key 7 <hash>', s('key 7 04585A150C2E') === 'key 7 «redacted»');
    ok('prefixed env key names', s('ANTHROPIC_API_KEY=sk-ant-abc123') === 'ANTHROPIC_API_KEY=«redacted»');
    ok('snmp community still covered', s('snmp-server community public RO').includes('«redacted»'));
    ok('ordinary config lines are untouched', s('interface GigabitEthernet1/0/3') === 'interface GigabitEthernet1/0/3');
    ok('real evidence is untouched', s('Cisco IOS XE Software, Version 17.12.01prd9').includes('17.12.01prd9'));
  }

  section('LOW 10 — the triage intake keeps its 4th question:');
  {
    const four = ['a?', 'b?', 'c?', 'd?'];
    conduct.setPlanner({ available: () => true, understand: async () => ({ ...VAGUE, questions: four }) });
    const intake = await conduct.understand({ problem: 'network is slow' });
    ok('understand does NOT slice to 3 (triage applies its own cap of 4)', intake.questions.length === 4);
    ok('the CHAT envelope still caps at 3', conduct.envelope.ask('x', four).questions.length === 3);
  }

  section('LOW 14 — the thread store is bounded:');
  {
    conduct.setPlanner({ available: () => true, understand: async () => VAGUE });
    conduct._threads.clear();
    for (let i = 0; i < 210; i++) await conduct.assess({ conversationId: `bulk-${i}`, text: 'vague thing' });
    ok('threads never grow without bound', conduct._threads.size <= 200, `${conduct._threads.size}`);
    ok('the most recent thread survives eviction', Boolean(conduct.pending('bulk-209')));
  }

  // ══════════════════════════════════════════════════════════════════════════
  // RE-REVIEW of 5c02cdb (2026-08-20) — one section per finding.
  // ══════════════════════════════════════════════════════════════════════════

  section('F1 — a change ask is NEVER met with silence, on any path:');
  {
    // The deterministic backstop alone (no LLM changeAsk) must already catch all
    // three phrasings the reviewer used, including the ones isDeviceCliRequest
    // returns false for — which is why the old branch was dead code.
    const cases = [
      ['bare', 'reload sw2'],
      ['mixed answer + write', 'All branch sites, since 2pm today, users cannot connect at all. Also go ahead and reload sw2 to clear it.'],
      ['polite', 'could you maybe restart sw2'],
    ];
    for (const [label, text] of cases) {
      ok(`${label}: the shared write screen sees it`, Boolean(conduct.writeAsk(text)), text);
    }
    ok('a PAST change is not a change ask', !conduct.writeAsk('after the reload last night users complain of slowness'));
    ok('a plain problem report is not a change ask', !conduct.writeAsk('the epg is not reachable from the campus'));
  }
  {
    // Bare "reload sw2" in chat — refused out loud, nothing engaged.
    const p = scriptPlanner([{ problemReport: false, specific: true, understood: 'a device command', hypotheses: [], questions: [], relevantFronts: [] }]);
    conduct.setPlanner(p.planner);
    resetHarness({ screen: () => true });   // the capability screen offers the change proposal
    stubClaude({});
    await jarvis.ask('reload sw2', { conversationId: 'w1' });
    ok('bare write ask: Jarvis says out loud that it is a change and did not do it',
      said.some((m) => /is a change/.test(m.text) && /read-only/.test(m.text)), said.map((m) => m.text).join(' | '));
    ok('bare write ask: nothing was engaged or read', gathers.length === 0 && !bridgeCreated);
    ok('bare write ask: it is still routed on to the change-proposal path', screened.length === 1);
  }
  {
    // The reviewer's exact mixed message, as the answer to parked questions:
    // the change is refused AND the scoping half still resumes the bridge.
    const p = scriptPlanner([VAGUE, SPECIFIC]);
    conduct.setPlanner(p.planner);
    resetHarness();
    stubClaude({ 'opening a P1 bridge': { engaged: [{ agentId: 'router-expert', why: 'fabric owner' }], stoodDown: [] } });
    await jarvis.ask('wifi is bad at the branches', { conversationId: 'w2' });
    said.length = 0;
    await jarvis.ask('All branch sites, since 2pm today, users cannot connect at all. Also go ahead and reload sw2 to clear it.',
      { conversationId: 'w2' });
    ok('mixed message: the change half is refused out loud',
      said.some((m) => /is a change/.test(m.text)), said.map((m) => m.text).join(' | '));
    ok('mixed message: the scoping half still resumed the bridge', withKind('roster').length === 1 && Boolean(bridgeCreated));
    ok('mixed message: the refusal comes BEFORE the roster',
      said.findIndex((m) => /is a change/.test(m.text)) < said.findIndex((m) => m.env && m.env.kind === 'roster'));
  }
  {
    // The LLM's own reading wins when it has one, and the change is kept OUT of
    // `understood` so the investigation never chases it (root cause of M4).
    const p = scriptPlanner([{ ...SPECIFIC, changeAsk: 'bounce the uplink on sw2' }]);
    conduct.setPlanner(p.planner);
    resetHarness();
    stubClaude({ 'opening a P1 bridge': { engaged: [{ agentId: 'router-expert', why: 'fabric owner' }], stoodDown: [] } });
    await jarvis.ask('east-west is down for Prod-App in Retail since 14:00, sort it out', { conversationId: 'w3' });
    ok('the model-detected change ask is refused out loud',
      said.some((m) => /bounce the uplink on sw2/.test(m.text)), said.map((m) => m.text).join(' | '));
    ok('the change never reaches the investigation',
      !String(bridgeCreated.understood).toLowerCase().includes('bounce'));
  }
  {
    // With NO reasoning at all, the deterministic screen still speaks.
    conduct.setPlanner(null);
    resetHarness();
    stubClaude({ 'Principal Engineer of a live NOC': { intent: 'x', symptom: { timeAnchor: null, scope: null, rawSymptom: 'x' }, delegations: [], standDown: [], note: '', selfAnswer: 'ok' } });
    await jarvis.ask('reload sw2', { conversationId: 'w4' });
    ok('no planner: the change ask is STILL acknowledged, never silent',
      said.some((m) => /is a change/.test(m.text)), said.map((m) => m.text).join(' | '));
  }

  section('F2 — the plaintext shared-secret forms are scrubbed (the reviewer\'s 12 + more):');
  {
    const s = require('./session-log').scrub;
    const secrets = [
      ['tacacs-server host 1.1.1.1 key MyTacKey123', 'MyTacKey123'],
      ['radius-server key SuperRadius99', 'SuperRadius99'],
      ['snmp-server host 1.1.1.1 version 2c PrivComm99', 'PrivComm99'],
      ['crypto isakmp key VpnPsk2026 address 2.2.2.2', 'VpnPsk2026'],
      ['tacacs-server key 7 070C285F4D06', '070C285F4D06'],
      ['username bob secret 9 $14$abcdEFGH', '$14$abcdEFGH'],
      ['neighbor 1.1.1.1 password BgpMd5Key', 'BgpMd5Key'],
      ['ppp chap password 7 104D000A0618', '104D000A0618'],
      ['ip ftp password FtpPass123', 'FtpPass123'],
      ['snmp-server community S3cretComm RW', 'S3cretComm'],
      ['radius server R1\n key 0 RadKey0', 'RadKey0'],
      ['username admin privilege 15 password 0 Cisco123!', 'Cisco123!'],
      ['wpa-psk ascii 0 MyWifiPass', 'MyWifiPass'],
      ['ntp authentication-key 1 md5 NtpKey123', 'NtpKey123'],
      ['ip ospf message-digest-key 1 md5 MyOspfKey', 'MyOspfKey'],
      ['snmp-server host 1.1.1.1 traps PrivComm99 udp-port 162', 'PrivComm99'],
      ['key-string mysharedkey', 'mysharedkey'],
      ['ANTHROPIC_API_KEY=sk-ant-abc123', 'sk-ant-abc123'],
    ];
    for (const [line, secret] of secrets) {
      ok(`scrubbed: ${line.split('\n').pop().slice(0, 46)}`, !s(line).includes(secret), s(line));
    }
    const keep = [
      'interface GigabitEthernet1/0/3',
      'Cisco IOS XE Software, Version 17.12.01prd9',
      'key chain KC1',
      'crypto key generate rsa modulus 2048',
      ' description uplink to key customer',
      'ip address 10.1.1.1 255.255.255.0',
      'hostname sw2',
      'ntp authentication-key 1 md5 NtpKey123',  // the ALGORITHM name survives
    ];
    for (const line of keep) {
      const out = s(line);
      const unchanged = line.includes('NtpKey123') ? out.includes('md5') : out === line;
      ok(`evidence survives: ${line.trim().slice(0, 46)}`, unchanged, out);
    }
  }

  section('M1 — a cache-buster cannot make a repeated read look new:');
  {
    resetHarness();
    const obs = jarvis._test.bridgeObserver();
    const health = (ts) => ({ host: 'dnac', source: 'catalyst-center',
      command: `GET /dna/intent/api/v1/network-health?timestamp=${ts}`,
      output: 'Overall health score 100 across 4 devices', transport: 'api',
      line: 'Overall health score 100 across 4 devices (4 good / 0 bad).' });
    const round = (n, entries) => ({ round: n, agent: 'Monitor-Eye',
      probe: { agentId: 'monitor-eye', question: 'q' },
      report: { agentName: 'Monitor-Eye', stance: 'evidence', text: 't', cli: entries },
      hypotheses: [], confidence: 0.2, status: 'ok' });
    obs.onRound({}, round(1, [health(1787207261737)]));
    obs.onRound({}, round(2, [health(1787207291757)]));
    ok('round 1 announces the check', /1 new check/.test(withKind('say')[0].text));
    ok('the same read under a new timestamp is NOT announced as new',
      /nothing new/.test(withKind('say')[1].text), withKind('say')[1].text);
    ok('and it is not posted twice as a finding', withKind('finding').length === 1);
    ok('identity ignores volatile params but keeps real ones',
      conduct.identityKey({ source: 's', command: 'GET /x?a=1&_=9' }) === conduct.identityKey({ source: 's', command: 'GET /x?_=7&a=1' })
      && conduct.identityKey({ source: 's', command: 'GET /x?a=1' }) !== conduct.identityKey({ source: 's', command: 'GET /x?a=2' }));
    ok('an identical body under a DIFFERENT url is still caught as a repeat',
      conduct.outputKey({ source: 's', output: 'same' }) === conduct.outputKey({ source: 's', output: 'same' })
      && conduct.outputKey({ source: 's', output: 'same' }) !== conduct.outputKey({ source: 's', output: 'other' }));
  }
  {
    // A genuinely new check in a later round is still announced.
    resetHarness();
    const obs = jarvis._test.bridgeObserver();
    const e = (cmd) => ({ host: 'h', source: 'aci', command: cmd, output: cmd, transport: 'api', line: cmd });
    obs.onRound({}, { round: 1, agent: 'A', probe: { agentId: 'router-expert', question: 'q' },
      report: { agentName: 'A', stance: 'evidence', text: 't', cli: [e('/x'), e('/y')] }, hypotheses: [], confidence: 0.1, status: 'ok' });
    obs.onRound({}, { round: 2, agent: 'A', probe: { agentId: 'router-expert', question: 'q' },
      report: { agentName: 'A', stance: 'evidence', text: 't', cli: [e('/x'), e('/NEW')] }, hypotheses: [], confidence: 0.2, status: 'ok' });
    ok('a partially-new round names only the new check',
      /1 new check\(s\) — \/NEW/.test(withKind('say')[1].text), withKind('say')[1].text);
    ok('and posts only the new finding', withKind('finding').length === 3);
  }

  section('M2 — the overlap line names each agent\'s OWN systems:');
  {
    const p = scriptPlanner([SPECIFIC]);
    conduct.setPlanner(p.planner);
    resetHarness();
    stubClaude({
      'opening a P1 bridge': {
        engaged: [{ agentId: 'router-expert', why: 'aci + sdwan owner' }, { agentId: 'netops', why: 'campus owner' }],
        stoodDown: [
          { agentId: 'monitor-eye', why: 'alerts only' },        // shares catalyst-center + sdwan
          { agentId: 'config-keeper', why: 'no CLI needed' },     // shares catalyst-center only
        ],
      },
    });
    await jarvis.ask('east-west down for Prod-App since 14:00', { conversationId: 'm2' });
    const text = withKind('roster')[0].text;
    ok('each overlapping agent gets its own shared list',
      /Monitor-Eye \(catalyst-center, sdwan\)/.test(text) && /Config-Keeper \(catalyst-center\)/.test(text), text);
  }

  section('M3 — AGENT_SOURCES cannot drift from the builders without a test failing:');
  {
    const fs = require('fs');
    const src = fs.readFileSync(require('path').join(__dirname, 'live-agents.js'), 'utf8');
    const block = src.slice(src.indexOf('const DEBATE_BUILDERS = {'), src.indexOf('\n// Called once per participating agent when a debate runs.'));
    // Split the builder object into per-agent bodies on its 2-space-indented keys.
    const parts = block.split(/\n  '([a-z-]+)': \{/).slice(1);
    // What a module reference in a builder body MEANS in source-id terms.
    const REF = [
      [/\bcatalyst\./, 'catalyst-center'], [/\baci\./, 'aci'], [/\bsdwan\./, 'sdwan'],
      [/\bsshRunner\./, 'ssh'], [/\bincidentRead\./, 'incidents'],
      // The CLI choke point reaches Command Runner and (per device) direct SSH.
      [/executeDeviceCli|runDeviceCli/, 'catalyst-center'], [/executeDeviceCli|runDeviceCli/, 'ssh'],
    ];
    let checked = 0;
    for (let i = 0; i < parts.length; i += 2) {
      const agentId = parts[i];
      const body = parts[i + 1] || '';
      if (agentId === 'jarvis') continue;         // aggregator, no reads of its own
      const touched = new Set();
      for (const [re, id] of REF) if (re.test(body)) touched.add(id);
      const declared = new Set(live.sourcesFor(agentId));
      const missing = [...touched].filter((t) => !declared.has(t));
      ok(`${agentId}: every source its builder touches is declared`, missing.length === 0,
        `undeclared: ${missing.join(', ')}`);
      checked++;
    }
    ok('the drift check actually inspected the builders', checked >= 5, `${checked} builders`);
    // And the check must FAIL when a builder gains a read the table does not know.
    const fakeBody = 'async build(){ const x = await sdwan.getAlarmCount(); }';
    const fakeTouched = REF.filter(([re]) => re.test(fakeBody)).map(([, id]) => id);
    ok('a new read in a builder would be caught',
      fakeTouched.includes('sdwan') && !live.sourcesFor('netops').includes('sdwan'));
  }

  section('L1 — the thin-proceed assumption is never clipped away:');
  {
    const longUnderstood = 'Wi-Fi association failures affecting all branch sites since approximately 14:00 local time today, with clients unable to complete authentication against the RADIUS servers behind the branch controllers';
    const p = scriptPlanner([VAGUE, VAGUE, { ...VAGUE, specific: false, understood: longUnderstood }]);
    conduct.setPlanner(p.planner);
    resetHarness();
    stubClaude({ 'opening a P1 bridge': { engaged: [{ agentId: 'netops', why: 'campus owner' }], stoodDown: [] } });
    await jarvis.ask('wifi is bad', { conversationId: 'l1' });
    await jarvis.ask('not sure', { conversationId: 'l1' });
    said.length = 0;
    await jarvis.ask('still not sure', { conversationId: 'l1' });
    const thin = said.find((m) => /proceeding on:/.test(m.text));
    ok('the thin message exists', Boolean(thin));
    ok('it still fits the cap', thin.text.length <= conduct.TEXT_MAX, `${thin.text.length}`);
    ok('the invitation to re-scope survives the cap', /Correct me and I will re-scope\./.test(thin.text), thin.text);
    ok('the FULL assumption rides the envelope, uncut', thin.env.assumption === longUnderstood);
  }

  restoreClaude();
  conduct.setPlanner(null);
  console.log(`\nCW-9 bridge conduct: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('CW-9 test harness error:', err);
  process.exit(1);
});
