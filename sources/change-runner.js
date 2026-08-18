// change-runner.js — THE ONLY path in this system that can write to a device.
//
// Plain words: a change never "just happens". It is wrapped in six steps, in
// this order, and if any step cannot run the change does not happen and the
// record says exactly why:
//
//   1. GATE          — the permission gate (sources/approvals.js). Deny means
//                      ZERO wire calls: every step below runs INSIDE the gate's
//                      executor, so a denial cannot even read the device.
//   2. PRE-CAPTURE   — the device's real running-config, before anything.
//   3. APPLY         — the config push, through the real write transport.
//                      Where no write transport exists for a device, this step
//                      says exactly that and the change FREEZES. It is never
//                      simulated, and "failed to write" is never dressed up as
//                      "applied".
//   4. POST-CAPTURE  — the device's real running-config, after.
//   5. DIFF + VALIDATION — pre vs post, plus a health read (is the device still
//                      reachable, did new issues appear), written down as a
//                      verdict.
//   6. ROLLBACK ARTIFACT — the exact commands that put the pre-state back,
//                      derived from the real diff and stored with the record.
//                      POST /api/copilot/change/:id/rollback replays them
//                      through THIS SAME function, gate included.
//
// WHY THE ORDER MATTERS: post-capture, diff and validation run even when the
// apply step froze. That is not busywork — an empty diff after a refused apply
// is the PROOF that the device was left untouched, and proof beats assurance.
//
// One choke point, like the CLI read path: every caller (HTTP route, chat
// proposal, rollback) comes through run(). The gate, the audit, the scrubbing
// and the honest statuses live here, not in the callers.

const catalyst = require('./catalyst-center');
const sshRunner = require('./ssh-runner');
const approvals = require('./approvals');
const configStore = require('./config-store');
const changeStore = require('./change-store');
const session = require('./session-log');

// ── Which device, and can we write to it? ───────────────────────────────────
// The device registry (ssh-runner.REGISTRY) already declares HOW each device is
// reached. The live Catalyst Center inventory is the source of truth for what
// actually exists. Resolution asks both, and never guesses: an unknown name is
// an honest error, never "the first reachable box".
async function resolveDevice(name) {
  const wanted = String(name || '').trim();
  if (!wanted) return { error: 'No device named — I will not pick one for you.' };
  let devices;
  try {
    devices = await catalyst.getDevices();
  } catch (e) {
    return { error: `Could not read the device inventory from ${catalyst.label} — ${e.message}. I will not act on a device I cannot confirm exists.` };
  }
  const lower = wanted.toLowerCase();
  const hit = devices.find((d) =>
    String(d.hostname || '').toLowerCase() === lower ||
    String(d.hostname || '').toLowerCase().split('.')[0] === lower ||
    String(d.ip || '') === wanted ||
    String(d.id || '') === wanted);
  if (!hit) {
    return { error: `"${wanted}" is not in the live inventory (${devices.map((d) => d.hostname).join(', ')}). I ran nothing.` };
  }
  const registry = sshRunner.getDevice(String(hit.hostname || '').toLowerCase().split('.')[0]) || null;
  return {
    device: {
      id: hit.id,
      hostname: hit.hostname,
      ip: hit.ip,
      platform: hit.platform,
      reachability: hit.reachability,
      transport: registry ? registry.transport : 'command-runner',
    },
  };
}

// ── Rollback artifact ───────────────────────────────────────────────────────
// Derived from the REAL diff, not from the commands we asked for: what has to be
// undone is what actually changed on the box. An added line is removed with the
// IOS "no" form; a removed line is put back verbatim. Lines inside a sub-mode
// keep their parent line, so the rollback is applied in the right context.
function rollbackFromDiff(diff) {
  if (!diff || !diff.changed || !diff.lines || !diff.lines.length) {
    return { commands: [], basis: 'the diff is empty — nothing changed on the device, so there is nothing to roll back' };
  }
  const commands = [];
  for (const l of diff.lines) {
    const line = String(l.line);
    if (!line.trim()) continue;
    if (l.change === 'added') {
      const indent = line.match(/^\s*/)[0];
      commands.push(`${indent}no ${line.trim()}`);
    } else {
      commands.push(line);
    }
  }
  return {
    commands,
    basis: 'derived from the real pre/post diff — added lines get their "no" form, removed lines go back verbatim',
  };
}

