import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import type { Db } from './db/index.js';
import type { Logger } from './logger.js';
import { rateLimit } from './middleware/rate-limit.js';
import { NonceStore } from './nonce-store.js';
import { adminRoute } from './routes/admin.js';
import { blobsRoute } from './routes/blobs.js';
import { devicesRoute } from './routes/devices.js';
import { envelopesRoute } from './routes/envelopes.js';
import { invitesRoute } from './routes/invites.js';
import { ConnectionRegistry } from './ws/registry.js';

export type AppEnv = {
  Variables: {
    db: Db;
    log: Logger;
    deviceId: string;
    userId: string;
    nonceStore: NonceStore;
  };
};

export type RateLimitConfig = {
  devicesCapacity: number;
  devicesRefillPerSecond: number;
  envelopesCapacity: number;
  envelopesRefillPerSecond: number;
};

const DEFAULT_RATE_LIMITS: RateLimitConfig = {
  devicesCapacity: 10,
  devicesRefillPerSecond: 0.2, // 1 token / 5s
  envelopesCapacity: 60,
  envelopesRefillPerSecond: 1,
};

export type AppDeps = {
  db: Db;
  log: Logger;
  registry?: ConnectionRegistry;
  blobStorageDir?: string;
  /** When true, skip global rate limits — used by tests that batch-create devices. */
  disableRateLimits?: boolean;
  /** Per-endpoint rate-limit config. Defaults preserve pre-config behavior. */
  rateLimits?: Partial<RateLimitConfig>;
};

/**
 * Build the Hono app. Pure factory — no side effects, no globals. This
 * makes the app testable: tests construct an in-memory DB and pass it in.
 */
export function createApp(deps: AppDeps): { app: Hono<AppEnv>; registry: ConnectionRegistry } {
  const registry = deps.registry ?? new ConnectionRegistry();
  const nonceStore = new NonceStore(5 * 60 * 1000); // 5-min replay window
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    c.set('db', deps.db);
    c.set('log', deps.log);
    c.set('nonceStore', nonceStore);
    await next();
  });

  const startedAt = Date.now();
  app.get('/api/v1/health', (c) => {
    return c.json({
      ok: true,
      service: 'routr',
      version: 1,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    });
  });

  const blobDir = deps.blobStorageDir ?? join(tmpdir(), `routr-blobs-${process.pid}`);

  // Apply per-IP rate limits to the two unauthenticated POST endpoints that
  // would otherwise be enumeration/spam targets. Tests can opt out.
  if (!deps.disableRateLimits) {
    const limits: RateLimitConfig = { ...DEFAULT_RATE_LIMITS, ...deps.rateLimits };
    app.use(
      '/api/v1/devices',
      rateLimit({
        capacity: limits.devicesCapacity,
        refillPerSecond: limits.devicesRefillPerSecond,
      }),
    );
    app.use(
      '/api/v1/envelopes',
      rateLimit({
        capacity: limits.envelopesCapacity,
        refillPerSecond: limits.envelopesRefillPerSecond,
      }),
    );
  }

  app.route('/api/v1/devices', devicesRoute);
  app.route('/api/v1/invites', invitesRoute);
  app.route('/api/v1/envelopes', envelopesRoute(registry));
  app.route('/api/v1/blobs', blobsRoute(blobDir));
  app.route('/api/v1/admin', adminRoute(registry));

  app.notFound((c) => c.json({ error: 'not_found' }, 404));

  app.onError((err, c) => {
    deps.log.error({ err }, 'unhandled error');
    return c.json({ error: 'internal' }, 500);
  });

  return { app, registry };
}
