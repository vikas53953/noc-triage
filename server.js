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
const capabilities = require('./sources/capabilities');
const changeRunner = require('./sources/change-runner');
const changeStore = require('./sources/change-store');
const sshRunner = require('./sources/ssh-runner');   // CW-5: SSH transport status
const tickets = require('./sources/tickets');
const ticketStore = require('./sources/ticket-store');
const teams = require('./sources/teams');            // CW-4: Teams bridge (one-way post)
const servicenow = require('./sources/servicenow-client'); // CW-6: two-way ServiceNow sync
const investigation = require('./sources/investigation'); // CW-7: iterative investigation loop
const mcp = require('./sources/mcp-connector');      // CW-8: generic MCP connector (gated, read-only, honest-if-absent)
const guardrails = require('./sources/guardrails');
const { checkIntent } = guardrails;

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

// ── CW-1: operator identity + capability honesty ────────────────────────────
// (One contiguous block: a name-tag middleware and one read-only route. Nothing
// else in this file changes shape, so this lifts out cleanly if it ever must.)
//
// Plain words: the desk asks the operator for their name once and sends it on
// every request as the header `X-Operator-Name`. This middleware turns that
// header into `req.operator`, and runs the rest of the request inside an
// operator context so anything the request triggers — even work that finishes in
// a later timer — knows who asked for it. No auth in v1 (Gate-1 decision): it is
// a name tag, not a login.
//
// THE GATE: a state-changing call from the COPILOT SURFACE with no name is
// refused with 428 "Tell me your name first." Read-only GETs always pass, and
// the classic console (public/index.html) is deliberately NOT part of the
// copilot surface, so every existing route behaves EXACTLY as before for it.
//
// HONEST FRAMING (review of PR #42): the name gate is ATTRIBUTION, NOT ACCESS
// CONTROL. It exists so every copilot action carries a person's name, and it
// fails open by design — a caller that sends no Referer (curl, a script) is not
// stopped, because v1 has no auth at all (Gate-1 decision: open + name tag).
// SSO/auth bolts on at this same seam when real multi-user arrives.
//
// THE AUDIT, BY CONTRAST, IS NOT SCOPED TO THE SURFACE (blocker 2 of that
// review): surface detection reads a URL string, and one URL has many
// spellings — /DESK.HTML, //desk.html, /./desk.html all served the same desk
// page and silently escaped both the gate and the audit. So EVERY
// state-changing /api/ call is audited, whatever the surface, with
// who:"unknown" when it carries no name. No path, spelling or missing header
// can make an action disappear from the log.

// A name is a name: keep printable ASCII only, collapse whitespace, cap at 64.
// Anything else (control characters, tags, an over-long paste) is stripped
// before the name can reach a log line, a record, a store or the browser.
function scrubOperatorName(raw) {
  if (raw == null) return null;
  const cleaned = String(raw)
    .replace(/[^\x20-\x7E]/g, '')   // printable ASCII only
    .replace(/[<>]/g, '')           // never let a tag start in a name
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 64);
  return cleaned || null;
}

// Operator-supplied names arrive on TWO paths: the X-Operator-Name header and
// body fields (bridge roles — commander / scribe / owner / joiners). One scrub,
// applied at this one boundary to both, so no route can persist a raw name and
// no future route has to remember to. (Review: take-ownership persisted a raw
// <img onerror=…> string into the incident record via the body path.)
const OPERATOR_NAME_FIELDS = [
  'operator', 'commander', 'incidentCommander', 'scribe', 'owner', 'currentOwner',
  'assignee', 'requestedBy', 'joiners',
];
function scrubOperatorNamesInBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return;
  for (const field of OPERATOR_NAME_FIELDS) {
    const v = body[field];
    if (typeof v === 'string') {
      body[field] = scrubOperatorName(v) || '';
    } else if (Array.isArray(v)) {
      body[field] = v.map((n) => (typeof n === 'string' ? (scrubOperatorName(n) || '') : n));
    }
  }
}

// One URL, many spellings. Normalise before comparing: lower-case, collapse
// duplicate slashes, resolve "." / ".." segments, drop a trailing slash. So
// /DESK.HTML, //desk.html and /./desk.html are all the desk — the same page the
// browser is actually showing.
function normalizePath(p) {
  let s = String(p || '').toLowerCase().replace(/\/{2,}/g, '/');
  s = path.posix.normalize(s);
  if (s.length > 1) s = s.replace(/\/+$/, '');
  return s;
}

function isCopilotSurface(req) {
  if (normalizePath(req.path).startsWith('/api/copilot/')) return true;
  const ref = req.headers.referer || req.headers.referrer || '';
  if (!ref) return false;
  try {
    return /^\/desk(?:\.html)?$/.test(normalizePath(new URL(String(ref)).pathname));
  } catch (e) {
    return false;
  }
}

const READ_ONLY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

app.use((req, res, next) => {
  req.operator = scrubOperatorName(req.headers['x-operator-name']);
  scrubOperatorNamesInBody(req.body);

  const stateChanging = !READ_ONLY_METHODS.has(req.method);
  const isApi = normalizePath(req.path).startsWith('/api/');

  if (stateChanging && isApi && isCopilotSurface(req) && !req.operator) {
    session.audit({
      who: 'unknown',
      what: `${req.method} ${req.path}`,
      result: 'refused (428) — no operator name on a copilot action',
    });
    return res.status(428).json({ error: 'Tell me your name first.' });
  }

  // EVERY state-changing API call is audited at THIS boundary — one place, so
  // no route, and no spelling of a URL, can leave an action untraceable. An
  // unnamed action is recorded as who:"unknown"; it is never dropped.
  if (stateChanging && isApi) {
    const device = (req.body && (req.body.device || req.body.hostname || req.body.deviceName)) || null;
    res.on('finish', () => {
      session.audit({
        who: req.operator || 'unknown',
        what: `${req.method} ${req.path}`,
        device: device ? String(device) : undefined,
        result: `HTTP ${res.statusCode}`,
      });
    });
  }

  session.runAsOperator(req.operator, next);
});

// What Jarvis can actually do — straight from the single source of truth
// (sources/capabilities.js). Anything not available carries a plain-words reason.
app.get('/api/capabilities', (req, res) => {
  res.json({ abilities: capabilities.list() });
});

// CW-5 — honest SSH transport status. Which directly-reachable devices route
// over SSH, and which are actually wired (creds present in .env.local). No
// secret ever leaves here: listSshDevices reports host + a boolean, never a
// credential. A device with configured:false returns an honest "auth needed"
// when asked, never a fabricated read.
app.get('/api/ssh/devices', (req, res) => {
  res.json({ devices: sshRunner.listSshDevices() });
});

// The copilot audit trail: who did what, on which device, with what result.
app.get('/api/copilot/audit', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  res.json({ entries: session.auditAll({ limit }), file: session.AUDIT_FILE });
});
// ── end CW-1 block ──────────────────────────────────────────────────────────

