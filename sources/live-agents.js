// Live agent answers — every line of network data below comes from a real
// Cisco DevNet always-on sandbox. Nothing here invents a device, a number or a
// status. If a sandbox cannot be reached the agent says so and stops.
//
// Backends in play:
//   Catalyst Center (sandboxdnac.cisco.com)   — campus switches, health, issues
//   ACI / APIC       (sandboxapicdc.cisco.com) — Nexus fabric, tenants, faults
//   SD-WAN vManage   (sandbox-sdwan-2.cisco.com) — overlay routers, alarms
//
// Agents with no backend say "not connected" — they never fall back to canned
// reports.
const catalyst = require('./catalyst-center');
const aci = require('./aci');
const sdwan = require('./sdwan');
const session = require('./session-log');
const approvals = require('./approvals');
const { checkCommand, checkIntent, commandWord, READ_VERBS } = require('./guardrails');

// The host app injects its broadcast/status/task-board plumbing here so this
// module stays free of server internals.
let ctx = null;
function init(hostCtx) { ctx = hostCtx; }

const say = (agentId, text) => ctx.say(agentId, text);
const RULE = '──────────────────────────────────';

// Agents that have no sandbox behind them. Honest answer, every time.
const NO_BACKEND = {
  'sentinel': 'CVE / threat-feed source (Cisco Umbrella or Talos)',
  'firewall-pro': 'firewall source (Cisco Secure Firewall / FMC)',
  'loadbal-pro': 'load-balancer source (F5 — no Cisco DevNet equivalent)',
};

function notConnected(agentId) {
  const need = NO_BACKEND[agentId] || 'a live data source';
  say(agentId,
    `🔌 Not connected — needs sandbox credentials.\n${RULE}\n` +
    `I have no ${need} wired up, so I have nothing real to report.\n` +
    `I will not make up a report. Add the credentials to .env.local and I will answer for real.`);
  ctx.updateAgentStatus(agentId, 'idle', 'Not connected — no data source');
}

// Every live answer runs through here: task board in, honest failure out.
// gateMeta (optional) enriches the permission record for this read — the real
// CLI command, the target, and why. Every read passes the permission gate: in
// auto mode it auto-approves (and is logged); in ask mode it PAUSES until the
// operator decides. A denied read never touches the wire and is reported honestly.
async function runLive(agentId, taskTitle, busyLabel, worker, gateMeta, shareOpts) {
  const agent = ctx.agents[agentId];
  ctx.updateAgentStatus(agentId, 'active', busyLabel);
  const meta = Object.assign({
    agentId, agentName: agent.name,
    command: taskTitle, target: busyLabel, reason: taskTitle,
  }, gateMeta || {});
  // A direct read is a real check too — screen-share it into the chat as a
  // command_share (exact call · raw output · reasoning · conclusion), the SAME
  // way a Jarvis delegation does. Callers that emit their own clean single block
  // (e.g. Config-Keeper's "show version") opt out with shareOpts === false.
  const shareCtx = shareOpts === false ? {} : {
    share: true, tier: null,
    purpose: (shareOpts && shareOpts.purpose) || taskTitle,
    reasoning: (shareOpts && shareOpts.reasoning) || `${agent.name} ran a live read to answer directly.`,
  };
  try {
    // Inside the try: a task-board problem must not abort the live read, and
    // must not escape as an unhandled rejection.
    ctx.addTaskToBoard('inProgress', { title: taskTitle, agent: agent.name });
    // The permission gate wraps the actual work. The worker (and every wire call
    // inside it) runs ONLY if the read is approved — so a denial makes no wire call.
    const g = await approvals.gate(meta, () =>
      // Tag every wire call this worker makes with the agent + task, so the
      // CLI/session view can show "who logged into what and ran which command".
      session.runWithContext(Object.assign({ agentId, agentName: agent.name, label: taskTitle }, shareCtx), worker));

    if (g.denied) {
      say(agentId,
        `🛑 Read denied by the operator — ran nothing.\n${RULE}\n` +
        `The command "${escapeForSay(meta.command)}" was not approved, so I sent nothing to any device ` +
        `and I am not going to invent a result. Approve it in the approval panel and ask again to run it for real.`);
      ctx.appendToActivityLog(`[${new Date().toISOString()}] [${agent.name}] ${taskTitle} DENIED by operator — ran nothing\n`);
      ctx.updateAgentStatus(agentId, 'idle', 'Read denied — ran nothing');
    } else {
      ctx.updateAgentStatus(agentId, 'idle', `${taskTitle} complete (live data)`);
    }
  } catch (err) {
    say(agentId,
      `⚠️ Source unreachable.\n${RULE}\n${err.message}\n\n` +
      `No data to show. I am not going to guess what the network looks like.`);
    ctx.appendToActivityLog(`[${new Date().toISOString()}] [${agent.name}] ${taskTitle} FAILED — ${err.message}\n`);
    ctx.updateAgentStatus(agentId, 'idle', 'Source unreachable');
  }
  try {
    ctx.moveTaskOnBoard(taskTitle, 'inProgress', 'done');
  } catch (err) {
    console.error('[live] Could not tidy the task board:', err.message);
  }
}

// A tiny guard so a command label can be dropped into a chat line safely.
function escapeForSay(s) { return String(s == null ? '' : s).slice(0, 200); }

const pad = (s, n) => String(s == null ? '' : s).padEnd(n);

// ── NetOps — real campus inventory from Catalyst Center ──────────────────────
async function netops(agentId, command) {
  await runLive(agentId, 'Device health check', 'Querying Catalyst Center', async () => {
    say(agentId, `🌐 Connecting to Cisco Catalyst Center — ${catalyst.host} (read-only)...`);
    const devices = await catalyst.getDevices();
    const health = await catalyst.getHealth().catch(() => null);

    const rows = devices.map((d) =>
      `${pad(d.hostname, 10)} ${pad(d.ip, 16)} ${pad(d.platform, 16)} ${pad(d.reachability, 12)} ${d.software || ''}`);

    say(agentId,
      `📡 Live inventory — ${devices.length} device(s)\n${RULE}\n` +
      `${pad('HOST', 10)} ${pad('MGMT IP', 16)} ${pad('PLATFORM', 16)} ${pad('REACHABLE', 12)} VERSION\n` +
      (rows.join('\n') || 'no devices returned'));

    const down = devices.filter((d) => d.reachability !== 'Reachable');
    say(agentId,
      `✅ Health check complete\n${RULE}\n` +
      `🟢 Reachable: ${devices.length - down.length}/${devices.length}\n` +
      (down.length ? `🔴 Not reachable: ${down.map((d) => d.hostname).join(', ')}\n` : '') +
      (health ? `📊 Fabric health score: ${health.score} (good ${health.good} / bad ${health.bad})\n` : '') +
      `\nSource: ${catalyst.label} — ${catalyst.host}. Read-only.`);
  });
}

// ── Monitor-Eye — real health + issues + SD-WAN alarm counts ─────────────────
async function monitorEye(agentId) {
  await runLive(agentId, 'Alert sweep', 'Pulling live alerts', async () => {
    say(agentId, `👁️ Pulling live alerts from ${catalyst.host} and ${sdwan.host || 'vManage (not configured)'}...`);

    const health = await catalyst.getHealth();
    const issues = await catalyst.getIssues();
    say(agentId,
      `📊 Catalyst Center — network health\n${RULE}\n` +
      `Overall score: ${health.score}\nDevices monitored: ${health.total}\n` +
      `🟢 Good: ${health.good}   🔴 Bad: ${health.bad}   ⚫ Unmonitored: ${health.unmonitored ?? 0}\n` +
      `Open issues: ${issues.length}` +
      (issues.length ? '\n' + issues.slice(0, 6).map((i) => `  ${i.priority} · ${i.name} (${i.status})`).join('\n') : ''));

    // vManage lives on its own credentials — report it separately so one dead
    // source cannot take the whole answer down.
    try {
      const alarms = await sdwan.getAlarmCount();
      say(agentId, `🚨 SD-WAN (vManage ${sdwan.host}) — active alarms: ${alarms.active}, cleared: ${alarms.raw?.cleared_count ?? 'n/a'}`);
    } catch (e) {
      say(agentId, `⚠️ SD-WAN alarm feed unreachable — ${e.message}. Catalyst Center figures above are still live.`);
    }

    say(agentId, `✅ Alert sweep complete. All figures read live — no thresholds simulated.`);
  });
}

// ── Incident-Handler — real open issues + real ACI faults ────────────────────
async function incidentHandler(agentId) {
  await runLive(agentId, 'Incident triage', 'Triaging live issues', async () => {
    say(agentId, `🚨 Checking real incidents across Catalyst Center and the ACI fabric...`);

    const issues = await catalyst.getIssues();
    say(agentId,
      `📋 Catalyst Center open issues: ${issues.length}\n${RULE}\n` +
      (issues.length
        ? issues.slice(0, 8).map((i) => `${i.priority} · ${i.name}\n   category ${i.category} · seen ${i.occurrences}x · ${i.status}`).join('\n')
        : 'No open issues reported by Catalyst Center right now.'));

    try {
      const faults = await aci.getFaults(['critical', 'major']);
      const crit = faults.filter((f) => f.severity === 'critical');
      say(agentId,
        `🔥 ACI fabric faults (${aci.host}) — ${crit.length} critical, ${faults.length - crit.length} major\n${RULE}\n` +
        (faults.length
          ? faults.slice(0, 6).map((f) =>
              `[${f.severity}] F${f.code} · ${f.tenant === 'unknown' ? 'fabric-level' : 'tenant ' + f.tenant}` +
              `\n   ${String(f.description || '').slice(0, 120)}`).join('\n')
          : 'No critical or major faults.'));
    } catch (e) {
      say(agentId, `⚠️ ACI fault feed unreachable — ${e.message}. Catalyst Center figures above are still live.`);
    }

    say(agentId, `✅ Triage complete — every item above is a real fault or issue read from the sandbox.`);
  });
}

