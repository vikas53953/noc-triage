// Cisco Catalyst Center (formerly DNA Center) — read-only adapter.
// Always-on DevNet sandbox: https://sandboxdnac.cisco.com
//
// Verified live 2026-08-14: returns 4 Catalyst 9000v switches (sw1-sw4).
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
};