// ── CW-2: the change engine + drift checks ──────────────────────────────────
// Thin routes ON PURPOSE. Every rule — the permission gate, the six-step wrap,
// the honest statuses, the scrubbing, the audit — lives in
// sources/change-runner.js and sources/change-store.js, so no future route can
// make a change by a different path or with a step missing. The 428 name gate
// above already covers these (they are all under /api/copilot/).

// A change command is free text an operator typed; keep it printable, single-
// line and bounded before it goes anywhere near a device or a store.
function cleanChangeCommands(raw) {
  if (!Array.isArray(raw)) return { error: 'commands must be a list of configuration lines.' };
  const out = [];
  for (const item of raw) {
    if (typeof item !== 'string') return { error: 'every command must be text.' };
    const line = item.replace(/[^\x20-\x7E]/g, '').replace(/\s+$/, '');
    if (!line.trim()) continue;
    if (line.length > 300) return { error: 'a configuration line longer than 300 characters is not something I will send.' };
    out.push(line);
  }
  if (!out.length) return { error: 'no configuration lines given — there is no change to make.' };
  if (out.length > 100) return { error: 'more than 100 lines in one change — split it up.' };
  return { commands: out };
}

// POST /api/copilot/change — start a wrapped change. Answers 202 with the
// record id straight away; the wrap itself takes real minutes on real kit, and
// the desk follows it through change_update events and GET /api/copilot/change/:id.
app.post('/api/copilot/change', (req, res) => {
  const body = req.body || {};
  const device = String(body.device || '').trim();
  const reason = String(body.reason || '').trim();
  if (!device) return res.status(400).json({ error: 'Name the device — I will not pick one for you.' });
  if (!reason) return res.status(400).json({ error: 'Give a reason for the change — it goes in the record and the approval.' });
  const cleaned = cleanChangeCommands(body.commands);
  if (cleaned.error) return res.status(400).json({ error: cleaned.error });

  let created = null;
  const running = changeRunner.run(
    { device, commands: cleaned.commands, reason, who: req.operator },
    { onCreated: (rec) => { created = rec; } },
  );
  running
    .then((rec) => broadcast('change_update', rec))
    .catch((err) => {
      reportSystemError('the change engine could not finish that change', err);
      if (created) {
        try {
          broadcast('change_update', changeStore.status(created.id, 'failed', {
            by: req.operator, note: `The wrap threw before it finished — ${err.message}. Treat this change as UNKNOWN, not applied.`,
          }));
        } catch (e) { /* the audit line above already recorded it */ }
      }
    });

  if (!created) return res.status(500).json({ error: 'The change record could not be opened, so nothing was started.' });
  res.status(202).json({ change: created, watch: `/api/copilot/change/${created.id}` });
});

// POST /api/copilot/change/:id/rollback — replay the stored rollback commands
// through the SAME engine. A rollback is a change: its own record, its own gate.
app.post('/api/copilot/change/:id/rollback', (req, res) => {
  const id = String(req.params.id || '');
  const original = changeStore.get(id);
  if (!original) return res.status(404).json({ error: `No change record with id "${id}".` });

  let created = null;
  const running = changeRunner.rollback(id, req.operator, { onCreated: (rec) => { created = rec; } });
  running
    .then((rec) => { if (rec && !rec.error) broadcast('change_update', rec); })
    .catch((err) => reportSystemError('the change engine could not finish that rollback', err));

  if (!created) {
    // rollback() refused before opening a record (nothing to replay) — answer
    // with its own honest reason rather than a generic failure.
    return running.then((r) => res.status(409).json(r && r.error ? r : { error: 'That change has nothing to roll back.' }))
      .catch(() => res.status(500).json({ error: 'The rollback could not be started.' }));
  }
  res.status(202).json({ change: created, rollbackOf: id, watch: `/api/copilot/change/${created.id}` });
});

app.get('/api/copilot/changes', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 300);
  res.json({ changes: changeStore.list({ device: req.query.device, limit }) });
});

app.get('/api/copilot/change/:id', (req, res) => {
  const rec = changeStore.get(String(req.params.id || ''));
  if (!rec) return res.status(404).json({ error: `No change record with id "${req.params.id}".` });
  res.json({ change: rec });
});

// GET /api/copilot/drift/:device — live running-config vs the stored baseline.
// "no-baseline" is an honest STATE, answered 200, not an error.
app.get('/api/copilot/drift/:device', async (req, res) => {
  try {
    const out = await changeRunner.drift(String(req.params.device || ''));
    if (out.error) return res.status(404).json(out);
    res.json(out);
  } catch (err) {
    res.status(502).json({ error: `The drift check could not run — ${err.message}. No verdict is being claimed.` });
  }
});

// POST /api/copilot/drift/:device/rebaseline — store the live config as the new
// reference. Operator-named (the 428 gate) and audited inside the engine.
app.post('/api/copilot/drift/:device/rebaseline', async (req, res) => {
  try {
    const out = await changeRunner.rebaseline(String(req.params.device || ''), req.operator);
    if (out.error) return res.status(502).json(out);
    res.json(out);
  } catch (err) {
    res.status(502).json({ error: `The re-baseline could not run — ${err.message}. The baseline is unchanged.` });
  }
});
// ── end CW-2 block ──────────────────────────────────────────────────────────

// ── CW-3: the built-in ticket queue ─────────────────────────────────────────
// Thin routes ON PURPOSE. Every rule — the validated status transitions, the
// "cannot close without a resolution note" guard, the audit of every transition,
// the secret-scrub + XSS-escape on the way to disk — lives in sources/tickets.js
// and sources/ticket-store.js, so no future route (CW-4 / CW-6 will add adjacent
// ones) can move a ticket by a different path or with a step missing.
//
// The 428 name gate above already covers every write here (all under
// /api/copilot/, so isCopilotSurface is true): a state-changing call with no
// X-Operator-Name is refused 428 before it reaches these handlers, and audited.
// The logic layer re-checks the operator name as a belt to that brace.
//
// INTENT-FIRST: there is NO keyword routing here that creates a ticket from
// chat. create() is the tool the planner calls AFTER the operator confirms the
// proposal it composed (the real-Claude compose path is wired but PENDING
// CREDITS); the desk's "Create ticket" confirm is what POSTs to it.

// A ticket may LINK to one of this console's own incidents (INC-YYYYMMDD-NNN, or
// the internal trg-… id). The link is validated against the REAL incident list —
// a link is never fabricated. Returns the canonical incidentId + a label, or an
// error the route turns into a 400. Empty input = no link (allowed).
function resolveIncidentLink(raw) {
  const wanted = String(raw == null ? '' : raw).trim();
  if (!wanted) return { ok: true, incidentId: null, incidentLabel: null };
  const w = wanted.toLowerCase();
  const match = triage.listIncidents().find(
    (i) => String(i.incidentId || '').toLowerCase() === w || String(i.triageId || '').toLowerCase() === w
  );
  if (!match) {
    return { ok: false, error: `No incident with id "${wanted}" — I will not link a ticket to an incident that does not exist.` };
  }
  return {
    ok: true,
    incidentId: match.incidentId || match.triageId,
    incidentLabel: match.title ? String(match.title).slice(0, 200) : null,
  };
}

