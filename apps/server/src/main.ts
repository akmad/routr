import { serve } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db/index.js';
import { runMigrations } from './db/migrate.js';
import { createLogger } from './logger.js';
import { wsRoute } from './routes/ws.js';

function main(): void {
  const config = loadConfig();
  const log = createLogger(config);

  log.info({ config: { ...config, databaseUrl: config.databaseUrl } }, 'starting routr server');

  runMigrations(config.databaseUrl);
  const { db } = openDatabase(config.databaseUrl);

  const { app, registry } = createApp({ db, log });

  // WebSocket upgrade must be injected before calling serve().
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
  app.route('/api/v1/ws', wsRoute({ db, log, registry, upgradeWebSocket }));

  const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
    log.info({ host: info.address, port: info.port }, 'listening');
  });
  injectWebSocket(server);
}

main();