// ── Doc-Writer — writes a real inventory document from live data ─────────────
async function docWriter(agentId) {
  await runLive(agentId, 'Network inventory document', 'Writing live inventory doc', async () => {
    say(agentId, `📝 Building a network inventory document from live sources...`);

    const lines = [`# Network Inventory (live)`, ``, `Generated: ${new Date().toISOString()}`, ``];
    let anySource = false;

    try {
      const devices = await catalyst.getDevices();
      anySource = true;
      lines.push(`## Campus — ${catalyst.label} (${catalyst.host})`, ``,
        `| Host | Mgmt IP | Platform | Role | Software | Reachability |`,
        `|---|---|---|---|---|---|`,
        ...devices.map((d) => `| ${d.hostname} | ${d.ip} | ${d.platform} | ${d.role} | ${d.software} | ${d.reachability} |`), ``);
      say(agentId, `✓ Catalyst Center: ${devices.length} devices — ${devices.map((d) => d.hostname).join(', ')}`);
    } catch (e) {
      lines.push(`## Campus — Catalyst Center`, ``, `Source unreachable: ${e.message}`, ``);
      say(agentId, `⚠️ Catalyst Center unreachable — ${e.message}`);
    }

    try {
      const nodes = await aci.getFabricNodes();
      const tenants = await aci.getTenants();
      anySource = true;
      lines.push(`## Data centre — ${aci.label} (${aci.host})`, ``,
        `| Node | Model | Role | State | Version |`, `|---|---|---|---|---|`,
        ...nodes.map((n) => `| ${n.name} | ${n.model || '-'} | ${n.role} | ${n.state} | ${n.version || '-'} |`),
        ``, `Tenants: ${tenants.length} — ${tenants.map((t) => t.name).join(', ')}`, ``);
      say(agentId, `✓ ACI: ${nodes.length} fabric nodes — ${nodes.map((n) => n.name).join(', ')}; ${tenants.length} tenants`);
    } catch (e) {
      lines.push(`## Data centre — ACI`, ``, `Source unreachable: ${e.message}`, ``);
      say(agentId, `⚠️ ACI unreachable — ${e.message}`);
    }

    try {
      const devices = await sdwan.getDevices();
      anySource = true;
      lines.push(`## WAN — ${sdwan.label} (${sdwan.host})`, ``,
        `| Host | System IP | Type | State |`, `|---|---|---|---|`,
        ...devices.map((d) => `| ${d.hostname} | ${d.systemIp || '-'} | ${d.type} | ${d.state} |`), ``);
      say(agentId, `✓ SD-WAN: ${devices.length} devices — ${devices.map((d) => d.hostname).join(', ')}`);
    } catch (e) {
      lines.push(`## WAN — SD-WAN`, ``, `Source unreachable: ${e.message}`, ``);
      say(agentId, `⚠️ SD-WAN unreachable — ${e.message}`);
    }

    if (!anySource) throw new Error('every source was unreachable — nothing real to document');

    const file = ctx.writeReport(agentId, `network-inventory-${Date.now()}.md`, lines.join('\n'));
    say(agentId, `✅ Document written from live data.\n📁 ${file}\n\nEvery row above was read from a sandbox — nothing typed by hand.`);
  });
}

// ── Router-Expert — ACI fabric (Nexus) or SD-WAN overlay ────────────────────
const ACI_WORDS = /\b(aci|apic|fabric|tenant|epg|bridge[\s-]?domain|bd\b|vrf|contract|leaf|spine|nexus|n9k)\b/i;

async function routerExpert(agentId, command) {
  if (ACI_WORDS.test(command || '')) return routerExpertAci(agentId, command);
  return routerExpertSdwan(agentId);
}

async function routerExpertAci(agentId, command) {
  await runLive(agentId, 'ACI fabric check', 'Querying APIC', async () => {
    say(agentId, `🔀 Querying the ACI fabric — ${aci.host} (read-only)...`);

    const nodes = await aci.getFabricNodes();
    const health = await aci.getFabricHealth().catch(() => ({ score: null }));
    say(agentId,
      `📡 Fabric nodes — ${nodes.length}\n${RULE}\n` +
      `${pad('NODE', 10)} ${pad('MODEL', 16)} ${pad('ROLE', 12)} ${pad('STATE', 14)} VERSION\n` +
      nodes.map((n) => `${pad(n.name, 10)} ${pad(n.model || '-', 16)} ${pad(n.role, 12)} ${pad(n.state, 14)} ${n.version || '-'}`).join('\n') +
      (health.score != null
        ? `\n\n📊 Fabric health: ${health.score}${health.previous ? ` (previous reading ${health.previous})` : ''}`
        : ''));

    // If the question names a tenant, run the real read-only audit on it.
    const named = /tenant\s+([A-Za-z0-9_.:-]+)/i.exec(command || '');
    if (named) {
      const name = named[1];
      say(agentId, `🔎 Auditing tenant "${name}" — walking VRF → BD → EPG → contract for missing links...`);
      const audit = await aci.auditTenant(name);
      say(agentId,
        `📋 Tenant ${audit.tenant}\n${RULE}\n` +
        `VRFs ${audit.counts.vrfs} · BDs ${audit.counts.bridgeDomains} · App profiles ${audit.counts.appProfiles} · EPGs ${audit.counts.epgs} · Contracts ${audit.counts.contracts}\n\n` +
        (audit.findings.bdWithoutVrf.length ? `⚠️ Bridge domains with no VRF: ${audit.findings.bdWithoutVrf.join(', ')}\n` : '') +
        (audit.findings.epgWithoutBd.length ? `⚠️ EPGs with no bridge domain: ${audit.findings.epgWithoutBd.join(', ')}\n` : '') +
        (audit.findings.epgWithoutContract.length ? `⚠️ EPGs with no contract either way: ${audit.findings.epgWithoutContract.join(', ')}\n` : '') +
        (audit.faults.length ? `🔥 Faults: ${audit.faults.length}\n` : '') +
        (audit.clean ? '✅ Nothing incomplete found in this tenant.' : ''));
    } else {
      const tenants = await aci.getTenants();
      say(agentId, `🏢 Tenants — ${tenants.length}: ${tenants.map((t) => t.name).join(', ')}\n\nAsk me "audit tenant <name>" and I will walk its VRF/BD/EPG/contract links for real.`);
    }

    say(agentId, `✅ Read-only fabric check complete. Source: ${aci.label} — ${aci.host}.`);
  });
}

async function routerExpertSdwan(agentId) {
  await runLive(agentId, 'SD-WAN overlay check', 'Querying vManage', async () => {
    say(agentId, `🔀 Querying the SD-WAN overlay — vManage ${sdwan.host} (read-only)...`);

    const devices = await sdwan.getDevices();
    say(agentId,
      `📡 Overlay devices — ${devices.length}\n${RULE}\n` +
      `${pad('HOST', 14) } ${pad('SYSTEM IP', 16)} ${pad('TYPE', 10)} ${pad('STATE', 12)} MODEL\n` +
      devices.map((d) => `${pad(d.hostname, 14)} ${pad(d.systemIp || '-', 16)} ${pad(d.type, 10)} ${pad(d.state, 12)} ${d.model || '-'}`).join('\n'));

    const controllers = await sdwan.getControllers();
    const vedges = await sdwan.getVedges();
    const alarms = await sdwan.getAlarmCount().catch(() => ({ active: 'n/a' }));

    say(agentId,
      `✅ Overlay summary\n${RULE}\n` +
      `🎛  Controllers: ${controllers.length} — ${controllers.map((c) => c.hostname).join(', ')}\n` +
      `🛰  vEdges in inventory: ${vedges.length}\n` +
      `🚨 Active alarms: ${alarms.active}\n\n` +
      `Source: ${sdwan.label} — ${sdwan.host}. Read-only.\n` +
      `(Ask about ACI, fabric, leaf/spine or a tenant and I will switch to the APIC.)`);
  });
}

