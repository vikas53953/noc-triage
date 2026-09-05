// secrets.public.test.js — the PUBLIC-REPO guard (Vikas, 2026-09-05: "you can
// make it public only, just make sure there is no API key or anything publicly
// visible").
//
// Plain words: this repo is public on purpose. The one rule is that no key,
// password or credential may ever be committed. This suite walks every file
// git tracks and fails the build if a credential-shaped string is in it, and
// it checks that the files that DO hold real values are not tracked at all.
//
// It is deliberately a little paranoid and a little forgiving: hard key formats
// (Anthropic, OpenAI, GitHub, AWS, Slack, private-key blocks) are flagged
// anywhere unless the value plainly says it is fake; generic
// `password = "..."` shapes are flagged outside tests and examples. A false
// positive is cheap (add the value to the fake-markers below); a real key on a
// public repo is not.

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`); }
}

const ROOT = path.join(__dirname, '..');
const tracked = execSync('git ls-files -z', { cwd: ROOT }).toString('utf8').split('\0').filter(Boolean);

// Values that are obviously not real — test fixtures, docs, placeholders.
const FAKE = /(test|mock|fake|example|placeholder|never-real|not-real|not-here|set-in-env|sample|dummy|xxx+|<[^>]*>|\$\{[^}]*\})/i;

// Hard key formats: flagged in ANY tracked file unless the match is plainly fake.
const HARD = [
  ['Anthropic API key', /sk-ant-[A-Za-z0-9_-]{20,}/g],
  ['OpenAI-style key', /\bsk-(?!ant-)[A-Za-z0-9]{32,}\b/g],
  ['GitHub token', /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/g],
  ['AWS access key id', /\bAKIA[0-9A-Z]{16}\b/g],
  ['Slack token', /\bxox[abpr]-[A-Za-z0-9-]{10,}\b/g],
  ['private key block', /-----BEGIN (RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/g],
];
// Generic credential assignments: flagged outside tests / fixtures / examples.
const GENERIC = /\b(password|passwd|pwd|secret|api[_-]?key|token|client[_-]?secret)\b\s*[:=]\s*['"`]([^'"`\s$<>{}]{8,})['"`]/gi;
const isTestish = (f) => /(\.test\.js$|^test\/|\.example$|\.example\.|\.md$|fixture)/i.test(f);

console.log('\nPUBLIC REPO GUARD — no credential may be tracked:\n');

// 1. the files that hold real values must not be tracked
ok('.env.local is not tracked', !tracked.includes('.env.local'));
ok('no .env.* other than .env.example is tracked', tracked.filter((f) => /^\.env(\.|$)/.test(f)).every((f) => f === '.env.example'));
ok('config/mcp-servers.json (real MCP registry, may carry creds) is not tracked', !tracked.includes('config/mcp-servers.json'));
ok('.gitignore covers .env.*, config/mcp-servers.json and squad/', (() => {
  const gi = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  return /\.env\.\*/.test(gi) && /config\/mcp-servers\.json/.test(gi) && /squad\//.test(gi);
})());

// 2. walk every tracked text file
let scanned = 0;
const hits = [];
for (const f of tracked) {
  const full = path.join(ROOT, f);
  if (!fs.existsSync(full)) continue;
  if (/\.(png|jpg|jpeg|gif|mp4|webm|ico|pdf|woff2?|ttf|zip)$/i.test(f)) continue;
  if (f === 'package-lock.json') continue;
  if (f === path.relative(ROOT, __filename).replace(/\\/g, '/')) continue;   // this file names the patterns
  let text;
  try { text = fs.readFileSync(full, 'utf8'); } catch (e) { continue; }
  scanned++;
  for (const [label, re] of HARD) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (FAKE.test(m[0])) continue;
      hits.push(`${f}: ${label} (${m[0].slice(0, 12)}…)`);
    }
  }
  if (!isTestish(f)) {
    GENERIC.lastIndex = 0;
    let m;
    while ((m = GENERIC.exec(text)) !== null) {
      const val = m[2];
      if (FAKE.test(val) || FAKE.test(m[0])) continue;
      // env var NAMES and template refs are not values
      if (/^[A-Z_][A-Z0-9_]*$/.test(val)) continue;
      hits.push(`${f}: ${m[1]} assignment with a literal value (${val.slice(0, 6)}…)`);
    }
  }
}
ok(`scanned every tracked text file (${scanned})`, scanned > 50);
ok('no hard-format key anywhere in the tree', !hits.some((h) => !/assignment/.test(h)), hits.filter((h) => !/assignment/.test(h)).join('; '));
ok('no literal credential assignment outside tests / examples / docs', !hits.some((h) => /assignment/.test(h)), hits.filter((h) => /assignment/.test(h)).join('; '));

// 3. the example files carry placeholders only
const envExample = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
ok('.env.example has no value on ANTHROPIC_API_KEY / DNAC_PASS / ACI_PASS / SDWAN_PASS',
  /^ANTHROPIC_API_KEY=\s*$/m.test(envExample) && /^DNAC_PASS=\s*$/m.test(envExample) && /^ACI_PASS=\s*$/m.test(envExample) && /^SDWAN_PASS=\s*$/m.test(envExample));
const mcpExample = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'mcp-servers.example.json'), 'utf8'));
ok('config/mcp-servers.example.json maps credentials by NAME only', mcpExample.every((s) => Object.values(s.envFrom || {}).every((v) => /^[A-Z_][A-Z0-9_]*$/.test(v))
  && Object.entries(s.env || {}).every(([k, v]) => !/pass|secret|token|key/i.test(k) || FAKE.test(String(v)))));

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
