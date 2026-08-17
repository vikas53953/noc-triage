// Load .env.local FIRST — the sandbox adapters read their credentials from
// process.env at require time. The repo is public; .env.local is gitignored.
require('./sources/env');

const express = require('express');
const { WebSocketServer } = require('ws');
const chokidar = require('chokidar');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { AsyncLocalStorage } = require('async_hooks');

const live = require('./sources/live-agents');
const jarvis = require('./sources/jarvis');
const triage = require('./sources/triage');
const catalyst = require('./sources/catalyst-center');
const aci = require('./sources/aci');
const sdwan = require('./sources/sdwan');
const session = require('./sources/session-log');
const chatStore = require('./sources/chat-store');
const approvals = require('./sources/approvals');
const artifacts = require('./sources/artifacts');
const notifier = require('./sources/notifier');
const { checkIntent } = require('./sources/guardrails');

// One module owns where the workspace is and how any caller-supplied path is
// turned into a real path. Nothing else in this file builds a path from input.
const workspace = require('./workspace');
const { SQUAD_ROOT, PATHS, safeJoin, isPlainFilename, safeWrite, safeAppend } = workspace;

const { makeOriginChecker } = require('./origins');
const { limiter, allowSocketMessage } = require('./ratelimit');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
// Bind to this machine only unless HOST is set on purpose. Binding to every
// interface put the dashboard on the office Wi-Fi for anyone to drive.
const HOST = process.env.HOST || '127.0.0.1';

const origins = makeOriginChecker(PORT);

// All agent IDs
const AGENT_IDS = ['jarvis', 'netops', 'sentinel', 'firewall-pro', 'loadbal-pro', 'router-expert', 'monitor-eye', 'config-keeper', 'incident-handler', 'doc-writer'];

// Helper: get status file path for any agent
function getAgentStatusPath(agentId) {
  return safeJoin(PATHS.agentWorkspace, path.join(String(agentId), 'STATUS.json'));
}

// Agent registry
const agents = {
  jarvis: {
    id: 'jarvis',
    name: 'Jarvis',
    icon: '🎖️',
    role: 'squad-lead',
    description: 'Squad Lead — coordinates all agents, daily standups',
    status: 'active',
    currentTask: 'Monitoring squad',
    lastUpdated: new Date().toISOString(),
    lastAction: 'Squad Lead online — monitoring initiated',
    manages: ['netops', 'sentinel', 'firewall-pro', 'loadbal-pro', 'router-expert', 'monitor-eye', 'config-keeper', 'incident-handler', 'doc-writer']
  },
  netops: {
    id: 'netops',
    name: 'NetOps',
    icon: '🌐',
    description: 'SSH to devices, pre-checks, health monitoring',
    status: 'idle',
    currentTask: null,
    lastUpdated: new Date().toISOString(),
    lastAction: 'Standing by for tasks'
  },
  sentinel: {
    id: 'sentinel',
    name: 'Sentinel',
    icon: '🛡️',
    description: 'CVE monitoring, FortiGate/F5/Cisco advisories',
    status: 'idle',
    currentTask: null,
    lastUpdated: new Date().toISOString(),
    lastAction: 'Standing by for tasks'
  },
  'firewall-pro': {
    id: 'firewall-pro',
    name: 'Firewall-Pro',
    icon: '🔥',
    description: 'FortiGate specialist — policies, NAT, VPN',
    status: 'idle',
    currentTask: null,
    lastUpdated: new Date().toISOString(),
    lastAction: 'Standing by for tasks'
  },
  'loadbal-pro': {
    id: 'loadbal-pro',
    name: 'LoadBal-Pro',
    icon: '⚖️',
    description: 'F5 LTM/GTM — pools, SSL, health monitors',
    status: 'idle',
    currentTask: null,
    lastUpdated: new Date().toISOString(),
    lastAction: 'Standing by for tasks'
  },
  'router-expert': {
    id: 'router-expert',
    name: 'Router-Expert',
    icon: '🔀',
    description: 'BGP, OSPF, routing — Cisco IOS-XR',
    status: 'idle',
    currentTask: null,
    lastUpdated: new Date().toISOString(),
    lastAction: 'Standing by for tasks'
  },
  'monitor-eye': {
    id: 'monitor-eye',
    name: 'Monitor-Eye',
    icon: '👁️',
    description: 'Splunk, SNMP, alerts, thresholds',
    status: 'idle',
    currentTask: null,
    lastUpdated: new Date().toISOString(),
    lastAction: 'Standing by for tasks'
  },
  'config-keeper': {
    id: 'config-keeper',
    name: 'Config-Keeper',
    icon: '📋',
    description: 'Config backups, change tracking, compliance',
    status: 'idle',
    currentTask: null,
    lastUpdated: new Date().toISOString(),
    lastAction: 'Standing by for tasks'
  },
  'incident-handler': {
    id: 'incident-handler',
    name: 'Incident-Handler',
    icon: '🚨',
    description: 'Troubleshooting, RCA, incident docs',
    status: 'idle',
    currentTask: null,
    lastUpdated: new Date().toISOString(),
    lastAction: 'Standing by for tasks'
  },
  'doc-writer': {
    id: 'doc-writer',
    name: 'Doc-Writer',
    icon: '📝',
    description: 'Diagrams, runbooks, SOPs, reports',
    status: 'idle',
    currentTask: null,
    lastUpdated: new Date().toISOString(),
    lastAction: 'Standing by for tasks'
  }
};

// Name → ID lookup map for @mention routing
const nameToId = {};
Object.values(agents).forEach(a => {
  nameToId[a.name.toLowerCase()] = a.id;
});

// Debate threads storage
const debateThreads = [];
let debateIdCounter = 0;

// Mention counts per agent (unread)
const mentionCounts = {};
AGENT_IDS.forEach(id => mentionCounts[id] = 0);

// Command queue for agents
const commandQueue = [];

// Connected WebSocket clients
const clients = new Set();

// Pause state
let isPaused = false;

// Middleware
// Refuse anything from a web page that is not on the allowlist, before it can
// reach a route. Browsers always send Origin cross-origin, so this is what
// stops a random site from driving the dashboard.
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (!origins.isAllowed(origin)) {
    console.warn(`[CORS] Refused origin: ${origin}`);
    return res.status(403).json({ error: 'Origin not allowed' });
  }
  next();
});
app.use(cors({ origin: (origin, cb) => cb(null, origins.isAllowed(origin)) }));
app.use(express.json({ limit: '256kb' }));

// Rate limits. Generous enough that normal clicking never notices; tight
// enough that a loop cannot hammer the shared Cisco sandboxes through our
// credentials. Reads and writes get separate budgets.
const readLimit = limiter({ name: 'read', max: Number(process.env.RATE_LIMIT_READ || 300) });
const writeLimit = limiter({ name: 'write', max: Number(process.env.RATE_LIMIT_WRITE || 60) });
app.use('/api/', readLimit);
app.use('/api/', (req, res, next) => (req.method === 'GET' ? next() : writeLimit(req, res, next)));

app.use(express.static(path.join(__dirname, 'public')));

// Create HTTP server
const server = http.createServer(app);

// Create WebSocket server
const wss = new WebSocketServer({ server });

// ── Which question is this answering? ───────────────────────────────────────
// One store, set once per incoming command, carried across every await and
// timer that command spawns. Any chat message broadcast inside it is stamped
// with the question that asked for it, and the UI quotes that question in the
// reply header. Ordering can then never mis-attribute an answer.
const requestContext = new AsyncLocalStorage();
let requestSeq = 0;
const newRequestId = () => `req-${Date.now().toString(36)}-${(++requestSeq).toString(36)}`;

function currentRequest() {
  return requestContext.getStore() || null;
}

// Stamp chat messages with their originating question. Other broadcast types
// are untouched.
function withRequest(type, data) {
  if (type !== 'chat_message' || !data || typeof data !== 'object') return data;
  const req = currentRequest();
  if (!req) return data;
  return {
    ...data,
    requestId: data.requestId || req.requestId,
    inReplyTo: data.inReplyTo || (data.type === 'outgoing' ? null : req.question),
    inReplyToAgent: data.inReplyToAgent || (agents[req.agent]?.name || null),
  };
}

// Broadcast to all connected clients
function broadcast(type, data) {
  data = withRequest(type, data);
  // ONE SEAM for reload persistence (bug B4): every chat_message / activity_new
  // the app broadcasts passes through here, so persisting the recent window at
  // this single point restores the whole conversation + Live Activity feed on a
  // refresh (and across a server restart) with no per-caller wiring. The store
  // secret-scrubs before anything touches disk.
  if (type === 'chat_message') chatStore.appendChat(data);
  else if (type === 'activity_new' && data && data.ts !== undefined) {
    // activity_new now has ONE canonical emitter: appendToActivityLog, which
    // sends the {source,text,ts} shape. The ACTIVITY_LOG.md file watcher no
    // longer re-broadcasts (see M3 fix in setupFileWatcher), so live and
    // persisted feeds each carry every event exactly once. This `ts` guard is
    // kept as a defensive belt: only the canonical shape (which carries `ts`)
    // is ever persisted, so no stray non-canonical copy could double the feed.
    chatStore.appendActivity(data);
  }
  const message = JSON.stringify({ type, data, timestamp: new Date().toISOString() });
  clients.forEach(client => {
    if (client.readyState === 1) { // WebSocket.OPEN
      client.send(message);
    }
  });
}

// Live-stream every recorded wire call (real command → raw output) to the UI's
// CLI/session view. Rate-limited endpoints below still serve the same records
// for reconnect/restore.
session.setBroadcast((rec) => broadcast('session_record', rec));

// command_share (transparency contract): each real check an engaged agent runs
// during a delegation/triage is "screen-shared" into the chat — the exact command,
// the real raw output (already secret-scrubbed by the session log), why it ran and
// what it means — in addition to the summary chat_message.
session.setCommandShareBroadcast((data) => broadcast('command_share', data));