// ── THE CHOKE POINT — the ONE place a command reaches a device ───────────────
// Every route that can run CLI on a box (a direct Config-Keeper read, a Jarvis
// delegation, a debate contribution, any future caller) comes through here, and
// this function — not its callers — owns all four guarantees:
//
//   1. WRITE REFUSAL on the FULL RAW request. Judged on the operator's whole
//      sentence, never on an extracted fragment, so "show version on sw1;
//      reload" is refused OUT LOUD instead of having the reload quietly trimmed
//      away and the show run in its place (guardrails.js exists to stop exactly
//      that silent substitution).
//   2. READ-ONLY GUARDRAIL, run TWICE: once on the RAW matched fragment (before
//      any whitespace normalisation, so a "\n" or "|" separator still trips the
//      chaining check) and once on the canonicalised command.
//   3. THE NAMED DEVICE. The device the operator named is resolved against the
//      live inventory and the command runs on THAT box. An unknown name is
//      refused honestly — it NEVER silently falls back to the first reachable
//      device, because answering "sw3's running-config" with sw1's config is a
//      wrong answer wearing a right answer's clothes.
//   4. THE PERMISSION GATE, wrapped around the wire calls themselves. Putting it
//      here rather than in each caller is what makes "deny = zero wire calls"
//      true for every caller, including ones written after this line. Gates
//      nest re-entrantly (see approvals.js), so an outer caller that already
//      gated the same request does not prompt the operator twice.
//
// Returns a structured result; callers only render it.
//   { refused, kind, text }            — nothing ran (write intent / no command /
//                                        guardrail / unknown or unreachable device)
//   { denied: true, command }          — the operator denied it; zero wire calls
//   { ok, command, target, body, note} — it ran; body is the REAL device output
async function executeDeviceCli({ agentId, request, purpose, announce }) {
  const raw = String(request || '');
  const agentName = (ctx.agents[agentId] && ctx.agents[agentId].name) || agentId;

  // 1. Write intent, on the whole raw request.
  const intent = checkIntent(raw);
  if (intent.destructive) return { refused: true, kind: 'write', intent, command: null };

  // 2. Parse a read command out of the plain English.
  const read = readCommandFrom(raw);
  if (!read.command) return { refused: true, kind: 'no-command', note: read.note || null };

  // 2a. Guardrail on the RAW fragment first — chaining/redirection characters
  //     ("; & | > < ` $" and newlines) are still present at this point. The
  //     canonicalised string below has had its whitespace flattened, so a
  //     newline-separated second command would have been invisible to it.
  const rawVerdict = checkCommand(read.rawFragment || read.command);
  if (!rawVerdict.allowed) return { refused: true, kind: 'guardrail', reason: rawVerdict.reason };
  const verdict = checkCommand(read.command);
  if (!verdict.allowed) return { refused: true, kind: 'guardrail', reason: verdict.reason };

  // 3. Which box did the operator name? Parsed from the text alone (no wire
  //    call yet) so the approval record can name the target before anything runs.
  const named = namedDeviceIn(raw);

  if (announce) {
    say(agentId,
      `📋 You asked: "${raw.slice(0, 140)}"\n` +
      `I read that as the read-only command: "${verdict.command}" — guardrail passed.\n` +
      (named ? `Target named in your request: ${named}.\n` : `No device named in your request.\n`) +
      `Submitting to Catalyst Center Command Runner — ${catalyst.host}...`);
  }

  // 4. The gate wraps every wire call below: inventory read, command submit,
  //    task poll and output fetch. A denial runs none of them.
  const g = await approvals.gate({
    agentId, agentName,
    command: verdict.command,
    target: named
      ? `${named} (named in the request) via Catalyst Center Command Runner`
      : 'the first reachable Catalyst Center switch (no device named) via Command Runner',
    reason: purpose || `operator asked: "${raw.slice(0, 80)}"`,
    cli: verdict.command,
  }, async () => {
    const devices = await catalyst.getDevices();
    const pick = resolveTargetDevice(devices, named);
    if (pick.error) return { unknownDevice: pick.error, detail: pick.error };

    if (announce) {
      say(agentId, `🎯 Target: ${pick.target.hostname} (${pick.target.ip}, ${pick.target.platform})` +
        (pick.note ? ` — ${pick.note}` : '') +
        `. Sandbox Command Runner is slow — this can take up to a minute.`);
    }

    const file = await catalyst.runShowCommand([pick.target.id], verdict.command);
    const out = extractCommandOutput(file, verdict.command);
    // Scrub at the source: this string is about to become chat text, debate
    // text and a Jarvis finding. Anything credential-shaped in a device's own
    // output is redacted here, not at some later sink.
    const body = session.scrub(out ? String(out.text) : JSON.stringify(file)).slice(0, 2000);
    return {
      target: pick.target, note: pick.note || null, body,
      ok: !(out && out.ok === false),
      detail: `${verdict.command} on ${pick.target.hostname}`,
    };
  });

  if (g.denied) return { denied: true, command: verdict.command };
  const r = g.result || {};
  if (r.unknownDevice) return { refused: true, kind: 'unknown-device', reason: r.unknownDevice, command: verdict.command };
  return { ok: true, command: verdict.command, target: r.target, note: r.note, body: r.body, deviceOk: r.ok };
}

// Plain-words rendering of a choke-point result. Shared by every caller so the
// same refusal reads the same way in chat, in a debate and in a Jarvis finding.
function cliResultText(res, raw) {
  if (!res) return 'Nothing ran.';
  if (res.denied) {
    return `Read denied by the operator — ran nothing. The command "${res.command}" was not approved, ` +
      `so nothing was sent to any device and I will not invent a result.`;
  }
  if (res.refused) {
    if (res.kind === 'write') {
      return `Refused — that is a change, and I am read-only. What I refused: "${res.intent.keyword}"` +
        (res.intent.clause ? ` — in "${String(res.intent.clause).slice(0, 80)}"` : '') +
        `. Nothing was sent to any device, and I did NOT run something else in its place.`;
    }
    if (res.kind === 'guardrail') return `${res.reason} Nothing was sent to any device.`;
    if (res.kind === 'unknown-device') return res.reason;
    return (res.note ? `${res.note} ` : '') +
      `I could not find a read command in that, so I ran nothing — I will not answer a different ` +
      `question than the one you asked. I can run ${READ_VERBS.join(' / ')} against real kit.`;
  }
  return `Ran "${res.command}" live on ${res.target.hostname} (${res.target.ip}, ${res.target.platform}) ` +
    `via ${catalyst.label} Command Runner` + (res.note ? ` — ${res.note}` : '') + `:\n${res.body}\n` +
    (res.deviceOk === false
      ? `(The device rejected the command — real output above, nothing invented, no configuration sent.)`
      : `(Real output, read-only; no configuration was sent.)`);
}

// ── Which box did the operator name? ────────────────────────────────────────
// Only a DEVICE-POSITION phrase counts — "on sw2", "of sw3", "from 10.10.20.176"
// — because the address in "ping 10.10.20.48" is the ping TARGET, not the box
// the command runs on. A token must look like kit (an IPv4 address, or a name
// containing a digit: sw2, core-rtr1) so generic English ("on the switches",
// "on the box") is correctly read as "no device named".
const DEVICE_MENTION = /\b(?:on|of|from|against)\s+(?:the\s+)?(?:device\s+|switch\s+|router\s+|host\s+|box\s+)?((?:\d{1,3}(?:\.\d{1,3}){3})|[a-z][a-z0-9_-]*\d[a-z0-9._-]*)\b/ig;

function namedDeviceIn(text) {
  const raw = String(text || '');
  DEVICE_MENTION.lastIndex = 0;
  let m;
  const hits = [];
  while ((m = DEVICE_MENTION.exec(raw)) !== null) hits.push(m[1]);
  return hits.length ? hits[0] : null;
}

// Resolve the named device against the LIVE inventory. Honest on every miss:
// an unknown name is refused with the names that do exist, an unreachable box is
// refused as unreachable — never silently swapped for a different device.
// With nothing named, the first reachable device is used and SAYS so.
function resolveTargetDevice(devices, named) {
  const list = Array.isArray(devices) ? devices : [];
  if (named) {
    const want = String(named).toLowerCase();
    const match = list.find((d) => {
      const host = String(d.hostname || '').toLowerCase();
      return host === want || host.split('.')[0] === want || String(d.ip || '').toLowerCase() === want;
    });
    if (!match) {
      return { error:
        `There is no device called "${named}" in the live inventory, so I ran nothing. ` +
        `Catalyst Center (${catalyst.host}) currently knows: ` +
        `${list.map((d) => `${d.hostname} (${d.ip})`).join(', ') || 'no devices at all'}. ` +
        `I will not run your command on a different box and pass it off as the answer.` };
    }
    if (match.reachability !== 'Reachable') {
      return { error:
        `${match.hostname} (${match.ip}) is in the inventory but Catalyst Center reports it as ` +
        `"${match.reachability}", so I ran nothing. No output is better than another device's output.` };
    }
    return { target: match, note: `the device you named` };
  }
  const target = list.find((d) => d.reachability === 'Reachable');
  if (!target) throw new Error('no reachable device to read from');
  return { target, note: `you named no device, so I used the first reachable one` };
}

