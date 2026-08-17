// config-store.js — the "change correlation" front (gap 5). Snapshot each
// device's running-config per run and diff it against the last snapshot, so an
// honest "no config change on sw1-sw4 in the incident window" (rules out a cause
// class) or "sw2 changed at 13:55 — inside the window" becomes a real finding.
//
// HONESTY: nothing is invented. The very first snapshot of a device has nothing
// to compare against, so diff() returns { changed:false, firstSnapshot:true } —
// it never pretends a device is unchanged (or changed) when there is no prior.
//
// SECRETS NEVER TOUCH DISK: a running-config is full of secrets (line passwords,
// enable secret, snmp community, crypto/pre-shared keys). The Phase-B scrubber
// (sources/session-log.scrub) only catches JSON-shaped "token":"..." fields, so
// on top of it this module runs a CONFIG-LINE scrubber that redacts the secret
// half of every known IOS/NX-OS secret line while KEEPING the keyword — so a
// changed password still shows as a changed line in the diff, just with the
// value «redacted». What is written to disk, and what diff() returns, is always
// already scrubbed.
//
// PATH SAFETY: device ids become filenames only through the workspace safeJoin
// guard; a device id containing "../" resolves to null and is refused.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { SQUAD_ROOT, safeJoin } = require('../workspace');
const { scrub: phaseBScrub } = require('./session-log');

// Redact a secret to a NON-reversible fingerprint, not a flat «redacted». The
// value never touches disk, but a secret ROTATION still shows as a changed line
// in the diff (a plain «redacted» on both sides would hide a password change —
// exactly the kind of change correlation wants to catch). An 8-hex prefix of a
// SHA-256 is not sensitive and cannot be reversed to the secret.
function redactSecret(value) {
  const h = crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 8);
  return `«redacted:${h}»`;
}

const CONFIG_DIRNAME = 'configs';
const MAX_SNAPSHOTS = 20; // rolling history per device

function configRoot() {
  return path.join(SQUAD_ROOT, 'data', CONFIG_DIRNAME);
}

