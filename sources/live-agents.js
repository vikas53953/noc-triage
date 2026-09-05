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
// CW-5 — the reviewed direct-SSH engine. Wired in at the ONE choke point
// (executeDeviceCli) so SSH-transport devices route here while the DNAC switches
// stay on Command Runner. The registry inside decides transport PER DEVICE; the
// command text never does. runShow never throws and never fabricates.
const sshRunner = require('./ssh-runner');
const session = require('./session-log');
const approvals = require('./approvals');
const guardrails = require('./guardrails');
const { checkCommand, checkIntent, splitIntent, commandWord, READ_VERBS } = guardrails;
// QA Class 9 — the read-only window onto THIS console's OWN incidents. The chat
// brain used to be blind to incidents this very app minted; Incident-Handler now
// reads them from here alongside its external sources. Read-only by construction:
// this module has no write path into the triage engine.
const incidentRead = require('./incident-read');

// The host app injects its broadcast/status/task-board plumbing here so this
// module stays free of server internals.
let ctx = null;
function init(hostCtx) { ctx = hostCtx; }

const say = (agentId, text) => ctx.say(agentId, text);
const RULE = '──────────────────────────────────';

// ── CW-9: the terminal-evidence envelope ────────────────────────────────────
// Every read a delegated agent performs must come back with the evidence behind
// it — the host, the exact command (or API read), the RAW output (already
// secret-scrubbed by the session log) and an HONEST transport label. A Command
// Runner read is 'cmdrunner'; only a real SSH session is 'ssh'; everything else
// is an 'api' read. Nothing here changes what runs, what is gated or what is
// scrubbed — it only carries what ALREADY happened up to the bridge so the chat
// can show a real terminal instead of a wall of prose.
//
// ATTRIBUTION IS PER-DELEGATION, AT WRITE TIME (reviewer blocker #3, 2026-08-20).
// The first cut swept the GLOBAL session log by a sequence watermark, so two
// overlapping reads could hand one delegation's wire records to another — a
// finding showing a command that agent never ran, which is fabrication. Now every
// collection opens a scope id, session-log stamps that id onto each wire record it
// writes underneath (contexts nest), and the collector keeps ONLY the records
// carrying its own id. A delegation that read nothing comes back with nothing,
// however many other reads ran at the same time.
const { AsyncLocalStorage } = require('async_hooks');
const evidenceAls = new AsyncLocalStorage();
let evidenceSeq = 0;

function evidenceBag() { return evidenceAls.getStore() || null; }

// Record ONE real device-CLI run as terminal evidence. Called from the choke
// point only, with the values it actually used.
function pushCliEvidence({ host, command, output, transport, line, source }) {
  const bag = evidenceBag();
  if (!bag) return;
  bag.entries.push({
    host: String(host || 'unknown host'),
    command: String(command || ''),
    output: output == null ? '' : String(output),
    transport: transport === 'ssh' ? 'ssh' : 'cmdrunner',
    // Which SOURCE SYSTEM this read touched. The bridge checks the roster it
    // announced against these, so a "standing down" claim can be verified
    // against what was actually read instead of being taken on trust.
    source: source || (transport === 'ssh' ? 'ssh' : 'catalyst-center'),
    line: line ? String(line) : '',
    ts: new Date().toISOString(),
  });
}

// Everything else this delegation read is an API call, and the session log
// already holds it (host, path, raw body, plain-words interpretation). Records
// are selected by THIS scope's id — never by position in a shared log. Auth
// exchanges are excluded (their bodies are never kept) and the Command Runner
// hops are excluded because the CLI push above already carries that read as one
// clean block instead of four transport hops.
function apiEvidenceFor(evidenceId) {
  return session.all()
    .filter((r) => r.evidenceId === evidenceId)
    .filter((r) => r.kind !== 'reasoning' && r.kind !== 'login')
    .filter((r) => !(r.kind === 'command-runner' || r.kind === 'poll' || r.kind === 'output'))
    .map((r) => ({
      host: r.host || r.sourceLabel || 'unknown host',
      command: r.command || r.path || '',
      output: r.raw == null ? '' : String(r.raw),
      transport: 'api',
      source: r.source || 'unknown',
      line: r.interpretation || '',
      ts: r.ts,
    }));
}

/**
 * Run `fn` and collect the terminal evidence every read inside it produced.
 * Returns { result, cli: [{host, command, output, transport, source, line, ts}] }.
 * Evidence is attributed by scope id, so concurrent collections never mix.
 */
async function collectCliEvidence(fn) {
  const id = `ev-${Date.now().toString(36)}-${(++evidenceSeq).toString(36)}`;
  const bag = { id, entries: [] };
  return evidenceAls.run(bag, () => session.runWithContext({ evidenceId: id }, async () => {
    const result = await fn();
    const cli = bag.entries.concat(apiEvidenceFor(id))
      .sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
    return { result, cli };
  }));
}

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

// ── Router-Expert — ACI fabric (Nexus) AND SD-WAN overlay ───────────────────
// Class 1 (2026-08-18): the ACI_WORDS keyword fork is GONE. It used to route the
// WHOLE answer to EITHER the APIC or vManage based on a keyword — so a request
// that spanned both ("the vManage overlay and the ACI fabric") came back
// APIC-only, one source silently dropped. Router-Expert owns BOTH sources, so it
// now reads BOTH and reports BOTH; nothing keyword-decides which one the operator
// "meant". The tenant audit still keys off an explicit "tenant <name>" token in
// the command, inside routerExpertAci.
async function routerExpert(agentId, command) {
  await routerExpertAci(agentId, command);
  await routerExpertSdwan(agentId);
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
      `(For a tenant walk on the ACI fabric, name it — "audit tenant <name>".)`);
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
//   3. THE TARGET — resolved, or ASKED ABOUT. The device is resolved against the
//      live inventory and the command runs on THAT box. AMBIGUITY → ASK, NEVER
//      ASSUME (Vikas's law, 2026-08-17): exactly one candidate can serve the ask
//      → run it. NO candidate → the honest "no such device" refusal. SEVERAL
//      candidates — a prefix like "sw", or nothing named at all — → run NOTHING,
//      list the real candidates (hostname, mgmt IP, reachability, read live) and
//      ASK which one. Guessing "the first reachable one" and saying so out loud
//      is still a guess: it is a wrong answer wearing a right answer's clothes,
//      and a senior engineer would ask instead. The operator's answer ("sw2",
//      "2", "the second one", or "all") is resolved by resumeClarification()
//      below and REMEMBERED for the rest of that conversation, so follow-ups
//      ("now show the interfaces") land on the same box until another is named.
//   4. THE PERMISSION GATE, wrapped around the wire calls themselves. Putting it
//      here rather than in each caller is what makes "deny = zero wire calls"
//      true for every caller, including ones written after this line. Gates
//      nest re-entrantly (see approvals.js), so an outer caller that already
//      gated the same request does not prompt the operator twice.
//
// Returns a structured result; callers only render it.
//   { refused, kind, text }            — nothing ran (write intent / no command /
//                                        guardrail / unknown or unreachable device /
//                                        AMBIGUOUS target — see rule 3 below)
//   { denied: true, command }          — the operator denied it; zero wire calls
//   { ok, command, target, body, note} — it ran; body is the REAL device output
//   { ok, multi: true, runs: [...] }   — the operator said "all"; one real run per box
// A refused write, built in ONE place. The audit record is written here — at
// the DECISION — rather than in whichever renderer happens to run next, because
// the renderers differ (direct chat calls refuseWrite, a debate contribution
// only prints text) and a refusal that reaches the quieter renderer used to
// leave no trace at all. `intent.audited` tells refuseWrite this one is already
// on the record, so a refusal is logged exactly once, never twice.
function writeRefusal(agentId, raw, change, refusedChange) {
  const intent = { ...(change || {}), audited: true };
  auditRefusedWrite(agentId, raw, intent);
  return { refused: true, kind: 'write', intent, command: null, refusedChange: refusedChange || null };
}