// ── Validation ──────────────────────────────────────────────────────────────
// A health read, written down as a verdict. Never "looks fine": either the
// device answered and we say what it said, or we say we could not check.
async function validate(device, issuesBefore) {
  const out = { reachable: null, newCriticals: null, verdict: 'unverified', detail: '' };
  try {
    const devices = await catalyst.getDevices();
    const now = devices.find((d) => d.id === device.id);
    out.reachable = now ? now.reachability === 'Reachable' : null;
    const issues = await catalyst.getIssues().catch(() => null);
    if (issues) {
      const mine = issues.filter((i) => i.deviceId === device.id);
      const criticals = mine.filter((i) => String(i.priority || '').toUpperCase() === 'P1').length;
      out.newCriticals = issuesBefore == null ? null : criticals - issuesBefore;
    }
    if (out.reachable === true && (out.newCriticals == null || out.newCriticals <= 0)) {
      out.verdict = 'pass';
      out.detail = `${device.hostname} is still reachable` +
        (out.newCriticals == null ? '; the issue list could not be compared, so no claim is made about new criticals.'
          : ` and no new P1 issue appeared for it.`);
    } else if (out.reachable === false) {
      out.verdict = 'fail';
      out.detail = `${device.hostname} is NOT reachable after this step.`;
    } else if (out.newCriticals != null && out.newCriticals > 0) {
      out.verdict = 'fail';
      out.detail = `${out.newCriticals} new P1 issue(s) appeared for ${device.hostname} after this step.`;
    } else {
      out.detail = 'The health read did not come back cleanly, so I am not claiming this validated.';
    }
  } catch (e) {
    out.detail = `Health read failed — ${e.message}. Not claiming this validated.`;
  }
  return out;
}

// Which devices have a wrap running right now: device key → change id. See the
// "one change per device at a time" note inside run().
const inFlight = new Map();

async function countCriticals(deviceId) {
  try {
    const issues = await catalyst.getIssues();
    return issues.filter((i) => i.deviceId === deviceId && String(i.priority || '').toUpperCase() === 'P1').length;
  } catch (e) {
    return null;
  }
}

// ── The wrap ────────────────────────────────────────────────────────────────
/**
 * Run a change end to end. Returns the final change record (always — even when
 * the change was denied or frozen; there is no path that leaves no record).
 *
 * @param {{device:string, commands:string[], reason:string, who:string,
 *          rollbackOf?:string}} input
 */
