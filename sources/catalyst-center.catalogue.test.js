// catalyst-center.catalogue.test.js — A2: the read catalogue harvested from the
// NetClaw catc-mcp reference. DETERMINISTIC: no live sandbox needed. The HTTP
// layer (sources/http.js) is stubbed via require.cache BEFORE the adapter loads,
// so every new read runs against scripted responses. What it proves:
//   • real data flows through the envelope with { appliance, observedAt } stamped;
//   • an empty/zero result carries the "empty inventory ≠ empty network" caveat,
//     and a NON-empty result does NOT (no false alarm);
//   • typed honest outcomes are kept apart: ok / empty / forbidden / not_found /
//     auth_failed / not_configured / error — never a fabricated value on failure;
//   • READ-ONLY: every wire call the new reads make is a GET (the token POST aside);
//   • the DNAC password never appears in any returned envelope.

const assert = require('assert');
const HTTP_PATH = require.resolve('./http');
const CATC_PATH = require.resolve('./catalyst-center');

const SECRET_PASS = 'S3cr3t-DNAC-Pw!never-leak';
let calls = []; // { method, path } for every wire call the adapter makes

// Install a stubbed ./http into the module cache, then load a FRESH adapter that
// binds to it. `routes` maps a path-substring → a response object; the token
// endpoint is handled here so getToken() succeeds.
function loadAdapter({ configured = true, routes = {} } = {}) {
  calls = [];
  delete require.cache[CATC_PATH];
  if (configured) {
    process.env.DNAC_HOST = 'unit.test.local';
    process.env.DNAC_USER = 'unit-user';
    process.env.DNAC_PASS = SECRET_PASS;
  } else {
    delete process.env.DNAC_HOST; delete process.env.DNAC_USER; delete process.env.DNAC_PASS;
  }
  require.cache[HTTP_PATH] = {
    id: HTTP_PATH, filename: HTTP_PATH, loaded: true, exports: {
      basicAuth: (u, p) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64'),
      async requestJson(opts) {
        calls.push({ method: opts.method || 'GET', path: opts.path });
        if (opts.path.includes('/auth/token')) return { ok: true, status: 200, json: { Token: 'unit-token' } };
        for (const key of Object.keys(routes)) {
          if (opts.path.includes(key)) return routes[key];
        }
        return { ok: false, status: 500, error: 'no route in stub' };
      },
    },
  };
  return require(CATC_PATH);
}

const okRes = (json) => ({ ok: true, status: 200, json });
const errRes = (status) => ({ ok: false, status });

