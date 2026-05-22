import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bytesToB64u, generateIdentity, sign } from '@routr/crypto';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import type { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { type AppEnv, createApp } from '../src/app.js';
import { buildSignedRequestString } from '../src/auth.js';
import { type Db, openDatabase } from '../src/db/index.js';
import { createLogger } from '../src/logger.js';

const MIGRATIONS = resolve(fileURLToPath(import.meta.url), '../../drizzle');

type TestApp = Hono<AppEnv>;

function makeTestApp(): { app: TestApp; db: Db } {
  const { db } = openDatabase(':memory:');
  migrate(db, { migrationsFolder: MIGRATIONS });
  const log = createLogger({ logLevel: 'fatal' });
  const { app } = createApp({ db, log, disableRateLimits: true });
  return { app, db };
}

function fakeIdentityRequest(name = 'web') {
  const id = generateIdentity();
  return {
    id,
    body: {
      name,
      platform: 'web',
      identity: {
        signPub: bytesToB64u(id.sign.publicKey),
        kexPub: bytesToB64u(id.kex.publicKey),
      },
    },
  };
}

async function postJson(
  app: TestApp,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return await app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

describe('POST /api/v1/devices', () => {
  let app: TestApp;

  beforeEach(() => {
    app = makeTestApp().app;
  });

  it('registers the first device without an invite', async () => {
    const req = fakeIdentityRequest();
    const res = await postJson(app, '/api/v1/devices', req.body);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { deviceId: string; userId: string };
    expect(body.deviceId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(body.userId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('rejects a second registration without an invite', async () => {
    await postJson(app, '/api/v1/devices', fakeIdentityRequest('first').body);
    const second = await postJson(app, '/api/v1/devices', fakeIdentityRequest('second').body);
    expect(second.status).toBe(403);
    expect(await second.json()).toEqual({ error: 'invite_required' });
  });

  it('rejects re-registration of the same identity key', async () => {
    const dup = fakeIdentityRequest();
    const first = await postJson(app, '/api/v1/devices', dup.body);
    expect(first.status).toBe(201);
    const second = await postJson(app, '/api/v1/devices', dup.body);
    expect(second.status).toBe(400);
    expect(await second.json()).toEqual({ error: 'duplicate_key' });
  });

  it('rejects an invalid body', async () => {
    const res = await postJson(app, '/api/v1/devices', { name: 'x' });
    expect(res.status).toBe(400);
  });

  it('rejects an unknown invite', async () => {
    await postJson(app, '/api/v1/devices', fakeIdentityRequest('first').body);
    const req = fakeIdentityRequest('second');
    const res = await postJson(app, '/api/v1/devices', { ...req.body, invite: 'nope' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invite_invalid' });
  });
});

describe('POST /api/v1/invites + signed-request auth', () => {
  it('rejects unauthenticated requests', async () => {
    const { app } = makeTestApp();
    const res = await postJson(app, '/api/v1/invites', { scope: 'signup', ttl: 3600 });
    expect(res.status).toBe(401);
  });

  it('issues a signup invite when authenticated and lets a new user redeem it', async () => {
    const { app } = makeTestApp();

    // Register the first device.
    const first = fakeIdentityRequest('first');
    const reg = await postJson(app, '/api/v1/devices', first.body);
    expect(reg.status).toBe(201);
    const { deviceId } = (await reg.json()) as { deviceId: string };

    // Issue a signup invite, signed by the first device.
    const body = JSON.stringify({ scope: 'signup', ttl: 3600 });
    const timestamp = String(Date.now());
    const url = new URL('http://x/api/v1/invites');
    const bodyBytes = new TextEncoder().encode(body);
    const sigMessage = buildSignedRequestString(
      'POST',
      url.pathname + url.search,
      timestamp,
      bodyBytes,
    );
    const sigBytes = sign(first.id.sign.secretKey, new TextEncoder().encode(sigMessage));
    const authHeader = `Beam-Sig deviceId="${deviceId}", timestamp="${timestamp}", signature="${bytesToB64u(sigBytes)}"`;

    const inviteRes = await app.request('/api/v1/invites', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: authHeader },
      body,
    });
    expect(inviteRes.status).toBe(201);
    const inv = (await inviteRes.json()) as { token: string };

    // Use that invite to register a brand-new user's first device.
    const second = fakeIdentityRequest('second-user');
    const redeemRes = await postJson(app, '/api/v1/devices', { ...second.body, invite: inv.token });
    expect(redeemRes.status).toBe(201);
    const redeem = (await redeemRes.json()) as { userId: string };
    expect(redeem.userId).not.toBe('');
  });

  it('rejects a signed request with bad signature', async () => {
    const { app } = makeTestApp();
    const first = fakeIdentityRequest('first');
    const reg = await postJson(app, '/api/v1/devices', first.body);
    const { deviceId } = (await reg.json()) as { deviceId: string };

    const body = JSON.stringify({ scope: 'signup', ttl: 3600 });
    const timestamp = String(Date.now());
    // Sign a DIFFERENT body, send the original.
    const bodyBytes = new TextEncoder().encode('{"different":"body"}');
    const sigMessage = buildSignedRequestString('POST', '/api/v1/invites', timestamp, bodyBytes);
    const sigBytes = sign(first.id.sign.secretKey, new TextEncoder().encode(sigMessage));
    const authHeader = `Beam-Sig deviceId="${deviceId}", timestamp="${timestamp}", signature="${bytesToB64u(sigBytes)}"`;
    const res = await app.request('/api/v1/invites', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: authHeader },
      body,
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe('bad_signature');
  });

  it('rejects a replayed signed request with reason: replay', async () => {
    const { app } = makeTestApp();
    const first = fakeIdentityRequest('first');
    const reg = await postJson(app, '/api/v1/devices', first.body);
    const { deviceId } = (await reg.json()) as { deviceId: string };

    const body = JSON.stringify({ scope: 'signup', ttl: 3600 });
    const timestamp = String(Date.now());
    const bodyBytes = new TextEncoder().encode(body);
    const sigMessage = buildSignedRequestString('POST', '/api/v1/invites', timestamp, bodyBytes);
    const sigBytes = sign(first.id.sign.secretKey, new TextEncoder().encode(sigMessage));
    const authHeader = `Beam-Sig deviceId="${deviceId}", timestamp="${timestamp}", signature="${bytesToB64u(sigBytes)}"`;

    // First request: should succeed.
    const ok = await app.request('/api/v1/invites', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: authHeader },
      body,
    });
    expect(ok.status).toBe(201);

    // Same signed request, replayed: should 401 with reason 'replay'.
    const replay = await app.request('/api/v1/invites', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: authHeader },
      body,
    });
    expect(replay.status).toBe(401);
    expect(((await replay.json()) as { error: string }).error).toBe('replay');
  });
});
