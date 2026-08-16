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
    cleared: row.cleared ?? row.cleared_count ?? null,
    raw: row,
  };
}

// POST-only helper for the alarm query endpoint. Same auth as api(), but the
// alarms endpoint takes a JSON query body describing which alarms to return.
async function apiPost(path, bodyObj) {
  const { cookie, xsrf } = await login();
  const body = JSON.stringify(bodyObj);
  const res = await requestJson({
    host: HOST, path, method: 'POST',
    headers: {
      Cookie: cookie, 'X-XSRF-TOKEN': xsrf,
      'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
    },
    verifyTls: false, timeout: 45000,
  }, body);
  if (!res.ok) throw new Error(`vManage ${path} failed (${res.status || res.error})`);
  const j = res.json;
  return j && j.data !== undefined ? j.data : j;
}

// Map ONE raw vManage alarm to the shape the triage brain consumes. Every field
// is a REAL vManage alarm field (verified against a live sandbox-sdwan-2 read on
// 2026-08-16). Missing values are null/undefined — never invented.
//   entry_time  -> epoch-ms number, when the alarm was first raised
//   severity    -> Critical | Major | Medium | Minor  (severity_number: 0..3)
//   host_name / system_ip -> the reporting device
//   site_id     -> the site (often "" on fabric/system alarms — kept honest as null)
//   type        -> the alarm rule name (e.g. memory-usage, interface-state-change)
//   component   -> the vManage subsystem (system, control, security, …)
const shapeAlarm = (a) => {
  const device = a.host_name || a.system_ip
    || (Array.isArray(a.devices) && a.devices[0] && a.devices[0]['system-ip']) || null;
  const site = (a.site_id === undefined || a.site_id === null || a.site_id === '') ? null : String(a.site_id);
  return {
    uuid: a.uuid || null,
    severity: a.severity || null,
    severityNumber: a.severity_number ?? null,
    entryTime: typeof a.entry_time === 'number' ? a.entry_time : (a.entry_time ? Number(a.entry_time) : null),
    type: a.type || a.rulename || null,
    component: a.component || null,
    rule: a.rulename || null,
    ruleDisplay: a.rule_name_display || null,
    device,
    systemIp: a.system_ip || null,
    site,
    message: a.message || null,
    active: a.active ?? null,
    acknowledged: a.acknowledged ?? null,
    cleared: a.cleared ?? null,
  };
};

// Read the CURRENT (active, uncleared) alarms as per-alarm objects.
// Uses the same query the vManage alarm dashboard issues (active == true). On the
// always-on sandbox this is ~220-250 alarms — the standing noise the triage brain
// must cluster and baseline. Pass { active: false } to read the full alarm history.
async function getAlarms({ active = true } = {}) {
  const query = active
    ? { query: { condition: 'AND', rules: [{ value: ['true'], field: 'active', type: 'boolean', operator: 'equal' }] } }
    : {};
  const data = await apiPost('/dataservice/alarms', query);
  return (Array.isArray(data) ? data : []).map(shapeAlarm);
}

const A_DAY = 24 * 60 * 60 * 1000;

// Cluster shaped alarms into groups so triage can lead with the top-3 instead of a
// raw count. Pure function — no I/O, safe to unit-test with a fixture.
//   alarms   : array from getAlarms() (or any {entryTime,type,device,site,severity} objs)
//   opts.sinceTs : incident-window start (epoch ms). Alarms first seen before it are
//                  CHRONIC (standing noise); alarms at/after it are NEW. Defaults to
//                  24h ago when omitted.
//   opts.by  : grouping dimensions, default ['type','device','site'] (the (type|device|site)
//              key from the spec). Any subset works, e.g. ['type'] or ['device'].
//   opts.topN: how many groups to return in `groups`, biggest first. Default 10.
// Returns { total, groups:[{ key, type?, device?, site?, severity, count, firstSeen,
//           chronic, newCount }], chronicCount, newCount }.
function clusterAlarms(alarms, opts = {}) {
  const list = Array.isArray(alarms) ? alarms : [];
  const sinceTs = Number.isFinite(opts.sinceTs) ? opts.sinceTs : (Date.now() - A_DAY);
  const by = Array.isArray(opts.by) && opts.by.length ? opts.by : ['type', 'device', 'site'];
  const topN = Number.isFinite(opts.topN) ? opts.topN : 10;
  const sevRank = { Critical: 0, Major: 1, Medium: 2, Minor: 3 };

  const map = new Map();
  for (const a of list) {
    const parts = by.map((d) => (a[d] === null || a[d] === undefined || a[d] === '') ? '·' : String(a[d]));
    const key = parts.join(' | ');
    let g = map.get(key);
    if (!g) {
      g = {
        key, count: 0, firstSeen: null, newCount: 0,
        severity: null, _sevRank: 99,
      };
      // carry the grouping dimensions as named fields for friendly rendering
      by.forEach((d, i) => { g[d] = (a[d] === undefined ? null : a[d]); });
      map.set(key, g);
    }
    g.count += 1;
    const ts = Number.isFinite(a.entryTime) ? a.entryTime : null;
    if (ts !== null) {
      if (g.firstSeen === null || ts < g.firstSeen) g.firstSeen = ts;
      if (ts >= sinceTs) g.newCount += 1;
    }
    const r = sevRank[a.severity] ?? 98;
    if (r < g._sevRank) { g._sevRank = r; g.severity = a.severity || null; }
  }

  const groups = [...map.values()].map((g) => {
    const { _sevRank, ...rest } = g;
    return {
      ...rest,
      chronic: g.firstSeen !== null && g.firstSeen < sinceTs,
    };
  }).sort((x, y) => y.count - x.count || (x.firstSeen ?? Infinity) - (y.firstSeen ?? Infinity));

  return {
    total: list.length,
    sinceTs,
    chronicCount: list.filter((a) => Number.isFinite(a.entryTime) && a.entryTime < sinceTs).length,
    newCount: list.filter((a) => Number.isFinite(a.entryTime) && a.entryTime >= sinceTs).length,
    groups: groups.slice(0, topN),
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
  getAlarms,
  clusterAlarms,
};
