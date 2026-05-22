import { Hono } from 'hono';
import type { Db } from './db/index.js';
import type { Logger } from './logger.js';
import { devicesRoute } from './routes/devices.js';
import { invitesRoute } from './routes/invites.js';

export type AppEnv = {
  Variables: {
    db: Db;
    log: Logger;
    deviceId: string;
    userId: string;
  };
};

export type AppDeps = {
  db: Db;
  log: Logger;
};

/**
 * Build the Hono app. Pure factory — no side effects, no globals. This
 * makes the app testable: tests construct an in-memory DB and pass it in.
 */
export function createApp(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    c.set('db', deps.db);
    c.set('log', deps.log);
    await next();
  });

  app.get('/api/v1/health', (c) => {
    return c.json({ ok: true, service: 'routr', version: 1 });
  });

  app.route('/api/v1/devices', devicesRoute);
  app.route('/api/v1/invites', invitesRoute);

  app.notFound((c) => c.json({ error: 'not_found' }, 404));

  app.onError((err, c) => {
    deps.log.error({ err }, 'unhandled error');
    return c.json({ error: 'internal' }, 500);
  });

  return app;
}