// GET /api/copilot/tickets — the queue (most-recent first). Filterable by
// ?status= and ?assignee=. Read-only, so no name gate.
app.get('/api/copilot/tickets', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  res.json({ tickets: tickets.list({ status: req.query.status, assignee: req.query.assignee, limit }) });
});

// GET /api/copilot/tickets/:id — the full ticket (history + work notes).
app.get('/api/copilot/tickets/:id', (req, res) => {
  const t = tickets.get(String(req.params.id || ''));
  if (!t) return res.status(404).json({ error: `No ticket with id "${req.params.id}".` });
  res.json({ ticket: t });
});

// POST /api/copilot/tickets — create { severity, title, description, incidentId? }.
app.post('/api/copilot/tickets', (req, res) => {
  const body = req.body || {};
  const link = resolveIncidentLink(body.incidentId);
  if (!link.ok) return res.status(400).json({ error: link.error });
  const out = tickets.create({
    severity: body.severity,
    title: body.title,
    description: body.description,
    incidentId: link.incidentId,
    incidentLabel: link.incidentLabel,
    who: req.operator,
  });
  if (!out.ok) return res.status(out.status || 400).json({ error: out.error });
  res.status(201).json({ ticket: out.ticket });
});

// POST /api/copilot/tickets/:id/assign — { assignee }.
app.post('/api/copilot/tickets/:id/assign', (req, res) => {
  const out = tickets.assign(String(req.params.id || ''), {
    assignee: (req.body || {}).assignee,
    who: req.operator,
  });
  if (!out.ok) return res.status(out.status || 400).json({ error: out.error });
  res.json({ ticket: out.ticket });
});

// POST /api/copilot/tickets/:id/status — { status, note? }. Validated
// transitions; closing needs a resolution note (enforced in the logic layer).
app.post('/api/copilot/tickets/:id/status', (req, res) => {
  const body = req.body || {};
  const out = tickets.setStatus(String(req.params.id || ''), {
    status: body.status,
    note: body.note,
    who: req.operator,
  });
  if (!out.ok) return res.status(out.status || 400).json({ error: out.error });
  res.json({ ticket: out.ticket });
});

// POST /api/copilot/tickets/:id/note — { text } appends a work note.
app.post('/api/copilot/tickets/:id/note', (req, res) => {
  const out = tickets.addNote(String(req.params.id || ''), {
    text: (req.body || {}).text,
    who: req.operator,
  });
  if (!out.ok) return res.status(out.status || 400).json({ error: out.error });
  res.json({ ticket: out.ticket });
});
// ── end CW-3 block ──────────────────────────────────────────────────────────

// ── CW-4: the Teams bridge (honest one-way post + reply ingestion) ───────────
// Thin routes ON PURPOSE. Every rule — the honest not-connected no-op, the real
// POST, the secret handling (the webhook URL never leaves sources/teams.js), the
// audit — lives in sources/teams.js, and auto-posts ride the notifier seam
// (sources/notifier.js → teams.onBridgeEvent) so no future route can post by a
// different path. The 428 name gate above covers the POST routes (all /api/copilot/).
//
// HONEST ONE-WAY LIMIT: Incoming Webhooks are POST-only. GET/POST test are the
// real path; /inbound is the reply-ingestion seam a FUTURE Teams bot/Power-Automate
// flow calls to feed a REAL reply into the bridge — never a fabricated reply.

// GET /api/copilot/teams/status → { connected, lastPost } + any injected inbound
// replies. NEVER the webhook URL/host — only the boolean + the last-post summary.
app.get('/api/copilot/teams/status', (req, res) => {
  const s = teams.status();
  res.json({ ...s, inbound: teams.inboundReplies({ limit: 50 }) });
});

// POST /api/copilot/teams/test → operator-named test card, honest result. On no
// webhook it posts NOTHING and returns { ok:false, connected:false } — never a
// fake "sent ✓". The webhook URL never appears in the response.
app.post('/api/copilot/teams/test', async (req, res) => {
  const who = req.operator || 'unknown';
  const body = req.body || {};
  const note = typeof body.text === 'string' && body.text.trim()
    ? body.text.trim().slice(0, 500)
    : 'Test card from the noc-triage desk — confirming the Teams bridge is wired.';
  const out = await teams.postMessage(
    {
      title: '🧪 noc-triage — Teams bridge test',
      text: note,
      facts: [{ name: 'Sent by', value: who }],
    },
    { event: 'test', who }
  );
  res.json({ ...out, lastPost: teams.status().lastPost });
});

// POST /api/copilot/teams/inbound → inject a REAL reply fed by a future Teams
// bot/Power-Automate flow. { from, text, incidentId? }. Broadcasts it so the desk
// can surface it. We do NOT fabricate replies — this only records what a bot sends.
app.post('/api/copilot/teams/inbound', (req, res) => {
  const body = req.body || {};
  const out = teams.injectInbound({
    from: body.from,
    text: body.text,
    incidentId: body.incidentId,
  });
  if (!out.ok) return res.status(400).json({ error: out.error });
  broadcast('teams_inbound', out.reply);
  res.status(201).json({ reply: out.reply });
});
// ── end CW-4 block ──────────────────────────────────────────────────────────

// ── CW-6: two-way ServiceNow sync (INTERNAL QUEUE IS TRUTH, SNOW is a mirror) ─
// Thin routes ON PURPOSE, adjacent to CW-4. Every rule — the honest not-connected
// no-op (no fabricated INC), the real Table API create/update/read, the secret
// handling (SNOW_INSTANCE/USER/PASS never leave sources/servicenow-client.js),
// the conflict-not-clobber logic, the audit of every sync — lives in
// sources/servicenow-client.js (transport) and sources/tickets.js (the sync that
// folds the answer into the ticket's `snow` slot). No route here can sync by a
// different path or with the secret leaking. The 428 name gate above covers the
// POST routes (all under /api/copilot/). The structured ServiceNow EXPORT
// (sources/artifacts.js, GET /api/triage/:id/servicenow) stays as the fallback.
//
// INTENT-FIRST: there is NO keyword route that pushes to ServiceNow from chat.
// push is the tool the planner calls AFTER the operator confirms; the desk's
// "Push to ServiceNow" confirm is what POSTs here.

// GET /api/copilot/servicenow/status → { connected, lastSync }. Read-only, no
// name gate. NEVER the instance host or creds — only the boolean + last-sync summary.
app.get('/api/copilot/servicenow/status', (req, res) => {
  res.json(servicenow.status());
});

// POST /api/copilot/tickets/:id/snow/push → create-or-update the SNOW INC from
// the internal ticket. Honest not-connected (does nothing, no fake INC) →
// { connected:false }. Success → { number, url, ticket }.
app.post('/api/copilot/tickets/:id/snow/push', async (req, res) => {
  const out = await tickets.pushToSnow(String(req.params.id || ''), { who: req.operator });
  if (!out.ok) {
    if (out.connected === false) return res.status(200).json({ connected: false, ok: false });
    return res.status(out.status || 502).json({ error: out.error, connected: out.connected !== false });
  }
  broadcast('ticket_update', out.ticket);
  res.json({ ok: true, connected: true, number: out.number, url: out.url, ticket: out.ticket });
});