async function run(input, { onCreated } = {}) {
  const who = String(input.who || 'unknown');
  // Trailing whitespace goes; LEADING whitespace stays. Indentation is what puts
  // a line inside an interface/router sub-mode on IOS — trimming it would send
  // a different configuration than the one the operator wrote and approved.
  const commands = (input.commands || [])
    .map((c) => String(c).replace(/\s+$/, ''))
    .filter((c) => c.trim());
  const rec = changeStore.create({
    device: String(input.device || ''),
    commands,
    reason: String(input.reason || ''),
    who,
    rollbackOf: input.rollbackOf || null,
  });
  const id = rec.id;
  const deviceKey = String(input.device || '').trim().toLowerCase();
  // The record exists BEFORE anything runs, and the caller is handed it
  // synchronously — so the HTTP route can answer "here is your change id, watch
  // it" while the wrap takes its real minutes on the wire.
  if (typeof onCreated === 'function') { try { onCreated(rec); } catch (e) { /* never break a change */ } }

  if (!commands.length) {
    changeStore.step(id, 'gate', 'failed', 'no commands given');
    return changeStore.status(id, 'failed', { by: who, note: 'No commands given — there was no change to make.' });
  }

  // ── ONE CHANGE PER DEVICE AT A TIME ───────────────────────────────────────
  // Two wraps overlapping on one box would each photograph the other's work:
  // change A's "after" picture would contain change B's lines, and the diff
  // would credit A with something A never did. A diff that misattributes is a
  // fabricated finding, so the second change is refused up front rather than
  // producing one.
  const busyWith = inFlight.get(deviceKey);
  if (busyWith) {
    changeStore.step(id, 'gate', 'failed', `${input.device} is already mid-change (${busyWith})`);
    return changeStore.status(id, 'failed', { by: who,
      note: `${input.device} is already in the middle of change ${busyWith}. I will not run two changes on one device at once — the before/after pictures would cross and the diff would credit the wrong change. Nothing was sent.` });
  }
  inFlight.set(deviceKey, id);
  try {
    return await wrapped();
  } finally {
    inFlight.delete(deviceKey);
  }

  async function wrapped() {

    // ── STEP 1: THE GATE ──────────────────────────────────────────────────────
    // Everything that touches the wire lives inside the executor below, so a
    // denial makes ZERO wire calls — not even the pre-capture read.
    const gateResult = await approvals.gate({
      agentId: 'change-runner',
      agentName: 'Change engine',
      command: `CHANGE on ${input.device}: ${commands.join(' / ')}`,
      target: `${input.device} — configuration change (full wrap: pre-capture, apply, post-capture, diff, validation, rollback plan)`,
      reason: `${who} asked for this change. Reason given: ${input.reason || '(none given)'}`,
      // NOTE: no `cli` field. That field is the gate's read-only re-check for the
      // READ transport; a change is not a read, and this engine — not the gate —
      // is the sanctioned write path. The gate's job here is the human decision.
    }, async () => {
      changeStore.status(id, 'approved', { by: who, note: 'permission gate approved — the wrap starts' });
      changeStore.step(id, 'gate', 'ok', 'approved');

      const resolved = await resolveDevice(input.device);
      if (resolved.error) {
        changeStore.step(id, 'resolve', 'failed', resolved.error);
        return { frozen: true, at: 'resolve', reason: resolved.error };
      }
      const device = resolved.device;
      changeStore.patch(id, { deviceLabel: `${device.hostname} (${device.ip}, ${device.platform})` });
      changeStore.step(id, 'resolve', 'ok', `${device.hostname} — ${device.ip} — transport ${device.transport}`);

      // ── STEP 2: PRE-CAPTURE ────────────────────────────────────────────────
      const pre = await catalyst.getRunningConfig(device.id);
      if (!pre.ok) {
        const why = `Pre-change capture failed — ${pre.error || 'no config came back'}. ` +
          `I will not change a device I could not photograph first, so nothing was sent.`;
        changeStore.step(id, 'pre-capture', 'failed', why);
        return { frozen: true, at: 'pre-capture', reason: why };
      }
      const preConfig = configStore.scrubConfig(pre.text);
      changeStore.patch(id, { pre: { ts: new Date().toISOString(), config: preConfig } });
      changeStore.step(id, 'pre-capture', 'ok', `${preConfig.split('\n').length} lines captured from ${device.hostname}`);

      const criticalsBefore = await countCriticals(device.id);

      // ── STEP 3: APPLY ──────────────────────────────────────────────────────
      let apply;
      if (device.transport === 'command-runner') {
        apply = await catalyst.pushConfig({ deviceIp: device.ip, commands, label: `change ${id}` });
      } else {
        // The SSH runner (PR #40) is a READ path today; wiring writes through it
        // is CW-5. Saying so is the honest answer — not a simulated push.
        apply = { ok: false, noWritePath: true,
          reason: `${device.hostname} is reached over SSH, and the SSH path is read-only until CW-5 wires writes through it. There is no write path to this device yet.` };
      }
      changeStore.patch(id, { applyAttempt: { ok: !!apply.ok, reason: apply.reason || null, steps: apply.steps || [] } });
      if (apply.ok) {
        changeStore.step(id, 'apply', 'ok', apply.detail || 'configuration pushed');
      } else if (apply.noWritePath) {
        changeStore.step(id, 'apply', 'no-write-path', apply.reason);
      } else {
        changeStore.step(id, 'apply', 'failed', apply.reason);
      }

      // ── STEP 4: POST-CAPTURE ───────────────────────────────────────────────
      // Runs even when the apply froze. An empty diff is then the PROOF that the
      // device was left exactly as it was — the honest record, not an assurance.
      const post = await catalyst.getRunningConfig(device.id);
      if (!post.ok) {
        const why = `Post-change capture failed — ${post.error || 'no config came back'}. ` +
          (apply.ok
            ? `The push reported success but I cannot prove what is on the box now, so this change is FROZEN as unverified, not applied.`
            : `Nothing was applied, and I could not re-read the device to prove that either.`);
        changeStore.step(id, 'post-capture', 'failed', why);
        return { frozen: true, at: 'post-capture', reason: why, applied: !!apply.ok };
      }
      const postConfig = configStore.scrubConfig(post.text);
      changeStore.patch(id, { post: { ts: new Date().toISOString(), config: postConfig } });
      changeStore.step(id, 'post-capture', 'ok', `${postConfig.split('\n').length} lines captured from ${device.hostname}`);

      // ── STEP 5: DIFF + VALIDATION ──────────────────────────────────────────
      const diff = configStore.diffTexts(preConfig, postConfig);
      changeStore.patch(id, { diff });
      changeStore.step(id, 'diff', 'ok',
        diff.changed
          ? `${diff.added} line(s) added, ${diff.removed} removed`
          : 'no difference between the before and after captures — the device is byte-for-byte as it was');

      const validation = await validate(device, criticalsBefore);
      changeStore.patch(id, { validation });
      changeStore.step(id, 'validation', validation.verdict === 'pass' ? 'ok' : validation.verdict === 'fail' ? 'failed' : 'unverified', validation.detail);

      // ── STEP 6: ROLLBACK ARTIFACT ──────────────────────────────────────────
      const rollback = rollbackFromDiff(diff);
      changeStore.patch(id, { rollback });
      changeStore.step(id, 'rollback-artifact', 'ok',
        rollback.commands.length ? `${rollback.commands.length} command(s) recorded to restore the pre-state` : rollback.basis);

      if (!apply.ok) {
        return { frozen: true, at: 'apply', reason: apply.reason, noWritePath: !!apply.noWritePath, proofUnchanged: !diff.changed };
      }
      return { applied: true, changed: diff.changed, validation, detail: `change ${id} applied to ${device.hostname}` };
    });

    // ── The gate said no ──────────────────────────────────────────────────────
    if (gateResult.denied) {
      changeStore.patch(id, { approval: gateResult.record || null });
      changeStore.step(id, 'gate', 'denied', 'the operator denied this change — zero wire calls were made');
      return changeStore.status(id, 'denied', { by: who,
        note: 'Denied at the permission gate. Nothing was read, nothing was sent — zero wire calls.' });
    }

    changeStore.patch(id, { approval: gateResult.record || null });
    const r = gateResult.result || {};

    if (r.frozen) {
      changeStore.patch(id, { frozenAt: r.at, frozenReason: r.reason });
      return changeStore.status(id, 'failed', { by: who,
        note: `FROZEN at the ${r.at} step — ${r.reason}` +
          (r.proofUnchanged ? ' The post-capture matches the pre-capture exactly, which proves the device was left untouched.' : '') });
    }

    const finished = changeStore.status(id, 'applied', { by: who,
      note: r.changed
        ? `Applied and verified by diff (validation: ${r.validation ? r.validation.verdict : 'unverified'}).`
        : `The push reported success but the before/after captures are identical — recorded honestly, no change is claimed.` });

    // If this run was a rollback, mark the change it undid.
    if (input.rollbackOf) {
      changeStore.status(input.rollbackOf, 'rolled-back', { by: who, note: `rolled back by change ${id}` });
    }
    return finished;
  }
}