async function executeDeviceCli({ agentId, request, purpose, announce, device, all, planDevice }) {
  const raw = String(request || '');
  // CLASS 2: a structured target from the planner ("device" field). Trusted the
  // same way a name typed in the request is — it IS the operator's named device,
  // just carried as a field instead of buried in reworded prose. A blank/whitespace
  // value is treated as "not provided" so it falls back to the text parse below.
  const planTarget = (typeof planDevice === 'string' && planDevice.trim()) ? planDevice.trim() : null;
  const agentName = (ctx.agents[agentId] && ctx.agents[agentId].name) || agentId;

  // 1. Write intent, on the whole raw request.
  //
  // CW-2 pre-work 2 — COMPOUND "read then change". "reload sw1 then show me the
  // version" is two asks. The old code refused the whole sentence, which is safe
  // but drops the read without a word; running the whole sentence would be a
  // write. So the sentence is SPLIT: the change half is refused OUT LOUD, and
  // the read half is honoured — but only from the read clauses, rebuilt without
  // a single character of the change half, so nothing from it can reach the
  // parser or the wire. The reply says both things happened.
  const split = splitIntent(raw);
  if (split.destructive && !split.compound) {
    return writeRefusal(agentId, raw, split.change, null);
  }
  const refusedChange = split.compound ? split.change : null;
  // THE SAME SINK, for the change half of a COMPOUND ask. A compound refusal is
  // still a refused write, so it belongs on the record here — at the DECISION —
  // for the same reason the whole-request refusal does: the renderers differ,
  // and the one that runs next may never run at all. When the read half throws
  // (source unreachable) the caller's catch said only "source unreachable", and
  // the refused change vanished — no message, no activity line, no audit. Said
  // and recorded here, it survives whatever happens to the read.
  if (refusedChange) {
    auditRefusedWrite(agentId, raw, { ...refusedChange, compound: true });
    if (announce) say(agentId, changeRefusalText(refusedChange).trimEnd());
  }
  // From here on the ONLY text considered is the read half.
  const readOnlyText = refusedChange ? split.readText : raw;

  // 2. Parse a read command out of the plain English.
  const read = readCommandFrom(readOnlyText);
  if (!read.command) {
    // THE REFUSAL SINK. No read command came out of the text — but the reply
    // "I could not find a read command in that" is the WRONG thing to say to an
    // operator who asked for a CHANGE. They did not fail to name a read; they
    // named a change, and the honest answer is that this path is read-only.
    // Asked here, at the one place the no-command reply is produced, so every
    // caller gets the right message instead of each one guessing.
    const changeAsk = guardrails.looksLikeChangeAsk(readOnlyText);
    if (changeAsk.destructive) return writeRefusal(agentId, raw, changeAsk, refusedChange);
    return { refused: true, kind: 'no-command', note: read.note || null, refusedChange };
  }

  // 2a. Guardrail on the RAW fragment first — chaining/redirection characters
  //     ("; & | > < ` $" and newlines) are still present at this point. The
  //     canonicalised string below has had its whitespace flattened, so a
  //     newline-separated second command would have been invisible to it.
  const rawVerdict = checkCommand(read.rawFragment || read.command);
  if (!rawVerdict.allowed) return { refused: true, kind: 'guardrail', reason: rawVerdict.reason, refusedChange };
  const verdict = checkCommand(read.command);
  if (!verdict.allowed) return { refused: true, kind: 'guardrail', reason: verdict.reason, refusedChange };

  // 3. Which box did the operator name? Parsed from the text alone (no wire
  //    call yet) so the approval record can name the target before anything runs.
  // WHICH BOX, on a compound ask. The device belongs to the SENTENCE, not to a
  // clause: "reload sw2 then show me the version" names sw2 once and means it
  // for both halves. Reading the device out of the read half alone answered
  // with sw1 — the first reachable box — which is the wrong-answer-in-right-
  // clothes this path exists to prevent. So the read half is asked first (it
  // wins if it names its own box) and the full sentence is the fallback.
  let namedAll = namedDevicesIn(readOnlyText);
  if (!namedAll.length && refusedChange) {
    const fromWholeSentence = namedDevicesIn(raw);
    const fromChangeClause = deviceInChangeClause(refusedChange);
    namedAll = fromWholeSentence.length ? fromWholeSentence : (fromChangeClause ? [fromChangeClause] : []);
  }
  // More than one box named ("compare the running config of sw2 against sw3")
  // is a request this path cannot honour: Command Runner is driven here as one
  // command on one device, and running sw2 alone while the operator asked about
  // sw2 AND sw3 is half an answer presented as the whole one. Say so; run none.
  if (namedAll.length > 1) {
    return { refused: true, kind: 'multi-device', command: verdict.command, devices: namedAll,
      refusedChange,
      reason: `You named ${namedAll.length} devices (${namedAll.join(', ')}), and I run one command on one ` +
        `device at a time — so I ran nothing rather than answer for ${namedAll[0]} alone and let it look like ` +
        `the whole picture. Ask me for each box in turn ("${verdict.command} on ${namedAll[0]}", then ` +
        `"${verdict.command} on ${namedAll[1]}") and I will read both for real.` };
  }
  // The structured plan target wins over the text parse (that is the whole point
  // of CLASS 2), but only AFTER the multi-device guard above — if the operator
  // named two boxes in the text we still refuse rather than quietly run one.
  const named = planTarget || namedAll[0] || null;

  // 3a. What the operator pointed at, in the three shapes it can arrive in:
  //     a resolved choice handed back by resumeClarification (`device`), a
  //     concrete name in the text (`named`), a partial/loose hint ("on sw",
  //     "on the switches"), or "all". Nothing here touches the wire.
  const wantAll = Boolean(all) || (!device && !named && wantsAllDevices(raw));
  const hint = (!device && !named && !wantAll) ? deviceHintIn(raw) : null;
  // Nothing pointed at anything → the device this conversation already settled
  // on (rule 3: remembered until another is named). Never global: keyed by the
  // conversation id the surface sends.
  const remembered = (!device && !named && !wantAll && !hint) ? rememberedDevice() : null;

  // 3b. TRANSPORT ROUTING (CW-5). The device the operator pointed at either is an
  //     SSH-reachable box (the DevNet always-on sandboxes) or it is not. That is a
  //     property of the RESOLVED device — looked up in the ssh-runner registry —
  //     not a guess from the command text. When exactly one identity token points
  //     at an SSH device, this command runs over direct SSH; otherwise it falls
  //     through to the Catalyst Center Command Runner path exactly as before, so
  //     the DNAC switches sw1–sw4 (transport: command-runner) are untouched.
  //     "all" stays on Command Runner: it means "every reachable Catalyst switch",
  //     not the separate directly-reachable sandboxes.
  const sshIdentity = wantAll ? null : (device || named || hint || remembered || null);
  const sshMatch = sshIdentity ? sshRunner.resolveDevice(sshIdentity) : null;

  if (announce) {
    // Deliberately NOT "submitting…" — nothing has been submitted yet, and the
    // named device may not even exist. The submit line comes after resolution.
    const pointing =
      sshMatch ? `Target: ${sshMatch.device.label} — that box is directly reachable, so this runs over SSH, not Command Runner.`
      : device ? `Target you picked: ${device}. Checking it against the live inventory…`
      : named ? `Target named in your request: ${named}. Checking it against the live inventory…`
      : wantAll ? `You asked for every device. Reading the live inventory…`
      : hint ? `You pointed at "${hint}" — checking which devices that actually matches…`
      : remembered ? `No device named this time — checking ${remembered}, the box we have been working on…`
      : `No device named in your request. Reading the live inventory to see which devices could serve this…`;
    say(agentId,
      `📋 You asked: "${raw.slice(0, 140)}"\n` +
      `I read that as the read-only command: "${verdict.command}" — guardrail passed.\n` + pointing);
  }

  // 4. The gate wraps every wire call below: inventory read, command submit,
  //    task poll and output fetch. A denial runs none of them.
  const g = await approvals.gate({
    agentId, agentName,
    command: verdict.command,
    target: sshMatch ? `${sshMatch.device.label} (${sshMatch.device.host() || 'host not set'}) over direct SSH`
      : device ? `${device} (the device you picked) via Catalyst Center Command Runner`
      : named ? `${named} (named in the request) via Catalyst Center Command Runner`
      : wantAll ? 'every reachable Catalyst Center switch (you said "all") via Command Runner'
      : hint ? `whatever "${hint}" resolves to in the live inventory — if it matches more than one I will ask, not guess`
      : remembered ? `${remembered} (remembered from earlier in this conversation) via Command Runner`
      : 'a Catalyst Center switch — none named, so I will list the candidates and ask rather than pick one',
    reason: purpose || `operator asked: "${raw.slice(0, 80)}"`,
    cli: verdict.command,
  }, async () => {
    // TRANSPORT SPLIT (CW-5). Inside the SAME gate — so deny = zero wire on both
    // paths, and the outer guardrail + scrub already applied cover both. An SSH
    // device runs through the reviewed ssh-runner; everything else keeps the
    // Catalyst Center Command Runner path verbatim.
    if (sshMatch) return runSshTarget({ agentId, sshMatch, command: verdict.command, announce });
    const devices = await catalyst.getDevices();
    const pick = resolveTargetDevice(devices, device || named, { hint, remembered, wantAll });
    if (pick.error) return { unknownDevice: pick.error, detail: pick.error };
    if (pick.ambiguous) return { ambiguous: pick.ambiguous, detail: 'ambiguous target — asked the operator, ran nothing' };

    const targets = pick.all || [pick.target];
    if (announce) {
      say(agentId, `🎯 Target: ${targets.map((t) => `${t.hostname} (${t.ip}, ${t.platform})`).join(' · ')}` +
        (pick.note ? ` — ${pick.note}` : '') +
        `.\nSubmitting "${verdict.command}" to Catalyst Center Command Runner — ${catalyst.host}. ` +
        `The sandbox runner is slow; this can take up to a minute${targets.length > 1 ? ' per device' : ''}.`);
    }

    const runs = [];
    for (const target of targets) {
      const file = await catalyst.runShowCommand([target.id], verdict.command);
      const out = extractCommandOutput(file, verdict.command);
      // Scrub at the source: this string is about to become chat text, debate
      // text and a Jarvis finding. Anything credential-shaped in a device's own
      // output is redacted here, not at some later sink.
      const body = session.scrub(out ? String(out.text) : JSON.stringify(file)).slice(0, 2000);
      runs.push({ target, body, ok: !(out && out.ok === false) });
    }
    return {
      runs, multi: Boolean(pick.all), note: pick.note || null,
      detail: `${verdict.command} on ${runs.map((r) => r.target.hostname).join(', ')}`,
    };
  });

  if (g.denied) return { denied: true, command: verdict.command, refusedChange };
  const r = g.result || {};
  // An SSH dial that could not run for real — no creds, auth rejected, host
  // unreachable, host-key refused. It never fabricates: the gate approved, the
  // wire was attempted (or, for missing creds, honestly not attempted), and the
  // honest failure kind is carried straight back for the renderer to show.
  if (r.sshFailure) {
    return { ok: false, sshError: true, via: 'ssh', command: verdict.command,
      target: r.target, kind: r.sshFailure.kind, error: r.sshFailure.error, refusedChange };
  }
  if (r.unknownDevice) return { refused: true, kind: 'unknown-device', reason: r.unknownDevice, command: verdict.command, refusedChange };
  if (r.ambiguous) {
    // Ran NOTHING. Park the request so the operator's next word ("sw2", "2",
    // "all") finishes the job they actually asked for — the question is useless
    // if answering it makes them retype the command.
    rememberPendingChoice({
      agentId, request: raw, command: verdict.command, purpose,
      candidates: r.ambiguous.candidates,
    });
    return {
      refused: true, kind: 'ambiguous', command: verdict.command,
      candidates: r.ambiguous.candidates,
      reason: ambiguityQuestion(raw, verdict.command, r.ambiguous),
      refusedChange,
    };
  }
  const runs = r.runs || [];
  // CW-9: every real run becomes terminal evidence, with the transport it
  // ACTUALLY used — Command Runner is never dressed up as SSH.
  const transport = r.via === 'ssh' ? 'ssh' : 'cmdrunner';
  for (const run of runs) {
    pushCliEvidence({
      host: (run.target && (run.target.ip || run.target.hostname)) || 'unknown host',
      command: verdict.command,
      output: run.body,
      transport,
      source: transport === 'ssh' ? 'ssh' : 'catalyst-center',
      line: `${run.ok === false ? 'Device rejected' : 'Ran'} "${verdict.command}" on ` +
        `${(run.target && run.target.hostname) || 'the device'} over ` +
        `${transport === 'ssh' ? 'direct SSH' : `${catalyst.label} Command Runner`}.`,
    });
  }
  if (r.multi) return { ok: true, multi: true, command: verdict.command, runs, note: r.note, via: r.via || 'command-runner', refusedChange };
  const one = runs[0];
  // This conversation is now working on THIS box: a follow-up that names no
  // device lands here instead of starting the guessing game over. For an SSH
  // device we remember its registry key, which resolveDevice maps straight back
  // to the same box, so "now show the interfaces" stays on SSH.
  if (one) rememberDevice(one.target.hostname);
  return { ok: true, command: verdict.command, target: one.target, note: r.note, body: one.body, deviceOk: one.ok, via: r.via || 'command-runner', refusedChange };
}

