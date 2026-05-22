import type { NodeWebSocket } from '@hono/node-ws';
import { Hono } from 'hono';
import type { AppEnv } from '../app.js';
import type { Db } from '../db/index.js';
import type { Logger } from '../logger.js';
import type { ConnectionRegistry } from '../ws/registry.js';
import { WsSession } from '../ws/session.js';

type WsRouteDeps = {
  db: Db;
  log: Logger;
  registry: ConnectionRegistry;
  upgradeWebSocket: NodeWebSocket['upgradeWebSocket'];
};

export function wsRoute(deps: WsRouteDeps) {
  const route = new Hono<AppEnv>();

  route.get(
    '/',
    deps.upgradeWebSocket(() => {
      let session: WsSession | null = null;
      return {
        onOpen(_event, ws) {
          session = new WsSession(
            { db: deps.db, log: deps.log, registry: deps.registry },
            {
              send: (text) => ws.send(text),
              close: (code, reason) => ws.close(code, reason),
            },
          );
          session.start();
        },
        onMessage(event) {
          session?.onMessage(String(event.data));
        },
        onClose() {
          session?.onClose();
        },
      };
    }),
  );

  return route;
}
