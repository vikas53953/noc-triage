// tickets.test.js — CW-3 built-in ticket queue. DETERMINISTIC: no key, no
// network, no HTTP. Drives sources/tickets.js + ticket-store.js directly against
// a throwaway workspace so it never touches the real squad data.
//
// Covers the contract's verify list at the logic layer: create → id shape +
// listed; assign → assignee + status + audit; validated transitions (cannot
// close without a resolution note); work note appends with operator; operator
// name required; XSS payload in title/description stored ESCAPED; a secret in
// ticket text stored SCRUBBED.

const fs = require('fs');
const os = require('os');
const path = require('path');

// Point the workspace at a throwaway dir BEFORE anything requires workspace.js.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cw3-tickets-'));
process.env.SQUAD_ROOT = TMP;

const store = require('./ticket-store');
const tickets = require('./tickets');
const session = require('./session-log');

let passed = 0, failed = 0;
function ok(name, cond) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}`); }
}

console.log('\nCW-3 — built-in ticket queue (logic + store):\n');

// ── create ───────────────────────────────────────────────────────────────────
const created = tickets.create({ severity: 'p2', title: 'Branch-3 slowness', description: 'users report slow apps', who: 'Vikas' });
ok('create returns ok', created.ok === true);
ok('id is TKT-YYYYMMDD-NNN', /^TKT-\d{8}-\d{3}$/.test(created.ticket.id));
ok('severity normalised to P2', created.ticket.severity === 'P2');
ok('status starts open', created.ticket.status === 'open');
ok('createdBy is the operator', created.ticket.createdBy === 'Vikas');
ok('snow mirror slot present + empty', created.ticket.snow && created.ticket.snow.id === null);

// second create increments the daily sequence
const second = tickets.create({ severity: 'P3', title: 'link flap', who: 'Vikas' });
ok('second id increments NNN', Number(second.ticket.id.slice(-3)) === Number(created.ticket.id.slice(-3)) + 1);

// GET lists it
const listed = tickets.list({});
ok('GET list contains the created ticket', listed.some((t) => t.id === created.ticket.id));
ok('list is most-recent-first', listed[0].id === second.ticket.id);

// ── operator name required ───────────────────────────────────────────────────
const noName = tickets.create({ severity: 'P2', title: 'x', who: null });
ok('create without operator name → 428', noName.ok === false && noName.status === 428);
const noNameAssign = tickets.assign(created.ticket.id, { assignee: 'Ann', who: null });
ok('assign without operator name → 428', noNameAssign.ok === false && noNameAssign.status === 428);

// ── create validation ────────────────────────────────────────────────────────
ok('bad severity refused', tickets.create({ severity: 'P9', title: 'x', who: 'Vikas' }).status === 400);
ok('missing title refused', tickets.create({ severity: 'P2', title: '  ', who: 'Vikas' }).status === 400);

// ── assign ───────────────────────────────────────────────────────────────────
const assigned = tickets.assign(created.ticket.id, { assignee: 'Priya', who: 'Vikas' });
ok('assign returns ok', assigned.ok === true);
ok('assignee set', assigned.ticket.assignee === 'Priya');
ok('open → assigned on first assign', assigned.ticket.status === 'assigned');
ok('assign wrote a history entry', assigned.ticket.history.some((h) => h.note === 'assigned to Priya'));
ok('assign audited', session.auditAll({ limit: 50 }).some((a) => /assigned to Priya/.test(a.what)));
ok('assign unknown ticket → 404', tickets.assign('TKT-00000000-999', { assignee: 'X', who: 'Vikas' }).status === 404);

// ── status transitions (validated) ──────────────────────────────────────────
ok('assigned → in-progress allowed', tickets.setStatus(created.ticket.id, { status: 'in-progress', who: 'Vikas' }).ok === true);
ok('cannot jump in-progress → open', tickets.setStatus(created.ticket.id, { status: 'open', who: 'Vikas' }).status === 409);
ok('close WITHOUT resolution note refused', tickets.setStatus(created.ticket.id, { status: 'closed', who: 'Vikas' }).status === 400);
const closed = tickets.setStatus(created.ticket.id, { status: 'closed', note: 'rebooted the CPE, latency normal', who: 'Vikas' });
ok('close WITH resolution note allowed', closed.ok === true && closed.ticket.status === 'closed');
ok('resolution note captured as a work note', closed.ticket.worknotes.some((w) => /rebooted the CPE/.test(w.text)));
ok('close transition audited', session.auditAll({ limit: 50 }).some((a) => /in-progress → closed/.test(a.what)));
ok('unknown status value refused', tickets.setStatus(created.ticket.id, { status: 'banana', who: 'Vikas' }).status === 400);

// ── work note ────────────────────────────────────────────────────────────────
const noted = tickets.addNote(second.ticket.id, { text: 'checked the uplink counters', who: 'Sam' });
ok('note appends', noted.ok === true && noted.ticket.worknotes.length === 1);
ok('note stamped with operator', noted.ticket.worknotes[0].who === 'Sam');
ok('empty note refused', tickets.addNote(second.ticket.id, { text: '   ', who: 'Sam' }).status === 400);

// ── XSS escaped on the way in ────────────────────────────────────────────────
const xss = tickets.create({
  severity: 'P1',
  title: '<img src=x onerror=alert(1)>',
  description: 'link <script>steal()</script> down',
  who: 'Vikas',
});
ok('title XSS escaped in store', !/<img/.test(xss.ticket.title) && /&lt;img/.test(xss.ticket.title));
ok('description XSS escaped in store', !/<script>/.test(xss.ticket.description) && /&lt;script&gt;/.test(xss.ticket.description));
// prove it is persisted escaped, not just returned escaped
const reread = tickets.get(xss.ticket.id);
ok('escaped form persisted to disk', !/<script>/.test(JSON.stringify(reread)));

// ── secrets scrubbed on the way in ───────────────────────────────────────────
const secret = tickets.create({
  severity: 'P2',
  title: 'vpn down',
  description: 'operator used password=SuperSecret123 on the CPE',
  who: 'Vikas',
});
ok('secret value scrubbed from stored text', !/SuperSecret123/.test(JSON.stringify(secret.ticket)) && /«redacted»/.test(secret.ticket.description));

// cleanup
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* best effort */ }

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