// POST /api/copilot/tickets/:id/snow/pull → read the SNOW incident and surface
// its state/worknotes as a MIRROR (never overwrites internal truth). A both-changed
// conflict comes back as { conflict:true } and clobbers nothing.
app.post('/api/copilot/tickets/:id/snow/pull', async (req, res) => {
  const out = await tickets.pullFromSnow(String(req.params.id || ''), { who: req.operator });
  if (!out.ok) {
    if (out.connected === false) return res.status(200).json({ connected: false, ok: false });
    return res.status(out.status || 502).json({ error: out.error, connected: out.connected !== false });
  }
  broadcast('ticket_update', out.ticket);
  res.json({ ok: true, connected: true, conflict: out.conflict, mirror: out.mirror, ticket: out.ticket });
});
// ── end CW-6 block ──────────────────────────────────────────────────────────

// ── CW-7: the iterative investigation loop ──────────────────────────────────
// Thin routes ON PURPOSE, adjacent to CW-6. Every rule — the grill/ambiguity wait
// (fire no probe until the operator answers), the probe→report→narrow loop, the
// confidence stop, the hard round cap, the honest stuck/blocked/reasoning-
// unavailable stops, the audit of every round, the never-fabricate law — lives in
// sources/investigation.js (the engine) + sources/jarvis.js (the reasoning
// planner). No route here can investigate by a different path or skip a step. The
// 428 name gate above covers the POST routes (all under /api/copilot/).
//
// STREAMING: the desk starts an investigation, gets its id, then follows it live
// over the websocket — `investigation_update` (full snapshot on each state change:
// grilling, investigating, resolved, capped, stuck, blocked) and
// `investigation_round` ({round, probe, agent, report, hypotheses[], confidence,
// status}) per probe round.

// POST /api/copilot/investigate { problem, operatorTz? } → opens an investigation,
// returns its id immediately (202); the understand + probe loop runs in the
// background and streams. An ambiguous problem comes back status "awaiting-operator"
// with clarifying questions and NO probe fired.
app.post('/api/copilot/investigate', (req, res) => {
  const body = req.body || {};
  const problem = String(body.problem || '').trim();
  if (!problem) return res.status(400).json({ error: 'Give me a problem to investigate — I will not investigate nothing.' });
  const operatorTz = typeof body.operatorTz === 'string' ? body.operatorTz.trim() : null;

  const rec = investigation.create({ problem, operatorTz, who: req.operator });
  // Fire the loop; it streams its own progress. A crash is reported honestly and
  // never leaves the investigation silently dead.
  investigation.run(rec.id).catch((err) =>
    reportSystemError('the investigation loop could not run', err));
  res.status(202).json({ investigation: rec, watch: `/api/copilot/investigate/${rec.id}` });
});

// POST /api/copilot/investigate/:id/answer { text } → the operator's answer to a
// grill/clarifying question; resumes the loop (re-assesses specificity, then probes).
app.post('/api/copilot/investigate/:id/answer', async (req, res) => {
  const id = String(req.params.id || '');
  const text = String((req.body && req.body.text) || '').trim();
  if (!text) return res.status(400).json({ error: 'An empty answer narrows nothing — tell me what changed.' });
  if (!investigation.get(id)) return res.status(404).json({ error: `No investigation with id "${id}".` });
  // Kick the resume off in the background (it may run a full probe loop) and
  // answer with the current record; the desk follows the rest over the websocket.
  investigation.answer(id, text, req.operator).catch((err) =>
    reportSystemError('the investigation could not resume', err));
  res.status(202).json({ investigation: investigation.get(id), watch: `/api/copilot/investigate/${id}` });
});

// GET /api/copilot/investigate/:id → the full record (problem, understood, rounds,
// hypotheses, confidence, root cause, fix plan/proposal, status).
app.get('/api/copilot/investigate/:id', (req, res) => {
  const rec = investigation.get(String(req.params.id || ''));
  if (!rec) return res.status(404).json({ error: `No investigation with id "${req.params.id}".` });
  res.json({ investigation: rec });
});
// ── end CW-7 block ──────────────────────────────────────────────────────────

// ── CW-8: the generic MCP connector ──────────────────────────────────────────
// Self-contained, contiguous block (A4 edits server.js in parallel — keep this
// separable). All logic lives in sources/mcp-connector.js + sources/mcp-client.js;
// these routes are thin status/reconnect surfaces that leak NO secrets. The
// connector connects declared MCP servers at startup (below, near jarvis.init),
// exposes each connected tool to the planner as a namespaced delegation target
// (mcp:<server>:<tool>), and gates + audits every tool call through the SAME
// permission gate a device read uses. No servers configured → honest empty state.
//
// GET /api/copilot/mcp/status → { configured, servers:[{name, connected, toolCount,
// reason?}] }. No secrets — server creds live in config/env only, never here.
app.get('/api/copilot/mcp/status', (req, res) => {
  res.json(mcp.status());
});

// POST /api/copilot/mcp/reconnect → re-connect + re-list tools for every declared
// server (operator-named action). Honest result: the same status shape after the
// attempt, so a server that still won't connect shows its reason, never a fake tool.
// The 428 name gate above covers this POST (it is under /api/copilot/).
app.post('/api/copilot/mcp/reconnect', async (req, res) => {
  try {
    await mcp.connectAll();
    res.json(mcp.status());
  } catch (err) {
    reportSystemError('the MCP reconnect could not run', err);
    res.status(500).json({ error: 'MCP reconnect failed — check the server window for detail.' });
  }
});
// ── end CW-8 block ──────────────────────────────────────────────────────────

// ── A5: Batfish offline change-validation (netclaw pull) ─────────────────────
// Self-contained, contiguous block (A8 edits server.js in parallel — keep this
// separable). All logic lives in sources/batfish.js; these routes are thin
// surfaces that leak NO secrets (the Batfish host stays inside the module). This
// is an OFFLINE what-if check that never touches a device and never blocks a
// change — it pairs with the change engine as an optional pre-apply read.
// Require inside the block so the top-of-file requires stay conflict-free.
const batfish = require('./sources/batfish');

// GET /api/copilot/batfish/status → { connected, configured, lastRun, note }.
// No host, no secret — honest not-available when BATFISH_HOST is unset.
app.get('/api/copilot/batfish/status', (req, res) => {
  res.json(batfish.status());
});

// POST /api/copilot/batfish/validate { device, commands? | config?, baseline? }
// → the honest verdict { ok, connected, verdict:'clean'|'issues'|'unknown',
// findings, note }. Read-only offline analysis; verdict is clean/issues ONLY from
// a real Batfish answer, never fabricated. The 428 name gate above covers this
// POST (it is under /api/copilot/).
app.post('/api/copilot/batfish/validate', async (req, res) => {
  try {
    const body = req.body || {};
    const device = body.device;
    if (!device || !String(device).trim()) {
      return res.status(400).json({ error: 'Name the device to validate the change against (device).' });
    }
    const change = {
      commands: Array.isArray(body.commands) ? body.commands : undefined,
      config: typeof body.config === 'string' ? body.config : undefined,
      baseline: typeof body.baseline === 'string' ? body.baseline : undefined,
    };
    if (!change.commands && !change.config) {
      return res.status(400).json({ error: 'Provide the change commands (commands: []) or the full post-change config (config).' });
    }
    const verdict = await batfish.validateChange(device, change, { who: req.operator });
    res.json(verdict);
  } catch (err) {
    reportSystemError('the Batfish validation could not run', err);
    res.status(500).json({ error: 'Batfish validation failed — check the server window for detail.' });
  }
});
// ── end A5 block ─────────────────────────────────────────────────────────────

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

