// polish.p1.test.js — Polish wave P1 (2026-09-05): Law-1 leftovers and small
// honesty/UX fixes found by the CW-12 review.
//
// Plain words, what this pins:
//   1. The canned "@Name On it — querying…" acknowledgement is GONE. It was a
//      phrase table pretending to be the agent, posted on a random timer, and it
//      could land after the real answer. The only response to an @mention is
//      the agent's real read (or its honest "not connected").
//   2. The four dead Jarvis simulators (standup / squad status / weekly report /
//      the canned help card) are gone — they had no call sites and were
//      deterministic answering code, the class Law 1 forbids.
//   3. The STATUS.json file-watcher broadcasts the same agent_status shape as
//      updateAgentStatus (agentId / status / note were undefined before).
//   4. The desk header badge no longer claims a wave number that drifts.
//   5. At phone width the header can never make the page wider than the screen,
//      and the closed capabilities drawer is hidden, not just off-canvas.

const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function ok(name, cond) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}`); }
}
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const server = read('server.js');
const desk = read('public/desk.html');
const pkg = JSON.parse(read('package.json'));

console.log('\nPolish P1 — Law-1 leftovers + small honesty fixes:\n');

// 1. the canned @mention acknowledgement
ok('generateMentionResponse is gone (definition and every call)', !/generateMentionResponse/.test(server));
ok('no canned "@Name On it / Roger that / Acknowledged" agent lines remain (code, not comments)', !/`@\$\{from\.name\} (On it|Roger that|Acknowledged)/.test(server) && !/'sentinel': \[\s*`@/.test(server));
ok('handleMention no longer posts on a random timer', !/responseDelay/.test(server) && !/Responded to the operator's @mention/.test(server));
ok('the "📨 @Name …" relay bubble attributed to Jarvis is gone too (review #3)', !/📨 @\$\{agents\[targetId\]\.name\}/.test(server));
ok('a bare "@NetOps" is a mention, and an empty one is answered with a question (law 2), never run', /\^@\(\[A-Za-z\]\[\\w-\]\*\)\\s\*\(\[\\s\\S\]\*\)\$/.test(server) && /What do you need from \$\{t\.name\}\?/.test(server) && /if \(!mentionMessage\) \{[\s\S]{0,600}answered\(targetId, 'done'\);\s*\n\s*return;/.test(server));
ok('…but still records the mention (badge + log) and hands the ask to the real agent',
  /broadcast\('mention', \{/.test(server) && /@mentioned \$\{toAgent\.name\}/.test(server) && /pickedUp\(targetId\);\s*\n\s*settle\(simulateAgentAction\(targetId, mentionMessage\), targetId\)/.test(server));

// 2. dead simulators
['simulateStandup', 'simulateSquadStatus', 'simulateWeeklyReport', 'showJarvisHelp'].forEach((fn) => {
  ok(`${fn} is gone`, !new RegExp(`function ${fn}\\(|${fn}\\(`).test(server));
});
ok('Jarvis still has exactly one front door: jarvis.ask via simulateJarvisAction', /return jarvis\.ask\(command,/.test(server) && (server.match(/function simulateJarvisAction/g) || []).length === 1);
ok('the honest help card for engineer agents (showAgentHelp) is untouched', /function showAgentHelp\(agentId\)/.test(server) && /Capabilities\*\*/.test(server));

// 3. watcher shape
ok('the STATUS.json watcher broadcasts the transparency-contract shape', /broadcast\('agent_status', \{ \.\.\.agents\[agentId\], agentId, status: agents\[agentId\]\.status, note: agents\[agentId\]\.lastAction \|\| null \}\)/.test(server));
ok('…and no bare agents[agentId] agent_status broadcast remains', !/broadcast\('agent_status', agents\[agentId\]\)/.test(server));
ok('the watcher skips our OWN writes (no echo) and broadcasts external writes only when they validated (review #4/#5)',
  /selfStatusWrites\.set\(agentId, Date\.now\(\)\)/.test(server) && /if \(selfAt && Date\.now\(\) - selfAt < SELF_WRITE_WINDOW_MS\) return;/.test(server) && /if \(loadAgentStatus\(agentId\)\) \{/.test(server));
ok('loadAgentStatus validates the status vocabulary and returns success', /AGENT_STATUS_VALUES = new Set\(\['active', 'idle', 'offline'\]\)/.test(server) && /if \(!AGENT_STATUS_VALUES\.has\(status\)\) \{[\s\S]{0,300}return false;/.test(server));

// 4. badge
ok('the desk badge says "Cockpit" with no wave number', /<span class="dirtag"[^>]*>Cockpit<\/span>/.test(desk) && !/Cockpit · CW-\d/.test(desk));

// 5. phone width
ok('the ≤760 header block exists (brand ellipsis, controls kept)', /\.brand\{flex:1 1 auto;overflow:hidden;min-width:120px\}/.test(desk));
ok('at ≤600px the label span hides (real markup, no pseudo-element gear) and the name tag collapses to the avatar',
  /@media \(max-width:600px\)\{\s*\n\s*\.capbtn \.caplbl\{display:none\}[\s\S]*?\.whotag span\{display:none\}/.test(desk) && !/capbtn::before/.test(desk)
  && /<span class="capico" aria-hidden="true">⚙<\/span><span class="caplbl">Capabilities<\/span>/.test(desk));
ok('the phone block sits AFTER the .capbtn base rule (cascade order — review #1)', desk.indexOf('@media (max-width:600px)') > desk.indexOf('.capbtn{\n') && desk.indexOf('.capbtn{\n') > 0);
ok('the control group never shrinks or clips; the brand gives way; the chip may shrink to its dot', /\.top-right\{flex:0 0 auto;flex-wrap:nowrap\}/.test(desk) && !/\.top-right\{flex:0 1 auto;overflow:hidden/.test(desk) && /\.top-right \.iconbtn,\.top-right \.capbtn,\.top-right \.whotag\{flex-shrink:0\}/.test(desk) && /\.top-right \.chip\{flex:0 1 auto;min-width:22px\}/.test(desk));
ok('the 320px budget is written down and enforced (brand min 96px, tight header padding)', /\.brand\{min-width:96px\}/.test(desk) && /\.top\{padding:0 \.6rem\}/.test(desk));
ok('the chip\'s words ride in its title so the dot-only chip still says what it means', /c\.title = 'Not connected — retrying'/.test(desk));
ok('the closed drawer is hidden, not just translated off-canvas', /\.cap-drawer:not\(\.on\)\{visibility:hidden/.test(desk) && /\.cap-drawer\.on\{visibility:visible\}/.test(desk));

ok('this suite is in npm test', /polish\.p1\.test\.js/.test(pkg.scripts.test));

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
