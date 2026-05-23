import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../app.js';

/**
 * Defensive response headers. The server only emits JSON and opaque
 * binary blobs — no user-facing HTML — so the safe minimum is:
 *   - nosniff: browsers must not MIME-sniff blob downloads.
 *   - DENY frame-options: nothing the API returns should ever live in a
 *     frame.
 *   - no-referrer: keeps the server URL out of any outbound Referer
 *     header if a JSON response is somehow followed as a link.
 */
export const securityHeaders: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  c.header('x-content-type-options', 'nosniff');
  c.header('x-frame-options', 'DENY');
  c.header('referrer-policy', 'no-referrer');
};
