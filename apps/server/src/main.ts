import { serve } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db/index.js';
import { runMigrations } from './db/migrate.js';
import { createLogger } from './logger.js';
import { wsRoute } from './routes/ws.js';
import { cleanupExpiredEnvelopes } from './services/envelopes.js';

function main(): void {
  const config = loadConfig();
  const log = createLogger(config);

  log.info({ config: { ...config, databaseUrl: config.databaseUrl } }, 'starting routr server');

  runMigrations(config.databaseUrl);
  const { db } = openDatabase(config.databaseUrl);

  const { app, registry } = createApp({ db, log, blobStorageDir: config.blobStorageDir });

  // WebSocket upgrade must be injected before calling serve().
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
  app.route('/api/v1/ws', wsRoute({ db, log, registry, upgradeWebSocket }));

  const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
    log.info({ host: info.address, port: info.port }, 'listening');
  });
  injectWebSocket(server);

  // Sweep expired envelopes every 5 minutes. Cheap query on a small table;
  // no foreground impact.
  const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
  setInterval(() => {
    try {
      const n = cleanupExpiredEnvelopes(db);
      if (n > 0) log.info({ deleted: n }, 'swept expired envelopes');
    } catch (err) {
      log.error({ err }, 'envelope cleanup failed');
    }
  }, CLEANUP_INTERVAL_MS).unref();
}

main();
