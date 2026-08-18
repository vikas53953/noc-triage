// QA CLASS 5 — clean error handling, no stack/path leaks.
//
// Two leaks lived on POST /api/command before this fix:
//   • a truthy-but-wrong-typed field ({"agent":"jarvis","command":12345}) slipped
//     the old `if (!agent || !command)` guard and threw downstream — HTTP 500 with
//     a full stack trace and ABSOLUTE file paths in the body.
//   • a malformed JSON body reached body-parser's SyntaxError and Express's default
//     handler answered with the body-parser stack and node_modules paths.
//
// The fix: a type-guard on the route (bad type/shape → clean 400) and ONE global
// Express error handler (last app.use) that logs detail server-side and returns a
// clean, generic, path-free message for everything else.
//
// This boots the real server on an ephemeral port and drives it over HTTP — the
// most faithful regression net for a route + middleware defect. No LLM is exercised
// (every case is rejected before any reasoning), so it runs offline.
const { spawn } = require('child_process');
const http = require('http');

const PORT = 3899;
const ORIGIN = `http://127.0.0.1:${PORT}`;
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`); }
}

// A body leaks internals if it names a source file, an absolute path, a stack
// frame, or a raw error class the client should never see.
function leaks(body) {
  return /\bat\s+[\w.]+\s*\(|\.js:\d+|[A-Za-z]:\\|\/[\w./-]*node_modules|TypeError|SyntaxError|ReferenceError|<pre>/.test(String(body || ''));
}

function post(bodyRaw, contentType = 'application/json') {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: '/api/command', method: 'POST',
      headers: { 'Content-Type': contentType, 'Origin': ORIGIN, 'Content-Length': Buffer.byteLength(bodyRaw) },
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.write(bodyRaw);
    req.end();
  });
}

function waitForUp(tries = 50) {
  return new Promise((resolve, reject) => {
    const attempt = (n) => {
      const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/capabilities', headers: { Origin: ORIGIN } }, (res) => {
        res.resume(); resolve();
      });
      req.on('error', () => (n <= 0 ? reject(new Error('server never came up')) : setTimeout(() => attempt(n - 1), 200)));
    };
    attempt(tries);
  });
}

(async () => {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: require('path').join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' },
    stdio: ['ignore', 'ignore', 'ignore'],
  });

  let exitCode = 1;
  try {
    await waitForUp();
    console.log('\nCLASS 5 — no stack/path leaks, clean status codes:');

    // A) non-string command WITH an agent (the exact 500 leak).
    const a = await post('{"agent":"jarvis","command":12345}');
    ok('non-string command → 400 (not 500)', a.status === 400, `status ${a.status}`);
    ok('non-string command → NO stack/path leak', !leaks(a.body), a.body.slice(0, 200));

    // B) array body.
    const b = await post('["show","version"]');
    ok('array body → 400', b.status === 400, `status ${b.status}`);
    ok('array body → NO leak', !leaks(b.body), b.body.slice(0, 200));

    // C) missing command entirely.
    const c = await post('{"command":12345}');
    ok('missing agent → 400', c.status === 400, `status ${c.status}`);
    ok('missing agent → NO leak', !leaks(c.body), c.body.slice(0, 200));

    // D) malformed JSON (the body-parser stack leak).
    const d = await post('{bad json');
    ok('malformed JSON → 400', d.status === 400, `status ${d.status}`);
    ok('malformed JSON → NO stack/path leak', !leaks(d.body), d.body.slice(0, 200));

    // E) a VALID command still works (no regression).
    const e = await post('{"agent":"jarvis","command":"hello"}');
    ok('valid command → 200', e.status === 200, `status ${e.status}`);
    ok('valid command → success payload', /success/.test(e.body), e.body.slice(0, 200));

    console.log(`\nCLASS 5: ${pass} passed, ${fail} failed`);
    exitCode = fail ? 1 : 0;
  } catch (err) {
    console.log(`  FAIL harness — ${err.message}`);
    exitCode = 1;
  } finally {
    child.kill();
  }
  process.exit(exitCode);
})();