// The permission gate (Phase C) broadcasts approval requests + decisions so the
// approval surface updates live: approval_new, approval_update, approval_mode.
approvals.setBroadcast((type, data) => {
  broadcast(type, data);
  // On-call notifier (Wave 3): a read that needs an operator decision (ask mode)
  // pages on-call. Only a genuinely-PENDING new request — never an auto-approved
  // read or a decision update. Fire-and-forget; the notifier is an honest no-op
  // when no webhook is set and swallows its own failures (never blocks a read).
  if (type === 'approval_new' && data && data.state === 'pending') {
    try {
      const p = notifier.notify('approval_needed', {
        incidentId: data.triageId || null,   // approval records carry the trg-/INC id as triageId
        triageId: data.triageId || null,
        front: data.front || null,
        command: data.command || 'a read',
        target: data.target || null,
        summary: `Approval needed — ${data.agentName || 'an agent'} wants to run "${data.command || 'a read'}"${data.target ? ` against ${data.target}` : ''}${data.triageId ? ` (${data.triageId})` : ''}`,
        detail: { reason: data.reason || null, mode: data.mode || null },
      });
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (e) { /* telemetry must never break the approval flow */ }
  }
});

// Surface a problem on the dashboard instead of dying quietly (or loudly).
// The detail stays in the server log; the browser gets plain words.
function reportSystemError(what, err) {
  const detail = err && err.message ? err.message : String(err || '');
  console.error(`[System] ${what}: ${detail}`);
  broadcast('system_error', { message: `${what} — check the server window for detail.` });
}

// Every failed write in the app lands here.
workspace.setWriteErrorHandler((label, err) => reportSystemError(`Could not write ${label}`, err));

// A gap anywhere else should be visible, not fatal.
process.on('unhandledRejection', (err) => reportSystemError('Background job failed', err));
process.on('uncaughtException', (err) => reportSystemError('Unexpected error', err));

// Hand the live-source layer the plumbing it needs to talk to the dashboard.
// It stays out of server internals; this is the only seam between them.
live.init({
  agents,
  say(agentId, text) {
    const a = agents[agentId] || {};
    broadcast('chat_message', {
      type: 'incoming',
      agent: agentId,
      agentName: a.name || agentId,
      agentIcon: a.icon || '🤖',
      text,
      timestamp: new Date().toISOString(),
    });
  },
  updateAgentStatus,
  addTaskToBoard,
  moveTaskOnBoard,
  appendToActivityLog,
  writeReport(agentId, filename, content) {
    // Agent-chosen file names can carry user text, so they go through safeJoin
    // like anything else built from input.
    const full = safeJoin(PATHS.agentWorkspace, path.join(agentId, 'reports', filename));
    if (!full) {
      console.error(`[Workspace] Refused report path for ${agentId}: ${filename}`);
      return null;
    }
    safeWrite(full, content, `report ${filename}`);
    return filename;
  },
});

// Hand the REAL agentic Jarvis (Phase E) its plumbing. Jarvis reasons with a
// real Claude call about WHO to delegate to, then gathers each agent's live read
// through the SAME gate + guardrail + session log as any other read. The only
// LLM steps are the plan and the synthesis; everything around them is real and
// testable without a key. With no key, Jarvis declines to reason (honest state)
// — it never falls back to a rule-router.
function jarvisSay(agentId, text) {
  const a = agents[agentId] || {};
  broadcast('chat_message', {
    type: 'incoming',
    agent: agentId,
    agentName: a.name || agentId,
    agentIcon: a.icon || '🤖',
    text,
    timestamp: new Date().toISOString(),
  });
}
jarvis.init({
  say: jarvisSay,
  status: updateAgentStatus,
  log: (line) => appendToActivityLog(`[${new Date().toISOString()}] ${line}\n`),
  nameOf: (id) => (agents[id]?.name || id),
  // Delegation gather goes through the real gate + guardrail + session log.
  gather: (agentId, question) => live.gatherForJarvis(agentId, question),
  // The roster the planner reasons over: who exists + what each can actually see.
  roster: () => (agents.jarvis.manages || []).map((id) => ({
    id,
    name: agents[id]?.name || id,
    connected: !live.NO_BACKEND[id],
    sees: (live.CAPABILITIES[id] && live.CAPABILITIES[id].can) || [],
    note: live.NO_BACKEND[id] ? `not connected — ${live.NO_BACKEND[id]}` : '',
  })),
});

// Hand the triage engine the same broadcast/status plumbing. It reuses the live
// adapters directly for its reads; this seam only carries dashboard events.
triage.init({
  agents,
  broadcast,
  updateAgentStatus,
  appendToActivityLog,
});

// WebSocket connection handler
// The Origin check has to happen here too: CORS does not apply to WebSockets,
// so without it a foreign page could still open a socket and read everything.
wss.on('connection', (ws, req) => {
  const origin = req && req.headers ? req.headers.origin : undefined;
  if (!origins.isAllowed(origin)) {
    console.warn(`[WS] Refused connection from origin: ${origin}`);
    ws.close(1008, 'Origin not allowed');
    return;
  }
  const clientKey = (req && (req.socket?.remoteAddress || 'unknown')) || 'unknown';
  clients.add(ws);
  console.log(`[WS] Client connected. Total: ${clients.size}`);

  // Send initial state
  ws.send(JSON.stringify({
    type: 'init',
    data: {
      agents: Object.values(agents),
      tasks: getTasks(),
      files: getRecentFiles(),
      activity: getRecentActivity(),
      debates: debateThreads,
      mentionCounts: { ...mentionCounts },
      paused: isPaused,
      // Bug B4 restore contract: the recent direct-chat/DM stream and Live
      // Activity feed, oldest→newest, so a reconnecting client can rebuild both
      // instead of coming back empty. Same payload shapes chat_message /
      // activity_new already broadcast; already secret-scrubbed on disk.
      chatHistory: chatStore.getChatHistory(),
      activityHistory: chatStore.getActivityHistory()
    },
    timestamp: new Date().toISOString()
  }));

  ws.on('message', (message) => {
    try {
      if (!allowSocketMessage(clientKey)) {
        ws.send(JSON.stringify({
          type: 'system_error',
          data: { message: 'Too many messages — slow down.' },
          timestamp: new Date().toISOString()
        }));
        return;
      }
      const parsed = JSON.parse(message);
      if (parsed.type === 'command') {
        handleCommand(parsed.data);
      }
    } catch (e) {
      console.error('[WS] Invalid message:', e.message);
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    console.log(`[WS] Client disconnected. Total: ${clients.size}`);
  });
});

// Handle commands from dashboard.
// Everything a command triggers — acknowledgements, live reads, refusals,
// replies that land 30 seconds later — runs inside one request context, so
// every message can name the question that caused it. Without that, a slow
// reply appears under whatever was asked in the meantime and the reader
// attributes real fault data to the wrong exchange.
function handleCommand(data) {
  const question = String((data && data.command) || '');
  const ctxValue = {
    requestId: newRequestId(),
    question,
    agent: (data && data.agent) || null,
    askedAt: new Date().toISOString(),
  };
  return requestContext.run(ctxValue, () => handleCommandInner(data));
}

function handleCommandInner(data) {
  const { agent, command } = data;
  const timestamp = new Date().toISOString();
  const agentName = agents[agent]?.name || agent;
  const agentIcon = agents[agent]?.icon || '🤖';

  // Add to command queue
  commandQueue.push({ agent, command, timestamp, status: 'pending' });

  // Broadcast command sent (shows in chat as outgoing)
  broadcast('chat_message', {
    type: 'outgoing',
    agent,
    text: command,
    timestamp
  });

  // An @mention nobody answers to is a typo, not a task. Say so and stop —
  // creating live work against real kit for a name that does not exist is the
  // same failure as answering a question that was never asked.
  const unknown = unknownMentionNames(command);
  if (unknown.length && parseMentions(command).length === 0) {
    broadcast('chat_message', {
      type: 'incoming',
      agent: 'system',
      agentName: 'NOC Triage',
      agentIcon: '🎯',
      text:
        `🤷 There is no agent called @${unknown[0]}.\n` +
        `I have not created a task and nothing was sent to any device.\n\n` +
        `The squad is: ${AGENT_IDS.map((id) => `@${agents[id].name}`).join(', ')}.\n` +
        `Retype the mention with one of those names.`,
      timestamp,
    });
    appendToActivityLog(`[${timestamp}] [Dashboard] Unknown @mention refused: @${unknown[0]}\n`);
    return;
  }

  // Check if command is an @mention (e.g., "@NetOps run prechecks")
  const mentionMatch = command.match(/^@([A-Za-z][\w-]*)\s+(.*)/);
  if (mentionMatch) {
    const targetName = mentionMatch[1];
    const mentionMessage = mentionMatch[2];
    const targetId = nameToId[targetName.toLowerCase()];

    if (targetId) {
      // Route as a mention from current agent to target
      broadcast('chat_message', {
        type: 'incoming',
        agent,
        agentName,
        agentIcon,
        text: `📨 @${agents[targetId].name} ${mentionMessage}`,
        timestamp
      });

      handleMention(agent, targetId, mentionMessage);

      // Also have the target agent process the command
      setTimeout(() => {
        simulateAgentAction(targetId, mentionMessage);
      }, 1500);
      return;
    }
  }

  // Check if command starts a debate
  const debateMatch = command.match(/^debate\s+(.*)/i);
  if (debateMatch) {
    startDebate(agent, debateMatch[1]);
    return;
  }

  // Check if command is a refute/agree/resolve in active debate
  const refuteMatch = command.match(/^refute\s+(.*)/i);
  if (refuteMatch && activeDebateId !== null) {
    addDebateMessage(agent, 'refute', refuteMatch[1]);
    return;
  }
  const agreeMatch = command.match(/^agree\s+(.*)/i);
  if (agreeMatch && activeDebateId !== null) {
    addDebateMessage(agent, 'agree', agreeMatch[1]);
    return;
  }
  if (command.toLowerCase() === 'resolve' && activeDebateId !== null) {
    resolveDebate(agent);
    return;
  }

  // No "Command received" echo: the user's own bubble already shows what they
  // sent, and the agent's real answer follows. Hand straight to the read.
  setTimeout(() => {
    simulateAgentAction(agent, command);
  }, 500);
}

// @names in the text that match no agent in the squad.
function unknownMentionNames(text) {
  const found = [];
  const re = /@([A-Za-z][\w-]*)/g;
  let m;
  while ((m = re.exec(String(text || ''))) !== null) {
    const name = m[1];
    if (!nameToId[name.toLowerCase()] && name.toLowerCase() !== 'vikas') found.push(name);
  }
  return found;
}

// Parse @mentions from text, returns array of {name, id}
function parseMentions(text) {
  const mentionRegex = /@([A-Za-z][\w-]*)/g;
  const found = [];
  let match;
  while ((match = mentionRegex.exec(text)) !== null) {
    const name = match[1];
    const id = nameToId[name.toLowerCase()];
    if (id) {
      found.push({ name: agents[id].name, id });
    }
  }
  return found;
}

// Handle an @mention between agents
function handleMention(fromAgentId, toAgentId, message) {
  const fromAgent = agents[fromAgentId];
  const toAgent = agents[toAgentId];
  if (!fromAgent || !toAgent) return;

  const timestamp = new Date().toISOString();

  // Increment mention count
  mentionCounts[toAgentId] = (mentionCounts[toAgentId] || 0) + 1;

  // Broadcast mention event (for badge flash + highlighting)
  broadcast('mention', {
    from: fromAgentId,
    fromName: fromAgent.name,
    fromIcon: fromAgent.icon,
    to: toAgentId,
    toName: toAgent.name,
    toIcon: toAgent.icon,
    message,
    mentionCounts: { ...mentionCounts },
    timestamp
  });

  // Log to MENTIONS.md
  const logEntry = `[${timestamp}] [@${fromAgent.name} → @${toAgent.name}] ${message}\n`;
  if (!safeAppend(PATHS.mentionsLog, logEntry, 'mentions log')) {
    // Fall back to creating the file, still without being able to throw.
    safeWrite(PATHS.mentionsLog, `# Agent @Mentions Log\n\n${logEntry}`, 'mentions log');
  }

  // Log to activity
  appendToActivityLog(`[${timestamp}] [${fromAgent.name}] @mentioned ${toAgent.name}: ${message}\n`);

  // Simulate target agent acknowledging (1-2s delay)
  const responseDelay = 1000 + Math.random() * 1000;
  setTimeout(() => {
    const response = generateMentionResponse(toAgentId, fromAgentId, message);
    broadcast('chat_message', {
      type: 'incoming',
      agent: toAgentId,
      agentName: toAgent.name,
      agentIcon: toAgent.icon,
      text: response,
      timestamp: new Date().toISOString()
    });
    // handleMention is only ever reached from an operator-typed command, so the
    // responding agent answered the operator's @mention — not fromAgent, which is
    // merely the operator's currently-focused chat. Name the true relationship.
    appendToActivityLog(`[${new Date().toISOString()}] [${toAgent.name}] Responded to the operator's @mention\n`);
  }, responseDelay);
}

// Generate contextual response based on agent specialty
function generateMentionResponse(responderId, fromId, message) {
  const responder = agents[responderId];
  const from = agents[fromId];
  const msg = message.toLowerCase();

  // An acknowledgement may only promise what the agent can actually do, which
  // is read its own live source (Catalyst Center, the ACI fabric, or vManage).
  // Never name a tool, feed or capability that does not exist here — a
  // fabricated capability is as dishonest as a fabricated reading.
  const responses = {
    'netops': [
      `@${from.name} Roger that — reading live device inventory from Catalyst Center.`,
      `@${from.name} On it — checking current device reachability on Catalyst Center.`,
      `@${from.name} Acknowledged. Pulling the live device list and health score.`
    ],
    // No backend wired up — say so rather than promise a report we cannot make.
    'sentinel': [
      `@${from.name} I'm not connected to a CVE feed yet — no credentials, so I have nothing real to report.`
    ],
    'firewall-pro': [
      `@${from.name} I'm not connected to a firewall source yet — no credentials, so I have nothing real to report.`
    ],
    'loadbal-pro': [
      `@${from.name} I'm not connected to a load balancer — F5 has no Cisco DevNet sandbox. Nothing real to report.`
    ],
    'router-expert': [
      `@${from.name} On it — querying the live ACI fabric / SD-WAN overlay.`
    ],
    'monitor-eye': [
      `@${from.name} On it — reading the live health score and open issues from Catalyst Center.`,
      `@${from.name} Acknowledged. Checking current health and SD-WAN alarm counts.`,
      `@${from.name} Roger — pulling what my live sources report right now.`
    ],
    // No backup store, no compliance baseline and no config-diff engine exists —
    // this agent can only read running software versions and reachability.
    'config-keeper': [
      `@${from.name} On it — reading the running software versions from Catalyst Center.`,
      `@${from.name} Acknowledged. Checking what versions the devices actually report.`,
      `@${from.name} Roger — I hold no backups or baselines, but I can read current state.`
    ],
    'incident-handler': [
      `@${from.name} On it — reading open issues from Catalyst Center and faults from the ACI fabric.`,
      `@${from.name} Acknowledged. Checking what is currently open on my live sources.`,
      `@${from.name} Roger — pulling the current issue and fault list.`
    ],
    'doc-writer': [
      `@${from.name} On it — reading the connected sandboxes so anything I write is backed by live data.`,
      `@${from.name} Acknowledged. Checking what the live sources can actually confirm.`,
      `@${from.name} Roger — gathering current readings from the connected sources.`
    ],
    'jarvis': [
      `@${from.name} Understood. I'll coordinate the team on this.`,
      `@${from.name} Copy. Triaging and assigning as needed.`,
      `@${from.name} Acknowledged. Monitoring progress.`
    ]
  };

  const agentResponses = responses[responderId] || [`@${from.name} Acknowledged. Working on it.`];
  return agentResponses[Math.floor(Math.random() * agentResponses.length)];
}

// ============ AGENT NLU — per-agent intent detection ============
function detectAgentIntent(agentId, command) {
  const t = command.toLowerCase();

  // BGP / routing queries
  if (/\b(bgp|ospf|isis|mpls|routing table|route|prefix|peer|neighbor|convergence|as path|as number|autonomous system)\b/.test(t)) {
    return 'bgp_status';
  }
  // Security / CVE queries
  if (/\b(cve|vuln|threat|security|advisory|patch|exploit|risk|scan|attack|malware|compromise|posture)\b/.test(t)) {
    return 'security_scan';
  }
  // Firewall queries
  if (/\b(firewall|policy|policies|rule|acl|nat|vpn|fortigate|fortios|permit|deny|block|filter|access[\s-]list)\b/.test(t)) {
    return 'firewall_check';
  }
  // Load balancer queries
  if (/\b(f5|load[\s-]?bal|vip|pool|member|health[\s-]?monitor|ssl offload|virtual[\s-]?server|ltm|gtm|irule|persistence)\b/.test(t)) {
    return 'lb_check';
  }
  // Monitoring / alerts
  if (/\b(alert|monitor|splunk|snmp|trap|threshold|metric|dashboard|syslog|log|event|alarm)\b/.test(t)) {
    return 'alert_check';
  }
  // Device configuration / change actions — BEFORE config_check (which is read-only audit)
  if (/\b(configure|create|provision|deploy|apply[\s-]?config|push[\s-]?config|commit[\s-]?change|rollback)\b/.test(t) ||
      (/\b(add|set|enable|disable|shut|no[\s-]?shut|bring[\s-]?(up|down)|remove|delete|unconfigure)\b/.test(t) &&
       /\b(interface|loopback|lo\d+|gigabit|gig\b|vlan|trunk|route|ntp|snmp|bgp[\s-]?neighbor|ospf|eigrp|description|ip[\s-]?add)\b/.test(t))) {
    return 'configure_device';
  }
  // Device CLI — "run show version on sw1", "show running-config", "ping 10.0.0.1".
  // CLASS FIX (CLI routing): this is a command the operator wants EXECUTED on a
  // box, not a domain question an agent answers from its own source. It is
  // detected here, AFTER configure_device (so a config change is still refused
  // first) and BEFORE the domain intents, so it can never be classified as a
  // NetOps inventory read and dead-end on "no CLI/SSH session to the box".
  // The single owner of that path is Config-Keeper (Catalyst Center Command
  // Runner); live.runDeviceCli hands off out loud when another agent was asked.
  if (live.isDeviceCliRequest(command)) {
    return 'device_cli';
  }
  // Config / compliance
  if (/\b(config|backup|compliance|drift|change|diff|snapshot|baseline|audit|inventory)\b/.test(t)) {
    return 'config_check';
  }
  // Incident / RCA
  if (/\b(incident|rca|root[\s-]?cause|troubleshoot|diagnose|timeline|impact|outage report)\b/.test(t)) {
    return 'incident_check';
  }
  // Connectivity / pre-check
  if (/\b(precheck|pre[\s-]check|ssh|connect|reachab|connectivity|device health)\b/.test(t)) {
    return 'precheck';
  }
  // Ping
  if (/^(ping|test|alive|you there)[?!.\s]*$/.test(t)) {
    return 'ping';
  }
  // Help
  if (/\b(help|what can you|commands|capabilities)\b/.test(t)) {
    return 'help';
  }
  // Generic status / show / tell me → route to agent's domain check
  if (/\b(status|health|show|display|get|tell me|what'?s|how is|check|review|look at|give me|report on)\b/.test(t)) {
    return 'domain_status';
  }
  return 'general';
}


// ── Main agent action dispatcher — live sources, no simulation ───────────────
// Every network answer below comes from a real Cisco DevNet always-on sandbox
// via sources/live-agents.js. Agents without a backend say "not connected".
// One wrapper catches for every call site (several of them are timers, where a
// throw or a rejected promise would otherwise take the whole server down).
function simulateAgentAction(agentId, command) {
  try {
    const result = runAgentAction(agentId, command);
    if (result && typeof result.then === 'function') {
      result.catch((err) => reportSystemError(`${agentId} could not finish that request`, err));
    }
    return result;
  } catch (err) {
    reportSystemError(`${agentId} could not finish that request`, err);
  }
}

function runAgentAction(agentId, command) {
  const agent = agents[agentId];
  if (!agent) return;

  updateAgentStatus(agentId, 'active', `Processing: ${command}`);

  // Jarvis keeps its squad-coordination intents (standup, roll call, triage);
  // anything network-shaped falls through to the live sources.
  if (agentId === 'jarvis') return simulateJarvisAction(agentId, command);

  // Destructive intent is judged on the RAW request text, for EVERY network
  // agent — not just the one that talks to a device CLI. A refusal is always
  // spoken; nothing is ever quietly swapped for a different command.
  const writeIntent = checkIntent(command);
  if (writeIntent.destructive) {
    appendToActivityLog(`[${new Date().toISOString()}] [${agent.name}] Refused a state-changing request ("${writeIntent.keyword}") — "${command.slice(0, 60)}"\n`);
    return live.refuseWrite(agentId, command, writeIntent);
  }

  // Class-level CLI routing (works with the reasoning LLM offline): a "run a
  // command on a device" request — "show version on sw1", "show running-config",
  // "ping 10.0.0.1", "traceroute …" — reaches the shared Command Runner path,
  // whichever engineer it was aimed at. Config-Keeper owns that path; any other
  // agent hands off to it rather than dead-ending with "no CLI session". State
  // changes are already refused above, so only read-only verbs get here.
  if (live.isDeviceCliRequest(command)) {
    return live.runDeviceCli(agentId, command);
  }

  const intent = detectAgentIntent(agentId, command);

  switch (intent) {
    // Read-only is enforced before anything reaches a device.
    case 'configure_device': return live.refuseWrite(agentId, command);
    // Any engineer can be handed a device CLI command; only one path executes it.
    case 'device_cli':       return live.runDeviceCli(agentId, command);
    case 'ping':             return simulatePing(agentId);
    case 'help':             return showAgentHelp(agentId);
    default:                 return live.handle(agentId, command);
  }
}




// Simulate ping test
function simulatePing(agentId) {
  const agent = agents[agentId];
  const taskTitle = 'Connectivity test (ping)';

  addTaskToBoard('inProgress', { title: taskTitle, agent: agent.name });

  setTimeout(() => {
    broadcast('chat_message', {
      type: 'incoming',
      agent: agentId,
      agentName: agent.name,
      agentIcon: agent.icon,
      text: `🏓 Pong! Agent is responsive.\nDashboard uptime: ${Math.floor(process.uptime())}s\n\n(This is the agent answering, not a device. For a real device reachability test ask Config-Keeper to "ping <address>".)`,
      timestamp: new Date().toISOString()
    });
    updateAgentStatus(agentId, 'idle', 'Ping responded');
    moveTaskOnBoard(taskTitle, 'inProgress', 'done');
  }, 500);
}

// Show agent help.
// The help text is built from what this agent can ACTUALLY do right now: the
// old version printed NetOps' capability list for every agent and advertised
// configuration commands that the read-only guardrail always refuses.
function showAgentHelp(agentId) {
  const agent = agents[agentId];
  const missing = live.NO_BACKEND[agentId];

  const body = missing
    ? `🔌 **Not connected.**\nI have no ${missing} wired up, so I cannot report anything real.\n` +
      `I will not invent a report. Add the credentials to .env.local and I will answer for real.`
    : live.hasLiveBackend(agentId)
      ? `🔍 **Reads I can do (live, read-only)**\n` +
        ((live.CAPABILITIES[agentId]?.can || []).map((c) => `• ${c}\n`).join('')) +
        `• Anything outside that list I will say I cannot answer — I never run a different read instead.\n` +
        `• show / ping / traceroute / dir / more — the only verbs allowed through to a device.\n\n` +
        `🚫 **What I will refuse**\n` +
        `Anything that changes a device: configure, write, reload, erase, shut/no shut, copy, delete.\n` +
        `Read-only is enforced in code (sources/guardrails.js), not by convention.`
      : `I have no live data source mapped, so I will report "not connected" rather than guess.`;

  setTimeout(() => {
    broadcast('chat_message', {
      type: 'incoming',
      agent: agentId,
      agentName: agent.name,
      agentIcon: agent.icon,
      text: `📚 **${agent.name} — Capabilities**\n\n${body}\n\n📋 **Always available**\n• status — Agent status\n• ping — Agent responsiveness\n• help — This help`,
      timestamp: new Date().toISOString()
    });
    updateAgentStatus(agentId, 'idle', 'Help displayed');
  }, 500);
}

// ============ JARVIS NLU — NATURAL LANGUAGE UNDERSTANDING ============

// Score-based intent classifier: returns the best matching intent
function detectJarvisIntent(input) {
  const t = input.toLowerCase().trim();

  const intents = [
    {
      type: 'standup',
      patterns: [
        /\b(standup|stand[\s-]up)\b/,
        /\b(morning brief|daily brief|daily check|start of day|kick[\s-]?off)\b/,
        /\b(check[\s-]?in with|how is everyone|how'?s everyone|what'?s everyone (doing|working on))\b/,
        /\b(team (check|update|brief|status)|brief me|get a status|everyone doing)\b/,
        /\b(good morning|start the day|begin the day|open the day)\b/
      ]
    },
    {
      type: 'squad_status',
      patterns: [
        /\b(roll[\s-]?call|squad status|agent (roster|list|status))\b/,
        /\bwho'?s? (online|active|available|working|up|running)\b/,
        /\b(show|list|see|get) (me )?(all |the )?agents\b/,
        /\bhow many agents\b/,
        /\b(everyone online|all agents|who do we have|team roster|see the team|check on everyone)\b/,
        /\b(who is (available|online|active)|any agents (available|active|online))\b/
      ]
    },
    {
      type: 'weekly_report',
      patterns: [
        /\b(weekly report|week(ly)? summary|summary report|progress report)\b/,
        /\b(what'?s? been done|what (have|did) we (complete|accomplish|finish|do))\b/,
        /\b(overview of the week|week recap|how did we do|activity (summary|report))\b/,
        /\b(our progress|completed this week|this week'?s? work|wrap[\s-]?up)\b/
      ]
    },
    {
      type: 'escalate',
      patterns: [
        /\b(escalate|urgent|critical|emergency|p0|p1)\b/,
        /\b(major (incident|outage|issue|problem)|production (down|issue|problem|outage))\b/,
        /\b(is down|went down|has gone down|not (working|responding|reachable))\b/,
        /\b(outage|disaster|crisis|major failure|complete failure|total (loss|outage))\b/,
        /\b(needs? immediate|right now|asap|right away|immediately)\b/,
        /\b(broken|failed|failure|dead|unreachable|timed? out|packet[\s-]?loss)\b/,
        /\b(bgp (down|drop|flap|fail)|ospf (down|fail)|link (down|fail)|interface (down|fail))\b/,
        /\b(cpu (maxed|spiked|100%)|memory (full|exhausted|oom)|disk (full|100%))\b/
      ]
    },
    {
      type: 'triage',
      patterns: [
        /\b(triage|assign|delegate|route|dispatch)\b/,
        /\b(can (someone|an agent|you)|need (someone|an agent) to|who should (handle|look|check|fix))\b/,
        /\b(please (assign|handle|look into|check|fix|investigate))\b/,
        /\b(take care of|work on (this|it)|look into|check (on|out)|investigate)\b/,
        /\b(I have a task|new task|there'?s? a (task|ticket|issue|job|problem|request))\b/,
        /\b(add (this|a) task|create (a )?task|log (this|a) task|put (this|it) in)\b/,
        /\b(deal with|handle this|sort (this|it) out|take a look)\b/
      ]
    },
    {
      type: 'ping',
      patterns: [
        /^(hi|hey|hello|howdy|yo|sup|hiya)[!?.\s]*$/,
        /^(ping|test|testing|you there|are you there|you awake|online)[?!.\s]*$/,
        /^(hey jarvis|hi jarvis|hello jarvis)[!?.\s]*$/
      ]
    },
    {
      // Help is a BARE/EXPLICIT request for the capability card only — never any
      // sentence that merely contains "help". "help me figure out why x is slow"
      // is a reasoning request and must fall through to real Jarvis, so "help"
      // only counts when it stands alone (or as "need/show help"), not when it
      // leads into a task ("help me…", "can you help…").
      type: 'help',
      patterns: [
        /^\s*(help|halp|\?+)\s*$/,
        /^\s*(i\s+)?(need|want|show|show me|get)\s+help\s*[!?.]*$/,
        /\bwhat can you (do|help with)\b/,
        /\bwhat are your (commands|capabilities|options|features)\b/,
        /\b(list|show me) your (commands|capabilities|options|features)\b/,
        /\bhow do i use (you|jarvis)\b/
      ]
    }
  ];

  // Score each intent
  for (const intent of intents) {
    for (const pattern of intent.patterns) {
      if (pattern.test(t)) {
        return { type: intent.type };
      }
    }
  }

  // Contextual inference — network/infra issue descriptions
  const isNetworkTerm = /\b(bgp|ospf|isis|mpls|vlan|stp|spanning.tree|routing|interface|switch|router|firewall|fortigate|f5|load.?bal|vpn|tunnel|ipsec|ssl|certificate|cpu|memory|disk|latency|bandwidth|utilization|syslog|snmp|trap|acl|policy|nat|vip|pool|bgp|peer|prefix|route|nexthop|convergence)\b/.test(t);
  const isProblem = /\b(down|fail|error|high|spike|maxed|full|loss|issue|problem|broken|unreachable|timeout|flap|drop|slow|congested|blocked|denied|rejected|expired|mismatch|loop|storm)\b/.test(t);

  if (isNetworkTerm && isProblem) {
    return { type: 'escalate', inferred: true };
  }
  if (isNetworkTerm) {
    return { type: 'triage', inferred: true };
  }

  // Agent-name mentions — likely a routing request
  const agentNames = ['netops', 'sentinel', 'firewall', 'loadbal', 'router', 'monitor', 'config', 'incident', 'doc-writer', 'doc writer'];
  if (agentNames.some(n => t.includes(n))) {
    return { type: 'triage', inferred: true };
  }

  return { type: 'general' };
}

// Main Jarvis entry point.
//
// Phase E: Jarvis is a REAL agentic Principal Engineer. Open-ended, plain-words
// questions are reasoned about with a real Claude call (sources/jarvis.js) —
// Jarvis decides who to delegate to, gathers their live findings, and answers.
// With no API key it declines honestly; it NEVER falls back to a keyword router
// pretending to reason.
//
// Deterministic, PRESERVED squad operations (standup, roll call, weekly report,
// help, ping) are unambiguous app actions the operator typed — not Jarvis
// reasoning about the network — so they stay rule-handled and work with or
// without a key. EVERYTHING else the operator says in plain words — including
// "who should look at this?", incident descriptions, and any network question —
// is REAL agentic reasoning. It is never keyword-routed to a canned triage /
// escalate / overview and passed off as thinking: with a key Jarvis plans and
// delegates for real; with no key it shows the honest "needs your API key" state.
//
// (The manual "Open Triage" flow from Phase A is a separate surface and is
// untouched — it still works regardless of the key.)
function simulateJarvisAction(agentId, command) {
  const intent = detectJarvisIntent(command);

  // Only unambiguous, explicitly-typed squad operations stay deterministic.
  if (!intent.inferred) {
    switch (intent.type) {
      case 'standup':        return simulateStandup(agentId);
      case 'squad_status':   return simulateSquadStatus(agentId);
      case 'weekly_report':  return simulateWeeklyReport(agentId);
      case 'ping':           return simulatePing(agentId);
      case 'help':           return showJarvisHelp(agentId);
    }
  }

  // Open-ended reasoning (triage/escalate/general/inferred) → REAL agentic Jarvis.
  return jarvis.ask(command);
}

// Jarvis: Daily standup — collect status from all agents
function simulateStandup(agentId) {
  const jarvis = agents[agentId];
  updateAgentStatus(agentId, 'active', 'Running daily standup');
  addTaskToBoard('inProgress', { title: 'Daily Standup', agent: 'Jarvis' });

  const managedAgents = jarvis.manages || [];

  setTimeout(() => {
    broadcast('chat_message', {
      type: 'incoming', agent: agentId, agentName: jarvis.name, agentIcon: jarvis.icon,
      text: `📢 **DAILY STANDUP — ${new Date().toLocaleDateString()}**\nCollecting status from ${managedAgents.length} agents...`,
      timestamp: new Date().toISOString()
    });
    appendToActivityLog(`[${new Date().toISOString()}] [Jarvis] Daily standup initiated\n`);
  }, 500);

  let delay = 1500;
  const statusLines = [];

  managedAgents.forEach((id) => {
    const a = agents[id];
    setTimeout(() => {
      const statusIcon = a ? (a.status === 'active' ? '🟢' : a.status === 'idle' ? '🟡' : '🔴') : '⚫';
      const name = a ? a.name : id;
      const icon = a ? a.icon : '🤖';
      const action = a ? a.lastAction : 'Not deployed';
      const line = `${statusIcon} ${icon} **${name}** — ${action}`;
      statusLines.push(line);

      broadcast('chat_message', {
        type: 'incoming', agent: agentId, agentName: jarvis.name, agentIcon: jarvis.icon,
        text: `${statusIcon} ${icon} ${name}: ${action}`,
        timestamp: new Date().toISOString()
      });
    }, delay);
    delay += 800;
  });

  setTimeout(() => {
    const activeCount = managedAgents.filter(id => agents[id]?.status === 'active').length;
    const idleCount = managedAgents.filter(id => agents[id]?.status === 'idle').length;
    const offlineCount = managedAgents.length - activeCount - idleCount;

    broadcast('chat_message', {
      type: 'incoming', agent: agentId, agentName: jarvis.name, agentIcon: jarvis.icon,
      text: `📊 **Standup Summary**\n🟢 Active: ${activeCount} | 🟡 Idle: ${idleCount} | 🔴 Offline: ${offlineCount}\n✅ Standup complete. All agents accounted for.`,
      timestamp: new Date().toISOString()
    });

    appendToActivityLog(`[${new Date().toISOString()}] [Jarvis] Standup complete — Active: ${activeCount}, Idle: ${idleCount}, Offline: ${offlineCount}\n`);
    updateAgentStatus(agentId, 'active', 'Standup complete — monitoring squad');
    moveTaskOnBoard('Daily Standup', 'inProgress', 'done');
  }, delay + 500);
}

// Jarvis: Squad status / roll call
function simulateSquadStatus(agentId) {
  const jarvis = agents[agentId];
  updateAgentStatus(agentId, 'active', 'Checking squad status');

  setTimeout(() => {
    const managedAgents = jarvis.manages || [];
    const lines = managedAgents.map(id => {
      const a = agents[id];
      if (!a) return `⚫ 🤖 ${id} — Not deployed`;
      const statusIcon = a.status === 'active' ? '🟢' : a.status === 'idle' ? '🟡' : '🔴';
      return `${statusIcon} ${a.icon} ${a.name} — ${a.lastAction}`;
    });

    broadcast('chat_message', {
      type: 'incoming', agent: agentId, agentName: jarvis.name, agentIcon: jarvis.icon,
      text: `🎖️ **Squad Status Report**\n━━━━━━━━━━━━━━━━━━━━\n${lines.join('\n')}\n━━━━━━━━━━━━━━━━━━━━\nTotal: ${managedAgents.length} agents`,
      timestamp: new Date().toISOString()
    });
    updateAgentStatus(agentId, 'active', 'Monitoring squad');
  }, 1000);
}

// Jarvis: Weekly summary report
function simulateWeeklyReport(agentId) {
  const jarvis = agents[agentId];
  updateAgentStatus(agentId, 'active', 'Generating weekly report');
  addTaskToBoard('inProgress', { title: 'Weekly Summary Report', agent: 'Jarvis' });

  const steps = [
    { delay: 500, msg: '📊 Generating weekly squad report...' },
    { delay: 1500, msg: '📁 Scanning task history...' },
    { delay: 2500, msg: '📈 Analyzing agent performance...' },
  ];

  steps.forEach(step => {
    setTimeout(() => {
      broadcast('chat_message', {
        type: 'incoming', agent: agentId, agentName: jarvis.name, agentIcon: jarvis.icon,
        text: step.msg,
        timestamp: new Date().toISOString()
      });
    }, step.delay);
  });

  setTimeout(() => {
    const tasks = getTasks();
    const doneCount = (tasks.done || []).length;
    const inProgressCount = (tasks.inProgress || []).length;
    const inboxCount = (tasks.inbox || []).length;
    const managedAgents = jarvis.manages || [];
    const activeCount = managedAgents.filter(id => agents[id]?.status === 'active').length;

    const reportContent = `# Weekly Squad Report
**Generated:** ${new Date().toISOString()}
**Squad Lead:** Jarvis 🎖️

## Squad Overview
- Total Agents: ${managedAgents.length}
- Active: ${activeCount}
- Idle: ${managedAgents.length - activeCount}

## Task Summary
- Completed: ${doneCount}
- In Progress: ${inProgressCount}
- Inbox: ${inboxCount}

## Agent Status
${managedAgents.map(id => {
  const a = agents[id];
  if (!a) return `| ${id} | Not Deployed | - |`;
  return `| ${a.icon} ${a.name} | ${a.status} | ${a.lastAction} |`;
}).join('\n')}

## Recommendations
- ${inboxCount > 0 ? `${inboxCount} tasks pending triage in INBOX` : 'All tasks triaged'}
- ${activeCount === 0 ? 'No agents currently active — consider scheduling tasks' : `${activeCount} agents actively working`}

---
*Report generated by Jarvis, Network Squad Lead*
`;

    const reportName = `weekly-report-${Date.now()}.md`;
    const reportPath = path.join(SQUAD_ROOT, 'agents', 'jarvis', reportName);
    // Runs inside a timer — a raw write here would throw where nothing can
    // catch it and would silently abandon the rest of the report.
    safeWrite(reportPath, reportContent, `weekly report ${reportName}`);

    broadcast('chat_message', {
      type: 'incoming', agent: agentId, agentName: jarvis.name, agentIcon: jarvis.icon,
      text: `✅ **Weekly Report Complete**\n📋 Tasks — Done: ${doneCount} | Active: ${inProgressCount} | Inbox: ${inboxCount}\n👥 Squad — ${managedAgents.length} agents, ${activeCount} active\n📁 Report saved: ${reportName}`,
      timestamp: new Date().toISOString()
    });

    appendToActivityLog(`[${new Date().toISOString()}] [Jarvis] Weekly report generated: ${reportName}\n`);
    updateAgentStatus(agentId, 'active', `Weekly report: ${reportName}`);
    moveTaskOnBoard('Weekly Summary Report', 'inProgress', 'done');
  }, 4000);
}

// Jarvis help
function showJarvisHelp(agentId) {
  const jarvis = agents[agentId];
  setTimeout(() => {
    broadcast('chat_message', {
      type: 'incoming', agent: agentId, agentName: jarvis.name, agentIcon: jarvis.icon,
      text: `🎖️ **Jarvis — Squad Lead (Natural Language)**\n━━━━━━━━━━━━━━━━━━━━\nJust talk to me naturally. I understand intent, not just commands.\n\n📢 **Standup** — "check in with the team", "morning briefing", "how's everyone doing?"\n👥 **Squad status** — "who's online?", "show me all agents", "roll call"\n🔍 **Triage/assign** — "we need someone to look at the BGP issue", "assign the firewall audit"\n📊 **Reports** — "give me a summary of the week", "what have we completed?"\n🚨 **Escalate** — "the router is down", "we have a critical outage", "BGP is flapping"\n💬 **Anything else** — just describe the situation and I'll figure out the right action\n━━━━━━━━━━━━━━━━━━━━\nManaging ${(jarvis.manages || []).length} agents`,
      timestamp: new Date().toISOString()
    });
    updateAgentStatus(agentId, 'active', 'Help displayed');
  }, 500);
}

// Update agent status and broadcast
function updateAgentStatus(agentId, status, lastAction) {
  if (agents[agentId]) {
    agents[agentId].status = status;
    agents[agentId].lastAction = lastAction;
    agents[agentId].lastUpdated = new Date().toISOString();
    if (status === 'active') {
      agents[agentId].currentTask = lastAction;
    } else {
      agents[agentId].currentTask = null;
    }

    // Save to STATUS.json
    const statusPath = getAgentStatusPath(agentId);
    if (statusPath) safeWrite(statusPath, JSON.stringify(agents[agentId], null, 2), `${agentId} status`);

    // Transparency contract shape: {agentId, status, note?}. The full agent object
    // (with id/name/icon/lastAction) is still carried so a client can render either
    // a status-light delta or a full-roster refresh from the same event.
    broadcast('agent_status', { ...agents[agentId], agentId, status, note: lastAction || null });
  }
}

// Append to activity log — persist to the file AND stream a live activity_new
// event so the Live Activity panel updates the instant any meaningful thing
// happens (agent engaged, ran X, Jarvis delegated to Y, verdict). One seam, so
// every caller of appendToActivityLog feeds the feed with no per-site wiring.
function appendToActivityLog(entry) {
  safeAppend(PATHS.activityLog, entry, 'activity log');
  const line = String(entry || '').replace(/\n+$/, '');
  if (!line) return;
  const m = /^\[([^\]]+)\]\s*\[([^\]]+)\]\s*([\s\S]*)$/.exec(line);
  broadcast('activity_new', m
    ? { source: m[2], text: m[3], ts: m[1] }
    : { source: 'System', text: line, ts: new Date().toISOString() });
}

// Get tasks from TASKS.md
function getTasks() {
  try {
    if (!fs.existsSync(PATHS.tasksFile)) {
      return { inbox: [], inProgress: [], review: [], done: [], waiting: [] };
    }
    const content = fs.readFileSync(PATHS.tasksFile, 'utf-8');
    return parseTasksFile(content);
  } catch (e) {
    return { inbox: [], inProgress: [], review: [], done: [], waiting: [] };
  }
}

// Parse TASKS.md format
function parseTasksFile(content) {
  const tasks = { inbox: [], inProgress: [], review: [], done: [], waiting: [] };
  let currentSection = null;

  const sectionMap = {
    '## INBOX': 'inbox',
    '## IN PROGRESS': 'inProgress',
    '## REVIEW': 'review',
    '## DONE': 'done',
    '## WAITING': 'waiting'
  };

  content.split('\n').forEach((line, idx) => {
    const trimmed = line.trim();

    // Check for section headers
    for (const [header, section] of Object.entries(sectionMap)) {
      if (trimmed.toUpperCase().startsWith(header.toUpperCase())) {
        currentSection = section;
        return;
      }
    }

    // Parse task lines (- [ ] or - [x] format)
    if (currentSection && (trimmed.startsWith('- [ ]') || trimmed.startsWith('- [x]'))) {
      const completed = trimmed.startsWith('- [x]');
      const text = trimmed.replace(/^- \[.\]\s*/, '');

      // Extract agent tag if present
      const agentMatch = text.match(/\[([^\]]+)\]/);
      const agent = agentMatch ? agentMatch[1] : null;
      const title = text.replace(/\[[^\]]+\]\s*/, '');

      tasks[currentSection].push({
        id: `task-${idx}`,
        title,
        agent,
        completed,
        raw: trimmed
      });
    }
  });

  return tasks;
}

// Get recent files from all agent directories
function getRecentFiles() {
  try {
    const files = [];
    const skipFiles = new Set(['STATUS.json', 'CLAUDE.md']);

    // Scan each agent's directory for output files
    AGENT_IDS.forEach(agentId => {
      const agentDir = path.join(SQUAD_ROOT, 'agents', agentId);
      if (!fs.existsSync(agentDir)) return;

      // Scan agent root directory
      fs.readdirSync(agentDir).forEach(item => {
        if (skipFiles.has(item) || item.startsWith('.')) return;
        const itemPath = path.join(agentDir, item);
        const stats = fs.statSync(itemPath);

        if (stats.isFile()) {
          files.push({
            name: item,
            path: itemPath,
            size: stats.size,
            modified: stats.mtime.toISOString(),
            agent: agentId,
            type: path.extname(item).slice(1) || 'file'
          });
        } else if (stats.isDirectory()) {
          // Scan subdirectories (e.g., reports/)
          try {
            fs.readdirSync(itemPath).forEach(subFile => {
              const subPath = path.join(itemPath, subFile);
              const subStats = fs.statSync(subPath);
              if (subStats.isFile()) {
                files.push({
                  name: subFile,
                  path: subPath,
                  size: subStats.size,
                  modified: subStats.mtime.toISOString(),
                  agent: agentId,
                  type: path.extname(subFile).slice(1) || 'file'
                });
              }
            });
          } catch (e) { /* skip unreadable dirs */ }
        }
      });
    });

    // Sort by modified date (newest first)
    files.sort((a, b) => new Date(b.modified) - new Date(a.modified));
    return files.slice(0, 30);
  } catch (e) {
    return [];
  }
}

// Get recent activity from log
function getRecentActivity() {
  try {
    if (!fs.existsSync(PATHS.activityLog)) {
      return [];
    }
    const content = fs.readFileSync(PATHS.activityLog, 'utf-8');
    const lines = content.split('\n').filter(line => line.trim());

    // Parse activity lines
    const activities = lines.map((line, idx) => {
      const match = line.match(/\[([^\]]+)\]\s*\[([^\]]+)\]\s*(.*)/);
      if (match) {
        return {
          id: `activity-${idx}`,
          timestamp: match[1],
          agent: match[2],
          message: match[3]
        };
      }
      return { id: `activity-${idx}`, timestamp: new Date().toISOString(), agent: 'System', message: line };
    });

    return activities.slice(-50).reverse(); // Last 50, newest first
  } catch (e) {
    return [];
  }
}