// ── The SSH branch of the choke point (CW-5) ─────────────────────────────────
// Runs INSIDE the permission gate, so a denied read never reaches here. The
// guardrail already ran twice in executeDeviceCli before the gate; ssh-runner
// re-checks it a third time and the Python sidecar a fourth — belt and braces,
// never a substitute for the choke-point gate. Returns the SAME shape the
// Catalyst branch returns, so the post-gate interpreter and every renderer treat
// both transports identically:
//   success  → { runs:[{target,body,ok}], multi:false, note, via:'ssh' }
//   failure  → { sshFailure:{kind,error}, target, via:'ssh' }
// runShow never throws and never fabricates: with no creds it returns a clear
// "not connected" WITHOUT touching the wire; with creds it runs a real show.
async function runSshTarget({ agentId, sshMatch, command, announce }) {
  const dev = sshMatch.device;
  const target = { hostname: sshMatch.key, ip: dev.host() || null, platform: dev.platform };
  if (announce) {
    say(agentId, `🎯 Target: ${dev.label} (${dev.host() || 'host not set'}, ${dev.platform}).\n` +
      `Running "${command}" over direct SSH (read-only). DevNet retired the static public passwords, ` +
      `so without SSH creds in .env.local this returns an honest "auth needed", never a made-up result.`);
  }
  const res = await sshRunner.runShow(sshMatch.key, command);
  if (res.ok) {
    // runShow already scrubbed its output (structural + value + config redactor).
    // session.scrub again for parity with the Command Runner branch — double
    // scrubbing is harmless and keeps one guarantee, not two that can drift.
    const body = session.scrub(String(res.text || '')).slice(0, 2000);
    return {
      runs: [{ target, body, ok: true }], multi: false, via: 'ssh',
      note: `read live over direct SSH (${res.engine || 'ssh'}${res.elapsed != null ? `, ${res.elapsed}s` : ''})` +
        (res.truncated ? ' — output truncated at the cap' : ''),
      detail: `${command} on ${sshMatch.key} over SSH`,
    };
  }
  return { sshFailure: { kind: res.kind || 'error', error: res.error || 'SSH read failed' }, target, via: 'ssh',
    detail: `${command} on ${sshMatch.key} over SSH — ${res.kind || 'error'}` };
}

// Plain-words rendering of an SSH failure, shared by the direct chat path and
// cliResultText so the same honest message reads the same everywhere. Never a
// fabricated result — every branch says nothing was invented.
function sshFailureText(res) {
  const dev = res.target || {};
  const where = dev.hostname ? `${dev.hostname}${dev.ip ? ` (${dev.ip})` : ''}` : 'the SSH device';
  const head = (() => {
    switch (res.kind) {
      case 'not-connected':
        return `🔑 Auth needed — I ran nothing.\nThis box is SSH-reachable, but its credentials are not in ` +
          `.env.local, so I cannot log in. DevNet retired the static public passwords: reserve the always-on ` +
          `sandbox and add SSH_…_USER / SSH_…_PASS, then I will run "${res.command}" for real.`;
      case 'auth':
        return `🔑 SSH authentication was rejected by ${where}, so I ran nothing on it.`;
      case 'hostkey':
        return `🛑 The SSH host key for ${where} was not trusted, so I refused the connection rather than ` +
          `risk handing the password to an impostor. Nothing was sent.`;
      case 'dns':
      case 'unreachable':
        return `🔌 ${where} was unreachable over SSH, so I ran nothing.`;
      case 'blocked':
        return `🚫 The SSH engine refused that command as not read-only. Nothing was sent to any device.`;
      default:
        return `⚠️ The SSH read did not complete against ${where}, so I ran nothing.`;
    }
  })();
  return `${head}\n${RULE}\nReason: ${res.error}\nNothing was sent to the device, and I did not invent a result.`;
}

// ── Conversation memory + the parked question ───────────────────────────────
// Scope: ONE chat conversation (the id the surface sends with the command).
// Never global, never shared between operators, never persisted — a device the
// operator settled on in one conversation must not silently steer another.
const deviceMemory = new Map();   // conversationId -> hostname
const pendingChoice = new Map();  // conversationId -> parked request awaiting a pick
// QA CLASS 9 — the incident this conversation is working on, remembered for
// follow-ups ("who's on it?", "summarise it") exactly like the device above, and
// scoped exactly as narrowly: one conversation, never global, never shared.
const incidentMemory = new Map(); // conversationId -> INC-…/trg-… id

function conversationId() {
  try { return (ctx && typeof ctx.conversationId === 'function' && ctx.conversationId()) || 'default'; }
  catch (e) { return 'default'; }
}
function rememberDevice(hostname) { if (hostname) deviceMemory.set(conversationId(), String(hostname)); }
function rememberedDevice() { return deviceMemory.get(conversationId()) || null; }
function rememberIncident(id) { if (id) incidentMemory.set(conversationId(), String(id)); }
function rememberedIncident() { return incidentMemory.get(conversationId()) || null; }
function forgetConversation() {
  deviceMemory.delete(conversationId());
  pendingChoice.delete(conversationId());
  incidentMemory.delete(conversationId());
}