/**
 * Replay a change's rollback artifact through the SAME wrap (gate included).
 * A rollback is a change: it gets its own record, its own approval, its own
 * before/after proof. There is no privileged "undo" path.
 */
async function rollback(id, who, { onCreated } = {}) {
  const original = changeStore.get(id);
  if (!original) return { error: `No change record with id "${id}".` };
  if (!original.rollback || !original.rollback.commands || !original.rollback.commands.length) {
    return { error: `Change ${id} has no rollback commands — ${original.rollback ? original.rollback.basis : 'the wrap never got as far as building one'}. There is nothing to replay.` };
  }
  session.audit({ who, what: `rollback requested for change ${id}`, device: original.device, result: 'starting the same wrap' });
  return run({
    device: original.device,
    commands: original.rollback.commands,
    reason: `Rollback of change ${id} (originally by ${original.who}: ${original.reason})`,
    who,
    rollbackOf: id,
  }, { onCreated });
}

// ── Drift: live config vs the stored baseline ───────────────────────────────
/**
 * GET /api/copilot/drift/:device answers from here.
 *   verdict 'no-baseline' — nothing stored yet. An honest STATE, not an error.
 *   verdict 'unreadable'  — the device could not be read right now.
 *   verdict 'clean'       — live matches the baseline exactly.
 *   verdict 'drifted'     — every differing line, and where known, the change
 *                           record that explains it.
 */