// Load agent status from file
function loadAgentStatus(agentId) {
  const statusPath = getAgentStatusPath(agentId);
  if (!statusPath) return;
  try {
    if (fs.existsSync(statusPath)) {
      const data = JSON.parse(fs.readFileSync(statusPath, 'utf-8'));
      if (agents[agentId]) {
        agents[agentId] = {
          ...agents[agentId],
          status: data.status || 'idle',
          currentTask: data.currentTask || null,
          lastUpdated: data.lastUpdated || new Date().toISOString(),
          lastAction: data.lastAction || 'No recent activity'
        };
      }
    }
  } catch (e) {
    console.error(`[Status] Error loading ${agentId} status:`, e.message);
  }
}

// ============ DEBATE SYSTEM ============
let activeDebateId = null;

// Start a new debate thread
function startDebate(initiatorId, topic) {
  const initiator = agents[initiatorId];
  if (!initiator) return;

  const debateId = ++debateIdCounter;
  const timestamp = new Date().toISOString();

  // Determine relevant agents based on topic keywords
  const topicLower = topic.toLowerCase();
  const participants = [initiatorId];

  // Auto-invite based on topic
  if (topicLower.match(/firewall|acl|policy|fortios|fortigate/i)) participants.push('firewall-pro');
  if (topicLower.match(/security|cve|vuln|threat|advisory/i)) participants.push('sentinel');
  if (topicLower.match(/config|backup|compliance|change|upgrade/i)) participants.push('config-keeper');
  if (topicLower.match(/load.?bal|f5|vip|pool/i)) participants.push('loadbal-pro');
  if (topicLower.match(/route|bgp|ospf|convergence/i)) participants.push('router-expert');
  if (topicLower.match(/monitor|alert|threshold|splunk/i)) participants.push('monitor-eye');
  if (topicLower.match(/incident|outage|down/i)) participants.push('incident-handler');
  if (topicLower.match(/doc|runbook|procedure/i)) participants.push('doc-writer');
  if (topicLower.match(/network|device|ssh|check/i)) participants.push('netops');

  // Always include jarvis as moderator
  if (!participants.includes('jarvis')) participants.push('jarvis');

  // Ensure at least 3 participants (add netops/sentinel if needed)
  if (participants.length < 3) {
    if (!participants.includes('netops')) participants.push('netops');
    if (participants.length < 3 && !participants.includes('sentinel')) participants.push('sentinel');
  }

  // Deduplicate
  const uniqueParticipants = [...new Set(participants)];

  const thread = {
    id: debateId,
    topic,
    initiator: initiatorId,
    initiatorName: initiator.name,
    participants: uniqueParticipants,
    messages: [],
    status: 'open',
    created: timestamp,
    updated: timestamp
  };

  debateThreads.push(thread);
  activeDebateId = debateId;

  // Broadcast new debate
  broadcast('debate_new', thread);

  // Jarvis announces the debate
  const participantNames = uniqueParticipants.map(id => `${agents[id]?.icon || '🤖'} ${agents[id]?.name || id}`).join(', ');
  broadcast('chat_message', {
    type: 'incoming',
    agent: 'jarvis',
    agentName: 'Jarvis',
    agentIcon: '🎖️',
    text: `⚔️ **DEBATE INITIATED**\n📋 Topic: "${topic}"\n👥 Participants: ${participantNames}\n\nI'll moderate this discussion. Agents, share your perspectives.`,
    timestamp
  });

  appendToActivityLog(`[${timestamp}] [Jarvis] Debate started: "${topic}" with ${uniqueParticipants.length} participants\n`);

  // Add initial message from initiator
  thread.messages.push({
    id: 1,
    agent: initiatorId,
    agentName: initiator.name,
    agentIcon: initiator.icon,
    stance: 'propose',
    text: `I'd like to discuss: ${topic}`,
    timestamp
  });

  // Each agent now goes and READS its own live source. No opinions are
  // generated — an agent either reports what its source just returned, or says
  // it is not connected. Runs one after another so the panel reads like a
  // conversation, and every agent is handed back its previous status after it
  // has spoken (a debate must not leave anyone stuck "active").
  const respondingAgents = uniqueParticipants.filter(id => id !== initiatorId);
  runDebateContributions(thread, respondingAgents);
}

