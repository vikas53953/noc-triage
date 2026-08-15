// ratelimit.js — a small in-memory rate limiter. No dependency needed for this.
//
// Why it exists: the command and debate routes reach out to Cisco's shared
// DevNet sandboxes using our credentials. One caller looping a POST would get
// the account throttled or banned. This caps how fast anyone can push.

const WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60000);

// key -> { count, resetAt }
const buckets = new Map();

function hit(key, max, windowMs = WINDOW_MS) {
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || now >= bucket.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: max - 1, retryAfter: 0 };
  }

  bucket.count += 1;
  if (bucket.count > max) {
    return { allowed: false, remaining: 0, retryAfter: Math.ceil((bucket.resetAt - now) / 1000) };
  }
  return { allowed: true, remaining: max - bucket.count, retryAfter: 0 };
}

// Drop expired buckets now and then so this cannot grow forever.
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (now >= bucket.resetAt) buckets.delete(key);
  }
}, WINDOW_MS);
if (typeof sweeper.unref === 'function') sweeper.unref();

/**
 * Express middleware factory.
 * @param {object} opts { max, windowMs, name }
 */
function limiter({ max, windowMs = WINDOW_MS, name = 'api' } = {}) {
  return function rateLimitMiddleware(req, res, next) {
    const who = req.ip || req.socket?.remoteAddress || 'unknown';
    const result = hit(`${name}:${who}`, max, windowMs);
    if (!result.allowed) {
      res.set('Retry-After', String(result.retryAfter));
      return res.status(429).json({ error: 'Too many requests — slow down.' });
    }
    res.set('X-RateLimit-Remaining', String(result.remaining));
    next();
  };
}

// Same budget, for WebSocket chat messages (which reach the same live sources).
function allowSocketMessage(key, max = Number(process.env.RATE_LIMIT_WS || 60), windowMs = WINDOW_MS) {
  return hit(`ws:${key}`, max, windowMs).allowed;
}

module.exports = { limiter, allowSocketMessage, hit };
