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
    var qs = arr(d && d.questions).filter(function (q) { return q && String(q).trim(); }).slice(0, 3);
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

  function verdictHtml(d) {
    var v = (d && d.verdict) || {};
    var cause = v.cause || (d && d.text) || '';
    if (!cause) return '';
    var meta = '';
    if (v.confidence) meta += '<span class="conf">confidence ' + esc(v.confidence) + '</span>';
    if (v.rounds != null) meta += '<span class="pill grey">' + esc(v.rounds) + ' round' + (Number(v.rounds) === 1 ? '' : 's') + '</span>';
    return '<div class="verdictcard"><span class="r-lbl">✔ Cause found</span>' +
      '<div class="vcause">' + esc(cause) + '</div>' +
      (meta ? '<div class="vmeta">' + meta + '</div>' : '') + '</div>';
  }

  function changeHtml(d) {
    var c = (d && d.change) || {};
    var steps = arr(c.steps).filter(function (s) { return s && String(s).trim(); });
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

  return {
    MAX_LINES: MAX_LINES, MAX_CHARS: MAX_CHARS, KINDS: KINDS,
    esc: esc, arr: arr, badList: badList, transport: transport, lineClass: lineClass,
    outputHtml: outputHtml, termBlockHtml: termBlockHtml,
    askHtml: askHtml, rosterHtml: rosterHtml, findingHtml: findingHtml,
    verdictHtml: verdictHtml, changeHtml: changeHtml, placeholderHtml: placeholderHtml,
    isEnvelope: isEnvelope, resolveResume: resolveResume, safeField: safeField,
  };
}));
