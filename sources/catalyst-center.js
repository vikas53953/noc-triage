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
};
