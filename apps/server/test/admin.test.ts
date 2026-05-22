import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bytesToB64u, generateIdentity, sign } from '@routr/crypto';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import type { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { type AppEnv, createApp } from '../src/app.js';
import { buildSignedRequestString } from '../src/auth.js';
import { type Db, openDatabase } from '../src/db/index.js';
import { envelopes as envelopesTable, recipients as recipientsTable } from '../src/db/schema.js';
import { newId } from '../src/ids.js';
import { createLogger } from '../src/logger.js';
import { registerDevice } from '../src/services/devices.js';
import { ConnectionRegistry } from '../src/ws/registry.js';

const MIGRATIONS = resolve(fileURLToPath(import.meta.url), '../../drizzle');

function makeTestApp(opts: { registry?: ConnectionRegistry } = {}): {
  app: Hono<AppEnv>;
  db: Db;
  registry: ConnectionRegistry;
} {
  const { db } = openDatabase(':memory:');
  migrate(db, { migrationsFolder: MIGRATIONS });
  const log = createLogger({ logLevel: 'fatal' });
  const registry = opts.registry ?? new ConnectionRegistry();
  const { app } = createApp({ db, log, registry, disableRateLimits: true });
  return { app, db, registry };
}

function signedHeaders(
  identity: ReturnType<typeof generateIdentity>,
  deviceId: string,
  path: string,
): Record<string, string> {
  const ts = String(Date.now());
  const sigInput = buildSignedRequestString('GET', path, ts, new Uint8Array(0));
  const sigBytes = sign(identity.sign.secretKey, new TextEncoder().encode(sigInput));
  return {
    authorization: `Beam-Sig deviceId="${deviceId}", timestamp="${ts}", signature="${bytesToB64u(sigBytes)}"`,
  };
}

describe('GET /api/v1/admin/stats', () => {
  it('requires auth', async () => {
    const { app } = makeTestApp();
    const res = await app.request('/api/v1/admin/stats');
    expect(res.status).toBe(401);
  });

  it('returns counts for an authenticated device', async () => {
    const { app, db } = makeTestApp();
    const id = generateIdentity();
    const reg = registerDevice(db, {
      name: 'admin',
      platform: 'web',
      signPub: bytesToB64u(id.sign.publicKey),
      kexPub: bytesToB64u(id.kex.publicKey),
    });
    if (!reg.ok) throw new Error('setup');

    const ts = String(Date.now());
    const sigInput = buildSignedRequestString('GET', '/api/v1/admin/stats', ts, new Uint8Array(0));
    const sigBytes = sign(id.sign.secretKey, new TextEncoder().encode(sigInput));
    const res = await app.request('/api/v1/admin/stats', {
      method: 'GET',
      headers: {
        authorization: `Beam-Sig deviceId="${reg.deviceId}", timestamp="${ts}", signature="${bytesToB64u(sigBytes)}"`,
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      users: number;
      devices: number;
      envelopesStored: number;
      pendingRecipients: number;
      blobs: number;
      onlineConnections: number;
    };
    expect(body.users).toBe(1);
    expect(body.devices).toBe(1);
    expect(body.envelopesStored).toBe(0);
    expect(body.pendingRecipients).toBe(0);
    expect(body.blobs).toBe(0);
    expect(body.onlineConnections).toBe(0);
  });

  it('reports onlineDevices and onlineConnections separately', async () => {
    const { app, db, registry } = makeTestApp();
    const id = generateIdentity();
    const reg = registerDevice(db, {
      name: 'admin',
      platform: 'web',
      signPub: bytesToB64u(id.sign.publicKey),
      kexPub: bytesToB64u(id.kex.publicKey),
    });
    if (!reg.ok) throw new Error('setup');

    // Two connections from the same device (e.g. two browser tabs) and one
    // from a different device. Expect onlineDevices=2, onlineConnections=3.
    registry.add({ deviceId: reg.deviceId, send: () => {}, close: () => {} });
    registry.add({ deviceId: reg.deviceId, send: () => {}, close: () => {} });
    registry.add({ deviceId: 'OTHERDEVICEID0000000000000', send: () => {}, close: () => {} });

    const res = await app.request('/api/v1/admin/stats', {
      headers: signedHeaders(id, reg.deviceId, '/api/v1/admin/stats'),
    });
    const body = (await res.json()) as { onlineDevices: number; onlineConnections: number };
    expect(body.onlineDevices).toBe(2);
    expect(body.onlineConnections).toBe(3);
  });

  it('reports oldestPendingAt as the createdAt of the earliest unacked recipient', async () => {
    const { app, db } = makeTestApp();
    const id = generateIdentity();
    const reg = registerDevice(db, {
      name: 'admin',
      platform: 'web',
      signPub: bytesToB64u(id.sign.publicKey),
      kexPub: bytesToB64u(id.kex.publicKey),
    });
    if (!reg.ok) throw new Error('setup');

    // Insert two envelopes; the older one stays pending, the newer one is
    // acked. oldestPendingAt should equal the older envelope's createdAt.
    const oldEnvId = newId();
    const newEnvId = newId();
    const oldAt = new Date(Date.now() - 10 * 60 * 1000); // 10 min ago
    const newAt = new Date(Date.now() - 1 * 60 * 1000); // 1 min ago

    for (const [envId, at] of [
      [oldEnvId, oldAt],
      [newEnvId, newAt],
    ] as const) {
      db.insert(envelopesTable)
        .values({
          id: envId,
          fromDevice: reg.deviceId,
          createdAt: at,
          expiresAt: new Date(Date.now() + 86400_000),
          kind: 'url',
          size: 0,
          ciphertext: '',
          senderEphemeralPub: '',
          signature: `sig-${envId}`,
        })
        .run();
    }
    // Old envelope: unacked recipient.
    db.insert(recipientsTable)
      .values({ envelopeId: oldEnvId, deviceId: reg.deviceId, wrappedKey: '', ackedAt: null })
      .run();
    // New envelope: acked recipient — should not contribute to oldestPendingAt.
    db.insert(recipientsTable)
      .values({ envelopeId: newEnvId, deviceId: reg.deviceId, wrappedKey: '', ackedAt: new Date() })
      .run();

    const res = await app.request('/api/v1/admin/stats', {
      headers: signedHeaders(id, reg.deviceId, '/api/v1/admin/stats'),
    });
    const body = (await res.json()) as {
      pendingRecipients: number;
      oldestPendingAt: number | null;
    };
    expect(body.pendingRecipients).toBe(1);
    expect(body.oldestPendingAt).toBe(oldAt.getTime());
  });

  it('oldestPendingAt is null when nothing is pending', async () => {
    const { app, db } = makeTestApp();
    const id = generateIdentity();
    const reg = registerDevice(db, {
      name: 'admin',
      platform: 'web',
      signPub: bytesToB64u(id.sign.publicKey),
      kexPub: bytesToB64u(id.kex.publicKey),
    });
    if (!reg.ok) throw new Error('setup');

    const res = await app.request('/api/v1/admin/stats', {
      headers: signedHeaders(id, reg.deviceId, '/api/v1/admin/stats'),
    });
    const body = (await res.json()) as { oldestPendingAt: number | null };
    expect(body.oldestPendingAt).toBeNull();
  });
});
