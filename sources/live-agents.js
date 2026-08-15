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
async function runLive(agentId, taskTitle, busyLabel, worker) {
  const agent = ctx.agents[agentId];
  ctx.updateAgentStatus(agentId, 'active', busyLabel);
  try {
    // Inside the try: a task-board problem must not abort the live read, and
    // must not escape as an unhandled rejection.
    ctx.addTaskToBoard('inProgress', { title: taskTitle, agent: agent.name });
    await worker();
    ctx.appendToActivityLog(`[${new Date().toISOString()}] [${agent.name}] ${taskTitle} — live data returned\n`);
    ctx.updateAgentStatus(agentId, 'idle', `${taskTitle} complete (live data)`);
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

// ── Config-Keeper — real show output via Catalyst Center Command Runner ──────
// This is the one path that touches a device CLI, so it is the strictest:
// the guardrail allowlist runs before the request is built.
async function configKeeper(agentId, command) {
  const raw = String(command || '');

  // 1. Destructive intent is judged on the RAW text, not on an extracted
  //    fragment — so "erase startup-config and reload" and "show version;
  //    write erase" are both refused OUT LOUD instead of being trimmed away.
  const intent = checkIntent(raw);
  if (intent.destructive) {
    refuseWrite(agentId, raw, intent);
    return;
  }

  // 2. No read command in the request → say so. Never guess, never substitute.
  const read = readCommandFrom(raw);
  if (!read.command) {
    say(agentId,
      `${read.note ? '🔌 I cannot answer that one.' : '🤔 I could not find a read command in that.'}\n${RULE}\n` +
      `You asked: "${raw.slice(0, 140)}"\n\n` +
      (read.note ? `${read.note}\n\n` : '') +
      `I will not answer a different question than the one you asked, so I have run nothing.\n` +
      `I can only run read commands against real kit: ${READ_VERBS.join(' / ')}.\n` +
      `Tell me which one — for example "show version", "show running-config", ` +
      `"show ip interface brief" or "ping 10.10.20.48".`);
    ctx.updateAgentStatus(agentId, 'idle', 'Asked for a read command — ran nothing');
    return;
  }

  const verdict = checkCommand(read.command);
  if (!verdict.allowed) {
    say(agentId,
      `🚫 ${verdict.reason}\n${RULE}\n` +
      `You asked: "${raw.slice(0, 140)}"\n\n` +
      `Nothing was sent to any device. This squad is read-only against real kit by design — ` +
      `I can run ${READ_VERBS.join(' / ')} and nothing else.`);
    ctx.updateAgentStatus(agentId, 'idle', 'Blocked a non-read-only command');
    return;
  }

  await runLive(agentId, 'Config read', `Running "${verdict.command}"`, async () => {
    say(agentId,
      `📋 You asked: "${raw.slice(0, 140)}"\n` +
      `I read that as the read-only command: "${verdict.command}" — guardrail passed.\n` +
      `Submitting to Catalyst Center Command Runner — ${catalyst.host}...`);

    const devices = await catalyst.getDevices();
    const target = devices.find((d) => d.reachability === 'Reachable');
    if (!target) throw new Error('no reachable device to read from');

    say(agentId, `🎯 Target: ${target.hostname} (${target.ip}, ${target.platform}). Sandbox Command Runner is slow — this can take up to a minute.`);

    const file = await catalyst.runShowCommand([target.id], verdict.command);
    const out = extractCommandOutput(file, verdict.command);
    const body = out ? String(out.text).slice(0, 2000) : JSON.stringify(file).slice(0, 1200);
    say(agentId,
      `📡 ${target.hostname} — ${verdict.command}\n${RULE}\n${body}\n${RULE}\n` +
      (out && out.ok === false
        ? `⚠️ The device rejected that command. Real output above — nothing was invented, and no configuration was sent.`
        : `Real output, read live. No configuration was sent.`));
  });
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
  if (!m) return { command: null };

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
    if (/running[\s-]?conf(ig)?/.test(t)) return { command: 'show running-config' };
    if (/start(up)?[\s-]?conf(ig)?/.test(t)) return { command: 'show startup-config' };
    if (/\b(version|software|ios|firmware)\b/.test(t)) return { command: 'show version' };
    if (/\binterface/.test(t)) return { command: 'show ip interface brief' };
    if (/\binventor(y|ies)\b/.test(t)) return { command: 'show inventory' };
  }

  return { command: frag };
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
      return `Live from ${catalyst.label} (${catalyst.host}) just now: ` +
        `${devices.length - down.length}/${devices.length} devices reachable` +
        (devices.length ? ` — ${devices.map((d) => `${d.hostname} (${d.platform}, ${d.reachability})`).join('; ')}` : '') +
        (health ? `. Network health score ${health.score} (good ${health.good} / bad ${health.bad})` : '') +
        `.\nThat is the campus state anyone planning ${shortTopic(topic)} is working against. ` +
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
        return `Live from the APIC (${aci.host}): ${nodes.length} fabric node(s) — ` +
          `${nodes.map((n) => `${n.name} ${n.role} ${n.state}`).join('; ')}` +
          (health.score != null ? `. Fabric health ${health.score}` : '') +
          (tenants.length ? `. ${tenants.length} tenant(s): ${tenants.map((t) => t.name).join(', ')}` : '') +
          `.\nThat is the fabric ${shortTopic(topic)} would land on. I have not measured convergence or ` +
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
  debateContribution,
};
