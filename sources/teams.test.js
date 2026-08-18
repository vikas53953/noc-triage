// teams.test.js — CW-4 Teams bridge. DETERMINISTIC: no Claude key needed. The
// connected path posts to a LOCAL http catcher (a stub Teams webhook) started in
// this process, so it proves a REAL POST fires and records exactly what left —
// then asserts the webhook URL never appears in status/lastPost/audit.
//
// Covers the contract's verify list at the logic layer:
//   • no webhook → status connected:false, post() sends NOTHING, {ok:false,connected:false}
//   • capabilities teams unavailable with the "add a webhook" reason, engineBuilt:true
//   • dummy webhook → real POST fires (catcher receives a MessageCard), status
//     shows lastPost, capabilities flips available:true
//   • onBridgeEvent auto-posts (the notifier seam) for a real event
//   • inbound endpoint injects a reply; fabrication is impossible (empty rejected)
//   • the webhook URL never appears in any response, lastPost, or the audit log

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

// Throwaway workspace BEFORE anything requires workspace.js (audit lands here).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cw4-teams-'));
process.env.SQUAD_ROOT = TMP;
delete process.env.TEAMS_WEBHOOK;

const session = require('./session-log');
const teams = require('./teams');
const capabilities = require('./capabilities');
const notifier = require('./notifier');

let passed = 0, failed = 0;
function ok(name, cond) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}`); }
}

// A local stub Teams Incoming Webhook — records every POST body it receives.
const received = [];
const catcher = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    received.push({ method: req.method, url: req.url, body });
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('1'); // Teams answers "1" on success
  });
});

function run() {
  return new Promise(async (resolve) => {
    console.log('\nCW-4 — Teams bridge (honest one-way post + inbound):\n');

    // ── UNCONNECTED: honest no-op ───────────────────────────────────────────
    const s0 = teams.status();
    ok('unconnected: status connected:false', s0.connected === false);
    ok('unconnected: lastPost null before any attempt', s0.lastPost === null);

    const p0 = await teams.postMessage({ title: 'x', text: 'y' }, { event: 'test', who: 'Vikas' });
    ok('unconnected: post returns ok:false connected:false', p0.ok === false && p0.connected === false);
    ok('unconnected: catcher received NOTHING', received.length === 0);
    const s0b = teams.status();
    ok('unconnected: lastPost records the honest not-connected attempt',
      s0b.lastPost && s0b.lastPost.ok === false && s0b.lastPost.error === 'not connected');

    // capabilities: teams unavailable with reason, engineBuilt:true
    const teamsCapUnset = capabilities.list().find((a) => a.key === 'teams');
    ok('cap unset: available:false', teamsCapUnset.available === false);
    ok('cap unset: reason mentions add a webhook', /add a webhook/i.test(teamsCapUnset.reason || ''));
    ok('cap unset: engineBuilt:true always', teamsCapUnset.engineBuilt === true);

    // ── CONNECTED: real POST to the local catcher ───────────────────────────
    await new Promise((r) => catcher.listen(0, '127.0.0.1', r));
    const port = catcher.address().port;
    const WEBHOOK = `http://127.0.0.1:${port}/webhookb2/SECRET-TOKEN-abcdef123456/IncomingWebhook/zzz`;
    process.env.TEAMS_WEBHOOK = WEBHOOK;

    const s1 = teams.status();
    ok('connected: status connected:true', s1.connected === true);
    ok('connected: status does NOT leak the URL', JSON.stringify(s1).indexOf('SECRET-TOKEN') === -1);

    const p1 = await teams.postMessage(
      { title: 'Bridge update', text: 'branch-3 slow', facts: [{ name: 'Severity', value: 'P2' }], incidentId: 'INC-20260818-001' },
      { event: 'test', who: 'Vikas', incidentId: 'INC-20260818-001' }
    );
    ok('connected: post returns ok:true connected:true', p1.ok === true && p1.connected === true);
    ok('connected: catcher received exactly one POST', received.length === 1);
    const card = received.length ? JSON.parse(received[0].body) : {};
    ok('connected: body is a MessageCard', card['@type'] === 'MessageCard');
    ok('connected: card carries the real title', card.title === 'Bridge update');
    ok('connected: card carries the incident fact', JSON.stringify(card).indexOf('INC-20260818-001') !== -1);

    const s2 = teams.status();
    ok('connected: lastPost ok:true', s2.lastPost && s2.lastPost.ok === true);
    ok('connected: lastPost carries incident, not URL',
      s2.lastPost.incidentId === 'INC-20260818-001' && JSON.stringify(s2.lastPost).indexOf('SECRET-TOKEN') === -1);

    // capabilities flips available:true (dynamic, no restart)
    const teamsCapSet = capabilities.list().find((a) => a.key === 'teams');
    ok('cap set: available:true when TEAMS_WEBHOOK present', teamsCapSet.available === true);
    ok('cap set: no reason when available', teamsCapSet.reason === undefined);
    ok('cap set: still engineBuilt:true', teamsCapSet.engineBuilt === true);

    // ── AUTO-POST via the notifier seam ─────────────────────────────────────
    const before = received.length;
    await notifier.notify('verdict', { incidentId: 'INC-20260818-002', severity: 'P1', title: 'core link down', summary: 'Verdict on INC-20260818-002' });
    // notifier.notify fires teams.onBridgeEvent synchronously; give the POST a tick.
    await new Promise((r) => setTimeout(r, 150));
    ok('auto-post: a bridge event posted to Teams via the notifier seam', received.length === before + 1);
    const auto = JSON.parse(received[received.length - 1].body);
    ok('auto-post: card is the verdict event', /Verdict/i.test(auto.title) || /Verdict/i.test(auto.text));

    // ── INBOUND injection (reply ingestion) ─────────────────────────────────
    const inj = teams.injectInbound({ from: 'Priya (Teams)', text: 'On it — checking the core.', incidentId: 'INC-20260818-002' });
    ok('inbound: injection returns ok', inj.ok === true && inj.reply && inj.reply.text.indexOf('checking the core') !== -1);
    const s3 = teams.status();
    ok('inbound: reply surfaces in status.inbound... (via inboundReplies)', teams.inboundReplies({}).length === 1);
    const empty = teams.injectInbound({ from: 'x', text: '   ' });
    ok('inbound: empty reply rejected (no fabrication)', empty.ok === false);

    // ── SECRET: the webhook URL never appears anywhere persisted ─────────────
    let auditText = '';
    try { auditText = fs.readFileSync(session.AUDIT_FILE, 'utf8'); } catch (e) {}
    ok('secret: audit log has teams post entries', /teams post/.test(auditText));
    ok('secret: webhook URL NEVER in the audit log', auditText.indexOf('SECRET-TOKEN') === -1 && auditText.indexOf('127.0.0.1:' + port) === -1);
    ok('secret: webhook URL NEVER in status/lastPost/inbound',
      JSON.stringify(teams.status()).indexOf('SECRET-TOKEN') === -1);

    catcher.close(() => resolve());
  });
}

run().then(() => {
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
});
