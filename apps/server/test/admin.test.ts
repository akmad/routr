import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bytesToB64u, generateIdentity, sign } from '@routr/crypto';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import type { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { type AppEnv, createApp } from '../src/app.js';
import { buildSignedRequestString } from '../src/auth.js';
import { type Db, openDatabase } from '../src/db/index.js';
import { createLogger } from '../src/logger.js';
import { registerDevice } from '../src/services/devices.js';

const MIGRATIONS = resolve(fileURLToPath(import.meta.url), '../../drizzle');

function makeTestApp(): { app: Hono<AppEnv>; db: Db } {
  const { db } = openDatabase(':memory:');
  migrate(db, { migrationsFolder: MIGRATIONS });
  const log = createLogger({ logLevel: 'fatal' });
  const { app } = createApp({ db, log, disableRateLimits: true });
  return { app, db };
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
});
