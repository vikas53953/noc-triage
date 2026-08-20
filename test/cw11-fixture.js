/* cw11-fixture.js — DEV / REVIEW ONLY. Not loaded by the app.
 *
 * Plain words: paste this into the browser console on /desk.html to see
 * everything CW-11 adds to the screen WITHOUT waiting for the backend half
 * of the wave. Every string below is invented FOR THE LOOK ONLY and says so.
 *
 * WHAT CW-11 ADDS TO THE SCREEN (docs/copilot-cw11-reflexion-contract.md):
 *   1. The verdict card splits into VERIFIED claims (each one traces to a read
 *      from this incident) and SUSPECTED — UNVERIFIED claims (nothing read
 *      backs them yet). A verdict envelope WITHOUT the two new arrays renders
 *      exactly as it did before — that is what cw11VerdictOld() proves.
 *   2. A round that found nothing new, and a prediction that turned out wrong,
 *      are ORDINARY chat messages — no new kind. They may carry an optional
 *      reflection:{type:'nothing-new'|'reopened'|'confirmed'} field, which
 *      becomes a small glyph and a faint tint on that one message.
 *   3. The Lessons panel in the queue footer reads GET /api/lessons. A message
 *      that leaned on a past incident carries lessonRef and gets a chip.
 *
 * It uses the marked dev hooks — window.__cw9DevInject (an envelope),
 * window.__cw11DevSay (an ordinary message) and window.__cw11DevLessons (the
 * panel). Nothing in the product calls this file.
 *
 * Use:
 *   cw11Verdict()          — a verdict with both lists (the new card)
 *   cw11VerdictOld()       — an old verdict, neither list: unchanged rendering
 *   cw11VerdictSuspectOnly()— every claim failed the trace: honest, not alarming
 *   cw11VerdictBadList()   — the lists arrive in a shape we cannot read
 *   cw11VerdictXss()       — hostile text in the claims: printed, never run
 *   cw11Reflect()          — the three reflection markers, one message each
 *   cw11ReflectPlain()     — no reflection field: an ordinary message
 *   cw11LessonRef()        — a message that used a lesson (the chip)
 *   cw11Lessons()          — the panel, three lessons
 *   cw11LessonsEmpty()     — read, and genuinely empty
 *   cw11LessonsUnreadable()— an answer that is not a list of lessons
 *   cw11LessonsXss()       — hostile stored text in every lesson field
 *   cw11All()              — the whole wave, in order
 */

var CW11_TAG = ' [FIXTURE — invented, not a real read]';

function cw11Env(msg) {
  if (typeof window !== 'undefined' && window.__cw9DevInject) return window.__cw9DevInject(msg);
  console.log('open /desk.html first');
}
function cw11Say(msg) {
  if (typeof window !== 'undefined' && window.__cw11DevSay) return window.__cw11DevSay(msg);
  console.log('open /desk.html first');
}
function cw11Panel(d) {
  if (typeof window !== 'undefined' && window.__cw11DevLessons) return window.__cw11DevLessons(d);
  console.log('open /desk.html first (the Lessons panel is desk-only)');
}
function cw11Now() { return new Date().toISOString(); }

/* ---------- 1. the verdict split ---------- */

/* THE REAL WIRE SHAPE, pinned with the backend (PR #77, conduct.verdictMsg):
     verified:  [{ claim, evidenceIds[] }]
     suspected: [{ claim, why }]
     confidence: a NUMBER 0..1, or null     causeSupported: true | false | null
   Not strings, and not the word "high" — both were this branch's guesses. */
var CW11_VERIFIED = [
  { claim: 'Gi1/0/24 on sw1-hyd has 412 CRC errors since the last counter clear.', evidenceIds: ['ev-14', 'ev-17'] },
  { claim: 'The uplink to core-1 flapped twice inside the maintenance window.', evidenceIds: ['ev-21'] },
  { claim: 'The optic on Gi1/0/24 reports Rx power at -19.4 dBm, below the -17 dBm threshold.', evidenceIds: ['ev-23'] },
];
var CW11_SUSPECTED = [
  { claim: 'The fibre patch was probably disturbed during the 10:15 maintenance work.',
    why: 'no reading from this incident backs it' },
  { claim: 'The same optic is likely to fail again within a week.',
    why: 'a prediction, not a reading' },
];

