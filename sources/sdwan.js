// Cisco SD-WAN vManage — read-only adapter.
// Always-on DevNet sandbox: https://sandbox-sdwan-2.cisco.com
//
// vManage auth is a two-step dance, proven live 2026-08-14:
//   1. POST /j_security_check with a form body  -> session cookie
//      (on FAILURE vManage returns HTTP 200 with an HTML login page, so the
//       body has to be inspected — the status code alone lies)
//   2. GET /dataservice/client/token             -> XSRF token
//   3. every /dataservice read carries Cookie + X-XSRF-TOKEN
const { request, requestJson } = require('./http');

const HOST = process.env.SDWAN_HOST;
const USER = process.env.SDWAN_USER;
const PASS = process.env.SDWAN_PASS;

// vManage sessions are long-lived; refresh every 20 minutes.
let cached = { cookie: null, xsrf: null, expires: 0 };

function configured() {
  return Boolean(HOST && USER && PASS);
}

async function login() {
  if (!configured()) throw new Error('SD-WAN not connected — SDWAN_HOST/USER/PASS are not set');
  if (cached.cookie && Date.now() < cached.expires) return cached;

  const form = `j_username=${encodeURIComponent(USER)}&j_password=${encodeURIComponent(PASS)}`;
  const res = await request({
    host: HOST, path: '/j_security_check', method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(form) },
    verifyTls: false, timeout: 45000,
  }, form);

  const cookie = (res.headers?.['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');
  // An HTML body means vManage served the login page again = auth failed.
  const authFailed = (res.body || '').includes('<html');
  if (!cookie || authFailed) throw new Error(`vManage login failed (${res.status || res.error || 'bad credentials'})`);

  const tk = await request({
    host: HOST, path: '/dataservice/client/token', method: 'GET',
    headers: { Cookie: cookie }, verifyTls: false, timeout: 45000,
  });
  const xsrf = (tk.body || '').trim();
  if (!xsrf) throw new Error('vManage did not return an XSRF token');

  cached = { cookie, xsrf, expires: Date.now() + 20 * 60 * 1000 };
  return cached;
}

// Every read goes through here. GET only — no write path exists in this file.
async function api(path) {
  const { cookie, xsrf } = await login();
  const res = await requestJson({
    host: HOST, path, method: 'GET',
    headers: { Cookie: cookie, 'X-XSRF-TOKEN': xsrf },
    verifyTls: false, timeout: 45000,
  });
  if (!res.ok) throw new Error(`vManage ${path} failed (${res.status || res.error})`);
  const j = res.json;
  return j && j.data !== undefined ? j.data : j;
}

const shape = (d) => ({
  hostname: d['host-name'] || d.deviceId || d.uuid,
  systemIp: d['system-ip'] || d.deviceIP,
  type: d['device-type'] || d.deviceType,
  model: d['device-model'] || d.deviceModel,
  state: d.reachability || d.status || d.state,
  version: d.version,
  siteId: d['site-id'],
  uptime: d.uptime_date,
  validity: d.validity,
});

async function getDevices() {
  const data = await api('/dataservice/device');
  return (Array.isArray(data) ? data : []).map(shape);
}

async function getControllers() {
  const data = await api('/dataservice/system/device/controllers');
  return (Array.isArray(data) ? data : []).map(shape);
}

async function getVedges() {
  const data = await api('/dataservice/system/device/vedges');
  return (Array.isArray(data) ? data : []).map(shape);
}

async function getAlarmCount() {
  const data = await api('/dataservice/alarms/count');
  const row = Array.isArray(data) ? data[0] || {} : data || {};
  return {
    active: row.active ?? row.count ?? null,
    cleared: row.cleared ?? null,
    raw: row,
  };
}

module.exports = {
  id: 'sdwan',
  label: 'Cisco SD-WAN (vManage)',
  host: HOST || null,
  configured,
  probe: login,
  getDevices,
  getControllers,
  getVedges,
  getAlarmCount,
};
