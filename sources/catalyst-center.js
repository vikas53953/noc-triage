// Cisco Catalyst Center (formerly DNA Center) — read-only adapter.
// Always-on DevNet sandbox: https://sandboxdnac.cisco.com
//
// Verified live 2026-08-14: returns 4 Catalyst 9000v switches (sw1-sw4).
//
// ── Catalogue attribution (A2) ───────────────────────────────────────────────
// The set of high-value read (GET) operations added below — per-device health,
// interfaces, VLANs, clients, sites, physical topology, path trace, compliance
// and software images — was HARVESTED (endpoint URIs + shapes only) from the
// NetClaw catc-mcp read-only catalogue, which itself adopts Cisco's official
// Catalyst Center MCP tool definitions:
//   • NetClaw catc-mcp — Apache-2.0 — the curated 514-operation READ catalogue
//     (uri / method / parameterLocation), source of the endpoint list here.
//   • Upstream: github.com/cisco-en-programmability/catc-mcp-oss (release/2.3.7.11)
// No Python was copied — every function below is re-implemented in this repo's
// own Node style over sources/http.js. Only GET operations are used; nothing
// here can change device state (the write path stays the Template Programmer in
// pushConfig, and Command Runner stays show/ping-only via assertReadOnly).
//
// The "empty inventory ≠ empty network" stamp is also adopted from catc-mcp:
// every enveloped read below carries { appliance, observedAt }, and a zero-count
// / empty result carries an explicit caveat naming the real causes (discovery
// not run, RBAC scoping, a filter, or the WRONG appliance) — a zero here is a
// fact about THIS controller's last poll, never proof the network is empty.
const { requestJson, basicAuth } = require('./http');
const { assertReadOnly } = require('./guardrails');

// No fallbacks: this repo is PUBLIC. Missing env = "not connected", never a
// credential baked into tracked source.
const HOST = process.env.DNAC_HOST;
const USER = process.env.DNAC_USER;
const PASS = process.env.DNAC_PASS;

const configured = () => Boolean(HOST && USER && PASS);

// Catalyst Center tokens last an hour; cache and refresh a little early.
let cached = { token: null, expires: 0 };

async function getToken() {
  if (!configured()) throw new Error('Catalyst Center not connected — DNAC_HOST/USER/PASS are not set');
  if (cached.token && Date.now() < cached.expires) return cached.token;

  const res = await requestJson({
    host: HOST, path: '/dna/system/api/v1/auth/token', method: 'POST',
    headers: { Authorization: basicAuth(USER, PASS) }, verifyTls: false,
  });
  if (!res.ok || !res.json || !res.json.Token) {
    throw new Error(`Catalyst Center login failed (${res.status || res.error})`);
  }

  cached = { token: res.json.Token, expires: Date.now() + 50 * 60 * 1000 };
  return cached.token;
}

async function api(path) {
  const token = await getToken();
  const res = await requestJson({ host: HOST, path, headers: { 'X-Auth-Token': token }, verifyTls: false });
  if (!res.ok) throw new Error(`Catalyst Center ${path} failed (${res.status || res.error})`);
  return res.json;
}

// ── The read envelope (A2 — "empty inventory ≠ empty network") ────────────────
// Every NEW read below returns through here, so the answer always says WHICH
// appliance it came from and WHEN — and an empty/zero result is stamped, never
// silently passed off as "the network is empty". A zero from sandboxdnac2 (0
// devices, authenticates perfectly) is indistinguishable from a real empty
// estate unless the appliance is named, so it always is. Never throws: an
// honest typed outcome comes back so the caller records a fact, not a guess.
const observedAt = () => new Date().toISOString();
const EMPTY_CAVEAT =
  'An empty result here means THIS controller manages none right now — not that the ' +
  'network is empty. Discovery may not have run, the account\'s RBAC may scope it out, ' +
  'a filter may have excluded everything, or this may be the wrong appliance. ' +
  '(DevNet\'s sandboxdnac2 authenticates perfectly and returns 0 devices.)';