function cw11Verdict() {
  return cw11Env({
    kind: 'verdict',
    agentName: 'Jarvis',
    timestamp: cw11Now(),
    verdict: {
      cause: 'Dirty or failing optic on sw1-hyd Gi1/0/24 — the CRC errors and the low Rx power move together.' + CW11_TAG,
      confidence: 0.82,
      rounds: 3,
      causeSupported: true,
      verified: CW11_VERIFIED,
      suspected: CW11_SUSPECTED,
    },
  });
}

/* The whole point of the ADDITIVE rule: no verified/suspected → the exact card
   the desk drew before this wave. Run this next to cw11Verdict() and compare. */
function cw11VerdictOld() {
  return cw11Env({
    kind: 'verdict',
    agentName: 'Jarvis',
    timestamp: cw11Now(),
    verdict: {
      cause: 'Dirty or failing optic on sw1-hyd Gi1/0/24.' + CW11_TAG,
      confidence: 'high',
      rounds: 3,
    },
  });
}

/* Everything Jarvis wanted to say failed the trace. The card must still read as
   honest rather than as an alarm — there is no red, and no claim of a cause. */
function cw11VerdictSuspectOnly() {
  return cw11Env({
    kind: 'verdict',
    agentName: 'Jarvis',
    timestamp: cw11Now(),
    verdict: {
      cause: 'Nothing read on this incident proves a cause yet.' + CW11_TAG,
      /* causeSupported:false — the self-check found NOTHING backing the cause
         itself, and confidence 0 is the value that used to vanish because 0 is
         falsy. The card must stop calling this a found cause. */
      confidence: 0,
      rounds: 2,
      causeSupported: false,
      verified: [],
      suspected: CW11_SUSPECTED.concat([
        { claim: 'The problem may be upstream of sw1-hyd entirely.', why: 'nothing upstream has been read yet' },
      ]),
    },
  });
}

function cw11VerdictBadList() {
  return cw11Env({
    kind: 'verdict',
    agentName: 'Jarvis',
    timestamp: cw11Now(),
    verdict: {
      cause: 'A cause was stated but the claim lists came back wrong-shaped.' + CW11_TAG,
      verified: 'not a list at all',
      suspected: { one: 'nor is this' },
    },
  });
}

function cw11VerdictXss() {
  var bad = '<img src=x onerror=alert(1)>';
  return cw11Env({
    kind: 'verdict',
    agentName: bad,
    timestamp: cw11Now(),
    verdict: {
      cause: bad + ' cause' + CW11_TAG,
      confidence: bad,
      causeSupported: false,
      verified: [{ claim: bad + ' verified claim', evidenceIds: [bad] }],
      suspected: [{ claim: bad + ' suspected claim', why: bad }, { nested: bad }],
    },
  });
}

/* ---------- 2. the reflection markers ---------- */

function cw11Reflect() {
  cw11Say({
    role: 'jarvis', agentName: 'Jarvis', timestamp: cw11Now(),
    text: 'Round 3 turned up nothing this round that round 2 had not already shown. ' +
          'I am changing approach — moving off the interface counters and onto the optic itself.' + CW11_TAG,
    /* THE REAL WIRE SHAPE (PR #77): the backend sends {nothingNew, line,
       nextAngle} — a real reflection has no `type` field at all. */
    reflection: { nothingNew: true, line: 'nothing new this round', nextAngle: 'the optic itself' },
  });
  cw11Say({
    role: 'jarvis', agentName: 'Jarvis', timestamp: cw11Now(),
    text: 'The prediction did not hold. I said clearing the counters would stop the CRC climb; ' +
          'they are climbing again 12 minutes later, so that hypothesis was wrong. ' +
          'Reopening with that ruled out.' + CW11_TAG,
    reflection: { type: 'reopened' },
  });
  cw11Say({
    role: 'jarvis', agentName: 'Jarvis', timestamp: cw11Now(),
    text: 'The prediction held — after the optic swap the CRC counter has stayed at 0 for 20 minutes. ' +
          'Verdict confirmed.' + CW11_TAG,
    reflection: 'confirmed',   /* the plain-string form is accepted too */
  });
}

/* No reflection field at all — this is what every message looked like before
   this wave, and what an old transcript still looks like. */
