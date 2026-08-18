// QA CLASS 6 — no silent dropped turns (the always-surfaces guarantee).
//
// A delegated read is meant to end in one of three honest outcomes: real output,
// an honest error, or an honest denial. The blocker QA found was a FOURTH: silence
// — a read that hung on a slow/stuck source left the delegation loop awaiting
// forever, so the operator saw the plan and the "@Config-Keeper — …" line and then
// NOTHING. jarvis.gatherGuarded closes that: every delegation resolves to a
// rendered finding, and a hang / rejection / null / empty result becomes an
// explicit "no response" finding — never silence, and never a fabricated reading.
//
// Offline + deterministic: no network, no device, no LLM. We drive gatherGuarded
// with a stubbed ctx.gather for each failure shape and assert the guarantee.
process.env.JARVIS_GATHER_TIMEOUT_MS = '1000'; // keep the hang case fast (floor is 1s)
const jarvis = require('./jarvis');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`); }
}

// A finding is "surfaced honestly" when it is a well-formed object carrying
// non-empty, non-fabricated text and a non-evidence stance for a failed read.
function surfaced(f) {
  return f && typeof f === 'object' && typeof f.text === 'string' && f.text.trim().length > 0;
}

let gatherImpl = null;
jarvis.init({
  say: () => {},
  status: () => {},
  log: () => {},
  nameOf: (id) => (id === 'config-keeper' ? 'Config-Keeper' : id),
  gather: (...args) => gatherImpl(...args),
  roster: () => [],
});

const { gatherGuarded } = jarvis._test;
const d = { agentId: 'config-keeper', question: 'show ip int brief on sw2', device: 'sw2', incidentId: null };

(async () => {
  console.log('\nCLASS 6 — every tasked read resolves to output / error / denial, never silence:');

  // 1) The read HANGS forever (the reported blocker: slow/stuck sandbox).
  gatherImpl = () => new Promise(() => {}); // never resolves
  {
    const t0 = Date.now();
    const f = await gatherGuarded(d);
    const waited = Date.now() - t0;
    ok('hung read → an honest finding is surfaced (not silence)', surfaced(f), JSON.stringify(f));
    ok('hung read → says "no response"', /no response/i.test(f.text || ''), f && f.text);
    ok('hung read → stance is not "evidence"', f && f.stance && f.stance !== 'evidence', f && f.stance);
    ok('hung read → resolves within the bounded timeout (~1s)', waited >= 900 && waited < 4000, `${waited}ms`);
  }

  // 2) The read REJECTS (throws).
  gatherImpl = () => Promise.reject(new Error('Command Runner exploded'));
  {
    const f = await gatherGuarded(d);
    ok('rejected read → an honest finding is surfaced', surfaced(f), JSON.stringify(f));
    ok('rejected read → relays the real error, invents nothing', /could not complete/i.test(f.text) && /exploded/i.test(f.text), f && f.text);
  }

  // 3) The read returns NULL.
  gatherImpl = () => Promise.resolve(null);
  {
    const f = await gatherGuarded(d);
    ok('null read → an honest finding is surfaced', surfaced(f), JSON.stringify(f));
    ok('null read → says nothing came back', /no response|nothing/i.test(f.text), f && f.text);
  }

  // 4) The read returns a finding with EMPTY text.
  gatherImpl = () => Promise.resolve({ agentId: 'config-keeper', name: 'Config-Keeper', stance: 'evidence', text: '   ' });
  {
    const f = await gatherGuarded(d);
    ok('empty-text read → an honest finding is surfaced', surfaced(f), JSON.stringify(f));
    ok('empty-text read → stance downgraded off "evidence"', f.stance !== 'evidence', f && f.stance);
  }

  // 5) A REAL finding passes straight through unchanged (no false "no response").
  const real = { agentId: 'config-keeper', name: 'Config-Keeper', connected: true, stance: 'evidence',
    text: 'Ran "show ip interface brief" on sw2 — GigabitEthernet0/0 up/up ...' };
  gatherImpl = () => Promise.resolve(real);
  {
    const f = await gatherGuarded(d);
    ok('real read → passed through untouched', f === real, JSON.stringify(f));
    ok('real read → NOT relabelled "no response"', !/no response/i.test(f.text), f && f.text);
  }

  console.log(`\nCLASS 6: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