// CW-2: every write to a change record — created, each wrap step, each status
// transition — is pushed to the desk, so the change wrap the operator is
// watching is the record itself, not a UI guess at what is happening.
changeStore.setBroadcast((type, data) => broadcast(type, data));

// CW-3: every write to a ticket — created, assigned, status moved, work note —
// is pushed to the desk so the queue the operator is watching IS the record,
// not a UI guess. ticket_new / ticket_update carry the full stored ticket.
ticketStore.setBroadcast((type, data) => broadcast(type, data));

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
  // BULLETPROOF: this runs from the process-level uncaughtException /
  // unhandledRejection guards, so it must NEVER throw itself — a throw here
  // (e.g. broadcast failing mid-fault during a bad WS send) would defeat the
  // guard and force Node to exit 1. Everything is wrapped so a stray async
  // error anywhere (watcher callback, audit write, broadcast) can never take
  // the whole server down.
  try {
    const detail = err && err.message ? err.message : String(err || '');
    console.error(`[System] ${what}: ${detail}`);
    if (err && err.stack) console.error(err.stack);
  } catch (_) { /* logging must not crash the guard */ }
  try {
    broadcast('system_error', { message: `${what} — check the server window for detail.` });
  } catch (_) { /* a failing broadcast must not crash the guard */ }
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
  // Which conversation is this message part of? Device memory (the box the
  // operator picked) is scoped to THIS id and nothing wider — never global,
  // never across operators. A surface that sends no id gets 'default', so a
  // single console is one conversation until it says otherwise.
  conversationId: () => (currentRequest() || {}).conversationId || 'default',
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
// The roster BOTH the planner (jarvis) and the investigation loop reason over:
// the live squad agents PLUS (CW-8) every connected external MCP tool as its own
// namespaced delegation target. Built in one place so the two callers can never
// drift. When no MCP server is connected, mcp.rosterEntries() is empty and the
// roster is exactly what it was before CW-8 — nothing added, nothing fabricated.
function buildJarvisRoster() {
  const squad = (agents.jarvis.manages || []).map((id) => ({
    id,
    name: agents[id]?.name || id,
    connected: !live.NO_BACKEND[id],
    sees: (live.CAPABILITIES[id] && live.CAPABILITIES[id].can) || [],
    note: live.NO_BACKEND[id] ? `not connected — ${live.NO_BACKEND[id]}` : '',
  }));
  return squad.concat(mcp.rosterEntries());
}

jarvis.init({
  say: jarvisSay,
  status: updateAgentStatus,
  log: (line) => appendToActivityLog(`[${new Date().toISOString()}] ${line}\n`),
  nameOf: (id) => (agents[id]?.name || id),
  // Delegation gather goes through the real gate + guardrail + session log.
  // `device` (CLASS 2) is the planner's STRUCTURED target for a device-CLI
  // sub-question — threaded to the executor so the box comes from the plan, not
  // a regex over the reworded question.
  // `incidentId` (CLASS 9) is the planner's STRUCTURED reference to one of THIS
  // console's own incidents — threaded the same way `device` is.
  // CW-8: an MCP tool (id "mcp:<server>:<tool>") is a delegation target too — it
  // routes to the connector, which gates + audits the call exactly like a read.
  // Everything else goes to the live agents unchanged.
  gather: (agentId, question, device, incidentId) =>
    mcp.isMcpId(agentId)
      ? mcp.gather(agentId, question, { who: 'jarvis', approved: false })
      : live.gatherForJarvis(agentId, question, device, incidentId),
  // The roster the planner reasons over: who exists + what each can actually see,
  // plus (CW-8) every connected external MCP tool as its own delegation target.
  roster: () => buildJarvisRoster(),
});