// ── Config-line secret scrubbing ──────────────────────────────────────────────
// Redact the SECRET token on known config lines, keeping enough of the line that
// a real change to it still surfaces as a changed line in the unified diff.
// Applied AFTER the Phase-B JSON scrubber. Order matters (specific → general).
const CONFIG_SECRET_RULES = [
  // username admin privilege 15 password 7 <hash>  /  ... secret 5 <hash>
  { re: /^(\s*username\s+\S+(?:\s+privilege\s+\d+)?\s+(?:password|secret)\s+(?:\d+\s+)?)(\S.*)$/i, keep: 1 },
  // enable secret 5 <hash>  /  enable password 7 <hash>
  { re: /^(\s*enable\s+(?:secret|password)\s+(?:\d+\s+)?)(\S.*)$/i, keep: 1 },
  // line-level: password 7 <hash>  /  password <clear>
  { re: /^(\s*password\s+(?:\d+\s+)?)(\S.*)$/i, keep: 1 },
  // secret 5 <hash>
  { re: /^(\s*secret\s+(?:\d+\s+)?)(\S.*)$/i, keep: 1 },
  // snmp-server community <string> RO/RW
  { re: /^(\s*snmp-server\s+community\s+)(\S+)(.*)$/i, keep: 1, tail: 3 },
  // snmp-server host <ip> [traps|informs] version 1|2c <community>
  { re: /^(\s*snmp-server\s+host\s+\S+(?:\s+(?:traps|informs))?\s+version\s+(?:1|2c)\s+)(\S+)(.*)$/i, keep: 1, tail: 3 },
  // snmp-server user ... auth md5/sha <key> priv aes <key>
  { re: /^(\s*snmp-server\s+user\s+.*?(?:auth\s+\S+\s+|priv\s+\S+\s+))(\S+)(.*)$/i, keep: 1, tail: 3 },
  // key <n> / key-string / key 7 <hash>  (key chains, EIGRP/OSPF/RIP auth)
  { re: /^(\s*key(?:-string)?\s+(?:\d+\s+)?)(\S.*)$/i, keep: 1 },
  // message-digest-key N md5 <key>  /  ospf ... md5 <key>
  { re: /^(\s*(?:.*\s)?message-digest-key\s+\d+\s+md5\s+(?:\d+\s+)?)(\S.*)$/i, keep: 1 },
  // ntp authentication-key N md5 <key>
  { re: /^(\s*ntp\s+authentication-key\s+\d+\s+\S+\s+)(\S.*)$/i, keep: 1 },
  // neighbor X password <secret>  (BGP)
  { re: /^(\s*neighbor\s+\S+\s+password\s+(?:\d+\s+)?)(\S.*)$/i, keep: 1 },
  // pre-shared-key / pre-shared-key address x.x.x.x key <secret>
  { re: /^(\s*(?:.*\s)?pre-shared-key\s+(?:\S+\s+)*?key\s+(?:\d+\s+)?)(\S.*)$/i, keep: 1 },
  { re: /^(\s*pre-shared-key\s+(?:\d+\s+)?)(\S.*)$/i, keep: 1 },
  // crypto isakmp key <PSK> address x.x.x.x / hostname <h>  (IKEv1 form).
  // The rules above only covered the IKEv2 "pre-shared-key" spelling, so an
  // IKEv1 PSK survived in cleartext. The trailing address/hostname clause is
  // NOT a secret and is kept, so a changed PSK still shows as a changed line.
  { re: /^(\s*crypto\s+isakmp\s+key\s+(?:\d+\s+)?)(\S+)(\s+(?:address|hostname|ipv6)\s+.*)$/i, keep: 1, tail: 3 },
  { re: /^(\s*crypto\s+isakmp\s+key\s+(?:\d+\s+)?)(\S.*)$/i, keep: 1 },
  // crypto ... authentication pre-share key <secret>  / set session-key ...
  { re: /^(\s*set\s+session-key\s+(?:inbound|outbound)\s+\S+\s+\S+\s+)(\S.*)$/i, keep: 1 },
  // radius/tacacs key <secret>
  { re: /^(\s*(?:radius|tacacs)(?:-server)?\s+.*?\bkey\s+(?:\d+\s+)?)(\S.*)$/i, keep: 1 },
  // ppp chap/pap password <secret>
  { re: /^(\s*ppp\s+(?:chap|pap)\s+(?:password|sent-username\s+\S+\s+password)\s+(?:\d+\s+)?)(\S.*)$/i, keep: 1 },
  // wpa-psk ascii/hex <key>  /  psk <key>
  { re: /^(\s*wpa-psk\s+(?:ascii|hex)\s+(?:\d+\s+)?)(\S.*)$/i, keep: 1 },
];

function scrubConfig(text) {
  if (text == null) return '';
  // Phase B first (JSON-shaped credential fields, if any wrap the CLI output).
  let s = phaseBScrub(String(text));
  const out = s.split('\n').map((line) => {
    for (const rule of CONFIG_SECRET_RULES) {
      const m = line.match(rule.re);
      if (m) {
        const head = m[rule.keep];
        const tail = rule.tail ? (m[rule.tail] || '') : '';
        // The secret is whatever the rule captured between head and tail.
        const secret = rule.tail ? (m[2] || '') : line.slice(head.length);
        return head + redactSecret(secret) + tail;
      }
    }
    return line;
  });
  return out.join('\n');
}

// ── Per-device snapshot files ─────────────────────────────────────────────────
function deviceKey(device) {
  const raw = String(device == null ? '' : device).trim();
  // Refuse path-shaped ids outright (separators, "..", null byte); safeJoin is
  // the backstop, this is the loud refusal the traversal test expects.
  if (!raw || raw.includes('/') || raw.includes('\\') || raw.includes('..') || raw.includes('\0')) return null;
  const key = raw.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '').slice(0, 120);
  return key || null;
}

function fileForDevice(device) {
  const key = deviceKey(device);
  if (!key) return null;
  return safeJoin(configRoot(), key + '.json');
}