// Walk the participants, one live read each, then let Jarvis summarise.
async function runDebateContributions(thread, respondingAgents) {
  const { id: debateId, topic } = thread;

  for (const agentId of respondingAgents) {
    const agent = agents[agentId];
    if (!agent) continue;
    if (thread.status !== 'open') break;

    const priorStatus = agent.status;
    const priorAction = agent.lastAction;
    updateAgentStatus(agentId, 'active', `Reading live data for debate: ${topic}`);

    // debateContribution never throws — a failed read comes back as a
    // "source unreachable" contribution, never as canned text.
    const response = await live.debateContribution(agentId, topic);
    const msgTimestamp = new Date().toISOString();

    thread.messages.push({
      id: thread.messages.length + 1,
      agent: agentId,
      agentName: agent.name,
      agentIcon: agent.icon,
      stance: response.stance,
      text: response.text,
      timestamp: msgTimestamp
    });
    thread.updated = msgTimestamp;

    broadcast('debate_message', {
      debateId,
      message: thread.messages[thread.messages.length - 1]
    });

    broadcast('chat_message', {
      type: 'incoming',
      agent: agentId,
      agentName: agent.name,
      agentIcon: agent.icon,
      text: `⚔️ [Debate] ${getStanceBadge(response.stance)} ${response.text}`,
      timestamp: msgTimestamp
    });

    appendToActivityLog(`[${msgTimestamp}] [${agent.name}] Debate contribution (${response.stance}) on "${topic}"\n`);

    // Hand the agent back the status it had before it was pulled in — but a
    // debate must never be the thing that leaves an agent "active", so a prior
    // debate status is dropped rather than restored.
    const wasBusyOnRealWork = priorStatus === 'active' && !/debat/i.test(priorAction || '');
    updateAgentStatus(
      agentId,
      wasBusyOnRealWork ? 'active' : 'idle',
      wasBusyOnRealWork ? priorAction : 'Debate contribution delivered'
    );
  }

  if (thread.status !== 'open') return;

  const summary = generateDebateSummary(thread);
  const summaryTimestamp = new Date().toISOString();

  thread.messages.push({
    id: thread.messages.length + 1,
    agent: 'jarvis',
    agentName: 'Jarvis',
    agentIcon: '🎖️',
    stance: 'summary',
    text: summary,
    timestamp: summaryTimestamp
  });
  thread.updated = summaryTimestamp;

  broadcast('debate_message', {
    debateId,
    message: thread.messages[thread.messages.length - 1]
  });

  broadcast('chat_message', {
    type: 'incoming',
    agent: 'jarvis',
    agentName: 'Jarvis',
    agentIcon: '🎖️',
    text: `⚔️ [Debate Summary] ${summary}\n\nType "resolve" to close this debate, or continue discussing.`,
    timestamp: summaryTimestamp
  });

  // Belt and braces: nobody stays "active" because a debate happened.
  thread.participants.forEach(id => {
    if (agents[id] && agents[id].status === 'active' &&
        /debat/i.test(agents[id].lastAction || '')) {
      updateAgentStatus(id, 'idle', 'Debate contribution delivered');
    }
  });
}


