// servicenow.test.js — CW-6 two-way ServiceNow sync. DETERMINISTIC: no Claude
// key needed. The connected path talks to a LOCAL http catcher (a stub ServiceNow
// Table API) started in this process, so it proves a REAL Basic-auth create /
// update / read fires and records exactly what left — then asserts the creds
// (SNOW_USER/SNOW_PASS) never appear in status/lastSync/the ticket/the audit log.
//
// Covers the contract's verify list at the logic layer:
//   • no creds → status connected:false; push/pull honest not-connected, NO INC
//     created (ticket.snow.id stays null); capabilities servicenow unavailable
//     with the "add instance + creds" reason, engineBuilt:true always.
//   • stub SNOW → push CREATES + records snow:{id,number,syncedAt}; a second push
//     UPDATES (PATCH, same sys_id); pull MIRRORS state without touching internal
//     truth; a both-changed conflict is surfaced (conflict:true) not clobbered.
//   • capabilities flips available:true when all three creds set.
//   • the creds never appear in any response, lastSync, the ticket, or the audit.
//   • Basic auth WAS actually sent to ServiceNow (the header the catcher saw).

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

// Throwaway workspace BEFORE anything requires workspace.js (audit + ticket store
// land here). Clear any inherited SNOW creds so the unconnected path is honest.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cw6-snow-'));
process.env.SQUAD_ROOT = TMP;
delete process.env.SNOW_INSTANCE;
delete process.env.SNOW_USER;
delete process.env.SNOW_PASS;

const session = require('./session-log');
const snow = require('./servicenow-client');
const tickets = require('./tickets');
const capabilities = require('./capabilities');

const SECRET_USER = 'svc.noc.integration';
const SECRET_PASS = 'S3cr3t-SNOW-Pw!xyz789';