function envelope(operation, data, extra) {
  const count = Array.isArray(data) ? data.length : (data == null ? 0 : 1);
  const empty = count === 0;
  return Object.assign({
    ok: true,
    outcome: empty ? 'empty' : 'ok',
    operation,
    appliance: HOST,
    observedAt: observedAt(),
    count,
    data: data == null ? (Array.isArray(data) ? [] : null) : data,
    note: empty ? EMPTY_CAVEAT : undefined,
  }, extra || {});
}

// Honest failure envelope — the same shape, so a caller reads outcome once and
// never has to tell "threw" from "returned". not_configured / not_found are
// facts too, kept apart from a real transport error exactly as catc-mcp keeps
// its typed outcomes apart.
function failure(operation, outcome, error) {
  return { ok: false, outcome, operation, appliance: HOST, observedAt: observedAt(), error, data: null };
}

// A single GET that never throws: it maps res into a typed outcome the way the
// catc-mcp _envelope() chokepoint does. 200 → json; 401/403 → auth/forbidden;
// 404 → not_found; anything else → error. Used by every enveloped read below.
async function tryGet(operation, path) {
  if (!configured()) {
    return failure(operation, 'not_configured', 'Catalyst Center not connected — DNAC_HOST/USER/PASS are not set');
  }
  let token;
  try {
    token = await getToken();
  } catch (e) {
    return failure(operation, 'auth_failed', (e && e.message) || 'login failed');
  }
  const res = await requestJson({ host: HOST, path, headers: { 'X-Auth-Token': token }, verifyTls: false });
  if (res.ok) return { ok: true, json: res.json };
  if (res.status === 401) return failure(operation, 'auth_failed', 'Catalyst Center rejected the token (401)');
  if (res.status === 403) return failure(operation, 'forbidden', 'this account is not permitted to read that (403)');
  if (res.status === 404) return failure(operation, 'not_found', `Catalyst Center has no record for that (404) — ${path}`);
  return failure(operation, res.status ? 'error' : 'unreachable', `Catalyst Center ${path} failed (${res.status || res.error})`);
}

// Read a LIST endpoint (response[] mapped by `map`) into an enveloped result.
async function readList(operation, path, map) {
  const g = await tryGet(operation, path);
  if (!g.ok) return g;
  const rows = (g.json && g.json.response) || [];
  const data = Array.isArray(rows) ? rows.map(map) : [];
  return envelope(operation, data);
}

async function getDevices() {
  const data = await api('/dna/intent/api/v1/network-device');
  return (data.response || []).map((d) => ({
    id: d.id,
    hostname: d.hostname,
    ip: d.managementIpAddress,
    platform: d.platformId,
    role: d.role,
    series: d.series,
    software: d.softwareVersion,
    uptime: d.upTime,
    reachability: d.reachabilityStatus,
    errorDescription: d.errorDescription,
  }));
}

async function getHealth() {
  // Catalyst Center wants a millisecond timestamp for the health snapshot.
  const data = await api(`/dna/intent/api/v1/network-health?timestamp=${Date.now()}`);
  const overall = (data.response || [])[0] || {};
  return {
    score: overall.healthScore,
    total: overall.totalCount,
    good: overall.goodCount,
    bad: overall.badCount,
    unmonitored: overall.unmonCount,
    measuredBy: data.measuredBy,
  };
}

async function getIssues() {
  const data = await api('/dna/intent/api/v1/issues');
  return (data.response || []).map((i) => ({
    name: i.name,
    priority: i.priority,
    status: i.status,
    category: i.category,
    deviceId: i.deviceId,
    occurrences: i.issue_occurence_count,
    lastOccurred: i.last_occurence_time,
  }));
}