// Which of THIS console's own incidents does this sub-question point at?
//   1. the planner's STRUCTURED incident id (`hint`) — the reliable path, the
//      same idiom as the structured `device` field CLASS 2 established;
//   2. otherwise any incident id the operator quoted in the sub-question — pure
//      identity resolution over an id this console mints, never intent guessing;
//   3. otherwise the incident THIS conversation already settled on.
// Nothing is invented: an id that resolves to no record is still returned, and
// incidentRead.recordText() answers it with a plain "no such incident".
function ownIncidentIdsFor(topic, hint) {
  const fromPlan = typeof hint === 'string' && incidentRead.idsMentionedIn(hint).length
    ? incidentRead.idsMentionedIn(hint)
    : [];
  if (fromPlan.length) { rememberIncident(fromPlan[0]); return fromPlan; }
  const quoted = incidentRead.idsMentionedIn(topic);
  if (quoted.length) { rememberIncident(quoted[0]); return quoted; }
  const remembered = rememberedIncident();
  return remembered ? [remembered] : [];
}
function rememberPendingChoice(p) { pendingChoice.set(conversationId(), { ...p, at: Date.now() }); }
function pendingChoiceNow() { return pendingChoice.get(conversationId()) || null; }

// The question itself. Built here, in the choke point, so every surface — direct
// chat, an @mention, a Jarvis delegation — asks the SAME question with the SAME
// real candidate list, and none of them can paraphrase the options away.
function candidateLine(c) {
  return `• ${c.hostname} — ${c.ip || 'mgmt IP not reported'} — ${c.reachability || 'reachability not reported'}`;
}
function ambiguityQuestion(raw, command, amb) {
  const list = amb.candidates || [];
  const names = list.map((c) => c.hostname);
  return `Which device? I ran nothing.\n${RULE}\n` +
    `You asked: "${String(raw).slice(0, 140)}"\n` +
    `${amb.why} I am not going to pick one for you and pass its output off as the answer.\n\n` +
    `Live from ${catalyst.label} (${catalyst.host}) just now:\n` +
    `${list.map(candidateLine).join('\n')}\n\n` +
    `Reply with a name ("${names[0] || 'sw1'}"), its number ("2"), or "all" to run it on every reachable one. ` +
    `"${command}" is ready to go — nothing has been sent to any device yet.`;
}

// Plain-words rendering of a choke-point result. Shared by every caller so the
// same refusal reads the same way in chat, in a debate and in a Jarvis finding.
// The change half of a compound ask, refused OUT LOUD. Prepended to whatever
// happened to the read half, so the operator is never left assuming the change
// went through because the read did.
function changeRefusalText(refusedChange) {
  if (!refusedChange) return '';
  return `🚫 I did NOT do the change you asked for — "${refusedChange.keyword}"` +
    (refusedChange.clause && refusedChange.clause.toLowerCase() !== refusedChange.keyword
      ? ` (in "${String(refusedChange.clause).slice(0, 80)}")` : '') +
    `. That changes device state, and this path is read-only.\n` +
    `Changes go through the change engine (POST /api/copilot/change), which wraps every one in an ` +
    `approval, a before/after capture, a diff, a validation and a rollback plan.\n` +
    `What follows is the READ half of your request only — so it shows the device AS IT IS NOW, ` +
    `not as it would be after the change I refused.\n${RULE}\n`;
}

// Which transport actually served (or would have served) this read, in plain
// words. Command Runner unless the choke point routed the box over direct SSH.
function viaLabel(res) {
  return res && res.via === 'ssh' ? 'direct SSH' : `${catalyst.label} Command Runner`;
}