// ── Config-Keeper — real show output via Catalyst Center Command Runner ──────
// The direct chat path. All the safety lives in executeDeviceCli above; this
// function is presentation plus the task board.
async function configKeeper(agentId, command) {
  const raw = String(command || '');
  const agentName = (ctx.agents[agentId] && ctx.agents[agentId].name) || agentId;
  const taskTitle = 'Config read';

  ctx.updateAgentStatus(agentId, 'active', 'Reading a device via Command Runner');
  try { ctx.addTaskToBoard('inProgress', { title: taskTitle, agent: agentName }); } catch (e) { /* board must never block a read */ }

  try {
    const res = await executeDeviceCli({
      agentId, request: raw, announce: true,
      purpose: `operator asked: "${raw.slice(0, 80)}"`,
    });

    if (res.refused && res.kind === 'write') {
      refuseWrite(agentId, raw, res.intent);
    } else if (res.refused && res.kind === 'no-command') {
      say(agentId,
        `${res.note ? '🔌 I cannot answer that one.' : '🤔 I could not find a read command in that.'}\n${RULE}\n` +
        `You asked: "${raw.slice(0, 140)}"\n\n` +
        (res.note ? `${res.note}\n\n` : '') +
        `I will not answer a different question than the one you asked, so I have run nothing.\n` +
        `I can only run read commands against real kit: ${READ_VERBS.join(' / ')}.\n` +
        `Tell me which one — for example "show version", "show running-config", ` +
        `"show ip interface brief" or "ping 10.10.20.48".`);
      ctx.updateAgentStatus(agentId, 'idle', 'Asked for a read command — ran nothing');
    } else if (res.refused && res.kind === 'guardrail') {
      say(agentId,
        `🚫 ${res.reason}\n${RULE}\n` +
        `You asked: "${raw.slice(0, 140)}"\n\n` +
        `Nothing was sent to any device. This squad is read-only against real kit by design — ` +
        `I can run ${READ_VERBS.join(' / ')} and nothing else.`);
      ctx.updateAgentStatus(agentId, 'idle', 'Blocked a non-read-only command');
    } else if (res.refused && res.kind === 'unknown-device') {
      say(agentId, `🛑 I did not run that.\n${RULE}\n${res.reason}`);
      ctx.updateAgentStatus(agentId, 'idle', 'Named device not resolvable — ran nothing');
    } else if (res.denied) {
      say(agentId,
        `🛑 Read denied by the operator — ran nothing.\n${RULE}\n` +
        `The command "${escapeForSay(res.command)}" was not approved, so I sent nothing to any device ` +
        `and I am not going to invent a result. Approve it in the approval panel and ask again to run it for real.`);
      ctx.appendToActivityLog(`[${new Date().toISOString()}] [${agentName}] ${taskTitle} DENIED by operator — ran nothing\n`);
      ctx.updateAgentStatus(agentId, 'idle', 'Read denied — ran nothing');
    } else {
      say(agentId,
        `📡 ${res.target.hostname} — ${res.command}\n${RULE}\n${res.body}\n${RULE}\n` +
        (res.deviceOk === false
          ? `⚠️ The device rejected that command. Real output above — nothing was invented, and no configuration was sent.`
          : `Real output, read live from ${res.target.hostname} (${res.target.ip}). No configuration was sent.`));

      // ONE clean command_share for this direct read: the exact CLI command the
      // device ran, its real raw output, why it ran, and what it means. Emitted
      // explicitly (not per HTTP hop) so the chat shows a single deduped engineer
      // block — the real `show version`, not the four Command Runner API calls.
      session.emitCommandShare({
        agent: agentId,
        agentName,
        tier: null,
        purpose: `read "${res.command}" on ${res.target.hostname}`,
        command: res.command,
        raw: res.body,
        reasoning: `Operator asked: "${raw.slice(0, 100)}". Parsed to the read-only CLI "${res.command}" ` +
          `(guardrail passed) and ran it on ${res.target.hostname} via Catalyst Center Command Runner.`,
        conclusion: res.deviceOk === false
          ? `The device rejected "${res.command}" — real output above, nothing invented, no configuration sent.`
          : `Real "${res.command}" output read live from ${res.target.hostname} (${res.target.ip}). Read-only; no configuration sent.`,
        ok: res.deviceOk !== false,
      });
      ctx.updateAgentStatus(agentId, 'idle', `${taskTitle} complete (live data)`);
    }
  } catch (err) {
    say(agentId,
      `⚠️ Source unreachable.\n${RULE}\n${err.message}\n\n` +
      `No data to show. I am not going to guess what the network looks like.`);
    ctx.appendToActivityLog(`[${new Date().toISOString()}] [${agentName}] ${taskTitle} FAILED — ${err.message}\n`);
    ctx.updateAgentStatus(agentId, 'idle', 'Source unreachable');
  }

  try { ctx.moveTaskOnBoard(taskTitle, 'inProgress', 'done'); }
  catch (err) { console.error('[live] Could not tidy the task board:', err.message); }
}

// Pull the actual CLI command out of plain English. People type
// "show version on the switches" — the device only understands "show version",
// so the trailing English is trimmed off before anything is submitted.
//
// Honesty rule: if there is NO read command in the text, this returns
// { command: null } and the caller says so. It never falls back to a default,
// because answering "show version" to a question about backups is answering a
// question nobody asked.
//
// Returns { command, note } — `note` explains, in plain words, why a request
// that looked like a read produced no runnable command.
const NO_STORE = /\b(backup|backed[\s-]?up|compliance|drift|baseline|snapshot|golden|archive[sd]?)\b/i;