function readSnapshots(file) {
  if (!file || !fs.existsSync(file)) return [];
  try {
    const arr = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}

/**
 * Save a device's running-config for this run. The config is secret-scrubbed
 * BEFORE it is written — the raw value never touches disk. Returns the stored
 * snapshot { ts, config } (config already scrubbed) or null on refuse/failure.
 * @param {string} device            device id or hostname
 * @param {string} runningConfigText the real running-config text
 * @param {string} [ts]              ISO timestamp; defaults to now
 */
function snapshot(device, runningConfigText, ts) {
  const file = fileForDevice(device);
  if (!file) return null;
  const config = scrubConfig(runningConfigText);
  const entry = { ts: ts || new Date().toISOString(), config };

  const history = readSnapshots(file);
  history.push(entry);
  const trimmed = history.length > MAX_SNAPSHOTS ? history.slice(history.length - MAX_SNAPSHOTS) : history;

  try {
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(trimmed, null, 2));
    return entry;
  } catch (e) {
    return null;
  }
}

// ── Line diff (LCS) → unified hunks + a plain-words summary ────────────────────
function lcsDiff(aLines, bLines) {
  const n = aLines.length, m = bLines.length;
  // DP table of LCS lengths. Configs are small (hundreds of lines) so this is fine.
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = aLines[i] === bLines[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  // Backtrack into an ordered op list: ' ' equal, '-' removed, '+' added.
  const ops = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (aLines[i] === bLines[j]) { ops.push({ t: ' ', line: aLines[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ t: '-', line: aLines[i] }); i++; }
    else { ops.push({ t: '+', line: bLines[j] }); j++; }
  }
  while (i < n) { ops.push({ t: '-', line: aLines[i] }); i++; }
  while (j < m) { ops.push({ t: '+', line: bLines[j] }); j++; }
  return ops;
}

// Build a compact unified-diff-style string with a little context around changes.
function toUnified(ops, context = 3) {
  const changedIdx = ops.map((o, k) => (o.t !== ' ' ? k : -1)).filter((k) => k >= 0);
  if (!changedIdx.length) return '';
  const keep = new Set();
  for (const k of changedIdx) {
    for (let c = k - context; c <= k + context; c++) if (c >= 0 && c < ops.length) keep.add(c);
  }
  const lines = [];
  let prev = -2;
  for (let k = 0; k < ops.length; k++) {
    if (!keep.has(k)) continue;
    if (k !== prev + 1 && lines.length) lines.push('@@');
    lines.push((ops[k].t === ' ' ? ' ' : ops[k].t) + ops[k].line);
    prev = k;
  }
  return lines.join('\n');
}

/**
 * Compare a fresh running-config to the device's LAST stored snapshot.
 * Does NOT record — call snapshot() separately (intended order: diff first to
 * measure against the previous run, then snapshot to save the new one).
 *
 * @returns one of:
 *   { changed:false, firstSnapshot:true }                    — nothing stored yet
 *   { changed:false, when }                                  — identical to last
 *   { changed:true, when, summary, unified, added, removed } — a real change
 * `when` is the timestamp of the snapshot it compared against.
 */
function diff(device, newConfigText) {
  const file = fileForDevice(device);
  if (!file) return { changed: false, firstSnapshot: true, refused: true };

  const history = readSnapshots(file);
  if (!history.length) return { changed: false, firstSnapshot: true };

  const last = history[history.length - 1];
  const oldConfig = String(last.config || '');
  // Scrub the new config the SAME way the stored one was, so redactions line up
  // and only a REAL change (not a scrub difference) shows as changed.
  const newConfig = scrubConfig(newConfigText);

  if (oldConfig === newConfig) {
    return { changed: false, when: last.ts || null };
  }

  const ops = lcsDiff(oldConfig.split('\n'), newConfig.split('\n'));
  const added = ops.filter((o) => o.t === '+').length;
  const removed = ops.filter((o) => o.t === '-').length;
  const unified = toUnified(ops);
  const summary = `config changed since ${last.ts || 'last snapshot'}: `
    + `${added} line${added === 1 ? '' : 's'} added, ${removed} removed`;

  return { changed: true, when: last.ts || null, summary, unified, added, removed };
}

/**
 * The most recent stored snapshot for a device, or null. { ts, config } with
 * config already scrubbed. Handy for the UI / re-triage diff.
 */
function latest(device) {
  const file = fileForDevice(device);
  if (!file) return null;
  const history = readSnapshots(file);
  if (!history.length) return null;
  return history[history.length - 1];
}

module.exports = {
  snapshot,
  diff,
  latest,
  // exported for tests / reuse
  scrubConfig,
  deviceKey,
  configRoot,
};