function getStanceBadge(stance) {
  switch (stance) {
    case 'agree': return '🟢 AGREE:';
    case 'refute': return '🔴 REFUTE:';
    case 'alternative': return '🟡 ALTERNATIVE:';
    case 'propose': return '💡 PROPOSE:';
    case 'summary': return '📊 SUMMARY:';
    case 'evidence': return '📡 LIVE DATA:';
    case 'no-data': return '🔌 NO DATA:';
    default: return '';
  }
}

// The summary counts what actually happened: how many agents brought live
// readings and how many had nothing to read. Opinion stances (agree/refute/
// alternative) only ever come from a person typing them into the debate.
function generateDebateSummary(thread) {
  const count = (s) => thread.messages.filter(m => m.stance === s).length;
  const evidence = count('evidence');
  const noData = count('no-data');
  const agrees = count('agree');
  const refutes = count('refute');
  const alternatives = count('alternative');

  const silent = thread.messages
    .filter(m => m.stance === 'no-data')
    .map(m => m.agentName);

  let verdict;
  if (evidence === 0 && noData === 0) {
    verdict = 'Nothing read yet.';
  } else if (evidence === 0) {
    verdict = 'No live data at all behind this topic — every invited agent is unconnected or its source is down. There is nothing here to decide on.';
  } else {
    verdict = `${evidence} agent(s) brought live readings; ${noData} had no source to read` +
      (silent.length ? ` (${silent.join(', ')})` : '') +
      `. Weigh this only on the ${evidence} live reading(s) above — the rest is not evidence either way.`;
  }

  const opinions = (agrees + refutes + alternatives)
    ? `\n🗣 Typed-in positions: 🟢 ${agrees} agree | 🔴 ${refutes} refute | 🟡 ${alternatives} alternative`
    : '';

  return `📊 **Debate Status: "${thread.topic}"**\n📡 Live data: ${evidence} | 🔌 No data: ${noData}${opinions}\n📋 ${verdict}`;
}