// Read-only by contract: Command Runner is given ONLY show-class commands.
// The guardrail lives in sources/guardrails.js and is applied by the caller.
async function runShowCommand(deviceIds, command) {
  // Belt and braces: the caller checks the allowlist, and so does the adapter.
  const safe = assertReadOnly(command);
  const token = await getToken();
  const payload = JSON.stringify({ commands: [safe], deviceUuids: deviceIds });

  const submit = await requestJson({
    host: HOST, path: '/dna/intent/api/v1/network-device-poller/cli/read-request', method: 'POST',
    headers: { 'X-Auth-Token': token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    verifyTls: false,
  }, payload);
  if (!submit.ok) throw new Error(`Command Runner rejected the request (${submit.status || submit.error})`);

  const taskId = submit.json?.response?.taskId;
  if (!taskId) throw new Error('Command Runner did not return a task id');

  // Poll the task until the file handle appears, then fetch the output.
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const task = await api(`/dna/intent/api/v1/task/${taskId}`);
    const progress = task.response?.progress || '';
    if (task.response?.isError) throw new Error(task.response.failureReason || 'Command Runner task failed');
    if (progress.includes('fileId')) {
      const fileId = JSON.parse(progress).fileId;
      const file = await api(`/dna/intent/api/v1/file/${fileId}`);
      return file;
    }
  }
  throw new Error('Command Runner timed out waiting for output');
}

// Pull the real device CLI transcript out of a Command Runner file response.
// Body shape: [{ commandResponses: { SUCCESS: { "show running-config": "..." } } }].
// Returns { ok, text } or null — same buckets the live-agents extractor reads.
function extractCli(file, command) {
  try {
    const entry = Array.isArray(file) ? file[0] : file;
    const r = (entry && entry.commandResponses) || {};
    const pick = (bucket) => {
      const keys = Object.keys(bucket || {});
      return keys.length ? bucket[keys[0]] : null;
    };
    const ok = pick(r.SUCCESS || r.success);
    if (ok) return { ok: true, text: String(ok) };
    const failed = pick(r.FAILURE || r.failure);
    if (failed) return { ok: false, text: String(failed) };
    const blocked = pick(r.BLOCKLISTED || r.blocklisted);
    if (blocked) return { ok: false, text: `Catalyst Center blocklisted this command: ${blocked}` };
  } catch (e) { /* fall through */ }
  return null;
}

// Read a device's running-config live via Command Runner (read-only; the
// guardrail allows "show running-config" — a show-class read). Feeds
// config-store for change correlation (gap 5). Returns:
//   { ok:true,  deviceId, command, text }              — real config text
//   { ok:false, deviceId, command, text/error, ... }   — device rejected / unreachable
// It never throws for an unreachable source: the honest failure is returned so
// the caller can record "unreachable", not a fabricated "no change".
async function getRunningConfig(deviceId) {
  const command = 'show running-config';
  if (!configured()) {
    return { ok: false, deviceId, command, error: 'Catalyst Center not connected — DNAC_HOST/USER/PASS are not set' };
  }
  if (!deviceId) {
    return { ok: false, deviceId: null, command, error: 'no device id given' };
  }
  try {
    // runShowCommand re-checks the guardrail (assertReadOnly) before anything is sent.
    const file = await runShowCommand([deviceId], command);
    const out = extractCli(file, command);
    if (!out) {
      return { ok: false, deviceId, command, error: 'Command Runner returned no readable output' };
    }
    if (out.ok === false) {
      return { ok: false, deviceId, command, error: 'device rejected the command', text: out.text };
    }
    return { ok: true, deviceId, command, text: out.text };
  } catch (e) {
    return { ok: false, deviceId, command, error: (e && e.message) || 'unreachable' };
  }
}

