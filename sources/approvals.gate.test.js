// Class 5 — the permission gate must FAIL CLOSED.
//
// The defect this guards against (QA adversarial, confirmed): setMode used
// `m === 'ask' ? 'ask' : 'auto'`, so ANY other value — 'deny', 'lockdown',
// garbage, '' — silently became 'auto', the LEAST restrictive state, with a
// 200. An operator trying to LOCK DOWN got full auto-approve instead.
//
// The laws these cases pin (HANDOFF.md): deny = ZERO wire calls; a bad mode
// value must NEVER land on 'auto'; the three modes auto/ask/deny are the single
// source of truth; 'auto'/'ask' and per-request deny behave exactly as before.
//
// Deterministic — no LLM, no network. executeFn is a spy: if it ever runs, a
// "wire call" was made, and any test that expected a denial fails.

const approvals = require('./approvals');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`); }
}

// A gate meta + a spy executor. `ran` flips true only if the wire is touched.
function makeSpy() {
  const spy = { ran: false };
  const fn = async () => { spy.ran = true; return { detail: 'spy read ran' }; };
  return { spy, fn };
}
const READ_META = () => ({ agentId: 'test', agentName: 'Test', command: 'show version', target: 'sw1' });

(async () => {
  // ── The three modes are the single source of truth ─────────────────────────
  console.log('\nSINGLE SOURCE OF TRUTH — the advertised set is exactly auto/ask/deny:');
  ok('MODES = [auto, ask, deny]', JSON.stringify(approvals.modes()) === JSON.stringify(['auto', 'ask', 'deny']), JSON.stringify(approvals.modes()));
  ok('MODES export is frozen', Object.isFrozen(approvals.MODES));

  // ── setMode FAILS CLOSED: garbage never becomes auto ───────────────────────
  console.log('\nFAIL CLOSED — an unknown/garbage/empty mode is REJECTED, never silently "auto":');
  // Start from a NON-auto baseline so a silent coercion to auto would be visible.
  approvals.setMode('ask');
  for (const bad of ['deny-all', 'lockdown', 'garbage', '', '   ', 'AUTOO', null, undefined, 42, {}, 'off', 'open']) {
    const r = approvals.setMode(bad);
    const rejected = r && r.ok === false && r.error === 'bad_mode';
    ok(`reject ${JSON.stringify(bad)}`, rejected, `got ${JSON.stringify(r)}`);
    ok(`  ${JSON.stringify(bad)} did NOT flip to auto`, approvals.getMode() !== 'auto', `effective mode became ${approvals.getMode()}`);
    ok(`  ${JSON.stringify(bad)} left a valid mode in force`, approvals.MODES.includes(approvals.getMode()), approvals.getMode());
    ok(`  ${JSON.stringify(bad)} rejection lists the valid set`, !!(r && Array.isArray(r.valid) && r.valid.join(',') === 'auto,ask,deny'));
  }

  // ── setMode accepts the real three (and normalises case/whitespace) ────────
  console.log('\nACCEPTS the three real modes (case/space tolerant):');
  for (const [inp, want] of [['auto', 'auto'], ['ask', 'ask'], ['deny', 'deny'], [' Deny ', 'deny'], ['AUTO', 'auto']]) {
    const r = approvals.setMode(inp);
    ok(`setMode(${JSON.stringify(inp)}) → ${want}`, r && r.ok === true && r.mode === want && approvals.getMode() === want, JSON.stringify(r));
  }

  // ── DENY mode: a gated read is DENIED, ZERO wire calls, honest message ──────
  console.log('\nDENY / lockdown — a gated read runs NOTHING:');
  approvals.setMode('deny');
  {
    const { spy, fn } = makeSpy();
    const res = await approvals.gate(READ_META(), fn);
    ok('denied', res.denied === true && res.approved === false);
    ok('flagged as lockdown', res.lockdown === true);
    ok('ZERO wire calls (executeFn never ran)', spy.ran === false);
    ok('honest lockdown message', /lockdown|deny mode/i.test(res.record.outcome), res.record.outcome);
    ok('record state = denied', res.record.state === 'denied');
    ok('decidedBy = lockdown', res.record.decidedBy === 'lockdown');
  }

  // ── DENY mode: a CHANGE-style gate (no cli, the write path) is also denied ──
  console.log('\nDENY — a change-style gate (the write wrap) is also locked out:');
  {
    const { spy, fn } = makeSpy();
    const res = await approvals.gate({ agentId: 'change-runner', agentName: 'Change engine', command: 'CHANGE on sw1: set hostname' }, fn);
    ok('change denied', res.denied === true && spy.ran === false, JSON.stringify(res.record && res.record.outcome));
  }

  // ── DENY mode: nothing pends, nothing can be approved past the lock ─────────
  console.log('\nDENY — nothing is left pending for an operator to approve past:');
  ok('no pending approvals in deny', approvals.state().pending === 0, `pending=${approvals.state().pending}`);

  // ── AUTO mode unchanged: safe reads auto-approve and RUN, still logged ──────
  console.log('\nAUTO — safe reads auto-approve and run (unchanged behaviour):');
  approvals.setMode('auto');
  {
    const { spy, fn } = makeSpy();
    const res = await approvals.gate(READ_META(), fn);
    ok('approved', res.approved === true && res.denied === false);
    ok('wire call ran', spy.ran === true);
    ok('record state = auto', res.record.state === 'auto', res.record.state);
  }

  // ── ASK mode unchanged: pauses; operator DENY runs nothing; APPROVE runs ────
  console.log('\nASK — pauses for a decision; operator deny runs nothing, approve runs:');
  approvals.setMode('ask');
  {
    // Operator DENIES.
    const { spy, fn } = makeSpy();
    const p = approvals.gate({ ...READ_META(), command: 'ask-deny-case' }, fn);
    const pendingRec = approvals.list({ limit: 50 }).reverse().find((r) => r.command === 'ask-deny-case' && r.state === 'pending');
    ok('an approval is pending', !!pendingRec);
    approvals.decide(pendingRec.id, 'deny');
    const res = await p;
    ok('operator deny → denied', res.denied === true && spy.ran === false);
    ok('honest "ran nothing"', /ran nothing/i.test(res.record.outcome), res.record.outcome);
  }
  {
    // Operator APPROVES once.
    const { spy, fn } = makeSpy();
    const p = approvals.gate({ ...READ_META(), command: 'ask-approve-case' }, fn);
    const pendingRec = approvals.list({ limit: 50 }).reverse().find((r) => r.command === 'ask-approve-case' && r.state === 'pending');
    ok('an approval is pending', !!pendingRec);
    approvals.decide(pendingRec.id, 'approve-once');
    const res = await p;
    ok('operator approve → ran', res.approved === true && spy.ran === true);
  }

  // ── Per-request deny (a raw write CLI) stays ZERO wire in EVERY mode ────────
  console.log('\nPER-REQUEST DENY — a write CLI is blocked (zero wire) in every mode:');
  for (const mo of ['auto', 'ask', 'deny']) {
    approvals.setMode(mo);
    const { spy, fn } = makeSpy();
    const res = await approvals.gate({ ...READ_META(), command: 'reload', cli: 'reload' }, fn);
    ok(`[${mo}] write CLI denied, zero wire`, res.denied === true && spy.ran === false, res.record && res.record.outcome);
  }

  // Reset to the default for any downstream consumer.
  approvals.setMode('auto');

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