function cliResultText(res, raw) {
  if (!res) return 'Nothing ran.';
  if (res.refusedChange) return changeRefusalText(res.refusedChange) + cliResultText({ ...res, refusedChange: null }, raw);
  // An SSH dial that could not run — no creds / auth / unreachable / host-key.
  // Honest, never fabricated, and it carries its own explanation.
  if (res.sshError) return sshFailureText(res);
  if (res.denied) {
    return `Read denied by the operator — ran nothing. The command "${res.command}" was not approved, ` +
      `so nothing was sent to any device and I will not invent a result.`;
  }
  if (res.refused) {
    if (res.kind === 'write') {
      return `That is a change to the device, and I am read-only — so I did not do it. ` +
        `What I refused: "${res.intent.keyword}"` +
        (res.intent.clause ? ` — in "${String(res.intent.clause).slice(0, 80)}"` : '') +
        `. Nothing was sent to any device, and I did NOT run something else in its place. ` +
        `I can show you the device as it is now instead.`;
    }
    if (res.kind === 'guardrail') return `${res.reason} Nothing was sent to any device.`;
    // The ambiguity question travels VERBATIM into a Jarvis finding, so the
    // operator sees the real candidate list rather than a paraphrase of it.
    if (res.kind === 'unknown-device' || res.kind === 'multi-device' || res.kind === 'ambiguous') return res.reason;
    return (res.note ? `${res.note} ` : '') +
      `I could not find a read command in that, so I ran nothing — I will not answer a different ` +
      `question than the one you asked. I can run ${READ_VERBS.join(' / ')} against real kit.`;
  }
  if (res.multi) {
    return `You asked for every device, so I ran "${res.command}" on each reachable one via ` +
      `${viaLabel(res)} — real output per box, labelled:\n` +
      res.runs.map((r) =>
        `── ${r.target.hostname} (${r.target.ip}) ──\n${r.body}` +
        (r.ok === false ? `\n(The device rejected the command — real output above, nothing invented.)` : '')
      ).join('\n\n');
  }
  return `Ran "${res.command}" live on ${res.target.hostname} (${res.target.ip}, ${res.target.platform}) ` +
    `via ${viaLabel(res)}` + (res.note ? ` — ${res.note}` : '') + `:\n${res.body}\n` +
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

// EVERY device named in the request, de-duplicated and in the order typed. The
// caller needs all of them: silently taking the first one is how "compare sw2
// against sw3" turns into half an answer wearing a whole answer's clothes.
const DEVICE_TOKEN = '(?:\\d{1,3}(?:\\.\\d{1,3}){3}|[a-z][a-z0-9_-]*\\d[a-z0-9._-]*)';
// A second device usually arrives as a LIST, not a second preposition: "on sw2
// and sw3", "on sw2, sw3", "of sw2 vs sw3". Missing those is what turns a
// two-box request into a one-box answer nobody was told about.
const DEVICE_LIST_MORE = new RegExp(`\\b(?:and|or|vs\\.?|versus|against|,)\\s+(?:the\\s+)?(?:device\\s+|switch\\s+|router\\s+|host\\s+|box\\s+)?(${DEVICE_TOKEN})\\b`, 'ig');

function namedDevicesIn(text) {
  const raw = String(text || '');
  DEVICE_MENTION.lastIndex = 0;
  let m;
  const hits = [];
  let firstAt = -1;
  while ((m = DEVICE_MENTION.exec(raw)) !== null) {
    const tok = m[1].toLowerCase();
    if (firstAt < 0) firstAt = m.index;
    if (!hits.includes(tok)) hits.push(tok);
  }
  // Only look for list continuations once a device position has been
  // established, so "ping 8.8.8.8 and 1.1.1.1" (two ping TARGETS, no device
  // named) is not mistaken for two boxes.
  if (firstAt >= 0) {
    DEVICE_LIST_MORE.lastIndex = firstAt;
    let n;
    while ((n = DEVICE_LIST_MORE.exec(raw)) !== null) {
      const tok = n[1].toLowerCase();
      if (!hits.includes(tok)) hits.push(tok);
    }
  }
  return hits;
}

// In a CHANGE clause the box is the verb's OBJECT, not a prepositional phrase:
// "reload sw2" names sw2 without ever saying "on". namedDevicesIn deliberately
// ignores that shape (it would misread "ping 8.8.8.8" as a device), so the
// compound path asks for it explicitly — and only for the clause it already
// knows is a command, with the change verb itself as the anchor.
function deviceInChangeClause(change) {
  if (!change || !change.clause || !change.keyword) return null;
  const re = new RegExp(`\\b${change.keyword}\\b\\s+(?:the\\s+)?(?:device|switch|router|host|box)?\\s*(${DEVICE_TOKEN})\\b`, 'i');
  const m = re.exec(String(change.clause));
  return m ? m[1].toLowerCase() : null;
}

function namedDeviceIn(text) {
  const hits = namedDevicesIn(text);
  return hits.length ? hits[0] : null;
}

// "run it on all of them" / "on every switch" / a bare "all" as the answer to
// the question below. Only an explicit ALL counts — "the switches" is vague and
// must be asked about, not silently expanded to the whole estate.
const ALL_DEVICES = /\b(?:on\s+)?(?:all|every|each)\s+(?:of\s+)?(?:the\s+|them\b|those\s+)?(?:reachable\s+)?(?:devices?|switches|switch|boxes|box|kit|of\s+them)?\b/i;
function wantsAllDevices(text) {
  const t = String(text || '').trim().toLowerCase();
  if (/^(all|all of them|all devices|all switches|every one|everyone|each of them|both)[.!]?$/.test(t)) return true;
  if (/\b(?:on|for|across)\s+(?:all|every|each)\b/.test(t)) return true;
  return /\b(?:all|every|each)\s+(?:of\s+the\s+)?(?:the\s+)?(?:devices?|switches|boxes)\b/.test(t);
}

// A LOOSE device pointer — the thing the strict namedDevicesIn() cannot see
// because it carries no digit: "on sw", "of core", "on the switches". This is
// exactly the shape that used to fall through to "no device named → first
// reachable". It is not an answer; it is the reason to ask.
// Generic English is NOT a pointer: "on the switches" names no box, and is
// handled by the same "several candidates → ask" branch as naming nothing.
const HINT_MENTION = /\b(?:on|of|from|against|for)\s+(?:the\s+)?(?:device\s+|switch\s+|router\s+|host\s+|box\s+)?([a-z][a-z0-9_.-]*)\b/i;
const GENERIC_WORDS = new Set([
  'the', 'a', 'an', 'it', 'them', 'they', 'this', 'that', 'those', 'these', 'device', 'devices',
  'switch', 'switches', 'router', 'routers', 'host', 'hosts', 'box', 'boxes', 'kit', 'gear',
  'network', 'fabric', 'campus', 'estate', 'everything', 'all', 'each', 'every', 'both',
  'me', 'us', 'my', 'our', 'please', 'now', 'again', 'live', 'production', 'prod',
]);
function deviceHintIn(text) {
  const m = HINT_MENTION.exec(String(text || ''));
  if (!m) return null;
  const tok = m[1].toLowerCase();
  if (GENERIC_WORDS.has(tok)) return null;
  return tok;
}

const hostOf = (d) => String(d.hostname || '').toLowerCase();
const shortOf = (d) => hostOf(d).split('.')[0];
const ipOf = (d) => String(d.ip || '').toLowerCase();
function candidatesOf(list) {
  return list.map((d) => ({ hostname: d.hostname, ip: d.ip, reachability: d.reachability }));
}

// Resolve what the operator pointed at against the LIVE inventory.
//
// Honest on every outcome:
//   • exactly one candidate  → run it (that is not a guess, it is the answer)
//   • no candidate           → the "no such device" refusal, with the real names
//   • several candidates     → { ambiguous } — the caller asks and runs NOTHING
//   • "all"                  → every reachable box, each output labelled
// It NEVER falls back to "the first reachable one": the operator asked about a
// device, and answering with a different one is wrong even when you admit it.
function resolveTargetDevice(devices, named, opts) {
  const list = Array.isArray(devices) ? devices : [];
  const { hint, remembered, wantAll } = opts || {};
  const reachable = list.filter((d) => d.reachability === 'Reachable');

  if (wantAll) {
    if (!reachable.length) {
      return { error:
        `You asked for every device, but Catalyst Center (${catalyst.host}) reports none of them reachable ` +
        `right now (${list.map((d) => `${d.hostname} ${d.reachability}`).join(', ') || 'no devices at all'}), so I ran nothing.` };
    }
    return { all: reachable, note: `you said "all", so I ran it on each reachable device in turn` };
  }

  const want = named ? String(named).toLowerCase() : (hint || remembered || null);
  const fromMemory = !named && !hint && Boolean(remembered);

  if (want) {
    const exact = list.find((d) => hostOf(d) === want || shortOf(d) === want || ipOf(d) === want);
    const matches = exact ? [exact]
      : list.filter((d) => shortOf(d).startsWith(want) || hostOf(d).startsWith(want) || ipOf(d).startsWith(want));

    if (!matches.length) {
      return { error:
        `There is no device called "${want}" in the live inventory, so I ran nothing. ` +
        `Catalyst Center (${catalyst.host}) currently knows: ` +
        `${list.map((d) => `${d.hostname} (${d.ip})`).join(', ') || 'no devices at all'}. ` +
        `I will not run your command on a different box and pass it off as the answer.` };
    }
    if (matches.length > 1) {
      return { ambiguous: {
        candidates: candidatesOf(matches),
        why: `"${want}" matches ${matches.length} devices in the live inventory, not one.`,
      } };
    }
    const match = matches[0];
    if (match.reachability !== 'Reachable') {
      return { error:
        `${match.hostname} (${match.ip}) is in the inventory but Catalyst Center reports it as ` +
        `"${match.reachability}", so I ran nothing. No output is better than another device's output.` };
    }
    return { target: match, note: fromMemory
      ? `you named no device, so I used ${match.hostname} — the box you picked earlier in this conversation. Name another and I will switch.`
      : exact ? `the device you named`
      : `the only device in the inventory matching "${want}"` };
  }

  // Nothing named, nothing remembered. One reachable box can serve the ask
  // unambiguously; more than one cannot, and picking is guessing.
  if (!reachable.length) {
    return { error:
      `You named no device, and Catalyst Center (${catalyst.host}) reports nothing reachable right now ` +
      `(${list.map((d) => `${d.hostname} ${d.reachability}`).join(', ') || 'no devices at all'}), so I ran nothing.` };
  }
  if (reachable.length === 1) {
    return { target: reachable[0], note: `you named no device, and ${reachable[0].hostname} is the only reachable one — no ambiguity to resolve` };
  }
  return { ambiguous: {
    candidates: candidatesOf(reachable),
    why: `You did not name a device, and ${reachable.length} reachable ones could serve that command.`,
  } };
}

// ── The operator answers the question ───────────────────────────────────────
// Called on EVERY message, on every surface, before anything else routes it. It
// does something only when THIS conversation has a parked question. That is what
// makes the ask worth asking: "sw2" finishes the original command instead of
// being read as a fresh, meaningless request.
//
// Returns false when the message is not an answer — the caller then routes it
// normally, so an ordinary sentence is never swallowed.
const ORDINAL_WORDS = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, last: -1 };

