/* cw10-say-delta-fixture.js — DEV / REVIEW ONLY. Not loaded by the app.
 *
 * Plain words: paste this into the browser console on /desk.html (or /) to
 * watch a streamed answer arrive piece by piece and then be replaced by the
 * recorded message — WITHOUT waiting for the backend half of CW-10.
 *
 * It uses the marked dev hooks: window.__cw10DevDelta(msg) for a piece, and the
 * page's own incoming-message path for the final. Nothing in the product calls
 * this file. Every string below is invented FOR THE LOOK ONLY and says so.
 *
 * Use:
 *   cw10Stream()      — the happy path: pieces accumulate, final replaces
 *   cw10StreamLossy() — pieces go missing / arrive out of order; final still wins
 *   cw10StreamXss()   — hostile text in the pieces: printed, never executed
 *   cw10StreamOrphan()— pieces, done, and NO final (the honest stale note)
 *   cw10Spend()       — draw the Spend panel from a fixture (desk only)
 *   cw10SpendEmpty()  — the honest empty state
 */
var CW10_ANSWER =
  'Looking at sw1 now. The uplink to core-1 flapped twice in the last hour, ' +
  'both times inside the maintenance window at 10:15.\n' +
  'CRC counters on Gi1/0/24 are climbing — 412 since the last clear — which points at ' +
  'the cable or the optic rather than anything in the config.\n' +
  '[FIXTURE — invented sample answer, not a real read]';

function cw10Chunks(text, size) {
  var out = [];
  for (var i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

function cw10Final(id, text) {
  var msg = {
    role: 'jarvis', agent: 'jarvis', agentName: 'Jarvis',
    messageId: id, text: text, timestamp: new Date().toISOString(),
  };
  if (typeof window !== 'undefined' && window.__cw10DevSay) return window.__cw10DevSay(msg);
  console.log('open /desk.html or / first');
}

function cw10Play(id, pieces, opts) {
  opts = opts || {};
  var i = 0;
  (function step() {
    if (i >= pieces.length) {
      if (!opts.noFinal) setTimeout(function () { cw10Final(id, opts.finalText || CW10_ANSWER); }, 700);
      return;
    }
    var p = pieces[i++];
    window.__cw10DevDelta({
      kind: 'say-delta', messageId: id, delta: p.delta,
      seq: p.seq, done: i >= pieces.length,
      agentName: 'Jarvis', timestamp: new Date().toISOString(),
    });
    setTimeout(step, opts.gap || 55);
  }());
}

/* 1 — the happy path. */
function cw10Stream() {
  var id = 'fx-' + Date.now().toString(36);
  cw10Play(id, cw10Chunks(CW10_ANSWER, 14).map(function (c, n) { return { delta: c, seq: n }; }));
}

/* 2 — the network misbehaves: one piece never arrives, two swap places, one is
   delivered twice. The preview says a piece is missing; the final still wins. */
function cw10StreamLossy() {
  var id = 'fx-lossy-' + Date.now().toString(36);
  var cs = cw10Chunks(CW10_ANSWER, 14).map(function (c, n) { return { delta: c, seq: n }; });
  cs.splice(4, 1);                       /* lost */
  var a = cs[7]; cs[7] = cs[8]; cs[8] = a;  /* out of order */
  cs.splice(11, 0, cs[10]);              /* duplicate */
  cw10Play(id, cs, { gap: 70 });
}

/* 3 — hostile text inside the pieces. It must appear as characters, never run. */
function cw10StreamXss() {
  var id = 'fx-xss-' + Date.now().toString(36);
  var text = '<script>alert("stream")<\/script> <img src=x onerror=alert(1)> ' +
    'Interface is down  [FIXTURE]';
  cw10Play(id, cw10Chunks(text, 7).map(function (c, n) { return { delta: c, seq: n }; }),
    { finalText: text });
}

/* 4 — pieces, done, and the recorded message never arrives. After ~45s the
   preview says so instead of blinking forever. */
function cw10StreamOrphan() {
  var id = 'fx-orphan-' + Date.now().toString(36);
  cw10Play(id, cw10Chunks(CW10_ANSWER, 20).map(function (c, n) { return { delta: c, seq: n }; }),
    { noFinal: true });
}

/* ---------- Spend panel (desk only) ---------- */
var CW10_SPEND_FIXTURE = {
  today: { input_tokens: 184320, output_tokens: 21440, cache_read: 96110, cache_creation: 12800, calls: 37 },
  week: { input_tokens: 1284310, output_tokens: 143220, cache_read: 812400, cache_creation: 41200, calls: 268 },
  byPurpose: {
    understand: { input_tokens: 421000, output_tokens: 38000, calls: 96 },
    investigate: { input_tokens: 512000, output_tokens: 61000, calls: 74 },
    plan: { input_tokens: 186000, output_tokens: 22000, calls: 51 },
    probe: { input_tokens: 98000, output_tokens: 9000, calls: 33 },
    synthesize: { input_tokens: 67310, output_tokens: 13220, calls: 14 },
  },
  byModel: {
    'claude-opus-5': { input_tokens: 890000, output_tokens: 101000, calls: 171 },
    'claude-sonnet-5': { input_tokens: 394310, output_tokens: 42220, calls: 97 },
  },
};
function cw10Spend() { window.__cw10DevSpend(CW10_SPEND_FIXTURE); }
function cw10SpendEmpty() { window.__cw10DevSpend({ today: {}, week: {}, byPurpose: {}, byModel: {} }); }

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    CW10_ANSWER: CW10_ANSWER, CW10_SPEND_FIXTURE: CW10_SPEND_FIXTURE, cw10Chunks: cw10Chunks,
  };
}
