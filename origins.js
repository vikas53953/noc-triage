// origins.js — the ONE list of web pages allowed to talk to this server.
//
// Plain words: without this, any website open in your browser could quietly
// drive your dashboard — send commands, overwrite the task board, read your
// workspace — because the browser attaches to localhost happily.
//
// Default: this machine only. Set ALLOWED_ORIGINS to add more, comma separated.
//   ALLOWED_ORIGINS=https://mission.example.com,https://staging.example.com

function buildAllowlist(port) {
  const fromEnv = String(process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean);

  if (fromEnv.length) return fromEnv;

  const list = [];
  ['http', 'https'].forEach((scheme) => {
    ['localhost', '127.0.0.1', '[::1]'].forEach((host) => {
      list.push(`${scheme}://${host}:${port}`);
    });
  });
  return list;
}

function makeOriginChecker(port) {
  const allowed = buildAllowlist(port);
  const wildcard = allowed.includes('*');

  // No Origin header at all means the request is same-origin or came from a
  // tool like curl — browsers always send it cross-origin, so this is safe to
  // allow and keeps command-line use working.
  function isAllowed(origin) {
    if (!origin) return true;
    if (wildcard) return true;
    return allowed.includes(String(origin).replace(/\/$/, ''));
  }

  return { isAllowed, allowed };
}

module.exports = { makeOriginChecker, buildAllowlist };
