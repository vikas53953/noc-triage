// Shared HTTPS helper for every sandbox adapter.
// The DevNet sandboxes use self-signed certs, so cert checking is relaxed per
// request rather than globally — a global NODE_TLS_REJECT_UNAUTHORIZED would
// weaken every other outbound call this server makes.
const https = require('https');
const session = require('./session-log');

const DEFAULT_TIMEOUT = 30000;

function request(opts, body) {
  // Every real wire call is recorded for the CLI/session view (Phase B). The
  // request BODY is deliberately NOT passed to the recorder — login bodies carry
  // passwords, so only the method + path (the "command") and the RAW response
  // are ever captured. Timing wraps the whole call.
  const started = Date.now();
  return rawRequest(opts, body).then((res) => {
    try {
      session.record({ host: opts.host, method: opts.method || 'GET', path: opts.path, res, durationMs: Date.now() - started });
    } catch (e) { /* telemetry must never break a live read */ }
    return res;
  });
}

function rawRequest(opts, body) {
  // DELIBERATE: certificate checking is ON by default and only relaxed when a
  // caller passes verifyTls: false. The Cisco DevNet always-on sandboxes serve
  // self-signed certificates, so the sandbox adapters set that flag on purpose.
  // Never set it for a customer's real kit — the credentials would cross the
  // wire unverified.
  const agent = new https.Agent({ rejectUnauthorized: opts.verifyTls !== false, keepAlive: true });

  return new Promise((resolve) => {
    const req = https.request({
      host: opts.host,
      port: opts.port || 443,
      path: opts.path,
      method: opts.method || 'GET',
      headers: opts.headers || {},
      agent,
      timeout: opts.timeout || DEFAULT_TIMEOUT,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ ok: res.statusCode < 400, status: res.statusCode, body: data, headers: res.headers }));
    });

    req.on('error', (err) => resolve({ ok: false, error: err.code || err.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });

    if (body) req.write(body);
    req.end();
  });
}

// Same as request(), but parses JSON and never throws on bad JSON.
async function requestJson(opts, body) {
  const res = await request(opts, body);
  if (!res.ok) return res;
  try {
    return { ...res, json: JSON.parse(res.body) };
  } catch (e) {
    return { ...res, ok: false, error: 'response was not JSON' };
  }
}

const basicAuth = (user, pass) => 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');

module.exports = { request, requestJson, basicAuth };