function readCommandFrom(text) {
  const raw = String(text || '');

  // Config-Keeper holds no backup archive or compliance baseline. Saying that
  // out loud beats running a live read and letting it pass as an answer.
  if (NO_STORE.test(raw)) {
    return {
      command: null,
      note:
        'I hold no backup archive, compliance baseline or change history — there is no such source wired up, ' +
        'so I cannot tell you when anything was last backed up or whether it has drifted.\n' +
        'What I can do is read the device as it is right now (for example "show running-config").',
    };
  }

  const m = /\b((?:show|ping|traceroute|dir|more)\b[\w\s|:/.\-]*)/i.exec(raw);
  if (!m) {
    // No read verb typed. A canonical device-read noun still names exactly one
    // command ("the running config of sw3" → show running-config), so map it
    // rather than dead-ending on a request whose meaning is not in doubt.
    // Refused outright if the sentence carries any chaining/redirection
    // character: with no typed fragment there is nothing safe to hand the
    // guardrail's chain check, and guessing past a "|" or a newline is exactly
    // how a second command gets smuggled in.
    if (/[;&|><`$\n\r]/.test(raw)) {
      return { command: null, note: 'That request chains or redirects (; & | > < ` $), so I ran nothing.' };
    }
    const low = raw.toLowerCase();
    if (/\brun(?:ning)?[\s-]?config/.test(low)) return { rawFragment: 'show running-config', command: 'show running-config' };
    if (/\bstart(?:up)?[\s-]?config/.test(low)) return { rawFragment: 'show startup-config', command: 'show startup-config' };
    if (/\bversion\b/.test(low)) return { rawFragment: 'show version', command: 'show version' };
    return { command: null };
  }

  // The fragment EXACTLY as it was typed. The caller runs the read-only
  // guardrail on this first, because the normalisation below flattens every
  // newline into a space — and a newline is one of the chaining characters the
  // guardrail exists to refuse ("show ip arp\nreload" must never become the
  // single allowed line "show ip arp reload").
  const rawFragment = m[1];

  let frag = m[1]
    .replace(/\s+(on|for|from|of|across|in|please)\b.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();

  // "show me the ..." / "show us ..." is English, not CLI. The article goes too
  // — "show me the arp table" must not be submitted as "show the arp table".
  frag = frag
    .replace(/^show\s+(?:me|us)\b\s*/i, 'show ')
    .replace(/^show\s+(?:the|my|our|all)\b\s*/i, 'show ')
    .replace(/\s+/g, ' ')
    .trim();

  const t = frag.toLowerCase();

  // A bare verb with nothing after it is not a command.
  if (/^(show|ping|traceroute|dir|more)$/.test(t)) {
    return { command: null, note: `"${frag}" on its own is not a command — it needs something to read.` };
  }

  // Map the handful of plain-English phrasings people actually type onto the
  // real CLI command. The reply always states which command was run, so the
  // mapping is visible rather than silent.
  if (/^show\b/.test(t)) {
    if (/running[\s-]?conf(ig)?/.test(t)) return { rawFragment, command: 'show running-config' };
    if (/start(up)?[\s-]?conf(ig)?/.test(t)) return { rawFragment, command: 'show startup-config' };
    if (/\b(version|software|ios|firmware)\b/.test(t)) return { rawFragment, command: 'show version' };
    if (/\binterface/.test(t)) return { rawFragment, command: 'show ip interface brief' };
    if (/\binventor(y|ies)\b/.test(t)) return { rawFragment, command: 'show inventory' };
  }

  return { rawFragment, command: frag };
}

// ── The class: "run a command on a device" ──────────────────────────────────
// A device-CLI request is one the operator wants EXECUTED on a box through the
// Command Runner — "show version on sw1", "show running-config", "ping 10.0.0.1",
// "traceroute 8.8.8.8" — as opposed to a plain domain question an agent answers
// from its own source ("what's the device health", "show me the alarms", an
// inventory ask). Whichever engineer it is aimed at, this class must reach the
// one shared Command Runner path (Config-Keeper) instead of dead-ending on an
// agent that has no CLI session.
//
// Deliberately NARROW so ordinary domain asks still route to their owner. A
// request counts as device-CLI only when it names an ACTUAL COMMAND:
//   • ping/traceroute with a real target (a bare "ping" is an agent
//     responsiveness check, not a device ping);
//   • a read verb followed by a real IOS subject ("show running-config",
//     "show ip interface brief", "show version on sw2");
//   • or an explicit execution verb — "run"/"execute" <read verb …> — which is
//     the operator saying outright that they want it run on the box.
// What is NOT enough: any sentence that merely contains "show … on <device>".
// "show me the alarms on sw1" is a Monitor-Eye question about its own source
// ("alarms" is not an IOS subject) and must reach Monitor-Eye, not the runner.
// "inventory" and "health" are likewise NOT triggers — those are NetOps domain
// questions; asked as "run show inventory on sw1" the explicit verb carries it.
const IOS_SUBJECT =
  '(?:run(?:ning)?[\\s-]?config|start(?:up)?[\\s-]?config|version|software|ip\\s+\\w|' +
  'interfaces?\\b|int\\s+\\w|mac[\\s-]?address|cdp\\b|lldp\\b|vlan\\b|arp\\b|processes\\b|' +
  'logging\\b|clock\\b|users\\b|license|module|environment|power|spanning[\\s-]?tree|' +
  'platform|redundancy|flash|bootflash|standby|tech[\\s-]?support)';
const CANON_SHOW = new RegExp(`\\bshow\\s+(?:me\\s+|us\\s+)?(?:the\\s+|my\\s+|our\\s+|all\\s+)?${IOS_SUBJECT}`, 'i');
const EXPLICIT_RUN = /\b(?:run|execute)\b[^.;]{0,40}?\b(?:show|ping|traceroute|dir|more)\b/i;
const PING_TRACE = /\b(?:ping|traceroute|trace)\b\s+(?:\d{1,3}(?:\.\d{1,3}){3}|sw\d+|[a-z][\w.-]*\.[\w.-]+|[a-z][\w-]*\d[\w-]*)/i;
const DIR_MORE = /\b(?:dir|more)\s+(?:flash|bootflash|disk\d|nvram|\/|[\w-]+:)/i;

function isDeviceCliRequest(command) {
  const raw = String(command || '');
  const t = raw.toLowerCase();
  // Backup / compliance / baseline asks are NOT a live run — Config-Keeper says
  // out loud it holds no such store (readCommandFrom handles that honestly).
  if (NO_STORE.test(raw)) return false;
  if (PING_TRACE.test(t)) return true;
  if (CANON_SHOW.test(t)) return true;
  if (DIR_MORE.test(t)) return true;
  if (EXPLICIT_RUN.test(t)) return true;
  // No read verb typed at all, but a canonical device read aimed at a NAMED box
  // — "can you check the running config of sw3", "what version is on sw2". The
  // named device is what keeps this narrow: the same nouns with no device named
  // stay domain questions for their owner.
  if (DEVICE_READ_NOUN.test(t) && namedDeviceIn(raw)) return true;
  return false;
}

// Canonical device-read nouns — the ones that map onto exactly one IOS command.
// Kept deliberately short: every entry here must have a mapping in
// readCommandFrom, or the request would be classified as CLI and then refused
// for having no command in it.
const DEVICE_READ_NOUN = /\b(?:run(?:ning)?[\s-]?config(?:uration)?|start(?:up)?[\s-]?config(?:uration)?|(?:ios|software|code)?\s*version)\b/i;

// Route a device-CLI request to the shared Command Runner path. Config-Keeper
// owns that path; every other engineer hands it off OUT LOUD rather than
// dead-ending with "I have no CLI session". A state-changing command is still
// refused inside configKeeper (its guardrail runs first), so this never opens a
// write path. This is the single choke point that makes the class-level promise
// true: aim a "run <cli> on <device>" at anyone, it reaches the runner.
function runDeviceCli(originAgentId, command) {
  if (originAgentId && originAgentId !== 'config-keeper') {
    const ckName = (ctx.agents['config-keeper'] && ctx.agents['config-keeper'].name) || 'Config-Keeper';
    say(originAgentId,
      `🔀 That is a device CLI command. I read from my own source and hold no Command Runner session of my own, ` +
      `so I am handing this to @${ckName}, who runs read-only commands on the box through Catalyst Center's Command Runner.`);
    ctx.updateAgentStatus(originAgentId, 'idle', `Handed a CLI command to ${ckName}`);
    ctx.appendToActivityLog(
      `[${new Date().toISOString()}] [${(ctx.agents[originAgentId] && ctx.agents[originAgentId].name) || originAgentId}] ` +
      `Handed a device-CLI request to Config-Keeper — "${String(command).slice(0, 60)}"\n`);
  }
  return configKeeper('config-keeper', command);
}

// Command Runner returns a nested envelope with SUCCESS / FAILURE /
// BLOCKLISTED buckets. Read all three so a device error is reported as a
// device error, not dumped as raw JSON.
function extractCommandOutput(file, command) {
  try {
    const entry = Array.isArray(file) ? file[0] : file;
    const r = entry?.commandResponses || {};
    const pick = (bucket) => {
      const keys = Object.keys(bucket || {});
      return keys.length ? bucket[keys[0]] : null;
    };
    const ok = pick(r.SUCCESS || r.success);
    if (ok) return { ok: true, text: ok };
    const failed = pick(r.FAILURE || r.failure);
    if (failed) return { ok: false, text: failed };
    const blocked = pick(r.BLOCKLISTED || r.blocklisted);
    if (blocked) return { ok: false, text: `Catalyst Center blocklisted this command: ${blocked}` };
  } catch (e) { /* fall through */ }
  return null;
}

// ── Jarvis — one honest picture across every source ─────────────────────────
async function jarvisNetwork(agentId) {
  await runLive(agentId, 'Network overview', 'Polling all sources', async () => {
    say(agentId, `🎖️ Polling every connected source for a real picture...`);
    const lines = [];

    try {
      const devices = await catalyst.getDevices();
      const health = await catalyst.getHealth();
      const up = devices.filter((d) => d.reachability === 'Reachable').length;
      lines.push(`🟢 Campus (Catalyst Center, ${catalyst.host})\n   ${up}/${devices.length} reachable — ${devices.map((d) => d.hostname).join(', ')}\n   Health score ${health.score}`);
    } catch (e) { lines.push(`🔴 Campus (Catalyst Center) — unreachable: ${e.message}`); }

    try {
      const nodes = await aci.getFabricNodes();
      const health = await aci.getFabricHealth();
      const faults = await aci.getFaults(['critical']);
      lines.push(`🟢 Data centre (ACI, ${aci.host})\n   ${nodes.length} fabric nodes — ${nodes.map((n) => n.name).join(', ')}\n   Fabric health ${health.score} · ${faults.length} critical faults`);
    } catch (e) { lines.push(`🔴 Data centre (ACI) — unreachable: ${e.message}`); }

    try {
      const devices = await sdwan.getDevices();
      const alarms = await sdwan.getAlarmCount();
      lines.push(`🟢 WAN (SD-WAN vManage, ${sdwan.host})\n   ${devices.length} devices — ${devices.map((d) => d.hostname).join(', ')}\n   ${alarms.active} active alarms`);
    } catch (e) { lines.push(`🔴 WAN (SD-WAN) — unreachable: ${e.message}`); }

    lines.push(`⚪ Not connected: Sentinel (CVE feed), Firewall-Pro (firewall), LoadBal-Pro (F5) — no credentials, so they report nothing rather than guessing.`);

    say(agentId, `📊 **Live network overview**\n${RULE}\n${lines.join('\n\n')}\n${RULE}\nEverything above was read from a Cisco DevNet always-on sandbox just now.`);
  });
}

// ── Read-only refusal for any change request ────────────────────────────────
function refuseWrite(agentId, command, intent) {
  const named = intent && intent.keyword
    ? `What I refused: "${intent.keyword}"${intent.clause && intent.clause.toLowerCase() !== intent.keyword ? ` — in "${String(intent.clause).slice(0, 80)}"` : ''}. ` +
      `That changes device state.\n\n`
    : '';
  say(agentId,
    `🚫 Refused — that is a change, and I am read-only.\n${RULE}\n` +
    `You asked: "${String(command).slice(0, 140)}"\n\n` +
    named +
    `Nothing was sent to any device, and I did NOT run something else in its place.\n` +
    `This squad is wired to real Cisco DevNet sandboxes with read-only access enforced in code ` +
    `(sources/guardrails.js) — only ${READ_VERBS.join(' / ')} reads get through.`);
  ctx.updateAgentStatus(agentId, 'idle', 'Refused a write — read-only mode');
}

// ── Debate contributions — live reads only ──────────────────────────────────
// A debate contribution is NOT an opinion generator. Each agent runs the same
// read-only queries it would run for a direct question, and reports what those
// queries actually returned. There is no stance picking, no canned argument and
// no fallback text: an agent either has fresh numbers from its own source, or
// it says it is not connected / the source is unreachable.
//
// Two stances only:
//   'evidence' — live data came back; the text is what that data says.
//   'no-data'  — no source wired up, or the source could not be reached.

// Topics are free text, so keep quoting them short — but cut on a word break so
// the quote reads like a topic and not a truncated string.
function shortTopic(topic) {
  const t = String(topic || '').trim();
  if (t.length <= 90) return `"${t}"`;
  const cut = t.slice(0, 90);
  const space = cut.lastIndexOf(' ');
  return `"${(space > 40 ? cut.slice(0, space) : cut)}…"`;
}

// EPGs live at uni/tn-<tenant>/ap-<appProfile>/epg-<name>. Pull the application
// profile out of the dn so an EPG can be reported as tenant › AP › EPG.
function appProfileOf(dn) {
  const m = /\/ap-([^/]+)/.exec(dn || '');
  return m ? m[1] : null;
}

// Turn the flat EPG list (aci.getEpgs) into a bounded, readable per-tenant
// summary. It NEVER hides the count — always states "N EPG(s) across M
// tenant(s)" — and caps the enumerated names so a 70-EPG fabric stays readable
// while every tenant is still represented. Honest by construction: real names
// only, and it says plainly when it is showing a subset.
function summariseEpgs(epgs, cap = 40) {
  if (!epgs.length) return 'No EPGs returned by the APIC.';
  const byTenant = {};
  for (const e of epgs) {
    const t = e.tenant || 'unknown';
    (byTenant[t] = byTenant[t] || []).push(e);
  }
  const tenants = Object.keys(byTenant).sort();
  const lines = [];
  let shown = 0;
  for (const t of tenants) {
    const list = byTenant[t];
    const names = [];
    for (const e of list) {
      if (shown >= cap) break;
      const ap = appProfileOf(e.dn);
      names.push(ap ? `${ap}/${e.name}` : e.name);
      shown += 1;
    }
    const extra = list.length - names.length;
    lines.push(`  tenant ${t} (${list.length}): ${names.join(', ')}` + (extra > 0 ? `, +${extra} more` : ''));
    if (shown >= cap) break;
  }
  const capped = shown < epgs.length;
  const header = `${epgs.length} EPG(s) across ${tenants.length} tenant(s)` +
    (capped ? ` — showing ${shown}` : '');
  return `${header}:\n${lines.join('\n')}`;
}

function noDataContribution(agentId, topic) {
  const need = NO_BACKEND[agentId] || 'a live data source';
  return {
    stance: 'no-data',
    text: `Not connected — I can't weigh in with data on ${shortTopic(topic)}.\n` +
      `I have no ${need} wired up, so I have no readings to bring. ` +
      `I won't argue a position I can't back with live data.`,
  };
}

function unreachableContribution(source, topic, err) {
  return {
    stance: 'no-data',
    text: `Source unreachable — I can't weigh in with data on ${shortTopic(topic)}.\n` +
      `${source} did not answer: ${err.message}. No readings, so no position from me.`,
  };
}

// Each builder does real reads and returns the text. Throwing is fine — the
// caller turns it into an honest "source unreachable" line.
const DEBATE_BUILDERS = {
  'netops': {
    source: () => `${catalyst.label} (${catalyst.host})`,
    async build(topic) {
      const devices = await catalyst.getDevices();
      const health = await catalyst.getHealth().catch(() => null);
      const down = devices.filter((d) => d.reachability !== 'Reachable');
      // Carry EVERY field getDevices() already returned that a delegated
      // question could ask for — hostname, management IP, platform/model,
      // software version, reachability — one device per line. The old summary
      // dropped mgmt IP and version, so "list the mgmt IPs" and "what version is
      // sw1" came back unanswerable even though this read holds both. Honesty is
      // preserved: a field the API did not return is labelled "not reported",
      // never invented.
      const perDevice = devices.map((d) =>
        `${d.hostname}: mgmt IP ${d.ip || 'not reported'}, ` +
        `platform ${d.platform || 'not reported'}, ` +
        `software ${d.software || 'version not reported'}, ` +
        `${d.reachability}`);
      return `Live from ${catalyst.label} (${catalyst.host}) just now: ` +
        `${devices.length - down.length}/${devices.length} devices reachable.` +
        (devices.length ? `\n${perDevice.join('\n')}` : ' No devices returned.') +
        (health ? `\nNetwork health score ${health.score} (good ${health.good} / bad ${health.bad}).` : '') +
        `\nThat is the campus state anyone planning ${shortTopic(topic)} is working against. ` +
        (down.length
          ? `${down.map((d) => d.hostname).join(', ')} is not reachable right now, so that part I cannot vouch for.`
          : `Nothing in that inventory is currently unreachable.`);
    },
  },

  'monitor-eye': {
    source: () => `${catalyst.label} (${catalyst.host})`,
    async build(topic) {
      const health = await catalyst.getHealth();
      const issues = await catalyst.getIssues();
      let wan = '';
      try {
        const alarms = await sdwan.getAlarmCount();
        wan = ` SD-WAN (vManage ${sdwan.host}) reports ${alarms.active} active alarms.`;
      } catch (e) {
        wan = ` SD-WAN alarm feed unreachable (${e.message}) — I am not counting it.`;
      }
      return `Live monitoring read: health score ${health.score} across ${health.total} monitored devices ` +
        `(good ${health.good} / bad ${health.bad}), ${issues.length} open issue(s)` +
        (issues.length ? ` — ${issues.slice(0, 3).map((i) => `${i.priority} ${i.name}`).join('; ')}` : '') +
        `.${wan}\nAgainst ${shortTopic(topic)}: that is the current baseline. ` +
        `Any claim about trends beyond these numbers would be me guessing, so I am not making one.`;
    },
  },

  'incident-handler': {
    source: () => `${catalyst.label} / ${aci.label}`,
    async build(topic) {
      const issues = await catalyst.getIssues();
      let faultLine;
      try {
        const faults = await aci.getFaults(['critical', 'major']);
        const crit = faults.filter((f) => f.severity === 'critical').length;
        faultLine = `ACI fabric (${aci.host}) has ${crit} critical and ${faults.length - crit} major fault(s)` +
          (faults.length ? ` — e.g. F${faults[0].code} ${String(faults[0].description || '').slice(0, 80)}` : '');
      } catch (e) {
        faultLine = `ACI fault feed unreachable (${e.message}), so I have no fabric faults to add`;
      }
      return `Open incidents right now: Catalyst Center lists ${issues.length} issue(s)` +
        (issues.length ? ` — ${issues.slice(0, 3).map((i) => `${i.priority} ${i.name} (${i.status}, seen ${i.occurrences}x)`).join('; ')}` : '') +
        `. ${faultLine}.\nOn ${shortTopic(topic)}: that is what is already open. ` +
        `I have no incident history beyond what these sources return, so I am not citing past outages.`;
    },
  },

  'router-expert': {
    source: () => `${aci.label} / ${sdwan.label}`,
    async build(topic) {
      if (ACI_WORDS.test(topic || '')) {
        const nodes = await aci.getFabricNodes();
        const health = await aci.getFabricHealth().catch(() => ({ score: null }));
        const tenants = await aci.getTenants().catch(() => []);
        // Enumerate the actual EPGs from the live APIC (fvAEPg via getEpgs), not
        // just the tenant list. The old builder stopped at tenants, so "what
        // EPGs do we have?" could never be answered from this finding. Left
        // uncaught on purpose: if the APIC genuinely can't be read the whole
        // contribution becomes an honest "source unreachable", same as the
        // fabric-node read above — it never silently reports zero EPGs.
        const epgs = await aci.getEpgs();
        return `Live from the APIC (${aci.host}): ${nodes.length} fabric node(s) — ` +
          `${nodes.map((n) => `${n.name} ${n.role} ${n.state}`).join('; ')}` +
          (health.score != null ? `. Fabric health ${health.score}` : '') +
          (tenants.length ? `. ${tenants.length} tenant(s): ${tenants.map((t) => t.name).join(', ')}` : '') +
          `.\nEPGs (endpoint groups) live on the fabric now — ${summariseEpgs(epgs)}` +
          `\nThat is the fabric ${shortTopic(topic)} would land on. I have not measured convergence or ` +
          `traffic, so I am not making a claim about either.`;
      }
      const devices = await sdwan.getDevices();
      const controllers = await sdwan.getControllers().catch(() => []);
      const alarms = await sdwan.getAlarmCount().catch(() => ({ active: 'n/a' }));
      return `Live from vManage (${sdwan.host}): ${devices.length} overlay device(s) — ` +
        `${devices.map((d) => `${d.hostname} ${d.type} ${d.state}`).join('; ')}` +
        (controllers.length ? `. Controllers: ${controllers.map((c) => c.hostname).join(', ')}` : '') +
        `. Active alarms: ${alarms.active}.\nThat is the WAN state behind ${shortTopic(topic)}. ` +
        `Routing-protocol behaviour beyond these device states is not something I can read, so I am not asserting it.`;
    },
  },

  'config-keeper': {
    source: () => `${catalyst.label} (${catalyst.host})`,
    async build(topic) {
      // A device CLI command ("run show version on sw1", "show running-config",
      // "ping <ip>") goes through executeDeviceCli — the SAME choke point the
      // direct chat path uses, which owns the write refusal, the read-only
      // guardrail, resolving the named device, the permission gate and the
      // secret scrub. That is what makes this branch safe for EVERY caller of
      // build(), including the debate path, which does no gating of its own.
      if (isDeviceCliRequest(topic)) {
        const res = await executeDeviceCli({
          agentId: 'config-keeper', request: topic,
          purpose: `run the command asked for in: "${String(topic || '').slice(0, 80)}"`,
        });
        // Whatever happened — ran, refused, denied — say THAT. Never quietly
        // fall through to an inventory read: answering a command with a
        // different reading is the substitution this file exists to prevent.
        return cliResultText(res, topic);
      }
      const devices = await catalyst.getDevices();
      const versions = devices.map((d) => `${d.hostname}: ${d.software || 'version not reported'} (${d.reachability})`);
      return `Live software/reachability read from ${catalyst.label} (${catalyst.host}):\n` +
        (versions.join('\n') || 'no devices returned') +
        `\nFor ${shortTopic(topic)}: those are the actual running versions on the boxes in scope. ` +
        `I hold no backups or compliance baselines in this system, so I cannot claim rollback readiness.`;
    },
  },

  'doc-writer': {
    source: () => 'the connected sandboxes',
    async build(topic) {
      const parts = [];
      let any = false;
      try {
        const devices = await catalyst.getDevices();
        any = true;
        parts.push(`Catalyst Center: ${devices.length} device(s) documented (${devices.map((d) => d.hostname).join(', ')})`);
      } catch (e) { parts.push(`Catalyst Center unreachable — ${e.message}`); }
      try {
        const nodes = await aci.getFabricNodes();
        any = true;
        parts.push(`ACI: ${nodes.length} fabric node(s) (${nodes.map((n) => n.name).join(', ')})`);
      } catch (e) { parts.push(`ACI unreachable — ${e.message}`); }
      try {
        const devices = await sdwan.getDevices();
        any = true;
        parts.push(`SD-WAN: ${devices.length} device(s) (${devices.map((d) => d.hostname).join(', ')})`);
      } catch (e) { parts.push(`SD-WAN unreachable — ${e.message}`); }
      if (!any) throw new Error('every source was unreachable');
      return `What I can actually document for ${shortTopic(topic)} from live reads:\n${parts.join('\n')}\n` +
        `Anything not on that list has no source behind it, so it would not go in a runbook.`;
    },
  },

  'jarvis': {
    source: () => 'all connected sources',
    async build(topic) {
      const lines = [];
      let any = false;
      try {
        const devices = await catalyst.getDevices();
        const health = await catalyst.getHealth();
        any = true;
        lines.push(`Campus: ${devices.filter((d) => d.reachability === 'Reachable').length}/${devices.length} reachable, health ${health.score}`);
      } catch (e) { lines.push(`Campus (Catalyst Center) unreachable — ${e.message}`); }
      try {
        const nodes = await aci.getFabricNodes();
        const faults = await aci.getFaults(['critical']);
        any = true;
        lines.push(`Data centre: ${nodes.length} ACI node(s), ${faults.length} critical fault(s)`);
      } catch (e) { lines.push(`Data centre (ACI) unreachable — ${e.message}`); }
      try {
        const devices = await sdwan.getDevices();
        const alarms = await sdwan.getAlarmCount();
        any = true;
        lines.push(`WAN: ${devices.length} SD-WAN device(s), ${alarms.active} active alarm(s)`);
      } catch (e) { lines.push(`WAN (SD-WAN) unreachable — ${e.message}`); }
      if (!any) throw new Error('every source was unreachable');
      return `Moderating with live figures only. ${lines.join('. ')}.\n` +
        `That is the whole evidence base for ${shortTopic(topic)}. ` +
        `Sentinel, Firewall-Pro and LoadBal-Pro have no source, so their silence is not agreement — it is no data.`;
    },
  },
};

// ── Jarvis delegation gather (Phase E) ──────────────────────────────────────
// Jarvis (real Claude) hands an agent a piece of the question; this runs that
// agent's REAL live read and returns the findings for Jarvis to compose from.
//
// This is the honesty-critical seam: the read goes through the SAME path as any
// other live read — the permission gate (auto/ask/deny) and the CLI/session log
// — so a denied read runs nothing, a not-connected agent says so, and a dead
// source is reported as unreachable. Nothing here is fabricated. Jarvis's
// synthesis is instructed to use ONLY what these objects carry.
//
// Returns { agentId, name, connected, stance, text }:
//   stance ∈ 'evidence' | 'not-connected' | 'denied' | 'unreachable'
async function gatherForJarvis(agentId, question) {
  // CLASS FIX (CLI routing): a "run <show/ping/traceroute/dir/more> on <device>"
  // sub-question is a DEVICE CLI job. Only Config-Keeper holds the Command Runner
  // path, so whoever the planner picked, the execution seam re-points it there
  // instead of letting an inventory-only engineer answer "I have no CLI session".
  // Enforced HERE (not only in the planner prompt) because this is the single
  // choke point every delegated read passes through — a model that picks the
  // wrong owner can no longer dead-end the operator.
  let handoffFrom = null;
  if (agentId !== 'config-keeper' && DEBATE_BUILDERS['config-keeper'] && isDeviceCliRequest(question)) {
    handoffFrom = (ctx && ctx.agents && ctx.agents[agentId] && ctx.agents[agentId].name) || agentId;
    ctx.appendToActivityLog(
      `[${new Date().toISOString()}] [${handoffFrom}] Device-CLI sub-question handed to Config-Keeper (Command Runner) — ` +
      `"${String(question || '').slice(0, 60)}"\n`);
    ctx.updateAgentStatus(agentId, 'idle', 'Handed a CLI command to Config-Keeper');
    agentId = 'config-keeper';
  }

  const agent = (ctx && ctx.agents && ctx.agents[agentId]) || { name: agentId };
  const name = agent.name || agentId;
  const handoffNote = handoffFrom
    ? `(${handoffFrom} has no device CLI session, so this was handed to ${name}, who owns the Catalyst Center Command Runner path.)\n`
    : '';

  // CLASS FIX (transparency contract, agent_status): the MOMENT Jarvis delegates
  // to an agent it is engaged — flip it active here and idle when the turn ends,
  // covering every exit path (not-connected, denied, evidence, unreachable) via
  // finally. This is the delegation engagement path the roster light was missing.
  ctx.updateAgentStatus(agentId, 'active', `Jarvis delegation: ${String(question || '').slice(0, 60)}`);
  try {
    // The handoff note rides on EVERY outcome (ran, denied, unreachable, not
    // connected) — an operator whose question was re-pointed must be told so
    // even when the re-pointed read came back with nothing.
    const finding = await (async () => {
    // Not-connected agents never invent a report — Jarvis is told so plainly.
    if (NO_BACKEND[agentId]) {
      const need = NO_BACKEND[agentId];
      return {
        agentId, name, connected: false, stance: 'not-connected',
        text: `Not connected — no ${need} wired up. Nothing real to report.`,
      };
    }

    const builder = DEBATE_BUILDERS[agentId];
    if (!builder) {
      return {
        agentId, name, connected: false, stance: 'not-connected',
        text: 'No live data source mapped for this agent — nothing real to report.',
      };
    }

    // Every gathered read passes the permission gate and is tagged for the CLI
    // session log, exactly like a direct question or a triage read.
    const meta = {
      agentId, agentName: name,
      command: `Jarvis delegation: ${String(question || '').slice(0, 80)}`,
      target: (typeof builder.source === 'function' ? builder.source() : 'live source'),
      reason: 'Jarvis (Principal Engineer) delegated this read',
    };

    try {
      const g = await approvals.gate(meta, () =>
        // share:true → every real wire call this delegated read makes is also
        // screen-shared into the chat as a command_share (real command + raw +
        // reasoning + conclusion), on top of the summary chat line below.
        session.runWithContext(
          {
            agentId, agentName: name, label: `Jarvis delegation`,
            share: true, tier: 'L4 delegation',
            purpose: `answer Jarvis's sub-question: "${String(question || '').slice(0, 120)}"`,
            reasoning: 'Jarvis (Principal Engineer) delegated this read to answer its sub-question.',
          },
          () => builder.build(question),
        ));

      if (g.denied) {
        return {
          agentId, name, connected: true, stance: 'denied',
          text: 'Read denied by the operator — ran nothing, and I will not invent a result.',
        };
      }
      return { agentId, name, connected: true, stance: 'evidence', text: String(g.result || '').trim() };
    } catch (err) {
      const src = typeof builder.source === 'function' ? builder.source() : 'the source';
      return {
        agentId, name, connected: true, stance: 'unreachable',
        text: `Source unreachable — ${src} did not answer: ${err.message}. No readings, so nothing to report.`,
      };
    }
    })();
    return handoffNote ? { ...finding, text: handoffNote + finding.text } : finding;
  } finally {
    ctx.updateAgentStatus(agentId, 'idle', 'Delegation turn ended');
  }
}

// Called once per participating agent when a debate runs.
async function debateContribution(agentId, topic) {
  if (NO_BACKEND[agentId]) return noDataContribution(agentId, topic);
  const builder = DEBATE_BUILDERS[agentId];
  if (!builder) return noDataContribution(agentId, topic);
  try {
    const text = await builder.build(topic);
    return { stance: 'evidence', text };
  } catch (err) {
    return unreachableContribution(builder.source(), topic, err);
  }
}

// Which agent answers from which live source.
const HANDLERS = {
  'netops': netops,
  'monitor-eye': monitorEye,
  'incident-handler': incidentHandler,
  'doc-writer': docWriter,
  'router-expert': routerExpert,
  'config-keeper': configKeeper,
  'jarvis': jarvisNetwork,
};

function hasLiveBackend(agentId) { return Boolean(HANDLERS[agentId]); }

// ── What each agent can ACTUALLY answer ─────────────────────────────────────
// Every agent below has exactly one live action, and it reads one set of
// sources. Before this map existed the intent router fell through to that
// action for ANY text, so "what is the weather in Paris today" and "wipe the
// config on sw1" both came back as a confident live device read — the same
// silent substitution that Config-Keeper used to do with "show version".
//
// So the question is asked FIRST: is this request one this agent can answer?
// If not, the agent says so and runs nothing. There is no default action.
//
// A capability is TWO questions, not one keyword sweep: what is being asked FOR
// (the subject) and what is being asked to be DONE (the verb). Testing keyword
// presence alone let an in-domain noun drag an out-of-domain request through —
// "document my holiday in Spain" wrote a real network inventory file, "backup
// the inventory" ran a live device read, "is the coffee machine up?" answered
// with a switch health score. Both halves must land inside the agent's remit.
//
//   subjects — the things this agent can actually see. Nouns only.
//   verbs    — the actions it can actually perform, on top of the shared
//              question/read openers below. Anything else is out of remit.
//
// Verbs people use to ASK for a reading. Every agent accepts these, because
// every agent's job is to read something and report it back.
const READ_ASK = [
  'what', 'whats', 'which', 'who', 'whose', 'when', 'where', 'why', 'how',
  'is', 'are', 'was', 'were', 'am', 'any', 'anything', 'anyone', 'does', 'did',
  'has', 'have', 'tell', 'give', 'show', 'list', 'get', 'check', 'read',
  'report', 'look', 'see', 'display', 'find', 'confirm', 'verify', 'compare',
  'pull', 'fetch', 'run', 'status', 'update', 'brief', 'catch', 'recap',
];

const CAPABILITIES = {
  'netops': {
    subjects: /\b(device|devices|switch|switches|inventory|reachab|reachable|campus|catalyst|dnac|precheck|pre-check|connectivity|ssh|platform|software|version|uptime|hostname|serial|network|health score|kit|gear|sw\d+)\b/i,
    verbs: [],
    can: [
      'read the campus inventory from Catalyst Center — hostname, management IP, platform, software version, reachability',
      'report the campus health score (how many devices are good vs bad)',
    ],
  },
  'monitor-eye': {
    subjects: /\b(alert|alerts|alarm|alarms|threshold|issue|issues|event|events|syslog|snmp|metric|metrics|health|network|catalyst|sd-?wan|vmanage|device|devices)\b/i,
    verbs: ['monitor', 'watch', 'sweep', 'poll'],
    can: [
      'read live alerts and open issues from Catalyst Center',
      'read active and cleared alarm counts from SD-WAN vManage',
    ],
  },
  'incident-handler': {
    // "problem"/"problems" were subjects here — but they are generic English,
    // not something a source can see. Paired with the verb "triage" they let
    // "triage my landlord problem" through as a real live read (dictionary
    // overlap). A real network noun (incident, fault, device, fabric…) must be
    // named, so a nonsense triage is refused honestly instead of running a read.
    subjects: /\b(incident|incidents|fault|faults|issue|issues|outage|rca|root[\s-]?cause|impact|severity|critical|major|network|fabric|aci|catalyst|device|devices)\b/i,
    verbs: ['triage', 'diagnose', 'troubleshoot', 'investigate'],
    can: [
      'read open issues from Catalyst Center',
      'read critical faults from the ACI fabric (when the APIC is reachable)',
    ],
  },
  'doc-writer': {
    // Note what is NOT here: "document", "write", "report" are verbs, not
    // subjects. Doc-Writer writes about the network it can read — nothing else.
    subjects: /\b(network|inventory|device|devices|switch|switches|router|routers|fabric|aci|sd-?wan|overlay|topology|incident|incidents|alarm|alarms|alert|alerts|config|configuration|source|sources|catalyst|as[\s-]?built|estate)\b/i,
    verbs: ['write', 'document', 'draft', 'produce', 'generate', 'compile', 'record', 'summarise', 'summarize', 'note'],
    can: [
      'write a network inventory document from live sources (Catalyst Center, ACI, SD-WAN) and save it as markdown',
      'log any source it could not reach inside that document, rather than hiding it',
    ],
  },
  'router-expert': {
    subjects: /\b(aci|apic|fabric|leaf|leaves|spine|spines|tenant|tenants|epg|bd\b|vrf|contract|nexus|sd-?wan|vmanage|overlay|vedge|vedges|controller|controllers|wan|router|routers|routing|bgp|ospf|alarm|alarms|data[\s-]?cent(er|re))\b/i,
    verbs: ['audit', 'walk', 'trace'],
    can: [
      'read the ACI fabric from the APIC — nodes, fabric health, tenants, faults, and a tenant VRF/BD/EPG/contract walk',
      'read the SD-WAN overlay from vManage — devices, controllers, vEdges and alarm counts',
    ],
  },
  // Config-Keeper owns the one path that runs a real command ON a device — the
  // Catalyst Center Command Runner. Listed here so the Jarvis planner's roster
  // knows to delegate any "run <cli> on <device>" to it. It gates itself in
  // handle() (readCommandFrom), so this entry only feeds the roster `sees` + help.
  'config-keeper': {
    subjects: /\b(show|running[\s-]?config|start(up)?[\s-]?config|version|command|cli|ping|traceroute|interface|device|switch(es)?|sw\d+|config|configuration)\b/i,
    verbs: ['run', 'execute'],
    can: [
      'run a read-only command on a live switch through Catalyst Center Command Runner — "show version", "show running-config", "show ip interface brief", ping, traceroute — and return the real device output',
      'refuse any config-change command in code (read-only guardrail); it changes nothing on a device',
    ],
  },
  'jarvis': {
    subjects: /\b(network|overview|picture|estate|all sources|every source|devices?|inventory|fabric|switch(es)?|router|wan|sd-?wan|aci|catalyst|reachab|health)\b/i,
    verbs: ['poll', 'overview', 'summarise', 'summarize', 'brief'],
    can: [
      'poll every connected source at once (Catalyst Center, ACI, SD-WAN) and give one honest cross-network picture',
      'name which sources are not connected, instead of filling the gap with a guess',
    ],
  },
};

// Honest dead end: this agent has no way to answer, so it answers nothing.
// `why` says which half of the capability missed, so the reply tells the user
// something useful instead of a flat "no".
function cannotAnswer(agentId, command, why) {
  const cap = CAPABILITIES[agentId];
  const can = cap ? cap.can : [];
  let because = '';
  if (why && !why.subjectOk) {
    because = `That is not something I can see. I only read the sources listed below — ` +
      `if it is not on one of them, I have no way to know anything about it.\n\n`;
  } else if (why && !why.verbOk) {
    because = `I read and report. I do not "${why.verb}" anything — nothing in this squad ` +
      `changes, stores or creates state on a device.\n\n`;
  }
  say(agentId,
    `🤷 I don't have a way to answer that.\n${RULE}\n` +
    `You asked: "${String(command || '').slice(0, 140)}"\n\n` +
    because +
    `I have run nothing. I will not answer a different question than the one you asked, ` +
    `and I will not dress up a reading you did not ask for as the answer.\n\n` +
    (can.length ? `Here is what I can actually do:\n${can.map((c) => `• ${c}`).join('\n')}\n\n` : '') +
    `If this belongs to another agent, @mention them — or type "help" to see my full remit.`);
  ctx.appendToActivityLog(
    `[${new Date().toISOString()}] [${ctx.agents[agentId]?.name || agentId}] No way to answer — ran nothing: "${String(command || '').slice(0, 60)}"\n`);
  ctx.updateAgentStatus(agentId, 'idle', 'No way to answer that — ran nothing');
}

// Can this agent answer this request at all? Config-Keeper has its own, finer
// gate (readCommandFrom), so it is not listed here.
//
// BOTH halves must land: the subject asked about has to be something this agent
// can see, AND the action asked for has to be something it can do. Either one
// alone is not a capability — "backup the inventory" is an in-remit noun with an
// out-of-remit verb, and answering it with a device read would be exactly the
// substitution this whole branch exists to stop.
function canAnswer(agentId, command) {
  const cap = CAPABILITIES[agentId];
  if (!cap) return { ok: true };
  const text = String(command || '');

  const subjectOk = cap.subjects.test(text);

  // The verb is the first real word of the request, filler stripped — the same
  // reading the guardrail uses to spot a destructive command.
  const verb = commandWord(text);
  const verbOk = !verb
    || READ_ASK.includes(verb)
    || cap.verbs.includes(verb)
    // A request that opens with its own subject ("device health?", "alarms?")
    // is a noun phrase, not a different action.
    || cap.subjects.test(verb);

  return { ok: subjectOk && verbOk, subjectOk, verbOk, verb };
}

// Entry point used by the dispatcher in server.js.
function handle(agentId, command) {
  // CLASS FIX (CLI routing): "run <cli> on <device>" is a device-CLI job no
  // matter who it was aimed at. It goes to the one Command Runner path FIRST —
  // before the not-connected check, before the capability check — so an
  // inventory-only (or unwired) engineer can never dead-end it. configKeeper
  // still runs the destructive-intent check and the read-only guardrail inside,
  // so this opens no write path.
  if (isDeviceCliRequest(command)) return runDeviceCli(agentId, command);
  if (NO_BACKEND[agentId]) return notConnected(agentId);
  const fn = HANDLERS[agentId];
  if (!fn) return notConnected(agentId);
  // Config-Keeper gates itself: it must find a real read command in the text.
  if (agentId !== 'config-keeper') {
    const verdict = canAnswer(agentId, command);
    if (!verdict.ok) return cannotAnswer(agentId, command, verdict);
  }
  return fn(agentId, command);
}

module.exports = {
  init, handle, refuseWrite, notConnected, hasLiveBackend, NO_BACKEND, readCommandFrom,
  canAnswer, cannotAnswer, CAPABILITIES,
  isDeviceCliRequest, runDeviceCli,
  debateContribution, gatherForJarvis,
};