// Add a message to an active debate
function addDebateMessage(agentId, stance, text) {
  const thread = debateThreads.find(t => t.id === activeDebateId);
  if (!thread || thread.status !== 'open') return;

  const agent = agents[agentId];
  if (!agent) return;

  const timestamp = new Date().toISOString();
  const message = {
    id: thread.messages.length + 1,
    agent: agentId,
    agentName: agent.name,
    agentIcon: agent.icon,
    stance,
    text,
    timestamp
  };

  thread.messages.push(message);
  thread.updated = timestamp;

  // Add agent to participants if not already
  if (!thread.participants.includes(agentId)) {
    thread.participants.push(agentId);
  }

  broadcast('debate_message', { debateId: activeDebateId, message });

  broadcast('chat_message', {
    type: 'incoming',
    agent: agentId,
    agentName: agent.name,
    agentIcon: agent.icon,
    text: `⚔️ [Debate] ${getStanceBadge(stance)} ${text}`,
    timestamp
  });

  appendToActivityLog(`[${timestamp}] [${agent.name}] Debate ${stance}: ${text}\n`);
}

// Resolve/close a debate
function resolveDebate(agentId) {
  const thread = debateThreads.find(t => t.id === activeDebateId);
  if (!thread) return;

  const agent = agents[agentId];
  const timestamp = new Date().toISOString();

  thread.status = 'resolved';
  thread.updated = timestamp;

  const summary = generateDebateSummary(thread);
  const resolution = {
    id: thread.messages.length + 1,
    agent: 'jarvis',
    agentName: 'Jarvis',
    agentIcon: '🎖️',
    stance: 'summary',
    text: `✅ **DEBATE RESOLVED**\n${summary}\n\nDebate closed by ${agent ? agent.name : 'System'}.`,
    timestamp
  };

  thread.messages.push(resolution);

  broadcast('debate_resolved', { debateId: activeDebateId, thread });
  broadcast('debate_message', { debateId: activeDebateId, message: resolution });

  broadcast('chat_message', {
    type: 'incoming',
    agent: 'jarvis',
    agentName: 'Jarvis',
    agentIcon: '🎖️',
    text: resolution.text,
    timestamp
  });

  appendToActivityLog(`[${timestamp}] [Jarvis] Debate resolved: "${thread.topic}"\n`);

  // Reset active debate
  activeDebateId = null;

  // Return participants to idle
  thread.participants.forEach(id => {
    if (id !== 'jarvis') updateAgentStatus(id, 'idle', 'Debate concluded');
  });
}

// API Endpoints

// Jarvis reasoning status — presence of the Anthropic key ONLY (never the value),
// so the UI can show the honest "needs your API key to think" banner.
app.get('/api/jarvis/status', (req, res) => {
  res.json(jarvis.keyStatus());
});

app.get('/api/agents', (req, res) => {
  // Refresh status before responding
  Object.keys(agents).forEach(loadAgentStatus);
  res.json(Object.values(agents));
});

app.get('/api/tasks', (req, res) => {
  res.json(getTasks());
});

// Save tasks to TASKS.md
app.post('/api/tasks', (req, res) => {
  try {
    const tasks = req.body;
    const content = generateTasksMarkdown(tasks);
    if (!safeWrite(PATHS.tasksFile, content, 'task board')) {
      return res.status(500).json({ error: 'Could not save the task board' });
    }
    res.json({ success: true });
  } catch (e) {
    console.error('[Tasks] Save failed:', e.message);
    res.status(500).json({ error: 'Could not save the task board' });
  }
});

// Generate TASKS.md content from tasks object
function generateTasksMarkdown(tasks) {
  const formatTask = (task) => {
    const checkbox = task.completed ? '[x]' : '[ ]';
    const agent = task.agent ? `[${task.agent}] ` : '';
    return `- ${checkbox} ${agent}${task.title}`;
  };

  let md = '# Agent Task Board\n\n';

  md += '## INBOX\n';
  (tasks.inbox || []).forEach(t => md += formatTask(t) + '\n');
  md += '\n';

  md += '## IN PROGRESS\n';
  (tasks.inProgress || []).forEach(t => md += formatTask(t) + '\n');
  md += '\n';

  md += '## REVIEW\n';
  (tasks.review || []).forEach(t => md += formatTask(t) + '\n');
  md += '\n';

  md += '## DONE\n';
  (tasks.done || []).forEach(t => md += formatTask({...t, completed: true}) + '\n');
  md += '\n';

  md += '## WAITING\n';
  (tasks.waiting || []).forEach(t => md += formatTask(t) + '\n');

  return md;
}

// Add a task to the board programmatically
function addTaskToBoard(column, task) {
  const tasks = getTasks();

  if (!tasks[column]) {
    tasks[column] = [];
  }

  const newTask = {
    id: `task-${Date.now()}`,
    title: task.title,
    agent: task.agent || null,
    completed: task.completed || false
  };

  tasks[column].push(newTask);

  // Save to file. A failed write reports itself to the dashboard instead of
  // throwing — this runs inside timers where a throw would kill the process.
  const content = generateTasksMarkdown(tasks);
  if (!safeWrite(PATHS.tasksFile, content, 'task board')) return null;

  // Broadcast update
  broadcast('tasks_updated', tasks);

  console.log(`[Tasks] Added task to ${column}: ${task.title}`);
  return newTask;
}

// Move a task between columns
function moveTaskOnBoard(taskTitle, fromColumn, toColumn) {
  const tasks = getTasks();

  // Find task in source column
  const fromTasks = tasks[fromColumn] || [];
  const taskIndex = fromTasks.findIndex(t => t.title === taskTitle);

  if (taskIndex === -1) {
    console.log(`[Tasks] Task not found in ${fromColumn}: ${taskTitle}`);
    return false;
  }

  // Remove from source
  const [task] = fromTasks.splice(taskIndex, 1);

  // Update completion status
  task.completed = toColumn === 'done';

  // Add to destination
  if (!tasks[toColumn]) {
    tasks[toColumn] = [];
  }
  tasks[toColumn].push(task);

  // Save to file (never throws — see addTaskToBoard)
  const content = generateTasksMarkdown(tasks);
  if (!safeWrite(PATHS.tasksFile, content, 'task board')) return false;

  // Broadcast update
  broadcast('tasks_updated', tasks);

  console.log(`[Tasks] Moved task from ${fromColumn} to ${toColumn}: ${taskTitle}`);

  // When a task completes:
  // 1. Clear the mention badge for the assigned agent
  // 2. Auto-remove from done column after 4 seconds
  if (toColumn === 'done') {
    // Clear mention count for the agent who completed the task
    if (task.agent) {
      const agentId = AGENT_IDS.find(id => {
        const a = agents[id];
        return a && a.name && a.name.toLowerCase() === task.agent.toLowerCase();
      });
      if (agentId && mentionCounts[agentId] > 0) {
        mentionCounts[agentId] = 0;
        broadcast('agents_updated', {
          agents: Object.values(agents),
          mentionCounts: { ...mentionCounts }
        });
        console.log(`[Tasks] Cleared mention badge for ${task.agent}`);
      }
    }

    // Auto-remove from done after 4 seconds so board stays clean
    setTimeout(() => {
      try {
        const latest = getTasks();
        const doneIdx = (latest.done || []).findIndex(t => t.title === taskTitle);
        if (doneIdx !== -1) {
          latest.done.splice(doneIdx, 1);
          const updated = generateTasksMarkdown(latest);
          if (!safeWrite(PATHS.tasksFile, updated, 'task board')) return;
          broadcast('tasks_updated', latest);
          console.log(`[Tasks] Auto-removed completed task from board: ${taskTitle}`);
        }
      } catch (e) {
        // Nothing can catch a throw from inside a timer — handle it here.
        reportSystemError('Could not tidy the task board', e);
      }
    }, 4000);
  }

  return true;
}

// Create a task from a command
function createTaskFromCommand(agentId, command, column = 'inbox') {
  const agent = agents[agentId];
  return addTaskToBoard(column, {
    title: command,
    agent: agent ? agent.name : agentId,
    completed: false
  });
}

// Pause / Resume endpoints
app.post('/api/pause', (req, res) => {
  isPaused = true;
  broadcast('pause_state', { paused: true });
  appendToActivityLog(`[${new Date().toISOString()}] [Dashboard] ⏸ System PAUSED by Vikas\n`);
  res.json({ success: true, paused: true });
});

app.post('/api/resume', (req, res) => {
  isPaused = false;
  broadcast('pause_state', { paused: false });
  appendToActivityLog(`[${new Date().toISOString()}] [Dashboard] ▶ System RESUMED by Vikas\n`);
  res.json({ success: true, paused: false });
});

// Debate API endpoints
app.get('/api/debates', (req, res) => {
  res.json(debateThreads);
});

app.post('/api/debates', (req, res) => {
  const { initiator, topic } = req.body;
  if (!topic) return res.status(400).json({ error: 'Topic required' });
  startDebate(initiator || 'jarvis', topic);
  res.json({ success: true, debateId: debateIdCounter });
});