// ── THE WRITE PATH (CW-2) ────────────────────────────────────────────────────
// Command Runner is read-only by design — Cisco's endpoint is literally called
// "cli/read-request" and the platform blocklists configuration commands on it.
// The documented way to PUSH configuration through Catalyst Center is the
// Template Programmer: create a project, create a template holding the config
// lines, commit a version, then deploy that version to a device.
//
// This function attempts that FOR REAL, every time. It does not consult a
// hardcoded "the sandbox is read-only" flag, because that would be a belief
// rather than a fact: the account's rights can change, and the honest answer
// must come from the API's own response. When Catalyst Center answers 403 "Role
// does not have valid permissions", the result carries noWritePath:true and the
// verbatim reason, and the change engine freezes the change on it. Nothing is
// ever reported as applied that the platform did not apply.
//
// Returns { ok, noWritePath?, reason?, detail?, steps[] } — steps is the real
// API transcript (method, path, status) so the record can show what was tried.
async function pushConfig({ deviceIp, commands, label }) {
  const steps = [];
  const lines = (commands || []).map((c) => String(c));
  if (!configured()) {
    return { ok: false, noWritePath: true, steps,
      reason: 'Catalyst Center not connected — DNAC_HOST/USER/PASS are not set, so there is no write path to this device.' };
  }
  if (!lines.length) return { ok: false, steps, reason: 'no commands to push' };
  if (!deviceIp) return { ok: false, steps, reason: 'no management IP for that device — nothing to deploy to' };

  const token = await getToken();
  const post = async (path, bodyObj) => {
    const payload = JSON.stringify(bodyObj);
    const res = await requestJson({
      host: HOST, path, method: 'POST',
      headers: { 'X-Auth-Token': token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      verifyTls: false,
    }, payload);
    steps.push({ method: 'POST', path, status: res.status || res.error || 'no-response' });
    return res;
  };
  const waitTask = async (taskId) => {
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      const t = await api(`/dna/intent/api/v1/task/${taskId}`);
      const r = t.response || {};
      if (r.isError) return { ok: false, reason: r.failureReason || 'task failed' };
      if (r.endTime || r.data) return { ok: true, data: r.data };
    }
    return { ok: false, reason: 'timed out waiting for the task to finish' };
  };
  // A 403 anywhere in this chain means the same thing: this account may not
  // write. Recognised in ONE place so every step reports it identically.
  const noWritePath = (res, what) => ({
    ok: false, noWritePath: true, steps,
    reason: `Catalyst Center refused to ${what}: HTTP ${res.status} — ` +
      `${(res.json && res.json.message) || String(res.body || '').slice(0, 200)}. ` +
      `This account has no configuration-write rights, so there is no write path to this device yet.`,
  });

  const stamp = `${Date.now().toString(36)}`;
  const proj = await post('/dna/intent/api/v1/template-programmer/project', {
    name: `noc-triage-${stamp}`, description: `noc-triage change engine — ${label || 'change'}`,
  });
  if (proj.status === 403) return noWritePath(proj, 'create a configuration project');
  if (!proj.ok) return { ok: false, steps, reason: `could not create the configuration project (HTTP ${proj.status || proj.error})` };
  const projTask = await waitTask(proj.json?.response?.taskId);
  if (!projTask.ok || !projTask.data) return { ok: false, steps, reason: projTask.reason || 'no project id came back' };
  const projectId = projTask.data;

  const tmpl = await post(`/dna/intent/api/v1/template-programmer/project/${projectId}/template`, {
    name: `noc-triage-${stamp}`, projectId, description: label || 'noc-triage change',
    deviceTypes: [{ productFamily: 'Switches and Hubs' }], softwareType: 'IOS-XE',
    language: 'VELOCITY', composite: false, templateContent: lines.join('\n') + '\n',
  });
  if (tmpl.status === 403) return noWritePath(tmpl, 'create a configuration template');
  if (!tmpl.ok) return { ok: false, steps, reason: `could not create the configuration template (HTTP ${tmpl.status || tmpl.error})` };
  const tmplTask = await waitTask(tmpl.json?.response?.taskId);
  if (!tmplTask.ok || !tmplTask.data) return { ok: false, steps, reason: tmplTask.reason || 'no template id came back' };
  const templateId = tmplTask.data;

  const ver = await post('/dna/intent/api/v1/template-programmer/template/version', { templateId, comments: label || 'noc-triage change' });
  if (ver.status === 403) return noWritePath(ver, 'commit the configuration template');
  if (!ver.ok) return { ok: false, steps, reason: `could not commit the template version (HTTP ${ver.status || ver.error})` };
  await waitTask(ver.json?.response?.taskId);

  const dep = await post('/dna/intent/api/v1/template-programmer/template/deploy', {
    templateId, forcePushTemplate: true,
    targetInfo: [{ id: deviceIp, type: 'MANAGED_DEVICE_IP', params: {} }],
  });
  if (dep.status === 403) return noWritePath(dep, 'deploy the configuration');
  if (!dep.ok) return { ok: false, steps, reason: `deploy was rejected (HTTP ${dep.status || dep.error})` };

  const idMatch = String(dep.json?.deploymentId || '').match(/[0-9a-f-]{36}/i);
  if (!idMatch) return { ok: false, steps, reason: `deploy returned no deployment id: ${String(dep.body || '').slice(0, 200)}` };
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const st = await api(`/dna/intent/api/v1/template-programmer/template/deploy/status/${idMatch[0]}`);
    const s = String(st.status || '');
    if (/SUCCESS/i.test(s)) return { ok: true, steps, detail: `deployed to ${deviceIp}: ${s}` };
    if (/FAIL|ERROR/i.test(s)) return { ok: false, steps, reason: `deployment failed: ${st.statusMessage || s}` };
  }
  return { ok: false, steps, reason: 'timed out waiting for the deployment to finish — the device state is UNKNOWN, not assumed unchanged' };
}