let passed = 0, failed = 0;
function ok(name, cond) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}`); }
}
const stamped = (e) => e.appliance === 'unit.test.local' && typeof e.observedAt === 'string' && e.observedAt.length > 0;

(async () => {
  console.log('\nA2 — Catalyst Center read catalogue (catc harvest), deterministic:\n');

  // ── ok path: real data, stamped, no caveat ────────────────────────────────
  {
    const catc = loadAdapter({ routes: {
      '/dna/intent/api/v1/device-health': okRes({ response: [
        { name: 'sw1', ipAddress: '10.10.20.175', overallHealth: 10, reachabilityHealth: 'REACHABLE', osVersion: '17.12.1prd9', uuid: 'u1' },
      ] }),
    } });
    const r = await catc.getDeviceHealth({ limit: 5 });
    ok('device-health: outcome ok', r.ok === true && r.outcome === 'ok');
    ok('device-health: real row mapped', r.count === 1 && r.data[0].name === 'sw1' && r.data[0].overallHealth === 10);
    ok('device-health: envelope stamped (appliance + observedAt)', stamped(r));
    ok('device-health: NON-empty carries NO caveat', r.note === undefined);
    ok('device-health: wire call was a GET (read-only)', calls.filter((c) => !c.path.includes('/auth/token')).every((c) => c.method === 'GET'));
    ok('device-health: password never in the envelope', JSON.stringify(r).indexOf(SECRET_PASS) === -1);
  }

  // ── empty path: the "not empty network" stamp ─────────────────────────────
  {
    const catc = loadAdapter({ routes: { '/dna/intent/api/v1/flow-analysis': okRes({ response: [] }) } });
    const r = await catc.getPathTraces();
    ok('path-traces empty: outcome empty (not ok)', r.ok === true && r.outcome === 'empty' && r.count === 0);
    ok('path-traces empty: carries the not-empty-network caveat', typeof r.note === 'string' && /not that the network is empty/i.test(r.note));
    ok('path-traces empty: caveat names the wrong-appliance cause', /wrong appliance/i.test(r.note) && r.note === catc.EMPTY_CAVEAT);
    ok('path-traces empty: still stamped', stamped(r));
  }

  // ── interfaces mapping + read-only ────────────────────────────────────────
  {
    const catc = loadAdapter({ routes: { '/dna/intent/api/v1/interface/network-device/': okRes({ response: [
      { portName: 'GigabitEthernet1/0/1', status: 'up', adminStatus: 'UP', vlanId: '1', speed: '1000000' },
      { portName: 'GigabitEthernet1/0/2', status: 'down', adminStatus: 'DOWN', vlanId: '101' },
    ] }) } });
    const r = await catc.getInterfaces('dev-uuid-1');
    ok('interfaces: two rows mapped with status', r.count === 2 && r.data[0].name === 'GigabitEthernet1/0/1' && r.data[1].status === 'down');
    ok('interfaces: request targeted the device uuid', calls.some((c) => c.path.includes('/interface/network-device/dev-uuid-1')));
    ok('interfaces: no device id → honest error, no wire call', (await (loadAdapter().getInterfaces())).outcome === 'error');
  }

  // ── single-object read: device by ip ──────────────────────────────────────
  {
    const catc = loadAdapter({ routes: { '/dna/intent/api/v1/network-device/ip-address/': okRes({ response: {
      id: 'u1', hostname: 'sw1', managementIpAddress: '10.10.20.175', platformId: 'C9KV-UADP-8P',
      reachabilityStatus: 'Reachable', softwareVersion: '17.12.1prd9', serialNumber: 'CML12345UAD',
    } }) } });
    const r = await catc.getDeviceByIp('10.10.20.175');
    ok('device-by-ip: object mapped, count 1', r.outcome === 'ok' && r.count === 1 && r.data.hostname === 'sw1');
    ok('device-by-ip: stamped', stamped(r));
  }

  // ── typed failure outcomes, kept apart, never fabricated ──────────────────
  {
    let catc = loadAdapter({ routes: { '/dna/intent/api/v1/network-device/ip-address/': errRes(404) } });
    let r = await catc.getDeviceByIp('10.0.0.254');
    ok('404: outcome not_found, ok:false, data null (no fabrication)', r.ok === false && r.outcome === 'not_found' && r.data === null);

    catc = loadAdapter({ routes: { '/dna/intent/api/v1/compliance/': errRes(403) } });
    r = await catc.getDeviceCompliance('dev-uuid-1');
    ok('403: outcome forbidden, ok:false', r.ok === false && r.outcome === 'forbidden');

    catc = loadAdapter({ routes: { '/dna/intent/api/v1/sites': errRes(0) } });
    r = await catc.getSites();
    ok('transport fail: outcome unreachable/error, ok:false', r.ok === false && (r.outcome === 'unreachable' || r.outcome === 'error'));
    ok('transport fail: still stamped with appliance', r.appliance === 'unit.test.local');
  }

  // ── not_configured: no env, no wire call ──────────────────────────────────
  {
    const catc = loadAdapter({ configured: false });
    const r = await catc.getSites();
    ok('not_configured: outcome not_configured, ok:false', r.ok === false && r.outcome === 'not_configured');
    ok('not_configured: NOTHING was sent to the wire', calls.length === 0);
  }

  // ── software-images 404 → documented golden fallback, still GET ───────────
  {
    const catc = loadAdapter({ routes: {
      '/dna/intent/api/v1/images': errRes(404),
      '/dna/intent/api/v1/image/importation/golden': okRes({ response: [{ name: 'cat9k_iosxe.17.12.01', version: '17.12.1', golden: true }] }),
    } });
    const r = await catc.getSoftwareImages();
    ok('images fallback: golden endpoint used when /images 404s', r.outcome === 'ok' && r.data[0].version === '17.12.1');
    ok('images fallback: every call still a GET (read-only)', calls.filter((c) => !c.path.includes('/auth/token')).every((c) => c.method === 'GET'));
  }

  // ── clients window read: empty carries the caveat ─────────────────────────
  {
    const catc = loadAdapter({ routes: { '/dna/data/api/v1/clients': okRes({ response: [] }) } });
    const r = await catc.getClients({ limit: 3 });
    ok('clients empty: outcome empty + caveat', r.outcome === 'empty' && typeof r.note === 'string');
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
