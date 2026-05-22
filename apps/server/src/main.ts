import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db/index.js';
import { runMigrations } from './db/migrate.js';
import { createLogger } from './logger.js';

function main(): void {
  const config = loadConfig();
  const log = createLogger(config);

  log.info({ config: { ...config, databaseUrl: config.databaseUrl } }, 'starting routr server');

  runMigrations(config.databaseUrl);
  const { db } = openDatabase(config.databaseUrl);

  const app = createApp({ db, log });

  serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
    log.info({ host: info.address, port: info.port }, 'listening');
  });
}

main();