app.get('/api/debates/:id', (req, res) => {
  const thread = debateThreads.find(t => t.id === parseInt(req.params.id));
  if (!thread) return res.status(404).json({ error: 'Debate not found' });
  res.json(thread);
});

// ── Triage bridge endpoints ─────────────────────────────────────────────────
// POST starts a triage; the bridge then streams its events over the WebSocket.
// A description that names no real network subject is refused here (422) and no
// bridge is started — the honesty rule, enforced at the entry point.
app.post('/api/triage', (req, res) => {
  // operatorTz (gap 1): the client sends its IANA timezone (e.g. "Asia/Kolkata") so a
  // bare clock time like "since 2pm" is read in the OPERATOR's zone, not UTC. Absent
  // (older client) -> the engine falls back to the server's local zone and says so.
  const { severity, description, operatorTz } = req.body || {};
  const result = triage.startTriage(severity, description, operatorTz);
  if (result.refused) {
    return res.status(422).json({ error: result.reason });
  }
  // relatedTo (Wave 3): OPEN incidents this new triage may overlap with — surfaced
  // for the operator, never auto-merged. [] when there is no real shared scope.
  res.json({ triageId: result.triageId, incidentId: result.incidentId, relatedTo: result.relatedTo || [] });
});

// ── Alert-driven ingestion (Wave 2) ─────────────────────────────────────────
// POST an inbound monitoring alert (vManage / Catalyst / SNMP / Splunk-style) and
// AUTO-OPEN a triage from it. The alert is normalized, its severity mapped onto
// P1/P2/P3, and a triage description derived DETERMINISTICALLY (no LLM). A
// malformed payload, or an alert that names nothing real, is refused with a clean
// 422 — no phantom triage. Write-rate-limited via the shared /api/ budget.
//
// Contract: on success returns { triageId, incidentId, severity, source:'alert',
// alert:{...} }. The bridge then streams triage_opened (data.source='alert',
// data.alert={...}) + an "Alert-triggered triage" activity_new line.
//
// A `sample:true` flag substitutes a clearly-labelled SAMPLE alert (same as the
// dedicated /api/alerts/sample endpoint) so the flow can be tested without a real
// inbound — the opened triage is real, only the alert is marked sample:true.
app.post('/api/alerts', (req, res) => {
  const body = req.body || {};
  const useSample = body.sample === true;
  const payload = useSample ? triage.sampleAlert() : body;
  const result = triage.startTriageFromAlert(payload, { sample: useSample });
  if (result.error) {
    // Both 'malformed' and 'nonsense' are the operator's/monitor's bad input → 422.
    return res.status(422).json({ error: result.reason || 'Alert could not be ingested.' });
  }
  res.json(result);
});

// DEV helper: post a realistic SAMPLE alert to watch the alert→triage flow end to
// end without a real inbound. The opened triage is REAL (there is no fake path) —
// the alert is just marked sample:true so it is never mistaken for production.
app.post('/api/alerts/sample', (req, res) => {
  const result = triage.startTriageFromAlert(triage.sampleAlert(), { sample: true });
  if (result.error) {
    return res.status(422).json({ error: result.reason || 'Sample alert could not be ingested.' });
  }
  res.json({ ...result, note: 'This is a clearly-labelled SAMPLE alert (sample:true). It opened a real triage for testing.' });
});

// List of recent triages (id, severity, title, status, openedAt).
app.get('/api/triage', (req, res) => {
  res.json(triage.listTriages());
});

// ── Incident queue (Wave 3) ─────────────────────────────────────────────────
// The multi-incident queue view: all open + recent triages as compact rows,
// most-urgent first. Each concurrent bridge already has its own id — this just
// exposes the list cleanly. Contract: [{triageId, incidentId, severity, source,
// status, owner, title, openedAt, sla:{targetMs,breached}}]. Read-rate-limited.
app.get('/api/incidents', (req, res) => {
  res.json(triage.listIncidents());
});

// Full current triage object, for reconnect/refresh.
app.get('/api/triage/:id', (req, res) => {
  const t = triage.getTriage(req.params.id);
  if (!t) return res.status(404).json({ error: 'Triage not found' });
  res.json(t);
});

// Operator posts a message into an OPEN triage bridge (context / a nudge). It is
// streamed on the bridge, recorded in the triage record, and marked as coming
// from the operator — it never touches the evidence board. Write-rate-limited.
app.post('/api/triage/:id/message', (req, res) => {
  const { text } = req.body || {};
  const result = triage.postOperatorMessage(req.params.id, text);
  if (result.error) {
    const code = result.error === 'not_found' ? 404 : 422;
    return res.status(code).json({ error: result.reason || 'Could not post that.' });
  }
  res.json({ ok: true, message: result.message });
});

// Bridge roles (wave 1). The operator sets any of commander / scribe / joiners /
// owner on an open bridge — plain strings, no auth yet. Broadcasts triage_roles.
// Write-rate-limited (POST via the shared /api/ budget). Path-safe: the id is a
// pure in-memory lookup (resolveTriage) and is shape-validated (trg-/INC- only),
// so it never reaches the filesystem. Accepts either the trg- id or the INC- id.
app.post('/api/triage/:id/roles', (req, res) => {
  const b = req.body || {};
  // Accept both key spellings so the UI (incidentCommander/currentOwner) and the
  // canonical model (commander/owner) round-trip cleanly.
  const commander = b.commander !== undefined ? b.commander : b.incidentCommander;
  const owner = b.owner !== undefined ? b.owner : b.currentOwner;
  const { scribe, joiners } = b;
  const result = triage.setRoles(req.params.id, { commander, scribe, joiners, owner });
  if (result.error) {
    const code = result.error === 'not_found' ? 404 : 422;
    return res.status(code).json({ error: result.reason || 'Could not set roles.' });
  }
  res.json(result);
});

// Acknowledge / MTTA (wave 1). Stamps ackAt once and computes mttaMs
// (ackAt − openedAt); broadcasts triage_ack. Idempotent — a second call returns
// the same stamp. Write-rate-limited; path-safe (in-memory, shape-validated id).
app.post('/api/triage/:id/ack', (req, res) => {
  const result = triage.acknowledge(req.params.id);
  if (result.error) {
    const code = result.error === 'not_found' ? 404 : 422;
    return res.status(code).json({ error: result.reason || 'Could not acknowledge.' });
  }
  res.json(result);
});

// Re-triage & diff (issue 11 — ops lifecycle). Re-runs the SAME triage (same
// severity, symptom, scope), links it to the SAME incident id, and returns the
// REAL delta vs the previous verdict: fronts improved/worsened, faults/alarms
// new/cleared, config changes, and whether the hypothesis moved. A real re-run —
// it awaits the fresh bridge — so the delta is real, never a fabricated
// "nothing changed". Write-rate-limited (POST). Path-safe: the id is looked up in
// the in-memory map / resolved through the workspace guard in artifacts.getRecord.
app.post('/api/triage/:id/retriage', async (req, res) => {
  try {
    const result = await triage.retriage(req.params.id);
    if (result.error) {
      const code = result.error === 'not_found' ? 404 : 422;
      return res.status(code).json({ error: result.reason || 'Could not re-triage.' });
    }
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: 'Re-triage failed.' });
  }
});

// ServiceNow / ITSM export (issue 11). Returns the structured ServiceNow-ready
// object built from the REAL persisted record (real incident id, affected CIs,
// hypothesis, MTTR) plus a copy-ready text form. Read-rate-limited (GET). The id
// is resolved through the workspace safeJoin guard inside artifacts — a traversal
// attempt resolves to null and 404s. Secret values never appear (record is
// scrub()'d; CIs are device/tenant names only).
app.get('/api/triage/:id/servicenow', (req, res) => {
  const sn = artifacts.getServiceNow(req.params.id);
  if (!sn) return res.status(404).json({ error: 'No such triage record to export.' });
  res.json({ id: req.params.id, serviceNow: sn.object, text: sn.text, readOnly: true });
});

// ── Triage records / history + auto-written docs (Phase D) ──────────────────
// After a triage closes, its complete REAL record (timeline, every command + raw
// output, evidence transition history, operator posts, verdict) plus two derived
// documents (SLT + engineer) are persisted under the workspace. These read-only
// endpoints let anyone browse them after the fact. Rate-limited via the shared
// /api/ read budget. Every file read is resolved through the workspace safeJoin
// (the Tier-1 path guard) inside sources/artifacts.js — a triage id that tries to
// climb out of the triages folder resolves to null and 404s.
app.get('/api/records', (req, res) => {
  res.json({ records: artifacts.listRecords(), readOnly: true });
});

// One triage's full artifacts (the raw "what actually happened").
app.get('/api/records/:id', (req, res) => {
  const rec = artifacts.getRecord(req.params.id);
  if (!rec) return res.status(404).json({ error: 'No such triage record.' });
  res.json(rec);
});

// One triage's auto-written document — 'slt' (leadership) or 'engineer'.
app.get('/api/records/:id/doc/:which', (req, res) => {
  const which = req.params.which;
  if (which !== 'slt' && which !== 'engineer' && which !== 'servicenow') {
    return res.status(400).json({ error: 'Unknown document — use slt, engineer or servicenow.' });
  }
  const content = artifacts.getDoc(req.params.id, which);
  if (content == null) return res.status(404).json({ error: 'Document not found (or path refused).' });
  const names = { slt: 'Leadership summary', engineer: 'Engineer writeup', servicenow: 'ServiceNow export' };
  res.json({
    id: req.params.id,
    which,
    name: names[which] || which,
    content,
    readOnly: true,
  });
});

// Mention counts endpoint
app.get('/api/mentions', (req, res) => {
  res.json(mentionCounts);
});

app.get('/api/files', (req, res) => {
  res.json(getRecentFiles());
});

app.get('/api/activity', (req, res) => {
  res.json(getRecentActivity());
});

// Which live sources are wired up right now, and which agents they feed.
// An honest "not connected" is a first-class answer here.
app.get('/api/sources', async (req, res) => {
  const check = async (mod) => {
    if (!mod.configured()) return { host: mod.host, status: 'not connected', detail: 'credentials not set' };
    try { await mod.probe(); return { host: mod.host, status: 'live' }; }
    catch (e) { return { host: mod.host, status: 'unreachable', detail: e.message }; }
  };

  res.json({
    sources: {
      'catalyst-center': { label: catalyst.label, ...(await check(catalyst)), agents: ['netops', 'monitor-eye', 'incident-handler', 'doc-writer', 'config-keeper', 'jarvis'] },
      'aci': { label: aci.label, ...(await check(aci)), agents: ['router-expert', 'incident-handler', 'doc-writer', 'jarvis'] },
      'sdwan': { label: sdwan.label, ...(await check(sdwan)), agents: ['router-expert', 'monitor-eye', 'doc-writer', 'jarvis'] },
    },
    notConnected: live.NO_BACKEND,
    readOnly: true,
  });
});

// ── CLI / session view (Phase B) ────────────────────────────────────────────
// The real recorded wire calls: which source was logged into, the exact request
// issued, the RAW response that came back, and a plain-words interpretation. An
// engineer reads these to make sense of the logs the way an SME does. Rate-
// limited via the /api/ read budget. Everything here is REAL — never fabricated.
app.get('/api/session', (req, res) => {
  const { triageId, source, agent, limit } = req.query || {};
  const lim = Math.min(Number(limit) || 300, 600);
  res.json({ records: session.query({ triageId, source, agentId: agent, limit: lim }), readOnly: true });
});

app.get('/api/session/:agent', (req, res) => {
  const lim = Math.min(Number((req.query || {}).limit) || 300, 600);
  res.json({ agent: req.params.agent, records: session.query({ agentId: req.params.agent, limit: lim }), readOnly: true });
});

// ── Permission gate / approvals (Phase C) ───────────────────────────────────
// The REAL gate: every live/triage read passes approvals.gate. In auto mode
// reads auto-approve and are logged; in ask mode they PAUSE for a decision. A
// denied command runs nothing and is never silently swapped. These endpoints
// list/log the records, report+set the mode, and take a decision. Rate-limited
// via the shared /api/ budget (GET on the read budget, POST on the write budget).
app.get('/api/approvals', (req, res) => {
  const { triageId, limit } = req.query || {};
  const lim = Math.min(Number(limit) || 200, 500);
  res.json({ mode: approvals.getMode(), records: approvals.list({ triageId, limit: lim }), readOnly: true });
});

