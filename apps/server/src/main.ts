import { serve } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db/index.js';
import { runMigrations } from './db/migrate.js';
import { createLogger } from './logger.js';
import { wsRoute } from './routes/ws.js';
import { cleanupOldBlobs, pruneOrphanedBlobs } from './services/blobs.js';
import { cleanupExpiredEnvelopes } from './services/envelopes.js';
import { cleanupInvites } from './services/invites.js';

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
  const ENV_CLEANUP_MS = 5 * 60 * 1000;
  setInterval(() => {
    try {
      const n = cleanupExpiredEnvelopes(db);
      if (n > 0) log.info({ deleted: n }, 'swept expired envelopes');
    } catch (err) {
      log.error({ err }, 'envelope cleanup failed');
    }
  }, ENV_CLEANUP_MS).unref();

  // Sweep old blobs once an hour (default 7-day max age inside the helper).
  // Quieter cadence because each pass touches the filesystem.
  const BLOB_CLEANUP_MS = 60 * 60 * 1000;
  setInterval(() => {
    cleanupOldBlobs(db, config.blobStorageDir)
      .then((n) => {
        if (n > 0) log.info({ deleted: n }, 'swept old blobs');
      })
      .catch((err) => log.error({ err }, 'blob cleanup failed'));
  }, BLOB_CLEANUP_MS).unref();

  // Sweep orphaned blob files once an hour — files on disk with no DB
  // row, leftover from prior unlink failures or DB restores. The helper
  // skips anything modified in the last hour to avoid racing in-flight
  // uploads.
  const BLOB_ORPHAN_MS = 60 * 60 * 1000;
  setInterval(() => {
    pruneOrphanedBlobs(db, config.blobStorageDir)
      .then((n) => {
        if (n > 0) log.info({ deleted: n }, 'pruned orphaned blob files');
      })
      .catch((err) => log.error({ err }, 'orphan blob prune failed'));
  }, BLOB_ORPHAN_MS).unref();

  // Sweep used/expired invites once an hour. Used invites are single-shot;
  // expired-but-unused ones are dead.
  const INVITE_CLEANUP_MS = 60 * 60 * 1000;
  setInterval(() => {
    try {
      const n = cleanupInvites(db);
      if (n > 0) log.info({ deleted: n }, 'swept old invites');
    } catch (err) {
      log.error({ err }, 'invite cleanup failed');
    }
  }, INVITE_CLEANUP_MS).unref();
}

main();
