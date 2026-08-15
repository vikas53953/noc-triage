// Cisco ACI / APIC — read-only adapter.
// Always-on DevNet sandbox: https://sandboxapicdc.cisco.com
//
// Verified live 2026-08-14: leaf-1, leaf-2 (N9K-C9396PX), spine-1 (N9K-C9508),
// apic1 controller; 22 tenants, 70 EPGs, fabric health 88.
//
// The audit functions here follow the ACI object hierarchy:
//   Tenant -> VRF -> Bridge Domain -> Application Profile -> EPG -> Contract
// and look for the relationships that are MISSING, which is where real
// misconfiguration hides.
const { requestJson } = require('./http');

// No fallbacks: this repo is PUBLIC. Missing env = "not connected", never a
// credential baked into tracked source.
const HOST = process.env.ACI_HOST;
const USER = process.env.ACI_USER;
const PASS = process.env.ACI_PASS;

const configured = () => Boolean(HOST && USER && PASS);

// APIC tokens are short-lived (~10 min on the sandbox). Refresh well before.
let cached = { token: null, expires: 0 };

async function getToken() {
  if (!configured()) throw new Error('ACI not connected — ACI_HOST/USER/PASS are not set');
  if (cached.token && Date.now() < cached.expires) return cached.token;

  const payload = JSON.stringify({ aaaUser: { attributes: { name: USER, pwd: PASS } } });
  const res = await requestJson({
    host: HOST, path: '/api/aaaLogin.json', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    verifyTls: false,
  }, payload);

  const token = res.json?.imdata?.[0]?.aaaLogin?.attributes?.token;
  if (!res.ok || !token) throw new Error(`APIC login failed (${res.status || res.error})`);

  cached = { token, expires: Date.now() + 8 * 60 * 1000 };
  return token;
}

// Every APIC read goes through here. `cls` is a managed-object class name.
async function queryClass(cls, query = '') {
  const token = await getToken();
  const path = `/api/node/class/${cls}.json${query ? '?' + query : ''}`;
  const res = await requestJson({ host: HOST, path, headers: { Cookie: 'APIC-cookie=' + token }, verifyTls: false });
  if (!res.ok) throw new Error(`APIC ${cls} query failed (${res.status || res.error})`);
  return (res.json.imdata || []).map((item) => item[Object.keys(item)[0]].attributes);
}

async function getFabricNodes() {
  const nodes = await queryClass('fabricNode');
  return nodes.map((n) => ({
    name: n.name, model: n.model, role: n.role, serial: n.serial,
    version: n.version, state: n.fabricSt, address: n.address, id: n.id,
  }));
}

async function getFabricHealth() {
  const [health] = await queryClass('fabricHealthTotal', 'query-target-filter=eq(fabricHealthTotal.dn,"topology/health")');
  return { score: health ? Number(health.cur) : null, previous: health ? Number(health.prev) : null };
}

async function getTenants() {
  const tenants = await queryClass('fvTenant');
  return tenants.map((t) => ({ name: t.name, dn: t.dn, description: t.descr }));
}

async function getEpgs() {
  const epgs = await queryClass('fvAEPg');
  return epgs.map((e) => ({ name: e.name, dn: e.dn, mode: e.pcEnfPref, tenant: tenantOf(e.dn) }));
}

// Every ACI dn starts uni/tn-<tenant>/... — pull the tenant name out of it.
function tenantOf(dn) {
  const m = /uni\/tn-([^/]+)/.exec(dn || '');
  return m ? m[1] : 'unknown';
}

async function getFaults(severities = ['critical', 'major']) {
  const faults = await queryClass('faultInst');
  return faults
    .filter((f) => severities.includes(f.severity))
    .map((f) => ({
      code: f.code, severity: f.severity, cause: f.cause,
      description: f.descr, dn: f.dn, affected: f.affected,
      created: f.created, tenant: tenantOf(f.dn),
    }));
}

// ── The audit: walk the hierarchy and report what is INCOMPLETE ─────────────
// This is the read-only half of "safely operate it" — it finds the broken
// relationships without touching a single object.
async function auditTenant(tenantName) {
  const [vrfs, bds, aps, epgs, contracts, providers, consumers, faults] = await Promise.all([
    queryClass('fvCtx'), queryClass('fvBD'), queryClass('fvAp'), queryClass('fvAEPg'),
    queryClass('vzBrCP'), queryClass('fvRsProv'), queryClass('fvRsCons'), queryClass('faultInst'),
  ]);

  const mine = (list) => list.filter((x) => tenantOf(x.dn) === tenantName);
  const tVrfs = mine(vrfs), tBds = mine(bds), tAps = mine(aps), tEpgs = mine(epgs);
  const tContracts = mine(contracts);
  const tFaults = mine(faults).filter((f) => ['critical', 'major'].includes(f.severity));

  // A bridge domain with no VRF cannot route. A common real-world mistake.
  const bdWithoutVrf = [];
  for (const bd of tBds) {
    const rs = await queryClass('fvRsCtx', `query-target-filter=wcard(fvRsCtx.dn,"${bd.dn}/")`);
    if (!rs.length || !rs[0].tnFvCtxName) bdWithoutVrf.push(bd.name);
  }

  // An EPG with no bridge domain has no L2 identity.
  const epgWithoutBd = [];
  for (const epg of tEpgs) {
    const rs = await queryClass('fvRsBd', `query-target-filter=wcard(fvRsBd.dn,"${epg.dn}/")`);
    if (!rs.length || !rs[0].tnFvBDName) epgWithoutBd.push(epg.name);
  }

  // An EPG with no contract either way is isolated — sometimes deliberate,
  // usually a half-finished build. We report, we do not judge.
  const provDns = new Set(providers.map((p) => p.dn.replace(/\/rsprov-.*$/, '')));
  const consDns = new Set(consumers.map((c) => c.dn.replace(/\/rscons-.*$/, '')));
  const epgWithoutContract = tEpgs
    .filter((e) => !provDns.has(e.dn) && !consDns.has(e.dn))
    .map((e) => e.name);

  return {
    tenant: tenantName,
    counts: {
      vrfs: tVrfs.length, bridgeDomains: tBds.length, appProfiles: tAps.length,
      epgs: tEpgs.length, contracts: tContracts.length,
    },
    findings: { bdWithoutVrf, epgWithoutBd, epgWithoutContract },
    faults: tFaults.map((f) => ({ severity: f.severity, code: f.code, description: f.descr })),
    clean: !bdWithoutVrf.length && !epgWithoutBd.length && !epgWithoutContract.length && !tFaults.length,
  };
}

module.exports = {
  id: 'aci',
  label: 'Cisco ACI (APIC)',
  host: HOST || null,
  configured,
  probe: getToken,
  queryClass,
  getFabricNodes,
  getFabricHealth,
  getTenants,
  getEpgs,
  getFaults,
  auditTenant,
};