let passed = 0, failed = 0;
function ok(name, cond) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}`); }
}

// ── A local stub ServiceNow Table API ───────────────────────────────────────
// Holds ONE incident. Records the Authorization header of every request so we can
// prove Basic auth fired, and lets the test mutate the incident to simulate a
// change made directly in ServiceNow (for the conflict case).
const seen = []; // { method, url, auth, body }
let incident = null;
let counter = 0;
function bumpUpdated() { return new Date(Date.now() + (++counter) * 1000).toISOString().replace('T', ' ').replace(/\..*/, ''); }

const catcher = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    seen.push({ method: req.method, url: req.url, auth: req.headers['authorization'] || null, body });
    const reply = (obj, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    let parsed = {};
    try { parsed = body ? JSON.parse(body) : {}; } catch (e) { parsed = {}; }

    if (req.method === 'POST') {
      incident = {
        sys_id: 'a1b2c3d4e5f6', number: 'INC0012345',
        state: parsed.state || '1', sys_updated_on: bumpUpdated(),
        short_description: parsed.short_description || '', work_notes: parsed.work_notes || '',
      };
      return reply({ result: incident }, 201);
    }
    if (req.method === 'PATCH') {
      incident = { ...incident, ...parsed, sys_updated_on: bumpUpdated() };
      return reply({ result: incident });
    }
    if (req.method === 'GET') {
      // Return the display-value shape ServiceNow uses with sysparm_display_value=all.
      return reply({ result: {
        sys_id: { value: incident.sys_id, display_value: incident.sys_id },
        number: { value: incident.number, display_value: incident.number },
        state: { value: incident.state, display_value: snow.snowStateLabel(incident.state) },
        sys_updated_on: { value: incident.sys_updated_on, display_value: incident.sys_updated_on },
        work_notes: { value: '', display_value: incident.work_notes || '' },
        comments: { value: '', display_value: '' },
        short_description: { value: incident.short_description, display_value: incident.short_description },
      } });
    }
    reply({ error: 'method' }, 405);
  });
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function run() {
  return new Promise(async (resolve) => {
    console.log('\nCW-6 — two-way ServiceNow sync (internal queue is truth):\n');

    // A real internal ticket — the SOURCE OF TRUTH we will mirror.
    const created = tickets.create({ severity: 'P2', title: 'branch-3 slowness', description: 'users report slow app', who: 'Vikas' });
    ok('setup: internal ticket created', created.ok === true && /^TKT-/.test(created.ticket.id));
    const id = created.ticket.id;
    ok('setup: fresh ticket has empty snow slot (no INC)', created.ticket.snow.id === null);

    // ── UNCONNECTED: honest no-op ───────────────────────────────────────────
    const s0 = snow.status();
    ok('unconnected: status connected:false', s0.connected === false);
    ok('unconnected: lastSync null before any sync', s0.lastSync === null);

    const push0 = await tickets.pushToSnow(id, { who: 'Vikas' });
    ok('unconnected: push returns connected:false', push0.ok === false && push0.connected === false);
    ok('unconnected: catcher received NOTHING', seen.length === 0);
    ok('unconnected: NO fake INC written to the ticket', tickets.get(id).snow.id === null);

    const pull0 = await tickets.pullFromSnow(id, { who: 'Vikas' });
    ok('unconnected: pull returns connected:false', pull0.ok === false && pull0.connected === false);

    const capUnset = capabilities.list().find((a) => a.key === 'servicenow');
    ok('cap unset: available:false', capUnset.available === false);
    ok('cap unset: reason mentions add instance + creds', /add instance \+ creds/i.test(capUnset.reason || ''));
    ok('cap unset: engineBuilt:true always', capUnset.engineBuilt === true);

    // ── CONNECTED: real Basic-auth sync to the local catcher ────────────────
    await new Promise((r) => catcher.listen(0, '127.0.0.1', r));
    const port = catcher.address().port;
    process.env.SNOW_INSTANCE = `http://127.0.0.1:${port}`;
    process.env.SNOW_USER = SECRET_USER;
    process.env.SNOW_PASS = SECRET_PASS;

    const s1 = snow.status();
    ok('connected: status connected:true', s1.connected === true);
    ok('connected: status does NOT leak host or creds',
      JSON.stringify(s1).indexOf(SECRET_PASS) === -1 && JSON.stringify(s1).indexOf('127.0.0.1') === -1);

    const capSet = capabilities.list().find((a) => a.key === 'servicenow');
    ok('cap set: available:true when all three creds present', capSet.available === true);
    ok('cap set: no reason when available', capSet.reason === undefined);

    // PUSH — CREATE
    const push1 = await tickets.pushToSnow(id, { who: 'Vikas' });
    ok('push create: ok + returns real INC number', push1.ok === true && push1.number === 'INC0012345');
    ok('push create: returns a link url', typeof push1.url === 'string' && push1.url.indexOf('a1b2c3d4e5f6') !== -1);
    ok('push create: catcher saw a POST', seen.some((r) => r.method === 'POST'));
    ok('push create: Basic auth WAS sent', seen.some((r) => r.method === 'POST' && /^Basic /.test(r.auth || '')));

    const t1 = tickets.get(id);
    ok('push create: snow.id recorded (real sys_id)', t1.snow.id === 'a1b2c3d4e5f6');
    ok('push create: snow.number recorded', t1.snow.number === 'INC0012345');
    ok('push create: snow.syncedAt recorded', typeof t1.snow.syncedAt === 'string' && t1.snow.syncedAt.length > 0);
    ok('push create: status shows lastSync', snow.status().lastSync && snow.status().lastSync.number === 'INC0012345');

    // PUSH again — UPDATE (PATCH, same sys_id, no new INC)
    const push2 = await tickets.pushToSnow(id, { who: 'Vikas' });
    ok('push update: ok, same INC number (no new incident)', push2.ok === true && push2.number === 'INC0012345');
    ok('push update: used PATCH', seen.some((r) => r.method === 'PATCH'));
    ok('push update: snow.id unchanged', tickets.get(id).snow.id === 'a1b2c3d4e5f6');

    // PULL — mirror without touching internal truth
    const pull1 = await tickets.pullFromSnow(id, { who: 'Vikas' });
    ok('pull: ok, no conflict on a clean mirror', pull1.ok === true && pull1.conflict === false);
    ok('pull: mirror carries the SNOW state label (open → New)', pull1.mirror && pull1.mirror.stateLabel === 'New');
    const afterPull = tickets.get(id);
    ok('pull: internal truth untouched (title/status intact)',
      afterPull.title === 'branch-3 slowness' && afterPull.status === 'open');

    // ── CONFLICT: both sides change since the last sync ─────────────────────
    // 1) ServiceNow side changes directly (someone edits the INC in SNOW).
    incident.state = '6'; // Resolved, done outside noc-triage
    incident.sys_updated_on = bumpUpdated();
    // 2) Internal side changes too (a work note after the last push baseline).
    await wait(5);
    tickets.addNote(id, { text: 'still investigating on our side', who: 'Vikas' });

    const pull2 = await tickets.pullFromSnow(id, { who: 'Vikas' });
    ok('conflict: pull surfaces conflict:true', pull2.ok === true && pull2.conflict === true);
    ok('conflict: SNOW mirror shows its changed state', pull2.mirror.stateLabel === 'Resolved');
    const afterConflict = tickets.get(id);
    ok('conflict: internal truth NOT clobbered (status still open)', afterConflict.status === 'open');
    ok('conflict: internal work note preserved', (afterConflict.worknotes || []).some((w) => /still investigating/.test(w.text)));

    // ── SECRET: creds never appear anywhere persisted or returned ───────────
    let auditText = '';
    try { auditText = fs.readFileSync(session.AUDIT_FILE, 'utf8'); } catch (e) {}
    ok('secret: audit log has ServiceNow sync entries', /ServiceNow (push|pull)/.test(auditText));
    ok('secret: SNOW_PASS NEVER in the audit log', auditText.indexOf(SECRET_PASS) === -1);
    ok('secret: SNOW_USER NEVER in the audit log', auditText.indexOf(SECRET_USER) === -1);
    ok('secret: creds NEVER in status/lastSync', JSON.stringify(snow.status()).indexOf(SECRET_PASS) === -1);
    ok('secret: creds NEVER in the persisted ticket JSON',
      JSON.stringify(tickets.get(id)).indexOf(SECRET_PASS) === -1 && JSON.stringify(tickets.get(id)).indexOf(SECRET_USER) === -1);
    // The one place creds are allowed: the Basic auth header on the wire.
    const authHeader = (seen.find((r) => r.method === 'POST') || {}).auth || '';
    const decoded = authHeader.startsWith('Basic ') ? Buffer.from(authHeader.slice(6), 'base64').toString() : '';
    ok('secret: creds rode ONLY in the Basic auth header (as designed)', decoded === `${SECRET_USER}:${SECRET_PASS}`);

    catcher.close(() => resolve());
  });
}

run().then(() => {
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}).catch((e) => { console.error(e); process.exit(1); });
