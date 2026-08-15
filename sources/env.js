// Minimal .env.local loader — no npm dependency, no overwriting of real env vars.
// The repo is PUBLIC: credentials live only in .env.local, which .gitignore covers.
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', '.env.local');
if (fs.existsSync(file)) {
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    const value = m[2].trim().replace(/^['"]|['"]$/g, '');
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

module.exports = { loaded: fs.existsSync(file) };