async function drift(name) {
  const resolved = await resolveDevice(name);
  if (resolved.error) return { error: resolved.error };
  const device = resolved.device;

  const baseline = configStore.latest(device.hostname);
  const live = await catalyst.getRunningConfig(device.id);
  if (!live.ok) {
    return {
      device: device.hostname, baselineTs: baseline ? baseline.ts : null,
      verdict: 'unreadable', driftLines: [],
      detail: `Could not read ${device.hostname} right now — ${live.error}. I am not going to call it clean on a read that never happened.`,
    };
  }
  const liveConfig = configStore.scrubConfig(live.text);

  if (!baseline) {
    return {
      device: device.hostname, baselineTs: null, verdict: 'no-baseline', driftLines: [],
      detail: `No baseline is stored for ${device.hostname} yet, so there is nothing to compare against. ` +
        `Re-baseline it and I will have a reference from then on.`,
      liveLines: liveConfig.split('\n').length,
    };
  }

  const d = configStore.diffTexts(baseline.config, liveConfig);
  const changes = changeStore.list({}).filter((c) => {
    const dev = String(c.deviceLabel || c.device || '').toLowerCase();
    return dev.includes(String(device.hostname).toLowerCase());
  });

  // "Explained by" — a drift line is explained when a change record's own diff
  // contains that same line with the same sign. Exact-line matching only: a
  // fuzzy match would let a change take credit for drift it did not cause.
  const explain = (entry) => {
    for (let i = changes.length - 1; i >= 0; i--) {
      const c = changes[i];
      const lines = (c.diff && c.diff.lines) || [];
      if (lines.some((l) => l.change === entry.change && String(l.line).trim() === String(entry.line).trim())) {
        return { id: c.id, who: c.who, ts: c.ts, reason: c.reason };
      }
    }
    return null;
  };

  const driftLines = d.lines.map((l) => {
    const by = explain(l);
    return by ? { ...l, explainedBy: by } : { ...l };
  });
  const explained = driftLines.filter((l) => l.explainedBy).length;

  return {
    device: device.hostname,
    baselineTs: baseline.ts,
    verdict: d.changed ? 'drifted' : 'clean',
    driftLines,
    unified: d.unified,
    added: d.added,
    removed: d.removed,
    explainedCount: explained,
    detail: d.changed
      ? `${device.hostname} has drifted from its baseline of ${baseline.ts}: ${d.added} line(s) added, ${d.removed} removed` +
        (explained ? `, ${explained} of them explained by a recorded change.` : `, none of them explained by any change this system made.`)
      : `${device.hostname} matches its baseline of ${baseline.ts} exactly — no drift.`,
  };
}

/** Re-baseline: store the live config as the new reference. Operator-named. */
async function rebaseline(name, who) {
  const resolved = await resolveDevice(name);
  if (resolved.error) return { error: resolved.error };
  const device = resolved.device;
  const live = await catalyst.getRunningConfig(device.id);
  if (!live.ok) {
    session.audit({ who, what: `re-baseline ${device.hostname}`, device: device.hostname, result: `failed — ${live.error}` });
    return { error: `Could not read ${device.hostname} — ${live.error}. The baseline is unchanged; I will not store a config I did not read.` };
  }
  const entry = configStore.snapshot(device.hostname, live.text);
  if (!entry) {
    session.audit({ who, what: `re-baseline ${device.hostname}`, device: device.hostname, result: 'failed — could not write the snapshot' });
    return { error: `Read ${device.hostname} fine, but the snapshot could not be written. The baseline is unchanged.` };
  }
  session.audit({ who, what: `re-baseline ${device.hostname}`, device: device.hostname, result: `new baseline stored at ${entry.ts}` });
  return { device: device.hostname, baselineTs: entry.ts, lines: String(entry.config).split('\n').length, by: who };
}

module.exports = { run, rollback, drift, rebaseline, resolveDevice, rollbackFromDiff };
