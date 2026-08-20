// CW-11 — REFLEXION, verified DETERMINISTICALLY with scripted planners (no API
// key, no network, no device). This proves the four parts and, more importantly,
// the four PINNED GUARDRAILS that reviewers must be able to check as laws:
//
//   BOUNDED            — exactly one reflection pass per round, exactly one
//                        self-check per verdict, and never a loop looking for a
//                        new angle (one retry, then an honest stop).
//   EVIDENCE-GROUNDED  — a round with no read behind it gets NO reflection; a
//                        traced claim may only cite evidence ids this incident
//                        really produced; an invented id is dropped.
//   SILENT WHEN CLEAN  — a round that genuinely added something says nothing extra.
//   LESSONS ARE FACTS  — a lesson biases where to look first and carries nothing
//                        runnable; it can never cite an incident that does not exist.
//
// Plus the operator-experience probes from the contract: identical-evidence
// rounds, an unsupported verdict claim, a failed prediction, and a lesson written,
// scrubbed and consulted.

const fs = require('fs');
const path = require('path');
const reflexion = require('./reflexion');
const lessons = require('./lessons');
const investigation = require('./investigation');
const conduct = require('./conduct');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`); }
}
function section(t) { console.log(`\n${t}`); }

// One evidence entry, exactly the shape a real read produces.
const ev = (command, output, source = 'catalyst-center') => ({
  host: 'dnac', source, command, output, transport: 'api', line: `read ${command}`,
});

function scriptedInvestigation(probeImpl, rosterIds = ['config-keeper', 'monitor-eye']) {
  const events = [];
  const probeCalls = [];
  investigation.init({
    probe: (args) => { probeCalls.push(args); return probeImpl(args); },
    broadcast: (type, data) => events.push({ type, data }),
    roster: () => rosterIds.map((id) => ({ id, name: id, connected: true, sees: ['things'] })),
    audit: () => {},
  });
  return { events, probeCalls };
}

(async () => {
  console.log('\nCW-11 — reflexion (scripted planners, deterministic):');

  // ═══ PART 1 — ROUND REFLECTION ═════════════════════════════════════════════
  section('PART 1 — identical-evidence rounds: an honest line AND a changed approach:');
  {
    const same = ev('GET /dna/intent/api/v1/network-health', 'Overall health 100');
    let n = 0;
    const { probeCalls, events } = scriptedInvestigation(async () => {
      n++;
      // Rounds 1 and 2 return byte-identical readings; every later round reads
      // something genuinely new, so exactly one round can honestly be reflected on.
      const cli = n <= 2 ? [{ ...same }] : [ev(`GET /dna/intent/api/v1/interface?r=${n}`, `Gi1/0/${n} down`)];
      return { agentId: 'config-keeper', name: 'config-keeper', stance: 'evidence', text: 'a real read', cli };
    });
    const reflectCalls = [];
    reflexion.setPlanner({
      available: () => true,
      reflect: async (a) => {
        reflectCalls.push(a);
        return { line: 'Round 2 turned up nothing new — that angle is exhausted.',
          nextAngle: 'ask Monitor-Eye for the alarm history instead',
          avoidAgentIds: ['config-keeper'], avoidChecks: [] };
      },
    });
    const probeArgs = [];
    investigation.setPlanner({
      available: () => true,
      understand: async () => ({ specific: true, understood: 'a real problem', hypotheses: [] }),
      probe: async (a) => {
        probeArgs.push(a);
        // The CHANGED approach: a different agent once a change is required.
        return a.mustChange
          ? { agentId: 'monitor-eye', question: 'what alarms fired', device: null }
          : { agentId: 'config-keeper', question: 'is the port up', device: 'sw2' };
      },
      assess: async ({ hypotheses }) => ({ hypotheses, confidence: 0.1 }),
    });
    const rec = investigation.create({ problem: 'p', understood: 'p understood', who: 'tester' });
    const out = await investigation.run(rec.id);
    const rounds = out.rounds;

    ok('round 1 (new evidence) gets NO reflection — silent when clean', rounds[0].reflection === null);
    ok('round 2 (identical evidence) is reflected on', Boolean(rounds[1].reflection && rounds[1].reflection.nothingNew));
    ok('and says so honestly in one short line',
      /nothing new/i.test(rounds[1].reflection.line) && rounds[1].reflection.line.length <= conduct.TEXT_MAX,
      rounds[1].reflection && rounds[1].reflection.line);
    ok('the reflection names a DIFFERENT angle for the next round',
      /Monitor-Eye/i.test(rounds[1].reflection.nextAngle || ''), rounds[1].reflection.nextAngle);
    ok('the next round REALLY changes approach (different agent)',
      probeCalls[2] && probeCalls[2].agentId === 'monitor-eye', probeCalls[2] && probeCalls[2].agentId);
    ok('the change-approach instruction reached the probe planner',
      Boolean(probeArgs[2] && probeArgs[2].mustChange && probeArgs[2].mustChange.avoidAgentIds.includes('config-keeper')));
    ok('round 3 (new evidence again) is silent once more', rounds[2].reflection === null);
    ok('BOUNDED: exactly ONE reflection pass ran across the whole investigation',
      reflectCalls.length === 1, `${reflectCalls.length} passes`);
    const streamed = events.filter((e) => e.type === 'investigation_round').map((e) => e.data);
    ok('the reflection rides the streamed round payload (the UI can render it)',
      streamed[1] && streamed[1].reflection && streamed[1].reflection.nothingNew === true);
    ok('and a clean round streams reflection:null — nothing extra for the UI to show',
      streamed[0] && streamed[0].reflection === null);
  }

  section('BOUNDED — a second reflection pass on the same round is impossible:');
  {
    let calls = 0;
    reflexion.setPlanner({ available: () => true,
      reflect: async () => { calls++; return { line: 'nothing new', nextAngle: 'try elsewhere', avoidAgentIds: [], avoidChecks: [] }; } });
    const key = `bound-${Date.now()}`;
    const e = ev('GET /x', 'same body');
    await reflexion.reflectRound(key, { roundNo: 1, cli: [{ ...e }], understood: 'u', roster: [] });
    const first = await reflexion.reflectRound(key, { roundNo: 2, cli: [{ ...e }], understood: 'u', roster: [] });
    const second = await reflexion.reflectRound(key, { roundNo: 2, cli: [{ ...e }], understood: 'u', roster: [] });
    ok('the repeat round reflects once', Boolean(first && first.nothingNew));
    ok('a second call on the SAME round returns the SAME result', second === first);
    ok('and makes NO second model call', calls === 1, `${calls} calls`);
  }

  section('EVIDENCE-GROUNDED — no read behind the round means no reflection claim:');
  {
    let calls = 0;
    reflexion.setPlanner({ available: () => true, reflect: async () => { calls++; return { line: 'x' }; } });
    const key = `noread-${Date.now()}`;
    const out = await reflexion.reflectRound(key, { roundNo: 1, cli: [], understood: 'u', roster: [] });
    ok('a round that read nothing gets no reflection', out === null);
    ok('and the model is never asked to comment on a round with no evidence', calls === 0);
  }

  section('BOUNDED — the search for a new angle never loops:');
  {
    const same = ev('GET /same', 'same body');
    scriptedInvestigation(async () => ({ agentId: 'config-keeper', name: 'config-keeper',
      stance: 'evidence', text: 't', cli: [{ ...same }] }));
    reflexion.setPlanner({ available: () => true,
      reflect: async () => ({ line: 'nothing new', nextAngle: 'try another system', avoidAgentIds: [], avoidChecks: [] }) });
    let probePicks = 0;
    investigation.setPlanner({
      available: () => true,
      understand: async () => ({ specific: true, understood: 'u', hypotheses: [] }),
      // A planner that will not change its mind, ever.
      probe: async () => { probePicks++; return { agentId: 'config-keeper', question: 'the same check', device: 'sw2' }; },
      assess: async ({ hypotheses }) => ({ hypotheses, confidence: 0.1 }),
    });
    const rec = investigation.create({ problem: 'p', understood: 'u', who: 'tester' });
    const out = await investigation.run(rec.id);
    ok('a planner that cannot change approach stops the loop HONESTLY', out.status === 'stuck', out.status);
    ok('and says plainly why, without claiming progress',
      /could not find a different angle/i.test(out.stuckReason || ''), out.stuckReason);
    ok('it asked for a new angle exactly ONCE more — never in a loop',
      probePicks === 4, `${probePicks} probe picks`);
    ok('and no third round was recorded from a repeated check', out.rounds.length === 2, `${out.rounds.length} rounds`);
  }

  // ═══ PART 2 — VERDICT SELF-CHECK ═══════════════════════════════════════════
  section('PART 2 — an unsupported verdict claim is downgraded to SUSPECTED:');
  {
    const key = `verdict-${Date.now()}`;
    reflexion.indexEvidence(key, 1, [ev('GET /a', 'Gi1/0/3 is administratively down')]);
    reflexion.indexEvidence(key, 2, [ev('GET /b', 'no alarms in the window')]);
    let traceCalls = 0;
    let sawEvidence = null;
    reflexion.setPlanner({
      available: () => true,
      trace: async (a) => {
        traceCalls++; sawEvidence = a.evidence;
        return { causeEvidenceIds: ['E1'], claims: [
          { text: 'Gi1/0/3 was shut in config', evidenceIds: ['E1'] },
          { text: 'the upstream carrier dropped the circuit', evidenceIds: [] },
          { text: 'the ACI contract was deleted last night', evidenceIds: ['E99'] },
        ] };
      },
    });
    const sc = await reflexion.selfCheckVerdict(key, { cause: 'Gi1/0/3 was shut in config', summary: 's', hypotheses: [], rounds: [] });
    ok('the self-check ran', Boolean(sc && sc.ran));
    ok('the model was shown the REAL evidence records, tagged with ids',
      Array.isArray(sawEvidence) && sawEvidence.length === 2 && sawEvidence[0].eid === 'E1');
    ok('a claim traced to a real record is VERIFIED', sc.verified.length === 1 && sc.verified[0].evidenceIds[0] === 'E1');
    ok('a claim with no record behind it is SUSPECTED, not stated',
      sc.suspected.some((s) => /carrier/.test(s.claim) && /no reading/.test(s.why)));
    ok('a claim citing an INVENTED evidence id is also suspected',
      sc.suspected.some((s) => /ACI contract/.test(s.claim)));
    ok('and the invented id is dropped, never echoed as real', sc.droppedIds.includes('E99'));
    ok('the cause itself is reported as supported when it traces to a real record',
      sc.causeSupported === true && sc.causeEvidenceIds.join() === 'E1');
    const again = await reflexion.selfCheckVerdict(key, { cause: 'x' });
    ok('BOUNDED: a second self-check on the same verdict returns the first result', again === sc);
    ok('and makes NO second model call', traceCalls === 1, `${traceCalls} calls`);

    // The envelope the desk consumes.
    const env = conduct.envelope.verdict('Cause: x', { cause: 'x', confidence: 0.9, rounds: 2,
      verified: sc.verified, suspected: sc.suspected, causeSupported: sc.causeSupported });
    ok('the verdict envelope carries verified[] and suspected[] separately',
      env.verdict.verified.length === 1 && env.verdict.suspected.length === 2);
    ok('and a pre-CW-11 verdict still renders with empty lists (additive only)',
      conduct.envelope.verdict('t', { cause: 'c', confidence: 0.5, rounds: 1 }).verdict.verified.length === 0);
  }

  section('PART 2 — an UNSUPPORTED cause is labelled suspected on the record:');
  {
    const key = `verdict2-${Date.now()}`;
    reflexion.indexEvidence(key, 1, [ev('GET /a', 'nothing conclusive')]);
    reflexion.setPlanner({ available: () => true,
      trace: async () => ({ causeEvidenceIds: [], claims: [{ text: 'a bad SFP', evidenceIds: [] }] }) });
    const sc = await reflexion.selfCheckVerdict(key, { cause: 'a bad SFP' });
    ok('a cause no reading supports comes back causeSupported:false', sc.causeSupported === false);
    ok('and it appears in suspected, never in verified',
      sc.verified.length === 0 && sc.suspected.length === 1);
  }

  section('PART 2 — with no evidence and no reasoning, nothing is dressed up:');
  {
    reflexion.setPlanner(null);
    const sc = await reflexion.selfCheckVerdict(`empty-${Date.now()}`, { cause: 'x' });
    ok('no evidence / no reasoning → no self-check result at all (never a fake pass)', sc === null);
  }

  // ═══ PART 3 — PREDICTION FOLLOW-THROUGH ════════════════════════════════════
  section('PART 3 — a FAILED prediction is stated plainly and reopens the investigation:');
  {
    const saidLines = [];
    const reopens = [];
    const probes = [];
    reflexion.init({
      probe: async (a) => { probes.push(a); return { agentId: a.agentId, name: a.agentId, stance: 'evidence',
        text: 'Gi1/0/3 is still down', cli: [ev('show ip int brief', 'Gi1/0/3 down down', 'catalyst-center')] }; },
      say: (line) => saidLines.push(line),
      audit: () => {},
      reopen: async (r) => { reopens.push(r); return { id: 'INV-REOPEN-1' }; },
    });
    reflexion.setPlanner({ available: () => true,
      judge: async () => ({ held: false, line: 'My prediction was WRONG — the port is still down, so the shut config was not the cause. Reopening.' }) });
    const p = reflexion.registerPrediction({ key: 'k1', investigationId: 'INV-1',
      hypothesis: 'Gi1/0/3 was shut in config', then: 'the port comes up after no-shut',
      check: { agentId: 'config-keeper', question: 'is Gi1/0/3 up now', device: 'sw2' }, changeId: 'chg-1' });
    ok('the proving check is parked, not run', p.state === 'waiting' && probes.length === 0);
    const out = await reflexion.runFollowThrough(p.id, { who: 'tester' });
    ok('the check ran through the gated read path', probes.length === 1 && probes[0].agentId === 'config-keeper');
    ok('a failed prediction is recorded as FAILED', out.prediction.state === 'failed');
    ok('and said plainly — no softening into partial success',
      /wrong/i.test(out.line) && !/partial|some progress/i.test(out.line), out.line);
    ok('the operator is told, in one capped line', saidLines.length === 1 && saidLines[0].length <= conduct.TEXT_MAX);
    ok('the investigation is REOPENED, never closed on hope', reopens.length === 1);
    ok('carrying the falsified hypothesis as context',
      /Gi1\/0\/3 was shut in config/.test(reopens[0].falsified), reopens[0].falsified);
    ok('and carrying the real reading that falsified it',
      /still down/.test(reopens[0].report.text));
    const rerun = await reflexion.runFollowThrough(p.id, {});
    ok('BOUNDED: a settled prediction is never re-run', rerun.rerun === false && probes.length === 1);
  }

  section('PART 3 — a prediction that HOLDS is one confirm line, nothing more:');
  {
    const said = [];
    reflexion.init({
      probe: async (a) => ({ agentId: a.agentId, stance: 'evidence', text: 'Gi1/0/3 is up',
        cli: [ev('show ip int brief', 'Gi1/0/3 up up')] }),
      say: (line) => said.push(line), audit: () => {},
      reopen: async () => { throw new Error('reopen must NOT be called when the prediction holds'); },
    });
    reflexion.setPlanner({ available: () => true,
      judge: async () => ({ held: true, line: 'Prediction held: the port came up. The verdict stands.' }) });
    const p = reflexion.registerPrediction({ key: 'k2', hypothesis: 'h', then: 'the port comes up',
      check: { agentId: 'config-keeper', question: 'is it up', device: 'sw2' } });
    const out = await reflexion.runFollowThrough(p.id, {});
    ok('a held prediction is recorded as held', out.prediction.state === 'held' && out.held === true);
    ok('and is exactly one line', said.length === 1, `${said.length} lines`);
  }

  section('PART 3 — a check that read NOTHING confirms nothing and falsifies nothing:');
  {
    let judged = 0;
    let reopened = 0;
    reflexion.init({
      probe: async (a) => ({ agentId: a.agentId, stance: 'unreachable', text: '', cli: [] }),
      say: () => {}, audit: () => {},
      reopen: async () => { reopened++; },
    });
    reflexion.setPlanner({ available: () => true, judge: async () => { judged++; return { held: true, line: 'held' }; } });
    const p = reflexion.registerPrediction({ key: 'k3', hypothesis: 'h', then: 't',
      check: { agentId: 'config-keeper', question: 'q', device: 'sw2' } });
    const out = await reflexion.runFollowThrough(p.id, {});
    ok('an unreadable check settles nothing', out.prediction.state === 'inconclusive' && out.held === null);
    ok('the model is never asked to judge a reading that does not exist', judged === 0);
    ok('and nothing is reopened on a non-result', reopened === 0);
    ok('the operator is told honestly that nothing was proved',
      /neither confirm nor drop/i.test(out.line), out.line);

    // A guardrail REFUSAL is prose about why nothing ran — it is not a reading,
    // so it can never confirm a prediction either (found by the live pass).
    reflexion.init({
      probe: async () => ({ stance: 'refused', text: 'That request named two devices — I ran nothing.', cli: [] }),
      say: () => {}, audit: () => {}, reopen: async () => { reopened++; },
    });
    const p2 = reflexion.registerPrediction({ key: 'k3b', hypothesis: 'h', then: 't',
      check: { agentId: 'config-keeper', question: 'q', device: 'sw2' } });
    const out2 = await reflexion.runFollowThrough(p2.id, {});
    ok('a REFUSED check settles nothing and is never judged as a result',
      out2.prediction.state === 'inconclusive' && judged === 0);
  }

  section('PART 3 — no write path: the check is EXPOSED, never faked as applied:');
  {
    reflexion.init({ probe: async () => ({ stance: 'evidence', text: 'x' }), say: () => {}, audit: () => {} });
    const p = reflexion.registerPrediction({ key: 'k4', hypothesis: 'h', then: 't',
      check: { agentId: 'config-keeper', question: 'q', device: 'sw2' }, operatorTriggered: true });
    ok('the observer-sandbox message says plainly it cannot apply the change',
      /cannot apply this change myself/i.test(p.message) && /nothing has been applied/i.test(p.message), p.message);
    ok('and hands the operator the endpoint to trigger the check themselves',
      p.message.includes(`/api/copilot/predictions/${p.id}/check`));
    ok('it is listed for the UI', reflexion.listPredictions().some((x) => x.id === p.id));
  }

  section('PART 3 — a prediction with no runnable check is never parked:');
  {
    ok('no agent → nothing parked', reflexion.registerPrediction({ key: 'k5', check: { question: 'q' } }) === null);
    ok('no question → nothing parked', reflexion.registerPrediction({ key: 'k5', check: { agentId: 'a' } }) === null);
    reflexion.setPlanner({ available: () => true,
      predict: async () => ({ then: 't', agentId: 'not-on-the-roster', question: 'q', device: null }) });
    const composed = await reflexion.composePrediction({ cause: 'c', summary: 's',
      roster: [{ id: 'config-keeper', name: 'Config-Keeper' }] });
    ok('a proving check tasked to an agent that is not on the roster is refused', composed === null);
  }

  // ═══ PART 4 — LESSONS MEMORY ═══════════════════════════════════════════════
  section('PART 4 — a lesson is written, SCRUBBED, listed and consulted:');
  {
    const id = `INC-TEST-${process.pid}`;
    try { lessons.remove(id); } catch (e) { /* fresh start */ }
    lessons.setPlanner({
      available: () => true,
      compose: async () => ({
        cause: 'the uplink was shut during the maintenance window',
        // A device reading can carry a credential — the scrubber is the law here.
        fastestCheck: 'show ip int brief on sw2 (login used password=SuperSecret123)',
        wastedTime: 'two rounds re-reading network-health, which never moves',
        keywords: ['users cannot reach the app', 'branch down', 'uplink'],
      }),
      similar: async ({ lessons: notes }) => ({ matchId: notes[0].id, why: 'the same branch symptom',
        lookFirst: 'show ip int brief on the branch uplink' }),
    });
    const written = await lessons.recordFromIncident({ incidentId: id, problem: 'branch users cannot reach the app',
      cause: 'unknown at the time', rounds: [] });
    ok('a lesson file is written on close', Boolean(written) && written.id === id);
    const onDisk = fs.readFileSync(path.join(lessons.LESSONS_DIR, `${id}.md`), 'utf8');
    ok('it carries the four facts', /Cause:/.test(onDisk) && /Fastest check:/.test(onDisk)
      && /Wasted time:/.test(onDisk) && /Symptom keywords:/.test(onDisk));
    ok('SCRUBBED: a credential in a reading never reaches the lesson file',
      !/SuperSecret123/.test(onDisk), onDisk.slice(0, 300));
    ok('and the scrubber marker is there instead', /redacted/i.test(onDisk));
    ok('it reads back through get()', (lessons.get(id) || {}).cause.includes('uplink was shut'));
    ok('and appears in list()', lessons.list().some((l) => l.id === id));

    const hit = await lessons.consult({ problem: 'branch users cannot reach the app again', understood: 'branch reachability' });
    ok('a new problem consults the memory and says so in ONE line', Boolean(hit) && hit.id === id);
    ok('the line names the past incident and what to look at first',
      hit.line.includes(id) && /show ip int brief/.test(hit.line), hit.line);
    ok('LESSONS ARE FACTS, NOT RULES: the line says it still asks first',
      /still asking before I run anything/i.test(hit.line));
    ok('and the consult result carries NOTHING runnable — no agent, no command',
      !('agentId' in hit) && !('command' in hit) && !('run' in hit) && !('probe' in hit),
      Object.keys(hit).join(','));

    // The model cannot cite an incident we never closed.
    lessons.setPlanner({ available: () => true, similar: async () => ({ matchId: 'INC-NEVER-HAPPENED', why: 'w', lookFirst: 'x' }) });
    ok('a match naming a lesson that does not exist is thrown away',
      (await lessons.consult({ problem: 'p', understood: 'u' })) === null);

    // Honest silence when the model finds nothing.
    lessons.setPlanner({ available: () => true, similar: async () => ({ matchId: null, why: null, lookFirst: null }) });
    ok('no genuine match → nothing is said at all', (await lessons.consult({ problem: 'p', understood: 'u' })) === null);

    // NO KEYWORD MATCHING: with no reasoning, the memory stays quiet rather than
    // pattern-matching words (intent-first law).
    lessons.setPlanner(null);
    ok('with no reasoning the memory says nothing (it never keyword-matches)',
      (await lessons.consult({ problem: 'branch uplink down', understood: 'u' })) === null);

    ok('a lesson can be deleted by the operator', lessons.remove(id) === true && lessons.get(id) === null);
  }

  section('PART 4 — EVERY closing path writes the lesson (it lives in the engine):');
  {
    let composed = 0;
    lessons.setPlanner({ available: () => true,
      compose: async () => { composed++; return { cause: 'a shut uplink', fastestCheck: 'show ip int brief',
        wastedTime: 'nothing stood out', keywords: ['branch down'] }; } });
    reflexion.setPlanner({ available: () => true, trace: async () => ({ claims: [], causeEvidenceIds: [] }),
      predict: async () => null });
    scriptedInvestigation(async () => ({ agentId: 'config-keeper', name: 'config-keeper', stance: 'evidence',
      text: 'Gi1/0/3 is shut', cli: [ev('show run int Gi1/0/3', 'shutdown')] }));
    investigation.setPlanner({
      available: () => true,
      understand: async () => ({ specific: true, understood: 'u', hypotheses: [{ id: 'h1', text: 'port shut' }] }),
      probe: async () => ({ agentId: 'config-keeper', question: 'is it shut', device: 'sw2' }),
      assess: async ({ hypotheses }) => ({ hypotheses: hypotheses.map((h) => ({ ...h, status: 'confirmed' })), confidence: 0.95 }),
      fix: async () => ({ rootCause: 'the port was shut', summary: 'no shut it', proposal: null }),
    });
    const rec = investigation.create({ problem: 'branch is down', understood: 'u', who: 'tester' });
    const out = await investigation.run(rec.id);
    ok('the investigation resolved', out.status === 'resolved');
    // The write is fire-and-forget; let the microtask queue drain.
    await new Promise((r) => setTimeout(r, 20));
    const written = lessons.get(rec.id);
    ok('a lesson was written from the REST/engine path too, not only the bridge', Boolean(written), rec.id);
    ok('and it was composed by the model', composed === 1);
    if (written) lessons.remove(rec.id);
    lessons.setPlanner(null);
  }

  section('PART 3 — EVERY closing path parks the proving check (engine-owned):');
  {
    reflexion.init({ probe: async () => ({ stance: 'evidence', text: 'x' }), say: () => {}, audit: () => {} });
    reflexion.setPlanner({ available: () => true,
      trace: async () => ({ claims: [], causeEvidenceIds: [] }),
      predict: async () => ({ then: 'the port comes back up', agentId: 'config-keeper',
        question: 'is Gi1/0/3 up now', device: 'sw2' }) });
    scriptedInvestigation(async () => ({ agentId: 'config-keeper', name: 'config-keeper', stance: 'evidence',
      text: 'shut in config', cli: [ev('show run int Gi1/0/3', 'shutdown')] }));
    investigation.setPlanner({
      available: () => true,
      understand: async () => ({ specific: true, understood: 'u', hypotheses: [{ id: 'h1', text: 'port shut' }] }),
      probe: async () => ({ agentId: 'config-keeper', question: 'is it shut', device: 'sw2' }),
      assess: async ({ hypotheses }) => ({ hypotheses: hypotheses.map((h) => ({ ...h, status: 'confirmed' })), confidence: 0.95 }),
      fix: async () => ({ rootCause: 'the port was shut', summary: 'no shut it', proposal: null }),
    });
    const rec = investigation.create({ problem: 'p', understood: 'u', who: 'tester' });
    const out = await investigation.run(rec.id);
    ok('the verdict carries a parked prediction with an id', Boolean(out.prediction && out.prediction.id));
    ok('it is listed for the operator without the bridge being involved',
      reflexion.listPredictions().some((p) => p.id === out.prediction.id));
    ok('until a change is bound it is OPERATOR-triggered and says nothing was applied',
      out.prediction.operatorTriggered === true && /nothing has been applied/i.test(out.prediction.message));
    const bound = reflexion.attachChange(out.prediction.id, 'chg-99');
    ok('binding a change record flips it to automatic follow-through',
      bound.changeId === 'chg-99' && bound.operatorTriggered === false);
    ok('and the bound message still says nothing has been applied yet',
      /nothing has been applied/i.test(bound.message), bound.message);
    ok('binding an unknown prediction is a no-op, never a fabricated record',
      reflexion.attachChange('PRED-nope', 'chg-1') === null);
  }

  // ═══ THE CHAT ENVELOPE — what the DESK actually reads ══════════════════════
  // The reflection/lesson/prediction markers must ride the CHAT message, not only
  // the investigation WS payload — otherwise the desk's markers stay dark on real
  // traffic. The plain `text` never changes, so an old client is unaffected.
  section('CHAT ENVELOPE — reflection / lesson / prediction ride the chat message:');
  {
    const jarvis = require('./jarvis');
    const said = [];
    jarvis.init({
      say: (agentId, text, env) => said.push({ agentId, text, env: env || {} }),
      status: () => {}, log: () => {}, nameOf: (id) => id,
      roster: () => [{ id: 'config-keeper', name: 'config-keeper', connected: true, sees: ['cli'] }],
    });

    // 1. A round that turned up nothing new.
    const obs = jarvis._test.bridgeObserver();
    obs.onRound({}, {
      round: 2, agent: 'config-keeper', probe: { agentId: 'config-keeper', question: 'q' },
      report: { agentName: 'config-keeper', stance: 'evidence', text: 't',
        cli: [ev('GET /x', 'same body')] },
      hypotheses: [], confidence: 0.2, status: 'ok',
      reflection: { nothingNew: true, line: 'Round 2 turned up nothing new — that angle is exhausted.',
        nextAngle: 'read the alarm history instead', avoidAgentIds: ['config-keeper'] },
    });
    const marked = said.filter((m) => m.env && m.env.reflection);
    ok('the nothing-new chat message carries the reflection flag shape',
      marked.length >= 1 && marked[0].env.reflection.nothingNew === true);
    ok('with the line and the next angle the desk renders',
      /nothing new/i.test(marked[0].env.reflection.line)
      && /alarm history/.test(marked[0].env.reflection.nextAngle), JSON.stringify(marked[0].env.reflection));
    ok('the plain text is unchanged for a client that only reads text',
      /nothing new/i.test(marked[0].text));
    ok('the changing-approach line is marked too', marked.length === 2 && /Changing approach/.test(marked[1].text));

    // 2. A round that added something says nothing extra AND carries no marker.
    said.length = 0;
    const obs2 = jarvis._test.bridgeObserver();
    obs2.onRound({}, {
      round: 1, agent: 'config-keeper', probe: { agentId: 'config-keeper', question: 'q' },
      report: { agentName: 'config-keeper', stance: 'evidence', text: 't', cli: [ev('GET /new', 'new body')] },
      hypotheses: [], confidence: 0.2, status: 'ok', reflection: null,
    });
    ok('SILENT WHEN CLEAN: a clean round posts no reflection marker at all',
      said.every((m) => !m.env || !m.env.reflection));

    // 3. The parked prediction message.
    said.length = 0;
    reflexion.init({ probe: async () => ({ stance: 'evidence', text: 'x' }), say: () => {}, audit: () => {} });
    const parked = reflexion.registerPrediction({ key: 'env1', hypothesis: 'h', then: 't',
      check: { agentId: 'config-keeper', question: 'is it up', device: 'sw2' }, operatorTriggered: true });
    jarvis._test.parkPrediction({ id: 'INV-ENV-1', prediction: parked, hypotheses: [] }, { changeId: null });
    ok('the prediction message carries the prediction for the desk chip',
      said.length === 1 && said[0].env.prediction && said[0].env.prediction.id === parked.id);
    ok('and it still says plainly that nothing was applied',
      /nothing has been applied/i.test(said[0].text));

    // 4. The follow-through result, as the host receives it.
    const heard = [];
    reflexion.init({
      probe: async () => ({ stance: 'evidence', text: 'still down', cli: [ev('show ip int brief', 'down')] }),
      say: (line, extra) => heard.push({ line, extra }), audit: () => {}, reopen: async () => ({ id: 'INV-R' }),
    });
    reflexion.setPlanner({ available: () => true, judge: async () => ({ held: false, line: 'My call was WRONG — reopening.' }) });
    const p = reflexion.registerPrediction({ key: 'env2', hypothesis: 'the port was shut', then: 'it comes up',
      check: { agentId: 'config-keeper', question: 'is it up', device: 'sw2' } });
    const res = await reflexion.runFollowThrough(p.id, {});
    ok('a settled follow-through hands the host BOTH flag shapes',
      heard.length === 1 && heard[0].extra.prediction.id === p.id && Boolean(heard[0].extra.reflection));
    ok('and the failed one points at the reopen as its next angle',
      /reopening/i.test(heard[0].extra.reflection.nextAngle) && heard[0].extra.reflection.nothingNew === false,
      JSON.stringify(heard[0].extra.reflection));
    ok('the route result carries the same reflection shape', res.reflection === heard[0].extra.reflection
      || (res.reflection && res.reflection.nextAngle === heard[0].extra.reflection.nextAngle));

    // The two markers the desk renders on a follow-through message. Without these
    // a failed/held follow-through rendered as an empty marker (review blocker).
    ok('a FAILED follow-through sets reopened, not confirmed',
      heard[0].extra.reflection.reopened === true && heard[0].extra.reflection.confirmed === false,
      JSON.stringify(heard[0].extra.reflection));

    heard.length = 0;
    reflexion.init({
      probe: async () => ({ stance: 'evidence', text: 'it is up', cli: [ev('show ip int brief', 'up up')] }),
      say: (line, extra) => heard.push({ line, extra }), audit: () => {},
      reopen: async () => { throw new Error('a held prediction must never reopen'); },
    });
    reflexion.setPlanner({ available: () => true, judge: async () => ({ held: true, line: 'Prediction held.' }) });
    const held = reflexion.registerPrediction({ key: 'env3', hypothesis: 'h', then: 't',
      check: { agentId: 'config-keeper', question: 'q', device: 'sw2' } });
    await reflexion.runFollowThrough(held.id, {});
    ok('a HELD follow-through sets confirmed, not reopened',
      heard[0].extra.reflection.confirmed === true && heard[0].extra.reflection.reopened === false,
      JSON.stringify(heard[0].extra.reflection));

    heard.length = 0;
    reflexion.init({ probe: async () => ({ stance: 'unreachable', text: '', cli: [] }),
      say: (line, extra) => heard.push({ line, extra }), audit: () => {} });
    const inc = reflexion.registerPrediction({ key: 'env4', hypothesis: 'h', then: 't',
      check: { agentId: 'config-keeper', question: 'q', device: 'sw2' } });
    await reflexion.runFollowThrough(inc.id, {});
    ok('an INCONCLUSIVE follow-through lights NEITHER marker',
      heard[0].extra.reflection.confirmed === false && heard[0].extra.reflection.reopened === false);

    // A round reflection is not a confirm or a reopen — one shape, no bleed.
    ok('a round reflection never claims confirmed/reopened',
      marked[0].env.reflection.confirmed === false && marked[0].env.reflection.reopened === false);
  }

  section('PART 4 — lookFirst is ROUTED to the probe planner, as a bias not a rule:');
  {
    lessons.setPlanner(null);
    reflexion.setPlanner(null);
    scriptedInvestigation(async () => ({ agentId: 'config-keeper', name: 'config-keeper',
      stance: 'evidence', text: 't', cli: [] }));
    const seen = [];
    investigation.setPlanner({
      available: () => true,
      understand: async () => ({ specific: true, understood: 'u', hypotheses: [] }),
      probe: async (a) => { seen.push(a); return { stuck: 'nothing would narrow this' }; },
      assess: async ({ hypotheses }) => ({ hypotheses, confidence: 0 }),
    });
    const withLesson = investigation.create({ problem: 'p', understood: 'u', who: 'tester',
      lesson: { id: 'INC-20260101-001', lookFirst: 'show ip int brief on the branch uplink', why: 'same symptom' } });
    await investigation.run(withLesson.id);
    ok('the lesson reaches the probe planner — it is ROUTED, not merely announced',
      seen[0] && seen[0].lesson && seen[0].lesson.lookFirst === 'show ip int brief on the branch uplink',
      JSON.stringify(seen[0] && seen[0].lesson));
    ok('and it carries the id so the planner knows it is ANOTHER incident',
      seen[0].lesson.id === 'INC-20260101-001');
    ok('a BIAS, not a rule: the planner still decided, and its "stuck" stands',
      investigation.get(withLesson.id).status === 'stuck');
    ok('the engine never turns a lesson into a probe of its own',
      seen.length === 1 && investigation.get(withLesson.id).rounds.length === 0);
    ok('the lesson is on the record for the desk', investigation.get(withLesson.id).lesson.id === 'INC-20260101-001');

    // No lesson → the pre-CW-11 call shape, unchanged.
    seen.length = 0;
    const plain = investigation.create({ problem: 'p', understood: 'u', who: 'tester' });
    await investigation.run(plain.id);
    ok('with no lesson the planner is told so explicitly (null, never a guess)', seen[0].lesson === null);
    ok('and the record carries no lesson', investigation.get(plain.id).lesson === null);
  }

  section('PART 4 — a lesson id can never write outside squad/lessons:');
  {
    ok('a traversal id is refused', lessons.safeId('../../server') === null);
    ok('an absolute path is refused', lessons.safeId('C:/Windows/system32') === null);
    ok('an empty id is refused', lessons.safeId('   ') === null);
    ok('a real incident id is accepted', lessons.safeId('INC-20260820-001') === 'INC-20260820-001');
    ok('write() refuses a bad id outright', lessons.write({ incidentId: '../evil', cause: 'x' }) === null);
  }

  // ═══ THE LESSONS ROUTES ARE GATED LIKE ANY OTHER OPERATOR ACTION ═══════════
  // DELETE /api/lessons/:id sits OUTSIDE /api/copilot/, so it used to slip the
  // 428 name gate for any caller without a desk Referer (curl, a script) and be
  // audited as who:"unknown" (CW-11 review #2). The fix names the surface, so the
  // gate covers it without moving the path the desk pinned.
  section('GATE — deleting a lesson needs an operator name, like any other action:');
  {
    const { spawn } = require('child_process');
    const http = require('http');
    const PORT = 3901;
    const ORIGIN = `http://127.0.0.1:${PORT}`;
    const srv = spawn(process.execPath, [require('path').join(__dirname, '..', 'server.js')], {
      env: { ...process.env, PORT: String(PORT), ANTHROPIC_API_KEY: '' },
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    const call = (method, path, headers = {}) => new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port: PORT, path, method,
        headers: { Origin: ORIGIN, ...headers } }, (res) => {
        let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, body: d }));
      });
      req.on('error', () => resolve({ status: 0, body: '' }));
      req.end();
    });
    // Wait for it to answer rather than sleeping blind.
    let up = false;
    for (let i = 0; i < 60 && !up; i++) {
      const r = await call('GET', '/api/lessons');
      up = r.status === 200;
      if (!up) await new Promise((r2) => setTimeout(r2, 300));
    }
    ok('the server came up for the gate check', up);
    if (up) {
      const unnamed = await call('DELETE', '/api/lessons/INC-GATE-TEST');
      ok('an UNNAMED delete is refused 428 — never audited as who:"unknown"',
        unnamed.status === 428, `${unnamed.status} ${unnamed.body.slice(0, 80)}`);
      ok('and it says plainly what is missing', /name/i.test(unnamed.body), unnamed.body.slice(0, 80));
      const named = await call('DELETE', '/api/lessons/INC-GATE-TEST', { 'X-Operator-Name': 'Vikas' });
      ok('a NAMED delete passes the gate and gets the honest 404',
        named.status === 404, `${named.status} ${named.body.slice(0, 80)}`);
      const traversal = await call('DELETE', '/api/lessons/..%2f..%2fserver', { 'X-Operator-Name': 'Vikas' });
      ok('a traversal id is still refused at the route', traversal.status === 400);
      const read = await call('GET', '/api/lessons');
      ok('READS stay open — the gate is on the action, not the panel', read.status === 200);
      const preds = await call('GET', '/api/copilot/predictions');
      ok('the predictions list is served', preds.status === 200 && /"predictions"/.test(preds.body));
    }
    srv.kill();
    await new Promise((r) => setTimeout(r, 200));
  }

  console.log(`\nCW-11 reflexion: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