function resumeClarification(agentId, message) {
  const p = pendingChoiceNow();
  if (!p) return false;
  const text = String(message || '').trim();
  const t = text.toLowerCase().replace(/[.!?]+$/, '');
  const cands = p.candidates || [];

  // "forget it" — drop the parked command, run nothing.
  if (/^(cancel|never ?mind|forget it|forget that|drop it|stop|no thanks|nothing)$/.test(t)) {
    pendingChoice.delete(conversationId());
    say(p.agentId, `👍 Dropped it — "${p.command}" was never sent to any device.`);
    ctx.updateAgentStatus(p.agentId, 'idle', 'Operator cancelled — ran nothing');
    return true;
  }

  // A FRESH COMMAND SUPERSEDES THE PARKED ONE. This test has to run BEFORE the
  // name / number matches below, and that ordering IS the fix (QA, logged):
  // "show running-config on sw3" sent while "show version" was parked used to hit
  // the candidate-name match on "sw3" and replay the PARKED command — the
  // operator asked for the running-config and got a version read on a box they
  // named. A message that carries its own read command is not an answer to
  // "which device?" at any length; it is the operator moving on. We drop the
  // parked question, say so out loud (it was never sent anywhere), and let the
  // new request route normally.
  //
  // Class-level, not case-level: the rule is about the SHAPE of the message
  // (does it name its own command?), so it holds for every read verb, every
  // device name, and every phrasing — not just the one sentence QA found.
  if (isDeviceCliRequest(text)) {
    pendingChoice.delete(conversationId());
    say(p.agentId,
      `↪️ New request — dropping the question I had parked. "${p.command}" was never sent to any device.`);
    return false;
  }

  // "all" → run it on every reachable box, each output labelled.
  if (wantsAllDevices(t)) {
    pendingChoice.delete(conversationId());
    // CW-12: the read's own promise is returned (truthy), so the caller's
    // "answered" receipt waits for the read's last reply, not for this line.
    return configKeeper(p.agentId, p.request, { allDevices: true });
  }

  // A name or a management IP from the list we just showed.
  const byName = cands.find((c) => {
    const h = String(c.hostname || '').toLowerCase();
    const short = h.split('.')[0];
    return new RegExp(`(^|[^a-z0-9])(${escapeRe(h)}|${escapeRe(short)}|${escapeRe(String(c.ip || 'no-ip'))})([^a-z0-9]|$)`, 'i').test(t);
  });
  if (byName) return pickCandidate(p, byName);

  // "2", "#2", "number 2", "the second one", "the last one".
  const num = /^(?:the\s+)?(?:#|no\.?\s*|number\s*|option\s*)?(\d{1,2})(?:st|nd|rd|th)?(?:\s+one)?$/.exec(t);
  const wordOrd = Object.keys(ORDINAL_WORDS).find((w) => new RegExp(`^(?:the\\s+)?${w}(?:\\s+one)?$`).test(t));
  let idx = null;
  if (num) idx = Number(num[1]);
  else if (wordOrd) idx = ORDINAL_WORDS[wordOrd] === -1 ? cands.length : ORDINAL_WORDS[wordOrd];
  if (idx != null) {
    if (idx >= 1 && idx <= cands.length) return pickCandidate(p, cands[idx - 1]);
    say(p.agentId,
      `🤔 There is no option ${idx} — I listed ${cands.length}. I ran nothing.\n${RULE}\n` +
      `${cands.map(candidateLine).join('\n')}\n\nReply with a name, a number 1–${cands.length}, or "all".`);
    return Promise.resolve(true);   // the line above IS the reply (sync) — CW-12
  }

  // Not an answer, but a whole new request (a full sentence — the command shape
  // is already handled above) → let go of the parked question and route it
  // normally. Never swallow it.
  if (t.split(/\s+/).length > 6) {
    pendingChoice.delete(conversationId());
    return false;
  }

  // Short and unclear ("the blue one", "yes") → ask again, with the same list.
  say(p.agentId,
    `🤔 I could not tell which device "${text.slice(0, 60)}" means, so I still ran nothing.\n${RULE}\n` +
    `${cands.map(candidateLine).join('\n')}\n\n` +
    `Reply with a name ("${cands[0] ? cands[0].hostname : 'sw1'}"), a number 1–${cands.length}, or "all". ` +
    `"${p.command}" is still waiting.`);
  return Promise.resolve(true);   // the line above IS the reply (sync) — CW-12
}

function pickCandidate(p, c) {
  pendingChoice.delete(conversationId());
  rememberDevice(c.hostname);
  say(p.agentId, `👍 ${c.hostname} it is — running "${p.command}" there now. I will keep using ${c.hostname} for follow-ups until you name another.`);
  // CW-12: return the read's promise so "answered" waits for its output.
  return configKeeper(p.agentId, p.request, { device: c.hostname });
}

function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// "forget the device" / "new conversation" — a deliberate reset the operator can
// ask for out loud, so a remembered box is never stuck to them.
const FORGET = /^(?:forget (?:the )?(?:device|it|that|sw\w*)|new conversation|start over|reset (?:the )?(?:context|conversation|device))$/i;
function maybeForget(agentId, message) {
  if (!FORGET.test(String(message || '').trim())) return false;
  const had = rememberedDevice();
  forgetConversation();
  say(agentId, had
    ? `👍 Forgotten — I am no longer assuming ${had}. Name a device with your next command, or I will ask.`
    : `👍 Nothing to forget — I was not holding a device for this conversation.`);
  return true;
}

// ── Config-Keeper — real show output via Catalyst Center Command Runner ──────
// The direct chat path. All the safety lives in executeDeviceCli above; this
// function is presentation plus the task board.
async function configKeeper(agentId, command, opts) {
  const raw = String(command || '');
  const { device, allDevices } = opts || {};
  const agentName = (ctx.agents[agentId] && ctx.agents[agentId].name) || agentId;
  const taskTitle = 'Config read';

  ctx.updateAgentStatus(agentId, 'active', 'Reading a device via Command Runner');
  try { ctx.addTaskToBoard('inProgress', { title: taskTitle, agent: agentName }); } catch (e) { /* board must never block a read */ }

  try {
    const res = await executeDeviceCli({
      agentId, request: raw, announce: true, device, all: allDevices,
      purpose: `operator asked: "${raw.slice(0, 80)}"`,
    });

    // COMPOUND ask: the change half is refused OUT LOUD and put on the record by
    // executeDeviceCli, at the moment it is decided — not here. Saying it here
    // meant the message and the activity line were lost whenever the read half
    // threw before returning. See the refusal sink in executeDeviceCli.

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
    } else if (res.refused && res.kind === 'ambiguous') {
      // AMBIGUITY → ASK. Nothing was submitted to Command Runner; the question
      // carries the real candidate list and the parked command.
      say(agentId, `🤔 ${res.reason}`);
      ctx.appendToActivityLog(
        `[${new Date().toISOString()}] [${agentName}] Ambiguous target — asked which device, ran nothing: "${raw.slice(0, 60)}"\n`);
      ctx.updateAgentStatus(agentId, 'idle', 'Asked which device — ran nothing');
    } else if (res.refused && (res.kind === 'unknown-device' || res.kind === 'multi-device')) {
      say(agentId, `🛑 I did not run that.\n${RULE}\n${res.reason}`);
      ctx.updateAgentStatus(agentId, 'idle',
        res.kind === 'multi-device' ? 'More than one device named — ran nothing' : 'Named device not resolvable — ran nothing');
    } else if (res.sshError) {
      // An SSH device that could not run — no creds / auth / unreachable / host
      // key. Honest, never fabricated. Same rendering as the shared helper.
      say(agentId, sshFailureText(res));
      ctx.appendToActivityLog(
        `[${new Date().toISOString()}] [${agentName}] SSH read did not run (${res.kind}) — nothing sent: "${raw.slice(0, 60)}"\n`);
      ctx.updateAgentStatus(agentId, 'idle',
        res.kind === 'not-connected' ? 'SSH creds needed — ran nothing' : `SSH ${res.kind} — ran nothing`);
    } else if (res.denied) {
      say(agentId,
        `🛑 Read denied by the operator — ran nothing.\n${RULE}\n` +
        `The command "${escapeForSay(res.command)}" was not approved, so I sent nothing to any device ` +
        `and I am not going to invent a result. Approve it in the approval panel and ask again to run it for real.`);
      ctx.appendToActivityLog(`[${new Date().toISOString()}] [${agentName}] ${taskTitle} DENIED by operator — ran nothing\n`);
      ctx.updateAgentStatus(agentId, 'idle', 'Read denied — ran nothing');
    } else if (res.multi) {
      // "all" — one labelled block per box, so no output can be mistaken for
      // another device's, and one share record per real run.
      for (const r of res.runs) {
        say(agentId,
          `📡 ${r.target.hostname} — ${res.command}\n${RULE}\n${r.body}\n${RULE}\n` +
          (r.ok === false
            ? `⚠️ ${r.target.hostname} rejected that command. Real output above — nothing invented, no configuration sent.`
            : `Real output, read live from ${r.target.hostname} (${r.target.ip}). No configuration was sent.`));
        session.emitCommandShare({
          agent: agentId, agentName, tier: null,
          purpose: `read "${res.command}" on ${r.target.hostname}`,
          command: res.command, raw: r.body,
          reasoning: `Operator asked for every device: "${raw.slice(0, 100)}". Parsed to the read-only CLI ` +
            `"${res.command}" (guardrail passed) and ran it on ${r.target.hostname} via ${viaLabel(res)}.`,
          conclusion: r.ok === false
            ? `${r.target.hostname} rejected "${res.command}" — real output above, nothing invented, no configuration sent.`
            : `Real "${res.command}" output read live from ${r.target.hostname} (${r.target.ip}). Read-only; no configuration sent.`,
          ok: r.ok !== false,
        });
      }
      ctx.updateAgentStatus(agentId, 'idle', `${taskTitle} complete on ${res.runs.length} devices (live data)`);
    } else {
      say(agentId,
        `📡 ${res.target.hostname} — ${res.command}\n${RULE}\n${res.body}\n${RULE}\n` +
        (res.deviceOk === false
          ? `⚠️ The device rejected that command. Real output above — nothing was invented, and no configuration was sent.`
          : `Real output, read live from ${res.target.hostname} (${res.target.ip}). No configuration was sent.`) +
        (res.note ? `\nWhy this device: ${res.note}` : ''));

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
          `(guardrail passed) and ran it on ${res.target.hostname} via ${viaLabel(res)}.`,
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
// Class 1 (2026-08-18): the NO_STORE keyword table is GONE. It used to trip on
// words like "snapshot"/"backup"/"baseline" ANYWHERE in the text and refuse to
// run — so "run show running-config on sw2 to snapshot it" returned an inventory
// blurb instead of the config the operator literally asked for. That was a
// deterministic substitution answering a different question than the one asked,
// exactly what the no-static-bindings law forbids. The command path now decides:
// if there is a real read verb in the text we run it; if there is not, we still
// say so honestly (the `!m` branch below), which is the only honest refusal here.
function readCommandFrom(text) {
  const raw = String(text || '');

  const m = /\b((?:show|ping|traceroute|dir|more)\b[\w\s|:/.\-]*)/i.exec(raw);
  // No read verb in the text means there is no command in the text. This
  // function does NOT infer one from a noun: "was there a version change last
  // week" is a question about HISTORY, and answering it with today's `show
  // version` is answering a question nobody asked — the exact substitution the
  // docblock above forbids. The caller says so honestly instead.
  if (!m) return { command: null };

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

  // Class fix (Finding 3, 2026-08-18): NO show-command substitution. This block
  // used to COLLAPSE the operator's command onto a different one — any
  // "show …interface…" became "show ip interface brief", "software/ios/firmware"
  // became "show version", and a qualifier like "show running-config interface
  // Gi1/0/3" was silently dropped down to the whole "show running-config". That
  // is the exact keyword-substitutes-a-different-read binding this PR exists to
  // kill: it ran the status-only brief when an operator asked "show interfaces"
  // for drop/CRC counters, and blocked a packet-drop diagnosis in review.
  //
  // We now run the command the operator ACTUALLY asked for. Expanding a shorthand
  // or fixing a malformed command is the planner/intent's job upstream, not a
  // hardcoded collapse here. If a device rejects a malformed command, the real
  // rejection is shown (honest) — never a stand-in command's output.
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
  // Class 1: no NO_STORE keyword veto here. A request that names an actual read
  // command ("run show running-config on sw2 to snapshot it") IS a device-CLI
  // run and reaches the runner; a request that names no command still returns
  // false below and is answered honestly. The verb decides, not a noun.
  if (PING_TRACE.test(t)) return true;
  if (CANON_SHOW.test(t)) return true;
  if (DIR_MORE.test(t)) return true;
  if (EXPLICIT_RUN.test(t)) return true;
  // Note what is NOT here: a bare device-read NOUN ("was there a version change
  // last week"). Treating a noun as a command made Config-Keeper answer a
  // question about the past with a reading from now. A request must name an
  // actual command — with a read verb, or an explicit run/execute — to be this
  // class; anything else keeps the honest "I found no read command in that".
  return false;
}

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
// THE SINGLE REFUSAL SINK for a write. Every path that decides "this is a
// change" ends here — the deterministic screen in server.js, the CLI choke
// point, the configure_device intent — so the message and the AUDIT RECORD are
// written in exactly one place. They used to be written per-branch, which is
// how a refused write on the no-command path left no trace at all: the operator
// was told nothing ran, and the audit log agreed by staying silent.
function refuseWrite(agentId, command, intent) {
  const named = intent && intent.keyword
    ? `What I refused: "${intent.keyword}"${intent.clause && intent.clause.toLowerCase() !== intent.keyword ? ` — in "${String(intent.clause).slice(0, 80)}"` : ''}. ` +
      `That changes device state.\n\n`
    : '';
  say(agentId,
    `🚫 That is a change to the device, and I am read-only — so I did not do it.\n${RULE}\n` +
    `You asked: "${String(command).slice(0, 140)}"\n\n` +
    named +
    `Nothing was sent to any device, and I did NOT run something else in its place.\n` +
    `I can show you the device AS IT IS NOW instead — ask me for "show running-config", ` +
    `"show version" or "show ip interface brief" on that box.\n` +
    `To actually make the change, use the change engine (POST /api/copilot/change): it wraps every ` +
    `change in an approval, a before/after capture, a diff, a validation and a rollback plan.\n` +
    `This squad is wired to real Cisco DevNet sandboxes with read-only access enforced in code ` +
    `(sources/guardrails.js) — only ${READ_VERBS.join(' / ')} reads get through.`);
  if (!(intent && intent.audited)) auditRefusedWrite(agentId, command, intent);
  ctx.updateAgentStatus(agentId, 'idle', 'Refused a write — read-only mode');
}

// One audit record per refused write, written HERE so no branch can forget it.
// Guarded end-to-end: an audit failure must never turn a clean refusal into a
// crash, but it must also never be the reason nothing was logged.
function auditRefusedWrite(agentId, command, intent) {
  const agentName = (ctx && ctx.agents && ctx.agents[agentId] && ctx.agents[agentId].name) || agentId;
  const what = String(command || '').slice(0, 60);
  const word = (intent && intent.keyword) ? intent.keyword : 'a state-changing request';
  // A COMPOUND ask ("reload sw2 then show version") has its change half refused
  // while the read half still runs, so this record must not claim nothing was
  // sent to any device — the read was. Every record has to be true on its own.
  const half = Boolean(intent && intent.compound);
  const tail = half
    ? 'refused the change half — only the read half was run'
    : 'nothing sent to any device';
  try {
    ctx.appendToActivityLog(
      `[${new Date().toISOString()}] [${agentName}] Refused a state-changing request ("${word}") — ` +
      `"${what}" — ${tail}\n`);
  } catch (e) { /* activity log must never break the refusal */ }
  try {
    session.audit({
      what: `ask: ${String(command || '').slice(0, 200)}`,
      result: `refused — change request ("${word}") on a read-only path ` +
        (half ? '(change half refused; the read half ran)' : '(zero device calls)'),
    });
  } catch (e) { /* audit store must never break the refusal */ }
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
    source: () => `this console's own incident record / ${catalyst.label} / ${aci.label}`,
    // QA CLASS 9 — the silo is closed here. `hint` is the STRUCTURED incident id
    // the planner resolved (same idiom as config-keeper's `device`); when the
    // planner names none, any id the operator quoted in the sub-question is
    // resolved as a fallback. THIS CONSOLE'S OWN incidents lead the finding —
    // they are the ones an operator means by "the latest incident" — and the
    // external sources follow. Every part is real live state or an honest gap.
    // Arg 2 is the planner's structured DEVICE (config-keeper's target) and is
    // meaningless here; arg 3 is the structured INCIDENT id. Positional, so no
    // caller has to branch on which agent it is talking to.
    async build(topic, _planDevice, hint) {
      const parts = [];

      // 1. This console's OWN incidents (the record the desk shows).
      try {
        const wanted = ownIncidentIdsFor(topic, hint);
        if (wanted.length) {
          // A named incident: the full honest record, or a plain not-found.
          parts.push(wanted.map((id) => incidentRead.recordText(id)).join('\n\n'));
          // Ground the named look-up in the wider list too, so a mistyped id can
          // be answered with the real ones rather than a dead end.
          parts.push(incidentRead.summaryText(12));
        } else {
          parts.push(incidentRead.summaryText(12));
        }
      } catch (e) {
        parts.push(`This console's own incident record could not be read (${e.message}), so I am not claiming anything about it.`);
      }

      // 2. Catalyst Center's open issues (external, unchanged).
      try {
        const issues = await catalyst.getIssues();
        parts.push(`Catalyst Center (${catalyst.host}) lists ${issues.length} open issue(s)` +
          (issues.length ? ` — ${issues.slice(0, 3).map((i) => `${i.priority} ${i.name} (${i.status}, seen ${i.occurrences}x)`).join('; ')}` : '') + '.');
      } catch (e) {
        parts.push(`Catalyst Center issue feed unreachable (${e.message}), so I have no open issues from it to add.`);
      }

      // 3. ACI fabric faults (external, unchanged).
      try {
        const faults = await aci.getFaults(['critical', 'major']);
        const crit = faults.filter((f) => f.severity === 'critical').length;
        parts.push(`ACI fabric (${aci.host}) has ${crit} critical and ${faults.length - crit} major fault(s)` +
          (faults.length ? ` — e.g. F${faults[0].code} ${String(faults[0].description || '').slice(0, 80)}` : '') + '.');
      } catch (e) {
        parts.push(`ACI fault feed unreachable (${e.message}), so I have no fabric faults to add.`);
      }

      return parts.join('\n\n') +
        `\n\nOn ${shortTopic(topic)}: the incidents above are this console's own record plus what the ` +
        `external sources report right now. I am citing nothing beyond them.`;
    },
  },

  'router-expert': {
    source: () => `${aci.label} / ${sdwan.label}`,
    async build(topic) {
      // Class 1 (2026-08-18): no ACI_WORDS fork. Router-Expert reads BOTH the ACI
      // fabric AND the SD-WAN overlay and reports both, so a delegated ask that
      // spans them ("the vManage overlay and the ACI fabric") never comes back
      // with one source silently dropped. Each source is read independently in
      // its own try/catch — one unreachable source is reported as such and does
      // NOT take the other down. Jarvis's synthesis decides which part answers.
      const parts = [];
      try {
        const nodes = await aci.getFabricNodes();
        const health = await aci.getFabricHealth().catch(() => ({ score: null }));
        const tenants = await aci.getTenants().catch(() => []);
        const epgs = await aci.getEpgs();
        parts.push(`Live from the APIC (${aci.host}): ${nodes.length} fabric node(s) — ` +
          `${nodes.map((n) => `${n.name} ${n.role} ${n.state}`).join('; ')}` +
          (health.score != null ? `. Fabric health ${health.score}` : '') +
          (tenants.length ? `. ${tenants.length} tenant(s): ${tenants.map((t) => t.name).join(', ')}` : '') +
          `.\nEPGs (endpoint groups) live on the fabric now — ${summariseEpgs(epgs)}`);
      } catch (e) {
        parts.push(`ACI fabric (APIC ${aci.host}) unreachable — ${e.message}. No fabric readings to add.`);
      }
      try {
        const devices = await sdwan.getDevices();
        const controllers = await sdwan.getControllers().catch(() => []);
        const alarms = await sdwan.getAlarmCount().catch(() => ({ active: 'n/a' }));
        parts.push(`Live from vManage (${sdwan.host}): ${devices.length} overlay device(s) — ` +
          `${devices.map((d) => `${d.hostname} ${d.type} ${d.state}`).join('; ')}` +
          (controllers.length ? `. Controllers: ${controllers.map((c) => c.hostname).join(', ')}` : '') +
          `. Active alarms: ${alarms.active}.`);
      } catch (e) {
        parts.push(`SD-WAN overlay (vManage ${sdwan.host}) unreachable — ${e.message}. No overlay readings to add.`);
      }
      return `${parts.join('\n\n')}\nThat is the fabric + overlay state behind ${shortTopic(topic)}. ` +
        `I have not measured convergence or traffic, so I am not asserting either.`;
    },
  },

  'config-keeper': {
    source: () => `${catalyst.label} (${catalyst.host})`,
    async build(topic, planDevice) {
      // A device CLI command ("run show version on sw1", "show running-config",
      // "ping <ip>") goes through executeDeviceCli — the SAME choke point the
      // direct chat path uses, which owns the write refusal, the read-only
      // guardrail, resolving the named device, the permission gate and the
      // secret scrub. That is what makes this branch safe for EVERY caller of
      // build(), including the debate path, which does no gating of its own.
      if (isDeviceCliRequest(topic)) {
        const res = await executeDeviceCli({
          agentId: 'config-keeper', request: topic,
          // CLASS 2: the planner's STRUCTURED device targets the box — not a
          // regex over the reworded sub-question. null falls back to the text
          // parse + ambiguity net inside executeDeviceCli.
          planDevice: planDevice || null,
          purpose: `run the command asked for in: "${String(topic || '').slice(0, 80)}"`,
        });
        // Whatever happened — ran, refused, denied — say THAT. Never quietly
        // fall through to an inventory read: answering a command with a
        // different reading is the substitution this file exists to prevent.
        //
        // The STANCE rides along, because a debate/triage roll-up counts
        // stances: a denied read reported as 'evidence' made Jarvis announce
        // "2 agents brought live readings" when one brought nothing. Nothing
        // that did not touch the wire is evidence.
        return {
          text: cliResultText(res, topic),
          stance: res.denied ? 'denied' : res.refused ? 'refused' : 'evidence',
        };
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
async function gatherForJarvis(agentId, question, planDevice, planIncidentId) {
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
          // planDevice (CLASS 2): the config-keeper builder uses it as the
          // STRUCTURED targets the planner resolved: arg 2 = the CLI device
          // (config-keeper), arg 3 = the incident id (incident-handler, CLASS 9).
          // Positional and additive — every other builder ignores both.
          () => builder.build(question, planDevice, planIncidentId),
        ));

      if (g.denied) {
        return {
          agentId, name, connected: true, stance: 'denied',
          text: 'Read denied by the operator — ran nothing, and I will not invent a result.',
        };
      }
      // Same rule as the debate path: a builder that hands back { text, stance }
      // is telling us this finding is NOT evidence (a denied or refused device
      // command). Jarvis must see that stance, or its synthesis treats a read
      // that never happened as a reading.
      const built = g.result;
      const text = typeof built === 'string' || built == null ? String(built || '') : String(built.text || '');
      const stance = typeof built === 'string' || built == null ? 'evidence' : (built.stance || 'evidence');
      return { agentId, name, connected: true, stance, text: text.trim() };
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

// CW-9 — the SAME delegated read, with its terminal evidence attached. Every
// caller on the bridge path (Jarvis's plan loop, the investigation loop) uses
// this so a finding always arrives with the real command + raw output + honest
// transport behind it. The finding itself is byte-for-byte what gatherForJarvis
// returns; `cli` is additive.
async function gatherWithEvidence(agentId, question, planDevice, planIncidentId) {
  const { result, cli } = await collectCliEvidence(
    () => gatherForJarvis(agentId, question, planDevice, planIncidentId));
  return { ...(result || {}), cli };
}

// Called once per participating agent when a debate runs.
async function debateContribution(agentId, topic) {
  if (NO_BACKEND[agentId]) return noDataContribution(agentId, topic);
  const builder = DEBATE_BUILDERS[agentId];
  if (!builder) return noDataContribution(agentId, topic);
  try {
    // A builder may answer with a plain string (live readings) or with
    // { text, stance } when what came back is NOT evidence — a denied or
    // refused device command. Roll-ups count stances, so that distinction has
    // to survive the trip.
    const built = await builder.build(topic);
    return typeof built === 'string'
      ? { stance: 'evidence', text: built }
      : { stance: built.stance || 'evidence', text: String(built.text || '') };
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

// ── Which SOURCE SYSTEMS each agent actually reads (CW-9 reviewer blocker #1) ─
// Read off the builders above, not off marketing copy: Monitor-Eye's build()
// really does call catalyst.getHealth/getIssues AND sdwan.getAlarmCount, and
// Router-Expert really does read the APIC AND vManage. The bridge roster is
// checked against THIS map before it claims anyone is standing down, so a
// "standing down Monitor-Eye" line can never ship while an engaged agent is
// about to read Monitor-Eye's own systems. Ids match session-log's source ids
// ('catalyst-center' | 'aci' | 'sdwan'), plus 'ssh' and 'incidents' (this
// console's own record, which is not a wire source at all).
const AGENT_SOURCES = {
  'netops': ['catalyst-center'],
  'monitor-eye': ['catalyst-center', 'sdwan'],
  'incident-handler': ['incidents', 'catalyst-center', 'aci'],
  'router-expert': ['aci', 'sdwan'],
  'config-keeper': ['catalyst-center', 'ssh'],
  'doc-writer': ['catalyst-center', 'aci', 'sdwan'],
  'jarvis': [],
  // No backend behind these — they read nothing at all, honestly.
  'sentinel': [], 'firewall-pro': [], 'loadbal-pro': [],
};
function sourcesFor(agentId) { return (AGENT_SOURCES[agentId] || []).slice(); }

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
    subjects: /\b(incident|incidents|inc-\d+|trg-|fault|faults|issue|issues|outage|rca|root[\s-]?cause|impact|severity|critical|major|handover|hand[\s-]?off|shift|bridge|verdict|hypothesis|owner|commander|network|fabric|aci|catalyst|device|devices)\b/i,
    verbs: ['triage', 'diagnose', 'troubleshoot', 'investigate', 'summarise', 'summarize', 'hand over', 'handover', 'brief'],
    can: [
      // QA CLASS 9 — say OUT LOUD, in the roster the planner reasons over, that
      // this console's OWN incidents are readable. The planner cannot delegate a
      // question about INC-… if nothing on the roster claims to see it.
      "read THIS console's own incident record — every incident this app has opened, by its INC-… or trg-… id: severity, status, title, who opened it, the roles on the bridge (commander/owner/scribe/joiners), when it opened and closed, and the committed verdict (ranked hypothesis, next check, confidence, correlation)",
      "answer 'what is the latest incident', 'summarise INC-…', 'who is on this incident', and shift-handover questions from that record — and say plainly when an incident id does not exist, rather than inventing one",
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
  // CW-12: the honest not-connected / cannot-answer lines are synchronous
  // replies — wrapped so the caller's answered receipt follows them (a bare
  // undefined would fail closed and the operator's bubble would never tick).
  if (NO_BACKEND[agentId]) return Promise.resolve(notConnected(agentId));
  const fn = HANDLERS[agentId];
  if (!fn) return Promise.resolve(notConnected(agentId));
  // Config-Keeper gates itself: it must find a real read command in the text.
  if (agentId !== 'config-keeper') {
    const verdict = canAnswer(agentId, command);
    if (!verdict.ok) return Promise.resolve(cannotAnswer(agentId, command, verdict));
  }
  return fn(agentId, command);
}

module.exports = {
  init, handle, refuseWrite, notConnected, hasLiveBackend, NO_BACKEND, readCommandFrom,
  canAnswer, cannotAnswer, CAPABILITIES,
  isDeviceCliRequest, runDeviceCli,
  debateContribution, gatherForJarvis,
  // CW-9 evidence envelope: the same delegated read, plus the terminal evidence
  // (host / command / raw scrubbed output / honest transport) behind it.
  gatherWithEvidence, collectCliEvidence,
  // CW-9 roster truth: the source systems each agent really reads.
  AGENT_SOURCES, sourcesFor,
  // Ambiguity → ask, never assume: the parked-question resume + the explicit
  // "forget the device" reset. server.js calls these BEFORE it routes anything,
  // so both surfaces (Jarvis and a direct @mention) inherit the same behaviour.
  resumeClarification, maybeForget,
  // QA CLASS 9 — exposed for the isolation tests: per-conversation memory must be
  // provably separate between operators, and there is no other way to observe it.
  _conversation: {
    rememberedDevice, rememberDevice, rememberedIncident, rememberIncident,
    pendingChoiceNow, rememberPendingChoice, forgetConversation, ownIncidentIdsFor,
  },
};
