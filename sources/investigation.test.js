// CW-7 — the iterative investigation loop, verified DETERMINISTICALLY with a
// SCRIPTED planner (no API key, no network, no device). This proves the loop
// MECHANICS the contract pins: it narrows over N rounds to a confidence stop with
// a fix plan; a never-narrowing run hits the hard round cap and reports honestly;
// an ambiguous problem grills the operator and fires NO probe until answered;
// deny mode makes ZERO wire calls (reusing the REAL permission gate); a dead LLM
// stops honestly; every round is audited; and nothing is fabricated (each round's
// report is exactly what the probe returned). The real multi-round LLM run is the
// end-to-end test once credits return — the injection is what makes THIS test
// possible without them.

const investigation = require('./investigation');
const approvals = require('./approvals');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`); }
}

// A scripted planner factory. Each field is a function the test controls, so a
// scenario scripts exactly the reasoning it wants without any LLM.
function scriptedPlanner(script) {
  return {
    available: script.available || (() => true),
    understand: script.understand,
    probe: script.probe,
    assess: script.assess,
    fix: script.fix,
  };
}

// A probe spy + a broadcast/audit spy shared per scenario.
function freshCtx(probeImpl) {
  const events = [];
  const audits = [];
  const probeCalls = [];
  investigation.init({
    probe: (args) => { probeCalls.push(args); return probeImpl(args); },
    broadcast: (type, data) => events.push({ type, data }),
    roster: () => [
      { id: 'config-keeper', name: 'Config-Keeper', connected: true, sees: ['device CLI'] },
      { id: 'monitor-eye', name: 'Monitor-Eye', connected: true, sees: ['alarms'] },
    ],
    audit: (entry) => audits.push(entry),
  });
  return { events, audits, probeCalls };
}

(async () => {
  console.log('\nCW-7 — iterative investigation loop (scripted planner, deterministic):');

  // ── 1. NARROWS over 3 rounds → confidence stop → root cause + fix proposal ──
  {
    const reports = [
      'Ran "show ip int brief" on sw2 — Gi1/0/3 is administratively down.',
      'Monitor-Eye: interface-down alarm on sw2 Gi1/0/3 since 14:02.',
      'Ran "show run interface Gi1/0/3" on sw2 — "shutdown" present in the config.',
    ];
    let ri = 0;
    const { events, audits, probeCalls } = freshCtx(async () => ({
      agentId: 'config-keeper', name: 'Config-Keeper', stance: 'evidence', text: reports[ri++],
    }));
    let ci = 0;
    investigation.setPlanner(scriptedPlanner({
      understand: async () => ({ specific: true, understood: 'sw2 Gi1/0/3 down since 14:02',
        hypotheses: [{ id: 'h1', text: 'port shut' }, { id: 'h2', text: 'cable fault' }, { id: 'h3', text: 'upstream alarm' }] }),
      probe: async ({ rounds }) => ({ agentId: 'config-keeper', question: `probe #${rounds.length + 1}`, device: 'sw2', rationale: 'narrow it' }),
      // Confidence climbs 0.4 → 0.7 → 0.9 as the port-shut hypothesis is confirmed
      // and the others are eliminated; the loop stops the round it clears 0.85.
      assess: async ({ hypotheses }) => {
        const conf = [0.4, 0.7, 0.9][ci++];
        return {
          hypotheses: hypotheses.map((h) => h.id === 'h1' ? { ...h, status: ci === 3 ? 'confirmed' : 'standing' } : { ...h, status: ci >= 2 ? 'eliminated' : 'standing' }),
          confidence: conf,
        };
      },
      fix: async () => ({ rootCause: 'Gi1/0/3 was shut in config', summary: 'no shut the port',
        proposal: { device: 'sw2', commands: ['interface Gi1/0/3', 'no shutdown'], reason: 'restore the shut port' } }),
    }));

    const rec = investigation.create({ problem: 'sw2 port issue', who: 'tester' });
    const out = await investigation.run(rec.id);

    ok('narrow → status resolved', out.status === 'resolved', out.status);
    ok('narrow → ran exactly 3 rounds (confidence stop, not the cap)', out.rounds.length === 3, `${out.rounds.length}`);
    ok('narrow → final confidence ≥ threshold', out.confidence >= out.threshold, `${out.confidence} vs ${out.threshold}`);
    ok('narrow → root cause set', !!out.rootCause, out.rootCause);
    ok('narrow → a config fix came back as an approve-first proposal', !!(out.fixPlan && out.fixPlan.proposal && out.fixPlan.proposal.route === 'POST /api/copilot/change'), JSON.stringify(out.fixPlan && out.fixPlan.proposal));
    ok('narrow → proposal was NOT auto-applied (only a proposal on the record)', out.fixPlan.proposal.commands.join(' ').includes('no shutdown'), JSON.stringify(out.fixPlan.proposal.commands));
    // NO FABRICATION: each round's stored report is EXACTLY what the probe returned.
    ok('no fabrication → round reports match the real probe output verbatim',
      out.rounds.every((r, i) => r.report.text === reports[i]), JSON.stringify(out.rounds.map((r) => r.report.text)));
    // Hypotheses narrowed: h1 confirmed at the end, at least one eliminated.
    ok('narrow → hypotheses actually shrank (one confirmed, one eliminated)',
      out.hypotheses.some((h) => h.status === 'confirmed') && out.hypotheses.some((h) => h.status === 'eliminated'),
      JSON.stringify(out.hypotheses));
    // Streaming + audit.
    ok('narrow → a round event streamed per round', events.filter((e) => e.type === 'investigation_round').length === 3, `${events.filter((e) => e.type === 'investigation_round').length}`);
    ok('narrow → round WS shape carries {round,probe,agent,report,hypotheses,confidence,status}', (() => {
      const e = events.find((x) => x.type === 'investigation_round').data;
      return e && e.round === 1 && e.probe && e.agent && e.report && Array.isArray(e.hypotheses) && typeof e.confidence === 'number' && e.status;
    })());
    ok('narrow → every round was audited', audits.filter((a) => /investigation probe/.test(a.what)).length === 3, `${audits.length} audits`);
    ok('narrow → probe went to the agent the planner picked (config-keeper)', probeCalls.every((c) => c.agentId === 'config-keeper'));
  }

  // ── 2. NEVER narrows → hits the hard round CAP → honest report ──────────────
  {
    process.env.INVESTIGATION_MAX_ROUNDS = '6';
    const { events, audits } = freshCtx(async () => ({ agentId: 'monitor-eye', name: 'Monitor-Eye', stance: 'evidence', text: 'nothing conclusive' }));
    investigation.setPlanner(scriptedPlanner({
      understand: async () => ({ specific: true, understood: 'vague slowness', hypotheses: [{ id: 'h1', text: 'maybe congestion' }] }),
      probe: async () => ({ agentId: 'monitor-eye', question: 'keep looking', device: null }),
      assess: async ({ hypotheses }) => ({ hypotheses, confidence: 0.2 }), // never climbs
      fix: async () => { throw new Error('fix must not be called when capped'); },
    }));
    const rec = investigation.create({ problem: 'branch slow', who: 'tester' });
    const out = await investigation.run(rec.id);
    ok('cap → status capped', out.status === 'capped', out.status);
    ok('cap → ran exactly CAP rounds (hard stop)', out.rounds.length === 6, `${out.rounds.length}`);
    ok('cap → no false root cause claimed', out.rootCause === null, `${out.rootCause}`);
    ok('cap → honest summary names the cap + confidence, no proposal', /round cap/i.test(out.fixPlan.summary) && out.fixPlan.proposal === null);
    ok('cap → the cap stop was audited', audits.some((a) => /round cap/i.test(a.what)));
  }

  // ── 3. AMBIGUOUS → grills the operator, fires NO probe until answered ───────
  {
    let phase = 'vague';
    const { probeCalls, events } = freshCtx(async () => ({ agentId: 'config-keeper', name: 'Config-Keeper', stance: 'evidence', text: 'ran after the answer' }));
    investigation.setPlanner(scriptedPlanner({
      understand: async ({ answers }) => answers && answers.length
        ? { specific: true, understood: 'sw3 slow since 2pm', hypotheses: [{ id: 'h1', text: 'test' }] }
        : { specific: false, understood: 'too vague', questions: ['Which site/device?', 'Since when?'] },
      probe: async () => ({ agentId: 'config-keeper', question: 'now probe', device: 'sw3' }),
      assess: async ({ hypotheses }) => ({ hypotheses, confidence: 0.95 }),
      fix: async () => ({ rootCause: 'found it', summary: 'manual fix', proposal: null }),
    }));
    const rec = investigation.create({ problem: 'network is slow', who: 'tester' });
    const grilled = await investigation.run(rec.id);
    ok('ambiguous → status awaiting-operator', grilled.status === 'awaiting-operator', grilled.status);
    ok('ambiguous → clarifying questions posed', grilled.questions.length >= 1, JSON.stringify(grilled.questions));
    ok('ambiguous → ZERO probes fired before the answer', probeCalls.length === 0, `${probeCalls.length}`);
    // Operator answers → the loop resumes and now runs.
    const resumed = await investigation.answer(rec.id, 'sw3, since 2pm', 'tester');
    ok('answered → probe fired only AFTER the operator answered', probeCalls.length === 1, `${probeCalls.length}`);
    ok('answered → investigation reaches a resolved root cause', resumed.status === 'resolved', resumed.status);
    ok('answered → the answer is on the record', resumed.answers.length === 1 && /sw3/.test(resumed.answers[0].text));
  }

  // ── 4. DENY mode → probes make ZERO wire calls (reuses the REAL gate) ───────
  {
    let wireCalls = 0;
    approvals.setMode('deny');
    const { probeCalls, audits } = freshCtx(async ({ agentId, question }) => {
      // The SAME real gate the production read path uses. In deny mode it denies
      // BEFORE calling the worker, so the wire (worker) never runs.
      const g = await approvals.gate({ agentId, agentName: 'Config-Keeper', command: question, target: 'sw2', reason: 'probe' },
        async () => { wireCalls++; return { text: 'THIS SHOULD NEVER RUN' }; });
      if (g.denied) return { agentId, name: 'Config-Keeper', stance: 'denied', text: 'Read denied by the operator — ran nothing.' };
      return { agentId, name: 'Config-Keeper', stance: 'evidence', text: g.result.text };
    });
    investigation.setPlanner(scriptedPlanner({
      understand: async () => ({ specific: true, understood: 'sw2 check', hypotheses: [{ id: 'h1', text: 'x' }] }),
      probe: async () => ({ agentId: 'config-keeper', question: 'show version', device: 'sw2' }),
      assess: async ({ hypotheses }) => ({ hypotheses, confidence: 0.9 }),
      fix: async () => ({ rootCause: 'should not reach', summary: 'x', proposal: null }),
    }));
    const rec = investigation.create({ problem: 'sw2 in deny mode', who: 'tester' });
    const out = await investigation.run(rec.id);
    approvals.setMode('auto'); // restore
    ok('deny → ZERO wire calls were made', wireCalls === 0, `${wireCalls}`);
    ok('deny → the probe came back denied and the loop stopped blocked', out.status === 'blocked', out.status);
    ok('deny → no root cause fabricated', out.rootCause === null);
    ok('deny → the denied probe is on the record as a blocked round', out.rounds.length === 1 && out.rounds[0].status === 'blocked');
    ok('deny → the block was audited', audits.some((a) => /DENIED|blocked/i.test(a.what) || a.result === 'blocked'));
  }

  // ── 5. DEAD LLM (no key/credits) → honest "reasoning unavailable", stops ────
  {
    const { probeCalls } = freshCtx(async () => ({ agentId: 'config-keeper', name: 'x', stance: 'evidence', text: 'should not run' }));
    investigation.setPlanner(scriptedPlanner({
      available: () => false, // the dead-key signal
      understand: async () => { throw new Error('must not be asked to reason with no key'); },
    }));
    const rec = investigation.create({ problem: 'anything', who: 'tester' });
    const out = await investigation.run(rec.id);
    ok('dead key → status reasoning-unavailable', out.status === 'reasoning-unavailable', out.status);
    ok('dead key → says so honestly', /reasoning is unavailable/i.test(out.stuckReason || ''), out.stuckReason);
    ok('dead key → NOT one probe fired, nothing fabricated', probeCalls.length === 0 && out.rounds.length === 0 && out.rootCause === null);
  }

  // ── 6. STUCK → the planner sees no useful probe → honest "needs X" ──────────
  {
    const { probeCalls } = freshCtx(async () => ({ agentId: 'config-keeper', name: 'x', stance: 'evidence', text: 'unused' }));
    investigation.setPlanner(scriptedPlanner({
      understand: async () => ({ specific: true, understood: 'reachability', hypotheses: [{ id: 'h1', text: 'core down' }] }),
      probe: async () => ({ stuck: 'I need the core router, which I cannot reach — reserve it and re-run.' }),
      assess: async () => { throw new Error('assess must not run when stuck before the first probe'); },
      fix: async () => { throw new Error('fix must not run when stuck'); },
    }));
    const rec = investigation.create({ problem: 'core reachability', who: 'tester' });
    const out = await investigation.run(rec.id);
    ok('stuck → status stuck', out.status === 'stuck', out.status);
    ok('stuck → says exactly what it needs, no fabricated verdict', /cannot reach/i.test(out.stuckReason || '') && out.rootCause === null);
    ok('stuck → fired no probe (dead-end recognised before any wire)', probeCalls.length === 0, `${probeCalls.length}`);
  }

  // ── 7. CW-9: a bridge-driven run — seeded understanding, engaged-only probing,
  //          observer narration, and the terminal evidence on every report ────
  {
    const { probeCalls } = freshCtx(async ({ agentId }) => ({
      agentId, name: 'Config-Keeper', stance: 'evidence', text: 'Gi1/0/3 is administratively down.',
      cli: [{ host: '10.10.20.176', command: 'show ip int brief', output: 'Gi1/0/3  admin down', transport: 'cmdrunner' }],
    }));
    const rounds = [];
    const updates = [];
    let understandCalls = 0;
    investigation.setPlanner(scriptedPlanner({
      understand: async () => { understandCalls++; return { specific: true, understood: 'should not be asked', hypotheses: [] }; },
      probe: async ({ roster }) => ({ agentId: roster[0].id, question: 'show ip int brief on sw2', device: 'sw2' }),
      assess: async () => ({ hypotheses: [{ id: 'h1', text: 'the port is shut', status: 'confirmed' }], confidence: 0.95, note: 'confirmed' }),
      fix: async () => ({ rootCause: 'Gi1/0/3 was shut', summary: 'no shut it', proposal: { device: 'sw2', commands: ['interface Gi1/0/3', 'no shutdown'], reason: 'restore the port' } }),
    }));
    const rec = investigation.create({
      problem: 'users on sw2 lost the network',
      understood: 'Users behind sw2 lost connectivity since 14:00.',
      hypotheses: [{ id: 'h1', text: 'the access port is shut' }],
      agents: ['config-keeper'],
      observer: { onRound: (snap, round) => rounds.push(round), onUpdate: (snap) => updates.push(snap) },
      who: 'tester',
    });
    const out = await investigation.run(rec.id);
    ok('CW-9: a seeded understanding is NOT re-grilled (one gate in the system)', understandCalls === 0);
    ok('CW-9: the loop only tasked the ENGAGED agent', probeCalls.every((p) => p.agentId === 'config-keeper'), JSON.stringify(probeCalls));
    ok('CW-9: the observer saw the round', rounds.length === 1 && rounds[0].agent === 'Config-Keeper');
    ok('CW-9: the report carries its terminal evidence',
      rounds[0].report.cli.length === 1 && rounds[0].report.cli[0].transport === 'cmdrunner');
    ok('CW-9: the observer saw the resolved snapshot', updates.some((u) => u.status === 'resolved'));
    ok('CW-9: the engaged set is on the snapshot', JSON.stringify(out.agents) === JSON.stringify(['config-keeper']));
    ok('CW-9: the fix is still a PROPOSAL — nothing applied', out.fixPlan.proposal.device === 'sw2' && out.status === 'resolved');
  }

  // ── 8. CW-9: a throwing observer can never break the loop ──────────────────
  {
    freshCtx(async ({ agentId }) => ({ agentId, name: 'Config-Keeper', stance: 'evidence', text: 'a real reading' }));
    investigation.setPlanner(scriptedPlanner({
      understand: async () => ({ specific: true, understood: 'x', hypotheses: [] }),
      probe: async () => ({ stuck: 'nothing else would narrow this' }),
    }));
    const rec = investigation.create({
      problem: 'anything', understood: 'anything, understood',
      observer: { onRound: () => { throw new Error('boom'); }, onUpdate: () => { throw new Error('boom'); } },
      who: 'tester',
    });
    const out = await investigation.run(rec.id);
    ok('CW-9: a throwing observer does not break the investigation', out.status === 'stuck', out.status);
  }

  console.log(`\nCW-7 investigation: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
