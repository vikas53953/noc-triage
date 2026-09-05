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

// 4. badge
ok('the desk badge says "Cockpit" with no wave number', /<span class="dirtag"[^>]*>Cockpit<\/span>/.test(desk) && !/Cockpit · CW-\d/.test(desk));

// 5. phone width
ok('the right-hand header group shrinks instead of widening the page', /\.top-right\{flex:0 1 auto;overflow:hidden;flex-wrap:nowrap\}/.test(desk));
ok('at ≤480px the name tag collapses to the avatar and Capabilities to its gear', /@media \(max-width:480px\)\{[\s\S]*?\.whotag span\{display:none\}[\s\S]*?\.capbtn::before\{content:'⚙'/.test(desk));
ok('the closed drawer is hidden, not just translated off-canvas', /\.cap-drawer:not\(\.on\)\{visibility:hidden/.test(desk) && /\.cap-drawer\.on\{visibility:visible\}/.test(desk));

ok('this suite is in npm test', /polish\.p1\.test\.js/.test(pkg.scripts.test));

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