// ── On-call notifier status (Wave 3) ────────────────────────────────────────
// Is an on-call webhook (PagerDuty/Opsgenie/Slack) wired up? Honest: reports
// configured:false when ONCALL_WEBHOOK is unset — it never pretends to page.
// When configured, `target` is the webhook HOST only (never the full URL, which
// may carry a token). Read-rate-limited via the shared /api/ budget.
app.get('/api/notifier/status', (req, res) => {
  res.json(notifier.status());
});

// The persistent approval log — who wanted to run what, when, the decision, the outcome.
app.get('/api/approvals/log', (req, res) => {
  const lim = Math.min(Number((req.query || {}).limit) || 500, 500);
  res.json({ mode: approvals.getMode(), records: approvals.list({ limit: lim }) });
});

// Switch the mode: "auto" (auto-approve safe reads) or "ask" (prompt for each).
app.post('/api/approvals/mode', (req, res) => {
  const mode = approvals.setMode((req.body || {}).mode);
  res.json({ ok: true, mode });
});

// Decide a pending request: approve-once / approve-all (all reads this triage) / deny.
app.post('/api/approvals/:id/decision', (req, res) => {
  const out = approvals.decide(req.params.id, (req.body || {}).decision);
  if (out.error) {
    const code = out.error === 'not_pending' ? 409 : 400;
    return res.status(code).json({ error: out.reason || 'Could not record that decision.' });
  }
  res.json(out);
});

// ── Retry a down source on demand (Phase B) ─────────────────────────────────
// Re-attempt the live connection + a representative read from one source right
// now, and return the REAL fresh result. Success → live data; still down → the
// real new error string. Never a faked success. Write-rate-limited.
const SOURCE_RETRY = {
  'catalyst-center': { mod: catalyst, agent: 'netops', read: async (m) => ({ devices: (await m.getDevices()).length }) },
  'aci':             { mod: aci,      agent: 'router-expert', read: async (m) => ({ nodes: (await m.getFabricNodes()).length }) },
  'sdwan':           { mod: sdwan,    agent: 'router-expert', read: async (m) => ({ devices: (await m.getDevices()).length }) },
};
app.post('/api/sources/:id/retry', async (req, res) => {
  const spec = SOURCE_RETRY[req.params.id];
  if (!spec) return res.status(404).json({ error: 'Unknown source.' });
  const { mod, agent } = spec;
  if (!mod.configured()) {
    return res.json({ id: req.params.id, host: mod.host, status: 'not connected', detail: 'credentials not set — nothing to retry against' });
  }
  try {
    const out = await session.runWithContext(
      { agentId: agent, agentName: (agents[agent] || {}).name || agent, label: `Manual retry — ${mod.label}` },
      async () => { await mod.probe(); return spec.read(mod); });
    return res.json({ id: req.params.id, host: mod.host, status: 'live', detail: out });
  } catch (e) {
    // The REAL fresh error — the source is genuinely still down.
    return res.json({ id: req.params.id, host: mod.host, status: 'unreachable', detail: e.message });
  }
});

// Retry one front INSIDE an open triage — recolours the evidence card from a
// real fresh read (or a real fresh error). Write-rate-limited.
app.post('/api/triage/:id/retry/:front', async (req, res) => {
  const result = await triage.retryFront(req.params.id, req.params.front);
  if (result.error) {
    const code = result.error === 'not_found' ? 404 : 422;
    return res.status(code).json({ error: result.reason || 'Could not retry that front.' });
  }
  res.json(result);
});

app.post('/api/command', (req, res) => {
  const { agent, command } = req.body;
  if (!agent || !command) {
    return res.status(400).json({ error: 'Agent and command required' });
  }
  handleCommand({ agent, command });
  res.json({ success: true, message: 'Command queued' });
});

// File download endpoint
app.get('/api/files/download/:filename', (req, res) => {
  const filename = req.params.filename;

  // This route takes a file NAME, never a path. Express decodes %2f into a
  // slash only after the route matched, which is how `..%2f..%2f` used to walk
  // straight out of the workspace — so the name is rejected outright first.
  if (!isPlainFilename(filename)) {
    return res.status(400).json({ error: 'Bad filename' });
  }

  for (const agentId of AGENT_IDS) {
    for (const rel of [path.join(agentId, filename), path.join(agentId, 'reports', filename)]) {
      const filePath = safeJoin(PATHS.agentWorkspace, rel);
      if (filePath && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        return res.download(filePath);
      }
    }
  }
  res.status(404).json({ error: 'File not found' });
});

// File browser - list directory contents
app.get('/api/browse', (req, res) => {
  const requestedPath = req.query.path || SQUAD_ROOT;

  // One guard, one helper — resolves the path and proves it is inside the
  // workspace (a sibling folder called "squad-secret" no longer sneaks past).
  const normalizedPath = safeJoin(SQUAD_ROOT, String(requestedPath));
  if (!normalizedPath) {
    return res.status(403).json({ error: 'Access denied - path outside workspace' });
  }

  try {
    if (!fs.existsSync(normalizedPath)) {
      return res.status(404).json({ error: 'Path not found' });
    }

    const stats = fs.statSync(normalizedPath);

    if (stats.isFile()) {
      // Return file content
      const ext = path.extname(normalizedPath).toLowerCase();
      const textExts = ['.md', '.txt', '.json', '.yaml', '.yml', '.log', '.csv', '.py', '.js', '.sh', '.bat', '.cfg', '.conf', '.ini'];

      if (textExts.includes(ext)) {
        const content = fs.readFileSync(normalizedPath, 'utf-8');
        return res.json({
          type: 'file',
          path: normalizedPath,
          name: path.basename(normalizedPath),
          content: content.slice(0, 50000), // Limit to 50KB
          size: stats.size,
          modified: stats.mtime.toISOString()
        });
      } else {
        return res.json({
          type: 'file',
          path: normalizedPath,
          name: path.basename(normalizedPath),
          content: '[Binary file - click Download to view]',
          size: stats.size,
          modified: stats.mtime.toISOString(),
          binary: true
        });
      }
    }

    // List directory contents
    const items = fs.readdirSync(normalizedPath).map(name => {
      const itemPath = path.join(normalizedPath, name);
      try {
        const itemStats = fs.statSync(itemPath);
        return {
          name,
          path: itemPath,
          isDirectory: itemStats.isDirectory(),
          size: itemStats.size,
          modified: itemStats.mtime.toISOString()
        };
      } catch (e) {
        return null;
      }
    }).filter(Boolean);

    // Sort: directories first, then files, alphabetically
    items.sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;
      return a.name.localeCompare(b.name);
    });

    res.json({
      type: 'directory',
      path: normalizedPath,
      name: path.basename(normalizedPath),
      parent: normalizedPath !== SQUAD_ROOT ? path.dirname(normalizedPath) : null,
      items,
      root: SQUAD_ROOT
    });
  } catch (e) {
    // Node's own error text carries absolute paths and hostnames — keep it in
    // the server log, hand the browser plain words.
    console.error('[Browse] Failed:', e.message);
    res.status(500).json({ error: 'Could not read that folder' });
  }
});

// Download any file from workspace
app.get('/api/browse/download', (req, res) => {
  const requestedPath = req.query.path;

  if (!requestedPath) {
    return res.status(400).json({ error: 'Path required' });
  }

  const normalizedPath = safeJoin(SQUAD_ROOT, String(requestedPath));
  if (!normalizedPath) {
    return res.status(403).json({ error: 'Access denied' });
  }

  if (fs.existsSync(normalizedPath) && fs.statSync(normalizedPath).isFile()) {
    res.download(normalizedPath);
  } else {
    res.status(404).json({ error: 'File not found' });
  }
});

// Activity log position tracker
let lastActivitySize = 0;

// File watcher setup
function setupFileWatcher() {
  const watchPaths = [
    SQUAD_ROOT
  ];

  const watcher = chokidar.watch(watchPaths, {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 300,
      pollInterval: 100
    }
  });

  watcher.on('add', (filePath) => {
    console.log(`[Watcher] File added: ${filePath}`);
    broadcast('file_added', {
      path: filePath,
      name: path.basename(filePath),
      type: path.extname(filePath).slice(1) || 'file'
    });
    broadcast('files_updated', getRecentFiles());
  });

  watcher.on('change', (filePath) => {
    console.log(`[Watcher] File changed: ${filePath}`);

    const filename = path.basename(filePath);

    // Handle specific file changes
    if (filename === 'TASKS.md') {
      broadcast('tasks_updated', getTasks());
    } else if (filename === 'ACTIVITY_LOG.md') {
      // M3 (round-2 QA): DO NOT re-broadcast activity_new here. Every real
      // activity line is already streamed EXACTLY ONCE by appendToActivityLog
      // (the single canonical emission seam), which broadcasts the {source,text,
      // ts} shape the instant it writes. This watcher used to ALSO re-broadcast
      // each appended line as {timestamp,agent,message}, doubling (and on
      // Windows, where chokidar can fire 'change' more than once per write,
      // tripling) every event in the Live Activity feed — the "artifacts written
      // ×3 / closed ×2 / re-triage opened ×2" bug. We keep only the size cursor
      // advanced so nothing here ever replays the log; emission stays single.
      try {
        const stats = fs.statSync(filePath);
        if (stats.size > lastActivitySize) {
          lastActivitySize = stats.size;
        }
      } catch (e) {
        console.error('[Watcher] Error reading activity log:', e.message);
      }
    } else if (filename === 'STATUS.json') {
      // Determine which agent's status changed by checking directory
      const agentId = AGENT_IDS.find(id => filePath.includes(path.sep + id + path.sep) || filePath.includes('/' + id + '/'));
      if (agentId && agents[agentId]) {
        loadAgentStatus(agentId);
        broadcast('agent_status', agents[agentId]);
      }
    } else if (filename === 'ALERTS.md') {
      broadcast('alerts_updated', { timestamp: new Date().toISOString() });
    }
  });

  watcher.on('unlink', (filePath) => {
    console.log(`[Watcher] File removed: ${filePath}`);
    broadcast('file_removed', { path: filePath, name: path.basename(filePath) });
    broadcast('files_updated', getRecentFiles());
  });

  watcher.on('error', (error) => {
    console.error('[Watcher] Error:', error);
  });

  console.log('[Watcher] Watching for file changes...');
}

// Periodic status refresh
function startStatusRefresh() {
  setInterval(() => {
    if (isPaused) return;
    Object.keys(agents).forEach(agentId => {
      loadAgentStatus(agentId);
    });
    broadcast('agents_updated', Object.values(agents));
  }, 5000); // Every 5 seconds
}

// Initialize activity log size tracker
function initActivityTracker() {
  try {
    if (fs.existsSync(PATHS.activityLog)) {
      lastActivitySize = fs.statSync(PATHS.activityLog).size;
    }
  } catch (e) {
    lastActivitySize = 0;
  }
}

// Start server
// Make sure the workspace exists before anything tries to write into it, so a
// fresh clone boots and works instead of crashing on the first command.
try {
  const created = workspace.ensureWorkspace(AGENT_IDS);
  if (created.length) console.log(`[Workspace] Created ${created.length} missing folders/files under ${SQUAD_ROOT}`);
} catch (e) {
  console.error(`[Workspace] Could not prepare ${SQUAD_ROOT}: ${e.message}`);
  console.error('[Workspace] Set SQUAD_ROOT to a folder this account can write to.');
  process.exit(1);
}

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║     🚀 NOC TRIAGE — EVIDENCE SPLIT CONSOLE (LIVE) 🚀     ║');
  console.log('╠═══════════════════════════════════════════════════════════╣');
  console.log(`║  Dashboard: http://${HOST}:${PORT}`);
  console.log(`║  WebSocket: ws://${HOST}:${PORT}`);
  console.log(`║  Workspace: ${SQUAD_ROOT}`);
  console.log(`║  Allowed origins: ${origins.allowed.join(', ')}`);
  console.log('╠═══════════════════════════════════════════════════════════╣');
  console.log('║  Status: LIVE                                             ║');
  console.log('║  File Watcher: ACTIVE                                     ║');
  console.log('║  Auto-refresh: Every 5 seconds                            ║');
  console.log('╚═══════════════════════════════════════════════════════════╝');
  console.log('');

  initActivityTracker();
  setupFileWatcher();
  startStatusRefresh();
});
