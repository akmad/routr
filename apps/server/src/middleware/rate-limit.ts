import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../app.js';

/**
 * Token-bucket rate limiter, per client IP, in-process.
 *
 *   - `capacity` is the max burst (also the starting fill).
 *   - `refillPerSecond` is how fast tokens refill toward capacity.
 *
 * Each request takes one token. If the bucket is empty, the request is
 * rejected with 429. State is held in a Map keyed by IP, with idle
 * entries garbage-collected on touch.
 *
 * This is sufficient for a single-process self-host. For a fleet
 * deployment, swap in a redis-backed limiter.
 */
export type RateLimitOptions = {
  capacity: number;
  refillPerSecond: number;
  /** Header to read client IP from. Defaults to 'x-forwarded-for' then socket. */
  clientIpHeader?: string;
};

type Bucket = { tokens: number; updatedAt: number };

export function rateLimit(opts: RateLimitOptions): MiddlewareHandler<AppEnv> {
  const buckets = new Map<string, Bucket>();
  const { capacity, refillPerSecond } = opts;

  function take(ip: string, now: number): boolean {
    const existing = buckets.get(ip);
    let bucket: Bucket;
    if (!existing) {
      bucket = { tokens: capacity, updatedAt: now };
    } else {
      const dt = (now - existing.updatedAt) / 1000;
      const refilled = Math.min(capacity, existing.tokens + dt * refillPerSecond);
      bucket = { tokens: refilled, updatedAt: now };
    }
    if (bucket.tokens < 1) {
      buckets.set(ip, bucket);
      return false;
    }
    bucket.tokens -= 1;
    buckets.set(ip, bucket);
    return true;
  }

  return async (c, next) => {
    const ipHeader = opts.clientIpHeader ?? 'x-forwarded-for';
    const fwd = c.req.header(ipHeader);
    const ip = fwd?.split(',')[0]?.trim() || 'unknown';
    if (!take(ip, Date.now())) {
      c.header('retry-after', String(Math.ceil(1 / refillPerSecond)));
      c.get('log')?.warn?.({ ip, path: c.req.path }, 'rate limit hit');
      return c.json({ error: 'rate_limited' }, 429);
    }
    await next();
  };
}