function cw11ReflectPlain() {
  return cw11Say({
    role: 'jarvis', agentName: 'Jarvis', timestamp: cw11Now(),
    text: 'Checking the optic levels on sw1-hyd now.' + CW11_TAG,
  });
}

/* ---------- 3. the lesson chip and the lessons panel ---------- */

function cw11LessonRef() {
  return cw11Say({
    role: 'jarvis', agentName: 'Jarvis', timestamp: cw11Now(),
    text: 'This looks like the packet loss on sw1-hyd from last month. I am checking the optic levels ' +
          'first, because that is what found it fastest then.' + CW11_TAG,
    /* THE REAL SHAPE (PR #77): the backend's lesson hit is {id, lookFirst, why},
       and it names the field `lesson`. `lessonRef` was this branch's guess. */
    lesson: { id: 'INC-2041', why: 'the same thing happening on the network, not the same words',
              lookFirst: 'the optic levels on the complaining port' },
  });
}

var CW11_LESSONS = {
  lessons: [
    /* THE REAL RECORD, pinned with the backend (PR #77, lessons.parse):
         { id, closedAt, problem, cause, fastestCheck, wastedTime, keywords[] }
       Note `wastedTime` (not `wasted`), `closedAt` (not `date`), the `problem`
       field this panel used to drop, and NO `incident` field — the id is it. */
    {
      id: 'INC-2041', closedAt: '2026-07-14T09:12:00.000Z',
      problem: 'users on sw1-hyd seeing packet loss since 2pm' + CW11_TAG,
      cause: 'Failing optic on sw1-hyd Gi1/0/24 — CRC errors with low Rx power.',
      fastestCheck: 'show interface transceiver detail on the complaining port',
      wastedTime: '40 minutes spent reading BGP state on core-1, which was never involved',
      keywords: ['packet loss', 'CRC', 'sw1-hyd', 'optic'],
    },
    {
      id: 'INC-1988', closedAt: '2026-06-30T17:40:00.000Z',
      problem: 'nobody at the Hyderabad site can get an address' + CW11_TAG,
      cause: 'DHCP scope on the Hyderabad site had run out of addresses.',
      fastestCheck: 'show ip dhcp pool on the site router',
      wastedTime: 'two rounds of wireless checks before anyone looked at the pool',
      keywords: ['no ip address', 'wifi', 'hyderabad'],
    },
    {
      /* an id the SERVER would refuse (lessons.safeId bars ".."), so the panel
         shows no delete button rather than posting a route that 400s */
      id: '../escape', closedAt: '',
      problem: 'a lesson whose id the server would not accept',
      cause: 'Kept here so it is visible, but it cannot be deleted from this screen.' + CW11_TAG,
      fastestCheck: '', keywords: [],
    },
  ],
};

function cw11Lessons() { return cw11Panel(CW11_LESSONS); }
function cw11LessonsEmpty() { return cw11Panel({ lessons: [] }); }
function cw11LessonsUnreadable() { return cw11Panel({ ok: true, note: 'this is not a list of lessons' }); }
/* Rows that DID arrive, under names this panel does not know. It must never
   report these as "no lessons recorded yet" — they exist. */
function cw11LessonsForeignRows() { return cw11Panel({ lessons: [{ zzz: 1 }, { qqq: 2 }] }); }
function cw11LessonsMixed() { return cw11Panel({ lessons: [CW11_LESSONS.lessons[0], { zzz: 1 }, { qqq: 2 }] }); }
function cw11LessonsXss() {
  var bad = '<img src=x onerror=alert(1)>';
  return cw11Panel({
    lessons: [{
      id: 'INC-XSS', closedAt: bad, problem: bad,
      cause: bad, fastestCheck: bad, wastedTime: bad, keywords: [bad, bad + '2'],
    }],
  });
}

/* ---------- the whole wave, in order ---------- */
function cw11All() {
  cw11VerdictOld();
  cw11Verdict();
  cw11VerdictSuspectOnly();
  cw11Reflect();
  cw11LessonRef();
  cw11Lessons();
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { CW11_LESSONS: CW11_LESSONS, CW11_VERIFIED: CW11_VERIFIED, CW11_SUSPECTED: CW11_SUSPECTED };
}