// ── NEW READ OPERATIONS (A2 — harvested from the NetClaw catc-mcp catalogue) ──
// Every one is a GET, returns the honest envelope above (real data or a typed
// empty/error with the "not empty network" stamp), and never fabricates. The
// catalogue operation name each was re-implemented from is named in a comment so
// the lineage is auditable.

const enc = encodeURIComponent;
function qs(params) {
  const parts = Object.entries(params || {})
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${enc(k)}=${enc(v)}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

// Per-device assurance health scores — the NOC's "which boxes are unhealthy"
// view, distinct from getHealth()'s single fabric-wide score.
// catc: api_devices  GET /dna/intent/api/v1/device-health
async function getDeviceHealth(opts = {}) {
  const now = Date.now();
  const params = {
    startTime: opts.startTime || now - 60 * 60 * 1000,
    endTime: opts.endTime || now,
    siteId: opts.siteId, deviceRole: opts.deviceRole, health: opts.health,
    limit: opts.limit || 50, offset: opts.offset,
  };
  return readList('getDeviceHealth', `/dna/intent/api/v1/device-health${qs(params)}`, (d) => ({
    name: d.name, ip: d.ipAddress, model: d.model, location: d.location,
    role: d.deviceType || d.role, reachability: d.reachabilityHealth,
    overallHealth: d.overallHealth, cpuUtil: d.cpuUlitilization ?? d.cpuUtilization,
    memoryUtil: d.memoryUtilization, osVersion: d.osVersion, uuid: d.uuid,
  }));
}

// Full device detail resolved from a management IP — the shape a NOC reaches for
// when it has an address off an alarm and needs the box behind it.
// catc: api_getNetworkDeviceByIP  GET /dna/intent/api/v1/network-device/ip-address/{ipAddress}
async function getDeviceByIp(ip) {
  if (!ip) return failure('getDeviceByIp', 'error', 'no IP address given');
  const g = await tryGet('getDeviceByIp', `/dna/intent/api/v1/network-device/ip-address/${enc(ip)}`);
  if (!g.ok) return g;
  const d = (g.json && g.json.response) || null;
  return envelope('getDeviceByIp', d && {
    id: d.id, hostname: d.hostname, ip: d.managementIpAddress, platform: d.platformId,
    role: d.role, series: d.series, software: d.softwareVersion, uptime: d.upTime,
    reachability: d.reachabilityStatus, serial: d.serialNumber, macAddress: d.macAddress,
  });
}

// Full device detail by Catalyst Center UUID (the id getDevices() already hands
// back). catc: api_getDeviceByID  GET /dna/intent/api/v1/network-device/{id}
async function getDeviceDetail(id) {
  if (!id) return failure('getDeviceDetail', 'error', 'no device id given');
  const g = await tryGet('getDeviceDetail', `/dna/intent/api/v1/network-device/${enc(id)}`);
  if (!g.ok) return g;
  const d = (g.json && g.json.response) || null;
  return envelope('getDeviceDetail', d && {
    id: d.id, hostname: d.hostname, ip: d.managementIpAddress, platform: d.platformId,
    role: d.role, series: d.series, software: d.softwareVersion, uptime: d.upTime,
    reachability: d.reachabilityStatus, serial: d.serialNumber, macAddress: d.macAddress,
    lastUpdated: d.lastUpdated, collectionStatus: d.collectionStatus, errorDescription: d.errorDescription,
  });
}

// Every physical interface on a device, with status/speed — the first read a
// NOC runs on a switch behind an alarm.
// catc: api_getInterfaceInfoById  GET /dna/intent/api/v1/interface/network-device/{deviceId}
async function getInterfaces(deviceId) {
  if (!deviceId) return failure('getInterfaces', 'error', 'no device id given');
  return readList('getInterfaces', `/dna/intent/api/v1/interface/network-device/${enc(deviceId)}`, (i) => ({
    name: i.portName, status: i.status, adminStatus: i.adminStatus, description: i.description,
    vlan: i.vlanId, speed: i.speed, duplex: i.duplex, mac: i.macAddress,
    ip: i.ipv4Address, type: i.interfaceType, mediaType: i.mediaType,
  }));
}

// The VLANs configured on a device's interfaces.
// catc: api_getDeviceInterfaceVLANs  GET /dna/intent/api/v1/network-device/{id}/vlan
async function getDeviceVlans(deviceId) {
  if (!deviceId) return failure('getDeviceVlans', 'error', 'no device id given');
  return readList('getDeviceVlans', `/dna/intent/api/v1/network-device/${enc(deviceId)}/vlan`, (v) => ({
    vlanNumber: v.vlanNumber, vlanType: v.vlanType, interfaceName: v.interfaceName,
    ipAddress: v.ipAddress, mask: v.mask, prefix: v.prefix, networkAddress: v.networkAddress,
  }));
}

// Clients seen on the fabric in a recent window — the "who is actually connected"
// read. catc: api_retrievesTheListOfClients  GET /dna/data/api/v1/clients
async function getClients(opts = {}) {
  const now = Date.now();
  const params = {
    startTime: opts.startTime || now - 15 * 60 * 1000,
    endTime: opts.endTime || now,
    limit: opts.limit || 50, offset: opts.offset, type: opts.type,
  };
  return readList('getClients', `/dna/data/api/v1/clients${qs(params)}`, (c) => ({
    mac: c.macAddress, name: c.name || c.userId, ipv4: c.ipv4Address, type: c.type,
    connectedDevice: (c.connectedNetworkDevice && c.connectedNetworkDevice.connectedNetworkDeviceName)
      || c.connectedNetworkDeviceName,
    health: c.health && c.health.overallScore, ssid: c.ssid, band: c.band, vlan: c.vlanId,
  }));
}

// The site hierarchy the controller knows about — areas, buildings, floors.
// catc: api_getSites  GET /dna/intent/api/v1/sites
async function getSites(opts = {}) {
  const params = { limit: opts.limit || 100, offset: opts.offset, name: opts.name, type: opts.type };
  return readList('getSites', `/dna/intent/api/v1/sites${qs(params)}`, (s) => ({
    id: s.id, name: s.name, nameHierarchy: s.nameHierarchy, type: s.type,
    parentId: s.parentId, latitude: s.latitude, longitude: s.longitude, address: s.address,
  }));
}

// The physical/site topology graph — nodes and the links between them, as the
// controller has discovered them.
// catc: api_getSiteTopology  GET /dna/intent/api/v1/topology/site-topology
async function getSiteTopology() {
  const g = await tryGet('getSiteTopology', '/dna/intent/api/v1/topology/site-topology');
  if (!g.ok) return g;
  const r = (g.json && g.json.response) || {};
  const sites = Array.isArray(r.sites) ? r.sites : [];
  return envelope('getSiteTopology', sites.map((s) => ({
    name: s.name, id: s.id, parentId: s.parentId, locationType: s.locationType,
    latitude: s.latitude, longitude: s.longitude, displayName: s.displayName,
  })));
}

// Previously-run path traces (read-only retrieval — this NEVER launches a new
// trace, which would be a POST/write). catc: api_retrievesAllPreviousPathtracesSummary
// GET /dna/intent/api/v1/flow-analysis
async function getPathTraces(opts = {}) {
  const params = { limit: opts.limit || 25, offset: opts.offset,
    sourceIP: opts.sourceIP, destIP: opts.destIP, status: opts.status };
  return readList('getPathTraces', `/dna/intent/api/v1/flow-analysis${qs(params)}`, (p) => ({
    id: p.id, source: p.sourceIP, destination: p.destIP, protocol: p.protocol,
    status: p.status, createTime: p.createTime, lastUpdateTime: p.lastUpdateTime,
  }));
}

// A device's configuration-compliance status against Catalyst Center's policies.
// catc: api_deviceComplianceStatus  GET /dna/intent/api/v1/compliance/{deviceUuid}
async function getDeviceCompliance(deviceUuid) {
  if (!deviceUuid) return failure('getDeviceCompliance', 'error', 'no device uuid given');
  return readList('getDeviceCompliance', `/dna/intent/api/v1/compliance/${enc(deviceUuid)}`, (c) => ({
    category: c.complianceType, status: c.status, state: c.state,
    lastSyncTime: c.lastSyncTime, lastUpdateTime: c.lastUpdateTime,
  }));
}

// The software images Catalyst Center holds, with golden-tagging — the "what
// version should this be running" read. catc: api_returnsListOfSoftwareImages
// GET /dna/intent/api/v1/images
async function getSoftwareImages(opts = {}) {
  const params = { limit: opts.limit || 50, offset: opts.offset, name: opts.name };
  const g = await tryGet('getSoftwareImages', `/dna/intent/api/v1/images${qs(params)}`);
  if (!g.ok) {
    // Some appliance versions expose the older importation endpoint instead. A
    // 404 on /images is an honest "not on this version", not a fabricated answer —
    // fall back to the documented alternative before giving up, still read-only.
    if (g.outcome !== 'not_found') return g;
    return readList('getSoftwareImages', `/dna/intent/api/v1/image/importation/golden${qs(params)}`,
      (im) => ({ name: im.name, version: im.version, family: im.family, golden: im.golden }));
  }
  const rows = (g.json && (g.json.response || g.json.softwareImages)) || [];
  return envelope('getSoftwareImages', (Array.isArray(rows) ? rows : []).map((im) => ({
    name: im.name || im.imageName, version: im.version || im.imageVersion,
    family: im.family || im.imageFamily || im.applicableDevicesForImage, golden: im.golden,
    imageUuid: im.imageUuid, isTaggedGolden: im.isTaggedGolden,
  })));
}

module.exports = {
  id: 'catalyst-center',
  label: 'Cisco Catalyst Center',
  host: HOST || null,
  configured,
  probe: getToken,
  getDevices,
  getHealth,
  getIssues,
  runShowCommand,
  getRunningConfig,
  pushConfig,
  // A2 — the read catalogue harvested from NetClaw catc-mcp (all GET, enveloped).
  getDeviceHealth,
  getDeviceByIp,
  getDeviceDetail,
  getInterfaces,
  getDeviceVlans,
  getClients,
  getSites,
  getSiteTopology,
  getPathTraces,
  getDeviceCompliance,
  getSoftwareImages,
  // Exposed for tests + honest-empty rendering by callers.
  envelope,
  EMPTY_CAVEAT,
};
