import { isNull, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import type { AppEnv } from '../app.js';
import { requireDeviceAuth } from '../auth.js';
import { blobs, devices, envelopes, recipients, users } from '../db/schema.js';
import type { ConnectionRegistry } from '../ws/registry.js';

/**
 * Read-only stats for self-hosters / monitoring. Auth-gated to any device
 * — there's no admin role yet (everyone on a self-hosted Beam is the
 * admin). The info disclosed (counts only, no contents) is intentional.
 */
export function adminRoute(registry: ConnectionRegistry) {
  const route = new Hono<AppEnv>();

  route.get('/stats', requireDeviceAuth, (c) => {
    const db = c.get('db');
    const usersN = db.select({ n: sql<number>`count(*)` }).from(users).get()?.n ?? 0;
    const devicesN = db.select({ n: sql<number>`count(*)` }).from(devices).get()?.n ?? 0;
    const envelopesN = db.select({ n: sql<number>`count(*)` }).from(envelopes).get()?.n ?? 0;
    const blobsN = db.select({ n: sql<number>`count(*)` }).from(blobs).get()?.n ?? 0;
    const pendingN =
      db
        .select({ n: sql<number>`count(*)` })
        .from(recipients)
        .where(isNull(recipients.ackedAt))
        .get()?.n ?? 0;

    return c.json({
      users: usersN,
      devices: devicesN,
      envelopesStored: envelopesN,
      pendingRecipients: pendingN,
      blobs: blobsN,
      onlineConnections: registry.size(),
    });
  });

  return route;
}
