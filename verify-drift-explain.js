// CW-2 verification helper — the "drift explained by a change" path.
//
// WHY THIS SCRIPT EXISTS, said plainly: the Catalyst Center sandbox account is
// read-only (403 on every configuration-write API), so this system CANNOT make a
// real change to sw2 and then watch that change show up as drift. Rather than
// fake a change, the two halves are proved separately and honestly:
//
//   1. THE DRIFT IS REAL. The stored BASELINE is perturbed here (one real line
//      dropped from it) — the LIVE side of the comparison is still a genuine
//      running-config read from sw2 through Command Runner. So the drift the API
//      reports is a real difference between a real read and a stored reference.
//   2. THE MATCH IS REAL. A change record is seeded whose diff contains that same
//      line. Its `reason` says out loud, in the record itself, that it was NOT
//      applied to the device and exists to exercise the matcher. Nothing in the
//      store claims a change happened that did not.
require('./sources/env');
const configStore = require('./sources/config-store');
const changeStore = require('./sources/change-store');

const device = process.argv[2] || 'sw2';
const baseline = configStore.latest(device);
if (!baseline) { console.error(`No baseline stored for ${device} — re-baseline it first.`); process.exit(1); }

const lines = baseline.config.split('\n');
// Pick a real, harmless, uniquely-identifiable line to drop from the BASELINE.
const idx = lines.findIndex((l) => /^\s*description\s+\S/i.test(l))
  !== -1 ? lines.findIndex((l) => /^\s*description\s+\S/i.test(l))
         : lines.findIndex((l) => /^\s*ip\s+http/i.test(l));
if (idx < 0) { console.error('Could not find a line to perturb.'); process.exit(1); }
const victim = lines[idx];

const perturbed = lines.slice(0, idx).concat(lines.slice(idx + 1)).join('\n');
const stored = configStore.snapshot(device, perturbed);
console.log(`Baseline perturbed: dropped line ${idx + 1} → ${JSON.stringify(victim)}`);
console.log(`New (perturbed) baseline ts: ${stored.ts}`);

const rec = changeStore.create({
  device,
  deviceLabel: device,
  commands: [victim.trim()],
  who: 'Vikas',
  reason: 'CW-2 VERIFICATION FIXTURE — this change was NOT applied to any device. '
    + 'It exists only to prove that a drift line is matched to the change record that explains it. '
    + 'The sandbox account is read-only, so no real change could be made to compare against.',
});
changeStore.patch(rec.id, {
  diff: { changed: true, added: 1, removed: 0, unified: `+${victim}`, lines: [{ change: 'added', line: victim }] },
});
changeStore.status(rec.id, 'failed', { by: 'Vikas', note: 'verification fixture — never applied to a device' });
console.log(`Seeded change record ${rec.id} whose diff contains that line as "added".`);
console.log(`\nNow: GET /api/copilot/drift/${device} should report "drifted" with that line explained by ${rec.id}.`);
