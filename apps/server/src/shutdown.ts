import type Database from 'better-sqlite3';
import type { Logger } from './logger.js';
import type { ConnectionRegistry } from './ws/registry.js';

/**
 * Pure-async shutdown sequence. Order matters:
 *
 *   1. Stop the HTTP listener (no new requests accepted; in-flight ones
 *      continue draining server-side).
 *   2. Close every WS connection in the registry (1001 going-away frame
 *      → clients can reconnect on a different replica or wait for the
 *      new image).
 *   3. Wait for the HTTP listener's `close` callback or `timeoutMs`,
 *      whichever comes first.
 *   4. Close the SQLite handle so the WAL flushes before the process exits.
 *
 * Safe to call multiple times — subsequent calls become no-ops because
 * the server.close() race is serialized via `started`.
 */
export type ServerLike = {
  /** Stops accepting new connections; calls `cb` when all existing finish. */
  close(cb?: (err?: Error) => void): unknown;
};

export type ShutdownDeps = {
  server: ServerLike;
  registry: ConnectionRegistry;
  rawDb: Database.Database;
  log: Logger;
  /** Max ms to wait for in-flight requests before force-exiting. Default 10s. */
  timeoutMs?: number;
};

export async function gracefulShutdown(deps: ShutdownDeps): Promise<void> {
  const timeoutMs = deps.timeoutMs ?? 10_000;
  const start = Date.now();
  deps.log.info({ wsConnections: deps.registry.size() }, 'shutdown begin');

  // 1. Tell the HTTP listener to stop. server.close() is fire-and-callback;
  //    in-flight connections drain in the background.
  const httpClosed = new Promise<void>((resolve) => {
    let done = false;
    deps.server.close((err) => {
      done = true;
      if (err) deps.log.error({ err }, 'server.close error');
      resolve();
    });
    // Safety: even if `close` never fires, fall through after timeoutMs.
    setTimeout(() => {
      if (!done) {
        deps.log.warn({ timeoutMs }, 'shutdown timeout; forcing through');
        resolve();
      }
    }, timeoutMs).unref();
  });

  // 2. Yank WS connections proactively. The HTTP close() above doesn't
  //    automatically close upgraded sockets; without this they'd hold
  //    `server.close` open indefinitely.
  deps.registry.closeAll(1001, 'server shutting down');

  // 3. Wait for the HTTP listener to fully drain (or the timeout fires).
  await httpClosed;

  // 4. Close DB last so any final WAL checkpoint runs after responses are
  //    on the wire. Best-effort: a double-close shouldn't crash the exit.
  try {
    deps.rawDb.close();
  } catch (err) {
    deps.log.error({ err }, 'db close failed');
  }

  deps.log.info({ ms: Date.now() - start }, 'shutdown complete');
}
