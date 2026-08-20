/* ============================================================
   cw9-bridge.js — ONE implementation of the CW-9 bridge-conduct
   envelope, shared by the desk (public/desk.html) and the classic
   console (public/index.html).

   Why one file: the first cut of this wave had four helpers copied
   into two pages with two DIFFERENT escapers. A fix to one copy would
   never have reached the other, and only one copy was under test. This
   module is the single source: one escaper, one array guard, one
   same-origin check, one output cap, one set of card builders. Both
   pages load it; sources/desk.cw9.ui.test.js requires it directly.

   It is PURE: strings in, HTML strings out. It touches no DOM, no
   window, no network — so it runs identically in node and in a browser.

   THE SAFETY RULES IT OWNS
   - Every value that reaches the DOM is escaped here, first. CLI output
     is raw device text and is escaped line by line, and only THEN given
     a colour class on a span wrapping the whole line, so no device
     string can ever splice markup.
   - A route that arrives inside a message is resolved against the page
     origin and compared by ORIGIN, never by looking at its characters.
     Character checks are how "/\evil.example/steal" got through.
   - Every array-shaped field is coerced, so a wrong-typed envelope
     degrades to an honest card instead of throwing the message away.
   - Rendered/persisted output is capped, so one `show tech-support`
     cannot freeze the pane or silently break the saved thread.
   ============================================================ */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.CW9B = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* Displayed output caps. A real `show tech-support` is megabytes; the
     operator needs the head of it on screen NOW, and an honest note about what
     is not shown — never a frozen tab, and never a block so large that the
     saved thread cannot hold it (the two failures are the same failure).
     Whichever cap is reached first wins, and the note says exactly how much
     was shown out of how much arrived. */
  var MAX_LINES = 2000;
  var MAX_CHARS = 40000;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* One array guard for every array-shaped envelope field. A string, an
     object, a number or null all become an empty list instead of throwing
     out of the renderer and taking the whole message with them. */
  function arr(v) {
    if (Array.isArray(v)) return v;
    return [];
  }

  /* True when the envelope named a field we cannot use as a list — worth
     saying out loud rather than pretending the field was empty. */
  function badList(v) {
    return v != null && !Array.isArray(v);
  }

  /* CW-10 item 7b — one member of an array-shaped field, as display text.
     The old code did String(member), so a question or a change step that
     arrived as an OBJECT printed the literal words "[object Object]" on a P1
     bridge: a message that looks rendered but says nothing. Anything that is
     not already text is stringified to something a human can actually read,
     and bounded so one huge nested blob cannot fill the bubble.
     It returns TEXT, never HTML — the caller still escapes it at the sink. */
  var ITEM_MAX = 400;
  function itemText(v) {
    if (v == null) return '';
    var t = typeof v;
    if (t === 'string') return v;
    if (t === 'number' || t === 'boolean') return String(v);
    if (t === 'function' || t === 'symbol') return '(unreadable value)';
    var s;
    try { s = JSON.stringify(v); } catch (e) { s = null; }   /* cycles throw */
    if (s == null || s === undefined) {
      /* JSON.stringify returns undefined for a function/symbol and throws on a
         cycle — either way there is nothing honest to print. */
      return '(a value this screen cannot show — open the incident record)';
    }
    if (s.length > ITEM_MAX) s = s.slice(0, ITEM_MAX) + '… (trimmed for display)';
    return s;
  }

  /* Every array-of-text field goes through here: coerce the list, make each
     member readable, drop the ones that are genuinely empty. */
  function textList(v) {
    return arr(v).map(itemText).filter(function (s) { return s && s.trim(); });
  }

  function transport(t) {
    var k = String(t == null ? '' : t).toLowerCase();
    if (k === 'ssh') return { key: 'ssh', label: 'SSH', open: 'ssh ' };
    if (k === 'cmdrunner') return { key: 'cmdrunner', label: 'Command Runner', open: 'catalyst-center command-runner --device ' };
    if (k === 'api') return { key: 'api', label: 'API read', open: 'api read ' };
    return { key: 'unknown', label: 'transport not stated', open: 'read ' };
  }

  function lineClass(line) {
    var s = String(line || '');
    if (/(\berrors?\b|\bfailed\b|\bfailure\b|\bdown\b|\bdenied\b|\binvalid\b|\bunreachable\b|not found|no such|\brefused\b|\bcrc\b|\bmajor\b|\bcritical\b)/i.test(s)) return 'r';
    if (/(\bwarn|\babsent\b|\bflap|\bdegraded\b|\bmissing\b|\btimeout\b|timed out|not resolved|\bshutdown\b|\braised\b)/i.test(s)) return 'a';
    if (/(\bup\b|\bok\b|\bsuccess\b|\breachable\b|\bactive\b|\bconnected\b|\bestablished\b|\bpassed?\b)/i.test(s)) return 'g';
    return '';
  }

  function bytesLabel(n) {
    if (n < 1024) return n + ' characters';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(2) + ' MB';
  }

  /* Count lines without allocating a copy of a multi-megabyte string. */
  function countLines(s) {
    var n = 1, i = 0;
    while ((i = s.indexOf('\n', i)) !== -1) { n++; i++; }
    return n;
  }

  /* Escape + colour, with a hard display cap. Returns the HTML plus what was
     cut, so the caller can say so honestly.
     Deliberately allocation-shy: a 2.5 MB dump is never regex-replaced or split
     in full — only the head that can possibly be shown is. The first cut of this
     did `raw.replace(/\s/g,'')` on the whole string just to test emptiness, and
     blocked the tab for seconds. */
  function outputHtml(output) {
    var raw = String(output == null ? '' : output);
    if (!/\S/.test(raw)) {
      return { html: '<span class="tb-empty">(the device returned nothing)</span>', truncated: false };
    }
    var head = raw.slice(0, MAX_CHARS * 2).replace(/\r/g, '').split('\n');
    var totalLines = raw.length > MAX_CHARS * 2 ? countLines(raw) : head.length;
    var out = [], used = 0, shownLines = 0, truncated = raw.length > MAX_CHARS * 2;
    for (var i = 0; i < head.length && shownLines < MAX_LINES && used < MAX_CHARS; i++) {
      var e = esc(head[i]), c = lineClass(head[i]);
      var piece = c ? '<span class="' + c + '">' + e + '</span>' : e;
      out.push(piece); used += piece.length + 1; shownLines++;
    }
    if (shownLines < totalLines) truncated = true;
    var html = out.join('\n');
    if (truncated) {
      html += '\n<span class="a">… output truncated for display — ' + esc(String(shownLines)) +
        ' of ' + esc(String(totalLines)) + ' lines shown (' + esc(bytesLabel(raw.length)) +
        ' in total). Nothing was hidden from the record.</span>';
    }
    return { html: html, truncated: truncated, shownLines: shownLines, totalLines: totalLines };
  }

  /* One black-screen block for one finding.cli. */
  function termBlockHtml(cli, stamp) {
    var c = cli || {};
    var t = transport(c.transport);
    var host = c.host ? String(c.host) : 'unnamed device';
    var out = outputHtml(c.output);
    return '<div class="tblock">' +
      '<div class="tb-cap"><span class="host">' + esc(host) + '</span><span>·</span>' +
      '<span class="tport ' + t.key + '">' + esc(t.label) + '</span>' +
      '<span class="ts">' + esc(stamp || '') + '</span></div>' +
      '<pre class="tb-body">' +
        '<span class="p">jarvis@bridge</span>:~$ ' + t.open + esc(host) + '\n' +
        '<span class="p">' + esc(host) + (t.key === 'api' ? '›' : '#') + '</span> ' +
        esc(c.command == null ? '' : c.command) + '\n' +
        out.html +
      '</pre></div>';
  }

  /* ---------- the five cards (same markup on both pages) ---------- */

  function askHtml(d) {
    var qs = textList(d && d.questions).slice(0, 3);
    var html = '';
    if (qs.length) {
      html = '<ol class="asklist">' + qs.map(function (q) { return '<li>' + esc(q) + '</li>'; }).join('') + '</ol>';
    } else if (badList(d && d.questions)) {
      html = '<div class="askhint">Jarvis sent its questions in a shape this screen cannot list — read the line above and answer it.</div>';
    }
    return html + '<div class="askhint">Answer in the box below. Nothing has been read and nobody has been engaged yet.</div>';
  }

  function rosterHtml(d) {
    var r = (d && d.roster) || {};
    var on = arr(r.engaged).filter(function (x) { return x && x.agent; });
    var off = arr(r.stoodDown).filter(function (x) { return x && x.agent; });
    var wrong = badList(r.engaged) || badList(r.stoodDown);
    if (!on.length && !off.length && !wrong) return '';
    var pills = on.map(function (x) { return '<span class="rpill on">' + esc(x.agent) + ' ✓ engaged</span>'; })
      .concat(off.map(function (x) { return '<span class="rpill off">' + esc(x.agent) + '</span>'; })).join('');
    var why = on.concat(off).filter(function (x) { return x.why; }).map(function (x) {
      return '<div class="rwhy"><b>' + esc(x.agent) + '</b> — ' + esc(x.why) + '</div>';
    }).join('');
    return '<div class="bridgecard"><span class="r-lbl">Bridge roster · who is on this call</span>' +
      (pills ? '<div class="rosterwrap">' + pills + '</div>' : '') +
      (off.length ? '<div class="rstood">Struck out = stood down, not relevant to this problem.</div>' : '') +
      why +
      (wrong ? '<div class="rstood">Part of this roster arrived in a shape this screen cannot list — it is not being guessed at.</div>' : '') +
      '</div>';
  }

  /* Returns { html, blockHtml } — blockHtml is built ONCE and reused by the
     caller for the live pane, so a megabyte read is never escaped twice. */
  function findingHtml(d, stamp) {
    var f = (d && d.finding) || {};
    var cli = f.cli && typeof f.cli === 'object' ? f.cli : null;
    var block = cli ? termBlockHtml(cli, stamp) : '';
    var line = f.line || (d && d.text) || 'A read came back.';
    var agent = f.agent || (d && (d.agentName || d.agent)) || 'Engineer';
    var html = '<details class="findcard">' +
      '<summary><span class="fagent">' + esc(agent) + '</span>' +
      '<span class="fline">' + esc(line) + '</span>' +
      '<span class="fmore">' + (cli ? 'expand CLI' : 'no CLI attached') + '</span></summary>' +
      '<div class="fbody">' + (cli ? block
        : '<div class="termidle">This finding arrived without a command block — nothing is shown that was not run.</div>') +
      '</div></details>';
    return { html: html, blockHtml: block };
  }

  /* ============================================================
     CW-11 part 2 — THE VERDICT SELF-CHECK, ON SCREEN
     ============================================================
     Before Jarvis commits a verdict it walks every claim back to a real
     evidence record from THIS incident. Claims that trace become
     `verified`; claims that do not are downgraded to `suspected` rather
     than dropped silently. The card must show the two apart, because a
     suspected claim sitting inside the green cause block reads as proven
     — which is the exact fabrication this wave exists to stop.

     ADDITIVE: an old verdict envelope carries neither array and renders
     byte-for-byte as it did before this wave.

     TONE: "suspected — unverified" is honest, not alarming. It does not
     shout, it does not use the red/warning colour of a broken message; it
     is a quieter block under the green one that says plainly what is not
     yet backed by a read. */

  var CLAIM_MAX = 12;

  /* One list of claims: coerced, made readable, trimmed, capped — with the
     original length kept so the card can say how many it is not showing. */
  function claims(v) {
    var all = textList(v);
    return { shown: all.slice(0, CLAIM_MAX), total: all.length };
  }

  function claimsBlock(cls, label, c, wrong, note) {
    if (!c.shown.length && !wrong) return '';
    var more = c.total > c.shown.length
      ? '<div class="vcnote">' + esc(String(c.total - c.shown.length)) +
        ' more not shown here — the incident record holds all ' + esc(String(c.total)) + '.</div>'
      : '';
    return '<div class="vclaims ' + cls + '">' +
      '<span class="vch">' + label + '</span>' +
      (c.shown.length ? '<ul>' + c.shown.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ul>' : '') +
      more +
      (wrong ? '<div class="vcnote">Part of this list arrived in a shape this screen cannot read — it is not being guessed at. Open the incident record.</div>' : '') +
      (note && c.shown.length ? '<div class="vcnote">' + note + '</div>' : '') +
      '</div>';
  }

  function verdictHtml(d) {
    var v = (d && d.verdict) || {};
    var cause = v.cause || (d && d.text) || '';
    /* the fields may sit on the verdict object or on the envelope itself —
       either way they are the same two lists, so both are read. */
    var vRaw = v.verified !== undefined ? v.verified : (d && d.verified);
    var sRaw = v.suspected !== undefined ? v.suspected : (d && d.suspected);
    var ver = claims(vRaw), sus = claims(sRaw);
    var badVer = badList(vRaw), badSus = badList(sRaw);
    var anyClaims = ver.shown.length || sus.shown.length || badVer || badSus;
    if (!cause && !anyClaims) return '';
    var meta = '';
    if (v.confidence) meta += '<span class="conf">confidence ' + esc(v.confidence) + '</span>';
    if (v.rounds != null) meta += '<span class="pill grey">' + esc(v.rounds) + ' round' + (Number(v.rounds) === 1 ? '' : 's') + '</span>';
    if (ver.total || sus.total) {
      meta += '<span class="pill grey">' + esc(String(ver.total)) + ' verified · ' +
        esc(String(sus.total)) + ' suspected</span>';
    }
    return '<div class="verdictcard"><span class="r-lbl">✔ Cause found</span>' +
      (cause ? '<div class="vcause">' + esc(cause) + '</div>' : '') +
      claimsBlock('verified', '✔ Verified — traced to a read from this incident', ver, badVer, '') +
      claimsBlock('suspected', 'Suspected — unverified', sus, badSus,
        'Nothing read on this incident backs these yet. They are kept here so they are not lost, and they are not part of the cause above.') +
      (meta ? '<div class="vmeta">' + meta + '</div>' : '') + '</div>';
  }

  /* ============================================================
     CW-11 part 1 & 3 — REFLECTION MARKERS
     ============================================================
     A round that found nothing new, and a prediction that turned out
     wrong, are ORDINARY chat messages — there is no new envelope kind and
     nothing about them renders differently in an old client. What this
     adds is one optional field, `reflection:{type:…}`, which the page
     turns into a small glyph and a quiet tint on that message so an
     operator scanning a long thread can see where Jarvis changed its mind
     without reading every line. Absent field = a plain message. */

  var REFLECTIONS = {
    'nothing-new': { glyph: '↻', label: 'nothing new this round — changing approach' },
    'reopened':    { glyph: '⟲', label: 'the hypothesis was wrong — reopened' },
    'confirmed':   { glyph: '✔', label: 'the prediction held — confirmed' },
  };

  /* '' when the message carries no usable reflection field. Accepts either
     reflection:'confirmed' or reflection:{type:'confirmed'}. */
  function reflectionOf(d) {
    var r = d && d.reflection;
    var t = (r && typeof r === 'object' && !Array.isArray(r)) ? r.type : r;
    t = (typeof t === 'string') ? t.trim().toLowerCase() : '';
    return Object.prototype.hasOwnProperty.call(REFLECTIONS, t) ? t : '';
  }

  function reflectionGlyphHtml(type) {
    var t = (typeof type === 'string') ? type.trim().toLowerCase() : '';
    if (!Object.prototype.hasOwnProperty.call(REFLECTIONS, t)) return '';
    var m = REFLECTIONS[t];
    return '<span class="cw11-refl ' + t + '" title="' + esc(m.label) + '">' +
      '<span class="rg" aria-hidden="true">' + m.glyph + '</span>' +
      '<span class="rt">' + esc(m.label) + '</span></span>';
  }

  /* ============================================================
     CW-11 part 4 (message half) — "using lesson from INC-…"
     ============================================================
     When Jarvis leans on a past incident it says so on the message that
     used it. The chip is a statement about where it looked FIRST — never
     a claim that the old cause is this cause. */
  function lessonRefChipHtml(ref) {
    var inc = '';
    if (typeof ref === 'string' || typeof ref === 'number') inc = String(ref);
    else if (ref && typeof ref === 'object' && !Array.isArray(ref)) {
      inc = ref.incident || ref.id || ref.inc || ref.incidentId || '';
    }
    inc = itemText(inc).trim();
    if (!inc) return '';
    if (inc.length > 60) inc = inc.slice(0, 60) + '…';
    var why = (ref && typeof ref === 'object' && ref.why) ? itemText(ref.why).slice(0, 200) : '';
    return '<span class="cw11-lref" title="' +
      esc(why || 'A past incident is biasing where Jarvis looks first. It decides nothing on its own.') + '">' +
      '<span aria-hidden="true">📓</span> using lesson from ' + esc(inc) + '</span>';
  }

  function changeHtml(d) {
    var c = (d && d.change) || {};
    var steps = textList(c.steps);
    var wrong = badList(c.steps);
    if (!steps.length && !c.id && !wrong) return '';
    return '<div class="changecard"><span class="r-lbl">⏸ Fix drafted — held for approval</span>' +
      (c.id ? '<div><b>' + esc(c.id) + '</b> · <span class="state amber">' + esc(c.state || 'held-for-approval') + '</span></div>' : '') +
      (steps.length ? '<ol>' + steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol>' : '') +
      (wrong ? '<div class="cgate">The steps arrived in a shape this screen cannot list — they are not being guessed at. Read the change record before approving.</div>' : '') +
      '<div class="cgate">Nothing has been sent to any device. A change only runs after a human approves it.</div>' +
      '</div>';
  }

  /* A message we could not paint is still a message. It never vanishes and it
     never becomes an empty bubble — it says what arrived and what went wrong. */
  function placeholderHtml(kind, why) {
    return '<div class="cw9-broken"><span class="r-lbl">Message not shown</span>' +
      'Jarvis sent a <b>' + esc(kind || 'bridge') + '</b> message this screen could not render' +
      (why ? ' (' + esc(why) + ')' : '') +
      '. Nothing has been hidden from the record — open the incident record for the full text.</div>';
  }

  var KINDS = ['ask', 'roster', 'finding', 'verdict', 'change'];
  function isEnvelope(d) {
    return !!(d && typeof d === 'object' && KINDS.indexOf(d.kind) !== -1);
  }

  /* ---------- the resume route ----------
     A route arrives inside an agent-authored message, so it is hostile input.
     It is RESOLVED against the page origin and compared by origin — never
     inspected character by character. "/\evil.example/steal" passes a
     first-character check and resolves to another host; this cannot.
     Returns an origin-local path, so what is fetched is what was checked. */
  /* A body key must be a plain field name. `field:'__proto__'` silently posted an
     EMPTY body (the assignment is a no-op on a literal) and `field:{a:1}` posted
     under "[object Object]" — both are an operator's answer quietly going
     nowhere. Anything not a simple name falls back to the default key. */
  var FIELD_OK = /^[A-Za-z][\w-]{0,63}$/;
  function safeField(f) {
    return (typeof f === 'string' && FIELD_OK.test(f) && f !== '__proto__' && f !== 'constructor' && f !== 'prototype')
      ? f : 'text';
  }

  function resolveResume(d, origin) {
    function local(u) {
      if (typeof u !== 'string' || !u) return null;
      var parsed;
      try { parsed = new URL(u, origin); } catch (e) { return null; }
      if (!parsed || parsed.origin !== origin) return null;
      /* `/..//evil.example` resolves same-origin but NORMALISES to
         "//evil.example" — a protocol-relative path, which is another host to
         anything that later uses it without re-resolving. This function
         promises an origin-local path, so it must never hand one back. */
      if (parsed.pathname.charAt(0) !== '/' || parsed.pathname.charAt(1) === '/') return null;
      return parsed.pathname + parsed.search;
    }
    var r = d && (d.resume || d.resumeEndpoint);
    var path = null, field = 'text';
    if (typeof r === 'string') path = local(r);
    else if (r && typeof r === 'object' && typeof r.url === 'string') { path = local(r.url); field = safeField(r.field); }
    if (path) return { url: path, field: field };
    var tid = d && (d.triageId || d.threadId);
    if (tid && /^[A-Za-z0-9_.:-]+$/.test(String(tid))) {
      var p = local('/api/triage/' + encodeURIComponent(tid) + '/message');
      if (p) return { url: p, field: 'text' };
    }
    return null;   // nothing usable → the answer goes down the normal ask path
  }

  /* ============================================================
     CW-10 item 3 — STREAMING ANSWERS (kind:'say-delta')
     ============================================================
     The backend now sends Jarvis's answer twice: once as it is being
     written, in pieces — {kind:'say-delta', messageId, delta, done} — and
     once at the end, as the ordinary, complete chat message that is what
     the server actually recorded.

     THE ONE RULE: the final message always wins. The pieces are a PREVIEW.
     They are shown so the operator is not staring at a dead screen for
     fifteen seconds, and they are thrown away the moment the real message
     lands — never merged with it, never left beside it as a second bubble.

     What that buys us, in the failure cases that actually happen:
       - a piece is lost in flight  → the preview is short, the final is whole
       - pieces arrive out of order → optional `seq` catches it; without a seq
                                      the preview may read oddly for a second,
                                      and the final still replaces it
       - a piece arrives after done → it is appended; the final still replaces
       - the final never arrives    → the preview stays, and SAYS it is a
                                      preview; the page ages it out honestly
       - the stream never stops     → the preview is capped, not endless

     This is state + strings only. The pages own the DOM node it goes in. */

  var MAX_STREAM_CHARS = 24000;

  function streamId(d) {
    var id = d && (d.messageId !== undefined ? d.messageId : d.id);
    if (typeof id === 'number' && isFinite(id)) id = String(id);
    if (typeof id !== 'string') return '';
    id = id.trim();
    return (id && id.length <= 200) ? id : '';
  }

  function isDelta(d) {
    return !!(d && typeof d === 'object' && d.kind === 'say-delta' && streamId(d));
  }

  function note(t) { return '<span class="cw9-stream-note">' + t + '</span>'; }

  /* Why a preview stopped being live. Each one keeps the text that reached the
     screen and says what happened to the rest — none of them ever throws that
     text away, because the operator already read it. */
  var SETTLE_NOTES = {
    /* the recorded copy arrived with nothing in it */
    empty: 'The recorded copy of this answer came back empty. What is above is what actually reached this screen — it is kept, not thrown away.',
    /* the backend told us the stream was cut short (delta done+aborted) */
    aborted: 'Answer interrupted — this is the partial text Jarvis had written when the stream stopped. Nothing further is coming; ask again if you need the rest.',
    /* nothing more ever arrived and no record came */
    orphan: 'Jarvis stopped mid-answer and the recorded version never arrived. What is above is only what reached this screen — ask again if it matters.',
    /* the safety check refused the draft (delta done+aborted+discard) */
    discarded: 'The draft answer was withdrawn by the safety check — the recorded message below is what stands.',
  };

  function streamBody(st) {
    if (!st.text) return '<span class="cw9-stream-wait">Jarvis is answering…</span>';
    return esc(st.text).replace(/\n/g, '<br>');
  }
  function streamCaveats(st) {
    var out = '';
    if (st.capped) out += note('This answer is longer than the live preview holds — the whole of it lands when Jarvis finishes.');
    if (st.gaps) out += note('Part of this preview did not reach the screen. The complete answer replaces it when Jarvis finishes.');
    return out;
  }

  /* The preview body while the answer is still live. Deliberately NOT markdown:
     the pieces arrive mid-token, so a half-written `**bold` would flip
     formatting on and off while the operator reads. Plain escaped text now, the
     page's own markdown on the final message. */
  function streamPreviewHtml(st) {
    if (!st) return '';
    return '<span class="cw9-stream' + (st.done ? ' done' : '') + '">' + streamBody(st) +
      (st.done ? '' : '<span class="cw9-caret" aria-hidden="true"></span>') + '</span>' +
      streamCaveats(st) +
      (st.done ? note('Waiting for the recorded answer…') : '');
  }

  /* The preview is finished and no recorded answer is replacing it. The text
     STAYS on screen; only the caret and the "waiting" line go, replaced by the
     honest reason. Used for an empty recorded copy, an aborted stream, and a
     record that never came. */
  function streamSettledHtml(st, reason) {
    if (!st) return '';
    /* A DISCARDED draft is the one case where the text must NOT survive: the
       safety check refused that content, so leaving it on screen (or in the
       saved thread) would be the console keeping what the guardrail threw out.
       Nothing of it is rendered — not the text, not the "part of this did not
       arrive" caveats about it — only the line saying it was withdrawn. */
    if (reason === 'discarded') return note(SETTLE_NOTES.discarded);
    var body = st.text ? esc(st.text).replace(/\n/g, '<br>')
      : '<span class="cw9-stream-wait">Nothing of this answer reached the screen.</span>';
    return '<span class="cw9-stream done">' + body + '</span>' +
      streamCaveats(st) + note(SETTLE_NOTES[reason] || SETTLE_NOTES.orphan);
  }

  function createStream() {
    var live = Object.create(null);      /* answers still arriving */
    var ids = [];
    /* Answers that stopped being live WITHOUT a recorded message replacing them
       — interrupted, or a recorded copy that came back empty. Their text is
       still on screen, so a late recorded answer must still be able to replace
       it. Bounded, oldest dropped first. */
    var closed = Object.create(null);
    var closedIds = [];
    var CLOSED_MAX = 20;

    function drop(id) {
      var had = false;
      if (id in live) {
        delete live[id]; had = true;
        var i = ids.indexOf(id);
        if (i !== -1) ids.splice(i, 1);
      }
      if (id in closed) {
        delete closed[id]; had = true;
        var j = closedIds.indexOf(id);
        if (j !== -1) closedIds.splice(j, 1);
      }
      return had;
    }

    /* Move a live answer into the closed set with the reason it stopped. */
    function closeOut(id, reason) {
      var st = live[id];
      if (!st) return null;
      st.settled = reason;
      delete live[id];
      var i = ids.indexOf(id);
      if (i !== -1) ids.splice(i, 1);
      closed[id] = st;
      closedIds.push(id);
      while (closedIds.length > CLOSED_MAX) delete closed[closedIds.shift()];
      return st;
    }

    return {
      /* Take one delta. Returns null when this is not a delta we own, else
         { id, first, done, html } — `first` tells the page to create a bubble
         rather than update one. */
      accept: function (d, now) {
        if (!isDelta(d)) return null;
        var id = streamId(d);
        var first = !(id in live);
        if (first) {
          live[id] = {
            id: id, text: '', done: false, chunks: 0, gaps: false, capped: false,
            lastSeq: null, started: now || Date.now(), at: now || Date.now(),
            who: (typeof d.agentName === 'string' && d.agentName) ||
                 (typeof d.agent === 'string' && d.agent) || 'Jarvis',
            timestamp: typeof d.timestamp === 'string' ? d.timestamp : '',
          };
          ids.push(id);
        }
        var st = live[id];
        st.at = now || Date.now();

        /* `seq` is optional in the envelope. When it IS there we can tell a
           replayed/duplicate piece from a new one, and spot a hole. When it is
           not, we simply append — the final message covers us either way. */
        var seq = (typeof d.seq === 'number' && isFinite(d.seq)) ? d.seq
                : (typeof d.index === 'number' && isFinite(d.index)) ? d.index : null;
        var stale = false;
        if (seq !== null) {
          if (st.lastSeq !== null && seq <= st.lastSeq) stale = true;       /* already had it */
          else if (st.lastSeq !== null && seq > st.lastSeq + 1) st.gaps = true;
          if (!stale) st.lastSeq = seq;
        }

        if (!stale) {
          var piece = itemText(d.delta);
          if (piece) {
            var room = MAX_STREAM_CHARS - st.text.length;
            if (room <= 0) st.capped = true;
            else if (piece.length > room) { st.text += piece.slice(0, room); st.capped = true; }
            else st.text += piece;
            st.chunks++;
          }
        }
        if (d.done === true) st.done = true;

        /* The backend flags a stream it could not finish (done + aborted). The
           partial text stays exactly where it is, labelled as partial, and the
           answer stops being live IMMEDIATELY — there is no recorded message
           coming, so waiting for one would leave a caret blinking at an
           operator for no reason. A late record can still replace it. */
        if (st.done && d.aborted === true) {
          /* discard = the safety check refused the draft. The partial text is
             not "what reached the screen" any more, it is content a guardrail
             threw out, so it is DELETED here — from the state as well as the
             screen, because the state is what the page saves. The page flushes
             its saved copy straight after, so a reload cannot bring it back. */
          var discard = d.discard === true;
          if (discard) { st.text = ''; st.capped = false; st.gaps = false; }
          var reason = discard ? 'discarded' : 'aborted';
          closeOut(id, reason);
          return { id: id, first: first, done: true, stale: stale, aborted: true,
                   discard: discard, settled: reason, html: streamSettledHtml(st, reason) };
        }
        return { id: id, first: first, done: st.done, stale: stale, aborted: false,
                 discard: false, settled: null, html: streamPreviewHtml(st) };
      },

      /* What (if anything) this ORDINARY message does to a preview.
         Returns null, or { id, empty, shown, html }.
           empty:false → the page REPLACES the preview with this message
           empty:true  → the recorded copy was blank: the preview's text STAYS,
                         relabelled with `html`, and nothing is deleted

         ONE rule decides it: the messageId must match. The pinned seam puts
         the same messageId on the recorded answer, and everything ELSE on this
         socket — findings, rosters, system lines, another agent's reply —
         arrives without one. Two live reviews found the same class of bug from
         guessing: a finding landing mid-answer claimed the preview (a second
         bubble), and later, once settle-in-place existed, an unrelated message
         claiming a finished preview DELETED Jarvis's answer outright. There is
         no id-less path left; an unmatched message renders normally, and a
         preview nobody claims ages out honestly with its text intact.

         A message with no real text can never replace anything either — an
         empty recorded copy must not wipe what the operator just read. */
      settleFor: function (d) {
        if (!d || typeof d !== 'object' || isDelta(d)) return null;
        if (d.kind && KINDS.indexOf(d.kind) !== -1) return null;   /* a card, not an answer */
        var id = streamId(d);
        if (!id) return null;
        var st = live[id] || closed[id];
        if (!st) return null;
        var hasText = typeof d.text === 'string' && d.text.trim() !== '';
        if (!hasText) {
          if (!(id in live)) return null;          /* already settled — leave it alone */
          closeOut(id, 'empty');
          return { id: id, empty: true, shown: st.text.length, html: streamSettledHtml(st, 'empty') };
        }
        drop(id);
        return { id: id, empty: false, shown: st.text.length, html: '' };
      },

      /* Previews with no final message after `maxAgeMs`. The page turns these
         into an honest note; they are never silently deleted. */
      stale: function (maxAgeMs, now) {
        var t = now || Date.now();
        return ids.filter(function (id) { return t - live[id].at > maxAgeMs; });
      },

      get: function (id) { return live[id] || closed[id] || null; },
      isLive: function (id) { return !!live[id]; },
      ids: function () { return ids.slice(); },
      size: function () { return ids.length; },
      drop: drop,
      clear: function () {
        live = Object.create(null); ids = [];
        closed = Object.create(null); closedIds = [];
      },
    };
  }

  /* ============================================================
     CW-10 item 4 (panel half) — SPEND SUMMARY
     ============================================================
     Reads GET /api/spend/summary and turns it into totals + bars. The
     endpoint is built on the other branch, so this normalises the field
     names it could plausibly arrive under and, when it finds nothing,
     SAYS nothing was found. There is no default, no estimate, no
     placeholder number anywhere below: a spend panel that guesses is
     worse than no spend panel. Tokens only — this file never prints a
     price, because nothing in the record knows one. */

  function num(v) {
    var n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
    return (isFinite(n) && n >= 0) ? n : 0;
  }

  /* One bucket of counters, whatever the backend called its fields. */
  function tokens(o) {
    if (!o || typeof o !== 'object') return { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, calls: 0 };
    return {
      input: num(o.input_tokens !== undefined ? o.input_tokens : (o.inputTokens !== undefined ? o.inputTokens : o.input)),
      output: num(o.output_tokens !== undefined ? o.output_tokens : (o.outputTokens !== undefined ? o.outputTokens : o.output)),
      cacheRead: num(o.cache_read !== undefined ? o.cache_read
                  : (o.cacheRead !== undefined ? o.cacheRead : o.cache_read_input_tokens)),
      cacheCreate: num(o.cache_creation !== undefined ? o.cache_creation
                  : (o.cacheCreation !== undefined ? o.cacheCreation : o.cache_creation_input_tokens)),
      calls: num(o.calls !== undefined ? o.calls : (o.count !== undefined ? o.count : o.requests)),
    };
  }
  function totalOf(t) { return t.input + t.output + t.cacheRead + t.cacheCreate; }
  function anyOf(t) { return totalOf(t) > 0 || t.calls > 0; }

  /* A map {name: bucket} or a list [{purpose|model|name, …}] — both are shapes
     a reasonable backend would send, so both are read. */
  function buckets(v, nameKeys) {
    var out = [];
    if (Array.isArray(v)) {
      v.forEach(function (row) {
        if (!row || typeof row !== 'object') return;
        var name = '';
        for (var i = 0; i < nameKeys.length; i++) {
          if (typeof row[nameKeys[i]] === 'string' && row[nameKeys[i]]) { name = row[nameKeys[i]]; break; }
        }
        out.push({ name: name || 'not stated', t: tokens(row) });
      });
    } else if (v && typeof v === 'object') {
      Object.keys(v).forEach(function (k) {
        var row = v[k];
        out.push({ name: k || 'not stated', t: typeof row === 'number' ? tokens({ input: row }) : tokens(row) });
      });
    }
    return out.filter(function (b) { return anyOf(b.t); })
      .sort(function (a, b) { return totalOf(b.t) - totalOf(a.t); });
  }

  function pick(o, keys) {
    for (var i = 0; i < keys.length; i++) if (o && o[keys[i]] != null) return o[keys[i]];
    return null;
  }

  /* EMPTY and UNREADABLE are different claims, and saying the wrong one is a
     lie about money. "Nothing has been spent yet" is a statement about the
     server's record; it may only be made when a summary was actually
     understood and its counters really are zero. A body that is not an object,
     or that names none of the fields this panel reads, was NOT understood —
     that is UNREADABLE, and it says so. (A review found this branch was dead
     code: nothing here threw, so an unreadable shape claimed zero spend.) */
  var SPEND_KEYS = ['today', 'day', 'week', 'thisWeek', 'this_week', 'last7', 'last7Days',
    'byPurpose', 'purposes', 'perPurpose', 'by_purpose',
    'byModel', 'models', 'perModel', 'by_model'];

  function readable(o) {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
    for (var i = 0; i < SPEND_KEYS.length; i++) if (o[SPEND_KEYS[i]] != null) return true;
    return false;
  }

  function unreadableSpend() {
    var zero = tokens(null);
    return { today: zero, week: zero, purposes: [], models: [], empty: false, unreadable: true };
  }

  function normalizeSpend(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return unreadableSpend();
    var nested = (raw.totals && typeof raw.totals === 'object' && !Array.isArray(raw.totals)) ? raw.totals : null;
    if (!readable(raw) && !readable(nested)) return unreadableSpend();
    var t = nested && readable(nested) ? nested : raw;
    var today = tokens(pick(t, ['today', 'day']));
    var week = tokens(pick(t, ['week', 'thisWeek', 'this_week', 'last7', 'last7Days']));
    var purposes = buckets(pick(raw, ['byPurpose', 'purposes', 'perPurpose', 'by_purpose']), ['purpose', 'name', 'key']);
    var models = buckets(pick(raw, ['byModel', 'models', 'perModel', 'by_model']), ['model', 'name', 'key']);
    return {
      today: today, week: week, purposes: purposes, models: models, unreadable: false,
      empty: !anyOf(today) && !anyOf(week) && !purposes.length && !models.length,
    };
  }

  function compact(n) {
    n = num(n);
    if (n >= 1000000) return (n / 1000000).toFixed(n >= 10000000 ? 0 : 1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k';
    return String(Math.round(n));
  }
  function exact(n) { return String(Math.round(num(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

  /* One labelled bar. The number is written next to the label — the bar is
     only there to make the ORDER readable at a glance, so there is no grid,
     no axis and no second colour competing with it. */
  function bar(name, value, max, sub) {
    var w = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;
    return '<div class="sp-row" title="' + esc(exact(value)) + ' tokens">' +
      '<div class="sp-rowtop"><span class="sp-name">' + esc(name) + '</span>' +
      '<span class="sp-val">' + esc(compact(value)) + '</span></div>' +
      '<div class="sp-track"><span class="sp-fill" style="width:' + w + '%"></span></div>' +
      (sub ? '<div class="sp-sub">' + esc(sub) + '</div>' : '') +
      '</div>';
  }

  function totalsCard(label, t) {
    if (!anyOf(t)) {
      return '<div class="sp-tile"><span class="sp-tl">' + esc(label) + '</span>' +
        '<span class="sp-big">—</span><span class="sp-sub">nothing recorded</span></div>';
    }
    var sub = compact(t.input) + ' in · ' + compact(t.output) + ' out' +
      (t.cacheRead ? ' · ' + compact(t.cacheRead) + ' from cache' : '') +
      (t.calls ? ' · ' + exact(t.calls) + ' call' + (t.calls === 1 ? '' : 's') : '');
    return '<div class="sp-tile" title="' + esc(exact(totalOf(t))) + ' tokens">' +
      '<span class="sp-tl">' + esc(label) + '</span>' +
      '<span class="sp-big">' + esc(compact(totalOf(t))) + '</span>' +
      '<span class="sp-sub">' + esc(sub) + '</span></div>';
  }

  /* The honest states. `spendNoteHtml` is what shows when the endpoint is not
     there yet (404 — the backend branch has not merged), is unreachable, or
     answered with something this panel cannot read. It never shows a zero as
     if zero were the measurement. */
  function spendNoteHtml(reason) {
    return '<div class="sp-note"><b>No spend data yet</b>' +
      (reason ? ' — ' + esc(reason) : '') +
      '<div class="sp-fine">Nothing is being estimated here. When the server starts recording model usage, the real numbers appear.</div></div>';
  }

  /* Different claim, different words: this one does NOT say nothing was spent.
     It says the answer could not be understood, which is all we know. */
  function spendUnreadableHtml(reason) {
    return '<div class="sp-note"><b>Spend data can\'t be read</b>' +
      (reason ? ' — ' + esc(reason) : ' — the summary came back in a shape this panel does not recognise') +
      '<div class="sp-fine">There may or may not be spend recorded; this panel will not guess either way. The server\'s record is the truth — this is a display problem, and it is worth reporting.</div></div>';
  }

  function spendHtml(raw) {
    var s;
    try { s = normalizeSpend(raw); }
    catch (e) { return spendUnreadableHtml('reading the summary threw: ' + (e && e.message ? e.message : 'unexpected shape')); }
    if (s.unreadable) return spendUnreadableHtml('');
    if (s.empty) return spendNoteHtml('the server is recording model usage, but nothing has been spent yet');

    var html = '<div class="sp-tiles">' + totalsCard('Today', s.today) + totalsCard('This week', s.week) + '</div>';

    if (s.purposes.length) {
      var pmax = totalOf(s.purposes[0].t);
      html += '<div class="sp-sec"><span class="sp-sech">What it went on</span>' +
        s.purposes.slice(0, 8).map(function (b) {
          return bar(b.name, totalOf(b.t), pmax, b.t.calls ? exact(b.t.calls) + ' call' + (b.t.calls === 1 ? '' : 's') : '');
        }).join('') + '</div>';
    }
    if (s.models.length) {
      var mtotal = s.models.reduce(function (a, b) { return a + totalOf(b.t); }, 0);
      var mmax = totalOf(s.models[0].t);
      html += '<div class="sp-sec"><span class="sp-sech">Which model</span>' +
        s.models.slice(0, 6).map(function (b) {
          var v = totalOf(b.t);
          var pct = mtotal > 0 ? Math.round((v / mtotal) * 100) + '% of all tokens' : '';
          return bar(b.name, v, mmax, pct);
        }).join('') + '</div>';
    }
    html += '<div class="sp-fine">Tokens counted from the server\'s own usage record. No price is shown — the record does not hold one.</div>';
    return html;
  }

  /* ============================================================
     CW-11 part 4 (panel half) — LESSONS MEMORY
     ============================================================
     Reads GET /api/lessons. A lesson is a FACT about a past incident —
     what the cause turned out to be, which check found it fastest, what
     wasted time — and it biases where Jarvis looks first. It is never a
     rule: nothing here runs anything, approves anything, or skips the
     ask-first gate.

     The two honest states are kept APART, exactly as the Spend panel
     keeps them apart, and for the same reason: "no lessons recorded yet"
     is a claim about the server's record and may only be made when a list
     was actually understood and really was empty. A body that is not a
     list, and names no list, was NOT understood — that is unreadable, and
     it says so instead.

     Every field below is STORED TEXT written from model output, so every
     one of them is escaped at the sink like device output is. */

  var LESSON_LIST_KEYS = ['lessons', 'items', 'list', 'data', 'results'];
  var LESSON_MAX = 200;
  /* An id becomes a URL path segment on DELETE. Anything that is not a plain
     name gets no delete button rather than a guessed route. */
  var LESSON_ID_OK = /^[A-Za-z0-9_.:-]{1,80}$/;

  function lessonField(v, max) {
    var s = itemText(v).trim();
    if (max && s.length > max) s = s.slice(0, max) + '…';
    return s;
  }

  function lessonRow(row) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      /* a bare string in the list is still a lesson someone wrote */
      var s = lessonField(row, 300);
      return s ? { id: '', incident: '', cause: s, fastestCheck: '', wasted: '', keywords: [], date: '', deletable: false } : null;
    }
    var id = lessonField(row.id !== undefined ? row.id : (row.file !== undefined ? row.file : row.incident), 100);
    var incident = lessonField(row.incident !== undefined ? row.incident : (row.incidentId !== undefined ? row.incidentId : row.id), 80);
    var out = {
      id: id,
      incident: incident,
      cause: lessonField(row.cause, 300),
      fastestCheck: lessonField(row.fastestCheck !== undefined ? row.fastestCheck : row.fastest_check, 220),
      wasted: lessonField(row.wasted !== undefined ? row.wasted : (row.wastedTime !== undefined ? row.wastedTime : row.wasted_time), 220),
      keywords: textList(row.keywords !== undefined ? row.keywords : row.symptomKeywords)
        .map(function (k) { return lessonField(k, 40); }).filter(Boolean).slice(0, 8),
      date: lessonField(row.date !== undefined ? row.date : (row.closedAt !== undefined ? row.closedAt : row.at), 40),
      deletable: LESSON_ID_OK.test(id),
    };
    if (!out.incident && !out.cause && !out.fastestCheck && !out.keywords.length) return null;
    return out;
  }

  function normalizeLessons(raw) {
    var rows = null;
    if (Array.isArray(raw)) rows = raw;
    else if (raw && typeof raw === 'object') {
      for (var i = 0; i < LESSON_LIST_KEYS.length; i++) {
        if (Array.isArray(raw[LESSON_LIST_KEYS[i]])) { rows = raw[LESSON_LIST_KEYS[i]]; break; }
      }
    }
    if (!rows) return { list: [], empty: false, unreadable: true, total: 0 };
    var list = rows.map(lessonRow).filter(Boolean);
    return { list: list.slice(0, LESSON_MAX), empty: !list.length, unreadable: false, total: list.length };
  }

  function lessonHtml(l) {
    var head = l.incident ? esc(l.incident) : '<span class="ls-noinc">incident not stated</span>';
    var del = l.deletable
      ? '<button type="button" class="ls-del" data-lesson-id="' + esc(l.id) + '" data-lesson-name="' +
        esc(l.incident || l.id) + '" title="Delete this lesson">Delete</button>'
      : '<span class="ls-nodel" title="This lesson has no id the server would accept on a delete route — nothing is being guessed at.">no id</span>';
    var rows = '';
    if (l.cause) rows += '<div class="ls-row"><span class="ls-k">cause</span><span class="ls-v">' + esc(l.cause) + '</span></div>';
    if (l.fastestCheck) rows += '<div class="ls-row"><span class="ls-k">found fastest by</span><span class="ls-v">' + esc(l.fastestCheck) + '</span></div>';
    if (l.wasted) rows += '<div class="ls-row"><span class="ls-k">wasted time</span><span class="ls-v">' + esc(l.wasted) + '</span></div>';
    var kw = l.keywords.length
      ? '<div class="ls-kws">' + l.keywords.map(function (k) { return '<span class="ls-kw">' + esc(k) + '</span>'; }).join('') + '</div>'
      : '';
    return '<div class="ls-item" data-lesson-row="' + esc(l.id) + '">' +
      '<div class="ls-top"><span class="ls-inc">' + head + '</span>' +
      (l.date ? '<span class="ls-date">' + esc(l.date) + '</span>' : '') + del + '</div>' +
      rows + kw + '</div>';
  }

  function lessonsHtml(raw) {
    var s;
    try { s = normalizeLessons(raw); }
    catch (e) { return lessonsUnreadableHtml('reading the list threw: ' + (e && e.message ? e.message : 'unexpected shape')); }
    if (s.unreadable) return lessonsUnreadableHtml('');
    if (s.empty) return lessonsEmptyHtml();
    return s.list.map(lessonHtml).join('') +
      '<div class="ls-fine">A lesson only biases where Jarvis looks first. It never runs a check, never approves a change, and never overrides a question it should be asking you.</div>';
  }

  /* The record was read and it really is empty. */
  function lessonsEmptyHtml() {
    return '<div class="ls-note"><b>No lessons recorded yet</b>' +
      '<div class="ls-fine">Jarvis writes one short lesson when an incident is closed — the cause, the check that found it fastest, and what wasted time. Close an incident and the first one appears here.</div></div>';
  }

  /* The endpoint is not there, or is unreachable. Different claim from empty. */
  function lessonsNoteHtml(reason) {
    return '<div class="ls-note"><b>Lessons aren\'t available</b>' +
      (reason ? ' — ' + esc(reason) : '') +
      '<div class="ls-fine">This says nothing about whether lessons exist. Nothing is being invented here.</div></div>';
  }

  /* The answer came back in a shape this panel cannot read. */
  function lessonsUnreadableHtml(reason) {
    return '<div class="ls-note"><b>Lessons can\'t be read</b>' +
      (reason ? ' — ' + esc(reason) : ' — the server answered with something that is not a list of lessons') +
      '<div class="ls-fine">There may or may not be lessons recorded; this panel will not guess either way. The server\'s files are the truth — this is a display problem, and it is worth reporting.</div></div>';
  }

  return {
    MAX_LINES: MAX_LINES, MAX_CHARS: MAX_CHARS, MAX_STREAM_CHARS: MAX_STREAM_CHARS, KINDS: KINDS,
    CLAIM_MAX: CLAIM_MAX, LESSON_MAX: LESSON_MAX,
    reflectionOf: reflectionOf, reflectionGlyphHtml: reflectionGlyphHtml,
    lessonRefChipHtml: lessonRefChipHtml,
    normalizeLessons: normalizeLessons, lessonsHtml: lessonsHtml,
    lessonsEmptyHtml: lessonsEmptyHtml, lessonsNoteHtml: lessonsNoteHtml,
    lessonsUnreadableHtml: lessonsUnreadableHtml,
    itemText: itemText, textList: textList,
    isDelta: isDelta, streamId: streamId, createStream: createStream,
    streamPreviewHtml: streamPreviewHtml, streamSettledHtml: streamSettledHtml,
    normalizeSpend: normalizeSpend, spendHtml: spendHtml, spendNoteHtml: spendNoteHtml,
    spendUnreadableHtml: spendUnreadableHtml,
    esc: esc, arr: arr, badList: badList, transport: transport, lineClass: lineClass,
    outputHtml: outputHtml, termBlockHtml: termBlockHtml,
    askHtml: askHtml, rosterHtml: rosterHtml, findingHtml: findingHtml,
    verdictHtml: verdictHtml, changeHtml: changeHtml, placeholderHtml: placeholderHtml,
    isEnvelope: isEnvelope, resolveResume: resolveResume, safeField: safeField,
  };
}));