// CW-7 — hand the investigation LOOP engine its plumbing. The engine orchestrates
// deterministically (rounds, cap, gate, audit, streaming); the REASONING (which
// probe, which hypothesis, what confidence) is the injected planner —
// jarvis.investigationPlanner — so the loop never picks a probe itself, and it can
// be swapped for a scripted planner in tests. Every probe is a delegated read that
// goes through the SAME gate + guardrail + session log as any other read
// (live.gatherForJarvis), so deny = zero wire holds unchanged.
investigation.init({
  probe: ({ agentId, question, device, incidentId }) =>
    mcp.isMcpId(agentId)
      ? mcp.gather(agentId, question, { who: 'jarvis', approved: false })
      : live.gatherForJarvis(agentId, question, device || null, incidentId || null),
  broadcast,
  roster: () => buildJarvisRoster(),
  audit: (entry) => session.audit(entry),
});
investigation.setPlanner(jarvis.investigationPlanner);

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
  // CLASS 9: this socket's own conversation key. One browser = one operator =
  // one id, for the life of the connection, unless the client sends its own.
  // Two operators on two sockets can no longer land on one key.
  const socketSessionId = newSessionId('ws');
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
      activityHistory: chatStore.getActivityHistory(),
      // CLASS 9: the conversation key this socket will be filed under. The client
      // may keep it and send it back on every command so ONE operator holds ONE
      // thread across a reload; if it sends nothing, this same id is used anyway.
      // It is an opaque routing key — it carries no identity and no secret.
      sessionId: socketSessionId
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
        handleCommand(parsed.data, socketSessionId);
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
// ── Per-operator session isolation (QA CLASS 9) ─────────────────────────────
// Every scrap of conversational state in this app — the device the operator
// settled on, the incident the conversation is about, the parked "which device?"
// question — is keyed by this id inside live-agents. The id therefore decides
// whether two operators share a mind or have their own.
//
// THE DEFECT THIS CLOSES: the fallback used to be the literal string 'default',
// and no client ever sent anything else. Every operator on the console — every
// browser, every tab, every curl — landed in ONE conversation, so operator B's
// "sw2" answered operator A's parked question and A's remembered device silently
// steered B's next command. QA saw it live.
//
// THE RULE NOW: an id is never shared unless a client deliberately asks to share
// one by sending the SAME conversationId. Absent that, a socket gets its own id
// for its whole life; a one-shot HTTP command that carries a NAMED operator is
// filed under that operator's own key (so the desk — which sends X-Operator-Name
// but no conversationId — keeps ONE continuous thread per person, and two
// operators are two threads); and a truly anonymous one-shot gets a throwaway id
// that belongs to nobody. There is no path left that lands two operators on one
// key by accident — the unsafe shared 'default' simply does not exist any more.
let sessionSeq = 0;
function newSessionId(kind) {
  return `sess-${kind}-${Date.now().toString(36)}-${(++sessionSeq).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// A client-supplied id is honoured (that is how one operator keeps one thread
// across a reload), but only as an opaque, bounded, printable token — it is a
// Map key that partitions memory, so it is length-capped and stripped of
// anything but plain id characters before it is trusted.
function normalizeConversationId(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return null;
  const clean = s.replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 96);
  return clean || null;
}

// CLASS 9: a STABLE per-operator key derived from X-Operator-Name (set on the
// request by the CW-1 name middleware, carried through session.runAsOperator).
// This is what keeps the desk's device/incident memory continuous for one person
// while keeping two people apart — the operator identity half of "keyed off
// operator + conversation". Null when nobody is named (a bare curl), so an
// anonymous caller falls through to a throwaway id and shares nothing.
function operatorConversationId() {
  const op = typeof session.currentOperator === 'function' ? session.currentOperator() : null;
  if (!op) return null;
  const clean = String(op).replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 64);
  return clean ? `op-${clean}` : null;
}

function handleCommand(data, fallbackSessionId) {
  const question = String((data && data.command) || '');
  const ctxValue = {
    requestId: newRequestId(),
    question,
    agent: (data && data.agent) || null,
    askedAt: new Date().toISOString(),
    // The conversation this message belongs to. Carries the device and the
    // incident the operator settled on, and their parked question, no further
    // than this one conversation — never to another operator. Resolution order:
    // an explicit client id (a reload keeps its thread) → the socket's own id →
    // the named operator's stable key (the desk) → a throwaway anon id.
    conversationId: normalizeConversationId(data && data.conversationId)
      || fallbackSessionId
      || operatorConversationId()
      || newSessionId('anon'),
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
// Class 1 (2026-08-18): this used to compute ~13 intents (bgp_status,
// security_scan, firewall_check, lb_check, alert_check, config_check,
// incident_check, precheck, domain_status, general …) but the dispatcher below
// only ever branches on THREE of them — configure_device, ping and help;
// everything else fell straight through to `default → live.handle`, which does
// its OWN routing from the capability map. So those extra branches were a dead
// keyword table that answered/classified nothing. They are gone. Only the three
// live branches remain — each an unambiguous app action, not network reasoning:
//   • configure_device — a write, refused for SAFETY (a second net; the raw
//     write screen in runAgentAction already ran first).
//   • ping             — an agent-responsiveness check ("are you there?").
//   • help             — the capability card.
// Device-CLI routing ("run show version on sw1") is deliberately NOT here — it
// lives in ONE place, live.handle()/executeDeviceCli, next to the code that
// executes it, so two routers can never disagree about what "a command" is.
function detectAgentIntent(agentId, command) {
  const t = command.toLowerCase();

  // Device configuration / change actions → refused for safety downstream.
  if (/\b(configure|create|provision|deploy|apply[\s-]?config|push[\s-]?config|commit[\s-]?change|rollback)\b/.test(t) ||
      (/\b(add|set|enable|disable|shut|no[\s-]?shut|bring[\s-]?(up|down)|remove|delete|unconfigure)\b/.test(t) &&
       /\b(interface|loopback|lo\d+|gigabit|gig\b|vlan|trunk|route|ntp|snmp|bgp[\s-]?neighbor|ospf|eigrp|description|ip[\s-]?add)\b/.test(t))) {
    return 'configure_device';
  }
  // Ping — agent responsiveness, not a device read.
  if (/^(ping|test|alive|you there)[?!.\s]*$/.test(t)) {
    return 'ping';
  }
  // Help — the capability card.
  if (/\b(help|what can you|commands|capabilities)\b/.test(t)) {
    return 'help';
  }
  // Everything else → the agent's real live read (live.handle routes it from the
  // capability map). No keyword classification stands in front of that.
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

  // AMBIGUITY → ASK, NEVER ASSUME (the law, 2026-08-17). When this conversation
  // has a parked "which device?" question, the operator's next word is an ANSWER
  // ("sw2", "2", "the second one", "all"), not a fresh request — so it finishes
  // the command they already typed. Checked here, before every other route, so
  // BOTH surfaces inherit it: Jarvis and a direct @mention. It returns false for
  // anything that is not an answer, and that message routes normally as before.
  if (live.maybeForget(agentId, command)) return;
  if (live.resumeClarification(agentId, command)) return;

  updateAgentStatus(agentId, 'active', `Processing: ${command}`);

  // The deterministic write screen, judged on the RAW request text.
  //
  // WHO IT APPLIES TO is the whole subtlety. An engineer agent only ever does one
  // thing with what you type — turn it into a read — so every request to one is
  // screened, exactly as before. Jarvis is a CONVERSATION: incident prose is not
  // a command, and STATE_CHANGING is full of ordinary English ("after the upgrade
  // window", "set up a bridge", "clear picture", "copy the report"). Screening all
  // of it refused the first sentence of a real outage report.
  //
  // So on the Jarvis surface the screen fires only for the DEVICE-CLI CLASS — a
  // request that asks for a command to be run on a box, which is the only class
  // that can end at the wire. "show version on sw1; reload" is that class and is
  // still refused deterministically, before the model, on either route. Plain
  // prose reaches the planner, where the choke point (executeDeviceCli) re-runs
  // this same check on whatever is actually about to be executed.
  //
  // CW-2 pre-work 2: a COMPOUND "read then change" ("reload sw1 then show me
  // the version") is NOT refused here. It is passed down to the CLI choke point
  // (live-agents.executeDeviceCli), which refuses the change half out loud AND
  // honours the read half — one place owns both halves, so neither is dropped
  // silently. Only requests the choke point can actually reach are passed on;
  // anything else is still refused right here, exactly as before.
  const screenThis = agentId !== 'jarvis' || live.isDeviceCliRequest(command);
  const writeIntent = screenThis ? checkIntent(command) : { destructive: false };
  const compoundGoesToChokePoint = writeIntent.destructive
    && screenThis
    && live.isDeviceCliRequest(command)
    && guardrails.splitIntent(command).compound;
  if (writeIntent.destructive && !compoundGoesToChokePoint) {
    // The audit + activity record is written inside live.refuseWrite — the ONE
    // sink every refused write passes through. Logging it here as well would
    // double-count this branch while the other refusal paths still logged
    // nothing, which is exactly the hole this move closes.
    return live.refuseWrite(agentId, command, writeIntent);
  }

  // Jarvis keeps its squad-coordination intents (standup, roll call, triage);
  // anything network-shaped falls through to the live sources.
  if (agentId === 'jarvis') return simulateJarvisAction(agentId, command);

  const intent = detectAgentIntent(agentId, command);

  switch (intent) {
    // Read-only is enforced before anything reaches a device.
    case 'configure_device': return live.refuseWrite(agentId, command);
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

// Main Jarvis entry point.
//
// Phase E: Jarvis is a REAL agentic Principal Engineer. Open-ended, plain-words
// questions are reasoned about with a real Claude call (sources/jarvis.js) —
// Jarvis decides who to delegate to, gathers their live findings, and answers.
// With no API key it declines honestly; it NEVER falls back to a keyword router
// pretending to reason.
//
// Class 1 (2026-08-18): the deterministic phrase-table that used to intercept
// greetings/"brief me"/"how did we do" and answer with a standup / weekly report
// / canned Pong BEFORE the planner ran is GONE. EVERYTHING the operator says in
// plain words is now REAL agentic reasoning — it is never keyword-routed to a
// canned answer and passed off as thinking. Squad operations (standup, roll
// call, weekly report, help) remain as functions a future planner tool or an
// explicit UI action can invoke; they are no longer front-door interceptors.
//
// (The manual "Open Triage" flow from Phase A is a separate surface and is
// untouched — it still works regardless of the key.)
function simulateJarvisAction(agentId, command) {
  // NO STATIC BINDINGS — INTENT FIRST (Vikas, 2026-08-17; Class 1 fix).
  // The old code ran a phrase-table classifier (detectJarvisIntent) HERE and
  // answered a greeting with a daily standup, "brief me…" with a standup, "how
  // did we do…" with a weekly report and "hey jarvis" with a canned Pong —
  // deterministic ANSWERING in front of the planner, the exact thing the law
  // forbids. That front door is gone: every plain-words message now reaches the
  // real reasoning engine (jarvis.ask), which understands intent and delegates.
  // Standup / roll-call / weekly-report survive as FUNCTIONS the planner (or an
  // explicit UI action) can invoke — never as greeting-triggered interceptors.
  // The ONLY thing that still sits in front of the planner is the capability
  // gate below, and it may only REFUSE-FOR-SAFETY (an unambiguous imperative to
  // perform an unbuilt ability, or an off-topic ask); it never answers or routes.

  // CW-1 honest refusal. Before an open-ended ask reaches the reasoning engine,
  // it is checked against the capability map (sources/capabilities.js — the
  // single source of truth). ONLY two things are refused: an ask that plainly
  // asks Jarvis to PERFORM an ability that is not built yet, and an ask with
  // nothing to do with this NOC. Everything else passes through to real
  // reasoning — a wrong refusal would be worse than a slow answer. The refusal
  // text is built FROM the map, never hardcoded, and touches no device.
  const check = capabilities.checkAsk(command);
  if (!check.allowed) {
    const a = agents[agentId];
    broadcast('chat_message', {
      type: 'incoming',
      agent: agentId,
      agentName: a ? a.name : 'Jarvis',
      agentIcon: a ? a.icon : '🎖️',
      text: check.text,
      // A change ask is a PROPOSAL, not a refusal. Tagging the message lets the
      // desk render it as the caption to its proposal card (one coherent
      // response) instead of a second, contradicting bubble.
      kind: check.changeProposal ? 'change_proposal' : undefined,
      timestamp: new Date().toISOString(),
    });
    // Audit + activity must say what is TRUE. A change ask was OFFERED as a
    // proposal (the engine is built; it simply does not fire from chat), not
    // "honestly refused" — recording it as a refusal would misstate the system.
    if (check.changeProposal) {
      session.audit({
        what: `ask: ${String(command).slice(0, 200)}`,
        result: 'offered a change proposal to confirm — nothing fired, zero device calls',
      });
      appendToActivityLog(`[${new Date().toISOString()}] [Jarvis] Offered a change proposal (chat never fires a change) — asked: "${String(command).slice(0, 60)}"\n`);
      updateAgentStatus(agentId, 'idle', 'Drafted a change proposal — waiting for you to confirm');
      return;
    }
    session.audit({
      what: `ask: ${String(command).slice(0, 200)}`,
      result: `honestly refused — ${check.ability ? `${check.ability.key} not available` : 'no capability covers this'} (zero device calls)`,
    });
    // The activity line must say what is TRUE of the system's own state: a
    // matched-but-unbuilt ability is named with its reason; only a genuinely
    // uncovered ask is recorded as uncovered.
    const why = check.ability
      ? `"${check.ability.label}" is not wired up yet — ${check.ability.reason}`
      : `nothing in my capability map covers this`;
    appendToActivityLog(`[${new Date().toISOString()}] [Jarvis] Honest refusal — ${why} — asked: "${String(command).slice(0, 60)}"\n`);
    updateAgentStatus(agentId, 'idle', 'Answered honestly: not something I can do yet');
    return;
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
// CW-1: this one seam is also where the operator's name lands. If the request
// that caused this line carried X-Operator-Name, the line (on disk AND on the
// live feed) is stamped "— by <name>". No per-call-site wiring, and nothing
// changes for a request with no name.
function appendToActivityLog(entry) {
  const operator = session.currentOperator();
  let text = String(entry || '');
  if (operator) {
    const trailing = /\n*$/.exec(text)[0];
    const body = text.slice(0, text.length - trailing.length);
    if (body && !body.includes(`— by ${operator}`)) text = `${body} — by ${operator}${trailing}`;
  }
  safeAppend(PATHS.activityLog, text, 'activity log');
  const line = text.replace(/\n+$/, '');
  if (!line) return;
  const m = /^\[([^\]]+)\]\s*\[([^\]]+)\]\s*([\s\S]*)$/.exec(line);
  broadcast('activity_new', m
    ? { source: m[2], text: m[3], ts: m[1], operator: operator || undefined }
    : { source: 'System', text: line, ts: new Date().toISOString(), operator: operator || undefined });
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
    // Nothing reached the wire on these two, so they are NOT live data and are
    // badged and counted apart from it.
    case 'denied': return '🛑 DENIED — RAN NOTHING:';
    case 'refused': return '🚫 NOT RUN:';
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
  // A read the operator denied, or one the guardrail/device-resolution refused,
  // touched no wire — counting it as a live reading would overstate the evidence
  // base, and hiding it would understate what was attempted.
  const blocked = count('denied') + count('refused');
  const agrees = count('agree');
  const refutes = count('refute');
  const alternatives = count('alternative');

  const silent = thread.messages
    .filter(m => m.stance === 'no-data')
    .map(m => m.agentName);

  const blockedNote = blocked
    ? ` ${blocked} read(s) ran nothing at all (denied at the permission gate, or refused before the wire) — those are not evidence.`
    : '';

  let verdict;
  if (evidence === 0 && noData === 0 && blocked === 0) {
    verdict = 'Nothing read yet.';
  } else if (evidence === 0) {
    verdict = 'No live data at all behind this topic — every invited agent is unconnected, its source is down, ' +
      'or its read never ran. There is nothing here to decide on.' + blockedNote;
  } else {
    verdict = `${evidence} agent(s) brought live readings; ${noData} had no source to read` +
      (silent.length ? ` (${silent.join(', ')})` : '') +
      `. Weigh this only on the ${evidence} live reading(s) above — the rest is not evidence either way.` + blockedNote;
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
  // No hardcoded actor: whoever paused it is stamped by the activity seam when a
  // name is known (it used to read "PAUSED by Vikas — by <operator>").
  appendToActivityLog(`[${new Date().toISOString()}] [Dashboard] ⏸ System PAUSED\n`);
  res.json({ success: true, paused: true });
});

app.post('/api/resume', (req, res) => {
  isPaused = false;
  broadcast('pause_state', { paused: false });
  appendToActivityLog(`[${new Date().toISOString()}] [Dashboard] ▶ System RESUMED\n`);
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
    // `ask: true` means the subject named no site/device/service — the console is
    // ASKING which one, not rejecting the operator. Same 422 (no triage opened),
    // but the client can word it as a question.
    return res.status(422).json({ error: result.reason, ask: Boolean(result.ask) });
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
  // 'leadership' is an intuitive alias operators reach for; it maps to the same
  // stored slt doc (artifacts.getDoc is leadership-aware).
  const which = req.params.which === 'leadership' ? 'slt' : req.params.which;
  if (which !== 'slt' && which !== 'engineer' && which !== 'servicenow') {
    return res.status(400).json({ error: 'Unknown document — use slt (leadership), engineer or servicenow.' });
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
  // setMode fails CLOSED: unknown/garbage values are rejected and the mode is
  // left unchanged, never coerced to auto. It returns {ok,mode,valid,reason}.
  const r = approvals.setMode((req.body || {}).mode);
  if (!r.ok) {
    return res.status(400).json({ ok: false, error: r.error, mode: r.mode, valid: r.valid, message: r.reason });
  }
  res.json({ ok: true, mode: r.mode });
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
  // TYPE-GUARD THE INPUT (QA CLASS 5). A truthy-but-wrong-typed field used to sail
  // past a plain `if (!agent || !command)` and blow up downstream — a number command
  // hit `command.match(...)` and threw a 500 with a full stack trace and absolute
  // file paths. The shape is validated HERE, at the boundary, so a bad type/shape is
  // a clean 400 with a helpful message and nothing ever reaches the router that
  // assumes a string. (The global error handler at the end of this file is the
  // second net for anything a route still throws.)
  const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {};
  const { agent, command, conversationId } = body;
  if (typeof agent !== 'string' || !agent.trim()) {
    return res.status(400).json({ error: 'A text "agent" is required (the agent id to talk to).' });
  }
  if (typeof command !== 'string' || !command.trim()) {
    return res.status(400).json({ error: 'A text "command" is required (what you want to say or ask).' });
  }
  if (conversationId != null && typeof conversationId !== 'string') {
    return res.status(400).json({ error: 'If you send a "conversationId" it must be text.' });
  }
  handleCommand({ agent, command, conversationId });
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

// ── ONE global error handler (QA CLASS 5) ───────────────────────────────────
// The LAST app.use, so it catches everything the routes and the JSON body-parser
// throw. Two leaks lived here before it existed: a malformed JSON body reached
// body-parser's SyntaxError and Express's default handler answered with the FULL
// stack trace and absolute node_modules paths; a bad-typed field that slipped a
// route's guard threw a TypeError and leaked server.js line numbers the same way.
// Now the detail is logged SERVER-SIDE only, and the client always gets a clean,
// generic, path-free message. A malformed/oversized body is the client's fault
// (400/413); anything else is treated as a server fault (500). Four args — this
// signature is what marks it an Express ERROR handler; do not drop `next`.
app.use((err, req, res, next) => {
  // A body-parser parse/size failure carries a `type` and/or an HTTP `status`.
  const badBody =
    err && (err.type === 'entity.parse.failed' || err.type === 'entity.too.large'
      || err.type === 'request.aborted' || err.type === 'encoding.unsupported'
      || err instanceof SyntaxError);
  const status = badBody ? (err.status || err.statusCode || 400)
    : (err && (err.status || err.statusCode)) || 500;

  // Server-side detail only — never the client's business. Keep the stack in the
  // server window (and the dashboard's system_error banner) where operators look.
  const detail = (err && (err.stack || err.message)) || String(err);
  console.error(`[HTTP ${req.method} ${req.originalUrl}] ${status} — ${detail}`);
  try {
    broadcast('system_error', { message: 'A request could not be processed — check the server window for detail.' });
  } catch (e) { /* the console.error above already recorded it */ }

  // If the response has already started streaming, we cannot change the status —
  // hand off to Express's finalizer, which will close the socket without a body.
  if (res.headersSent) return next(err);

  const clientMessage = status === 413
    ? 'That request body is too large.'
    : badBody
      ? 'That request body was not valid JSON.'
      : status >= 400 && status < 500
        ? 'That request could not be processed.'
        : 'Something went wrong handling that request.';
  res.status(status).json({ error: clientMessage });
});
// ── end global error handler ────────────────────────────────────────────────

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

// ─── A4: native syslog + SNMP-trap live feeds ───────────────────────────────
// Self-contained additive block (kept tiny + contiguous so A1's parallel
// server.js edits merge cleanly). Two NATIVE UDP receivers deposit parsed,
// secret-scrubbed events into the live-events store; each new event is streamed
// to the desk as `live_event`. Both feeds are OFF unless explicitly enabled
// (SYSLOG_ENABLED / SNMPTRAP_ENABLED, or a *_PORT set) — off = honest "not
// receiving", store empty, nothing fabricated. The bridge/triage read the same
// store by time window via liveEvents.getInWindow(startMs, endMs).
const liveEvents = require('./sources/live-events');
const syslogFeed = require('./sources/syslog-feed');
const snmptrapFeed = require('./sources/snmptrap-feed');

// GET /api/copilot/feeds/status → booleans + counts only, never a secret, never
// a raw packet. Honest "not receiving" when a feed is off/unbound.
app.get('/api/copilot/feeds/status', (req, res) => {
  res.json({ syslog: syslogFeed.status(), snmptrap: snmptrapFeed.status() });
});

// GET /api/copilot/feeds/events?limit=&source= → recent scrubbed events (the
// raw evidence the bridge reasons over). Empty when nothing has been received.
app.get('/api/copilot/feeds/events', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const source = req.query.source === 'syslog' || req.query.source === 'trap' ? req.query.source : null;
  res.json({ events: liveEvents.recent(limit, source), count: liveEvents.count(source) });
});

syslogFeed.start({ log: (m) => console.log(m), onEvent: (ev) => broadcast('live_event', ev) });
snmptrapFeed.start({ log: (m) => console.log(m), onEvent: (ev) => broadcast('live_event', ev) });
// ─── end A4 block ───────────────────────────────────────────────────────────

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

  // CW-8: connect any declared MCP servers + list their tools, in the background.
  // Honest-if-absent: none declared → nothing happens and the capability stays OFF.
  // A server that fails to connect is recorded with its reason (no fake tool); it
  // never blocks or crashes startup.
  mcp.connectAll()
    .then((results) => {
      const up = results.filter((r) => r.connected);
      if (results.length) {
        console.log(`[MCP] ${up.length}/${results.length} server(s) connected` +
          (up.length ? ` — ${up.map((r) => `${r.name} (${r.toolCount} tool${r.toolCount === 1 ? '' : 's'})`).join(', ')}` : ''));
        results.filter((r) => !r.connected).forEach((r) =>
          console.log(`[MCP] ${r.name} NOT connected — ${r.reason || 'unavailable'}`));
      }
    })
    .catch((err) => reportSystemError('the MCP connector could not start', err));
});
