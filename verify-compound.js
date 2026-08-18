// CW-2 pre-work 2, proved live: a compound "read then change" must get BOTH
// halves answered — the change refused out loud, the read still run for real.
// Listens on the WebSocket, sends the ask, prints what Config-Keeper says.
const WebSocket = require('ws');
const http = require('http');

const ASK = process.argv.slice(2).join(' ') || 'reload sw2 then show me the version';
const ws = new WebSocket('ws://localhost:3800');

ws.on('open', () => {
  console.log(`ASKED: "${ASK}"\n${'─'.repeat(70)}`);
  const body = JSON.stringify({ agent: 'config-keeper', command: ASK });
  const req = http.request({ host: 'localhost', port: 3800, path: '/api/command', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, () => {});
  req.end(body);
});

ws.on('message', (raw) => {
  let msg; try { msg = JSON.parse(raw); } catch (e) { return; }
  if (msg.type !== 'chat_message') return;
  const d = msg.data || msg;
  if (d.type !== 'incoming') return;
  console.log(`\n[${d.agentName}]\n${d.text}`);
});

setTimeout(() => { console.log(`\n${'─'.repeat(70)}\n(done listening)`); process.exit(0); }, 120000);
