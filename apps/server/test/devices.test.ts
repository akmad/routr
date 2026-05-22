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

describe('GET /api/v1/devices/:id', () => {
  it('requires auth', async () => {
    const { app } = makeTestApp();
    const res = await app.request('/api/v1/devices/01HXXXXXXXXXXXXXXXXXXXXXXX');
    expect(res.status).toBe(401);
  });

  it('returns own device public metadata (no userId leak)', async () => {
    const { app } = makeTestApp();
    const me = fakeIdentityRequest('me');
    const reg = await postJson(app, '/api/v1/devices', me.body);
    const { deviceId } = (await reg.json()) as { deviceId: string };
    const ts = String(Date.now());
    const path = `/api/v1/devices/${deviceId}`;
    const sigInput = buildSignedRequestString('GET', path, ts, new Uint8Array(0));
    const sigBytes = sign(me.id.sign.secretKey, new TextEncoder().encode(sigInput));
    const res = await app.request(path, {
      headers: {
        authorization: `Beam-Sig deviceId="${deviceId}", timestamp="${ts}", signature="${bytesToB64u(sigBytes)}"`,
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.id).toBe(deviceId);
    expect(body.userId).toBeUndefined();
    expect(body.name).toBe('me');
    expect(body.platform).toBe('web');
  });

  it('returns 404 for a different user’s device', async () => {
    const { app } = makeTestApp();
    // User A bootstraps.
    const a = fakeIdentityRequest('a');
    const regA = await postJson(app, '/api/v1/devices', a.body);
    const { deviceId: aId } = (await regA.json()) as { deviceId: string };

    // A creates a signup invite for a new user B.
    const inviteBody = JSON.stringify({ scope: 'signup', ttl: 3600 });
    const inviteTs = String(Date.now());
    const inviteSig = buildSignedRequestString(
      'POST',
      '/api/v1/invites',
      inviteTs,
      new TextEncoder().encode(inviteBody),
    );
    const inviteSigBytes = sign(a.id.sign.secretKey, new TextEncoder().encode(inviteSig));
    const inv = await app.request('/api/v1/invites', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Beam-Sig deviceId="${aId}", timestamp="${inviteTs}", signature="${bytesToB64u(inviteSigBytes)}"`,
      },
      body: inviteBody,
    });
    const { token } = (await inv.json()) as { token: string };

    const b = fakeIdentityRequest('b');
    const regB = await postJson(app, '/api/v1/devices', { ...b.body, invite: token });
    const { deviceId: bId } = (await regB.json()) as { deviceId: string };

    // User A tries to GET user B's device — should 404.
    const ts = String(Date.now());
    const path = `/api/v1/devices/${bId}`;
    const sigInput = buildSignedRequestString('GET', path, ts, new Uint8Array(0));
    const sigBytes = sign(a.id.sign.secretKey, new TextEncoder().encode(sigInput));
    const res = await app.request(path, {
      headers: {
        authorization: `Beam-Sig deviceId="${aId}", timestamp="${ts}", signature="${bytesToB64u(sigBytes)}"`,
      },
    });
    expect(res.status).toBe(404);
  });

  it('regression: bad-signature attempts do NOT consume the replay-defense nonce', async () => {
    const { app } = makeTestApp();
    const me = fakeIdentityRequest('me');
    const reg = await postJson(app, '/api/v1/devices', me.body);
    const { deviceId } = (await reg.json()) as { deviceId: string };

    const path = `/api/v1/devices/${deviceId}`;
    const ts = String(Date.now());

    // Attacker sends a garbage signature for (deviceId, ts).
    const attackerRes = await app.request(path, {
      headers: {
        authorization: `Beam-Sig deviceId="${deviceId}", timestamp="${ts}", signature="${bytesToB64u(new Uint8Array(64))}"`,
      },
    });
    expect(attackerRes.status).toBe(401);
    expect(((await attackerRes.json()) as { error: string }).error).toBe('bad_signature');

    // Victim's legitimate request at the same timestamp must NOT be rejected
    // as 'replay' — the nonce must only be consumed on verified signatures.
    const sigInput = buildSignedRequestString('GET', path, ts, new Uint8Array(0));
    const sigBytes = sign(me.id.sign.secretKey, new TextEncoder().encode(sigInput));
    const victimRes = await app.request(path, {
      headers: {
        authorization: `Beam-Sig deviceId="${deviceId}", timestamp="${ts}", signature="${bytesToB64u(sigBytes)}"`,
      },
    });
    expect(victimRes.status).toBe(200);
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

describe('DELETE /api/v1/devices/:id (revoke)', () => {
  async function signedDelete(
    app: TestApp,
    revokerIdentity: ReturnType<typeof fakeIdentityRequest>['id'],
    revokerDeviceId: string,
    targetDeviceId: string,
  ) {
    const path = `/api/v1/devices/${targetDeviceId}`;
    const ts = String(Date.now());
    const sigMessage = buildSignedRequestString('DELETE', path, ts, new Uint8Array(0));
    const sigBytes = sign(revokerIdentity.sign.secretKey, new TextEncoder().encode(sigMessage));
    return app.request(path, {
      method: 'DELETE',
      headers: {
        authorization: `Beam-Sig deviceId="${revokerDeviceId}", timestamp="${ts}", signature="${bytesToB64u(sigBytes)}"`,
      },
    });
  }

  it('a device of the same user can revoke another device', async () => {
    const { app } = makeTestApp();
    // Device 1: bootstrap.
    const dev1 = fakeIdentityRequest('dev1');
    const reg1 = await postJson(app, '/api/v1/devices', dev1.body);
    const { deviceId: devId1 } = (await reg1.json()) as { deviceId: string };

    // Device 1 issues a pair_device invite for itself.
    const body = JSON.stringify({ scope: 'pair_device', ttl: 3600 });
    const ts1 = String(Date.now());
    const sigMessage = buildSignedRequestString(
      'POST',
      '/api/v1/invites',
      ts1,
      new TextEncoder().encode(body),
    );
    const sigBytes = sign(dev1.id.sign.secretKey, new TextEncoder().encode(sigMessage));
    const inviteRes = await app.request('/api/v1/invites', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Beam-Sig deviceId="${devId1}", timestamp="${ts1}", signature="${bytesToB64u(sigBytes)}"`,
      },
      body,
    });
    const { token } = (await inviteRes.json()) as { token: string };

    // Device 2 joins via the invite.
    const dev2 = fakeIdentityRequest('dev2');
    const reg2 = await postJson(app, '/api/v1/devices', { ...dev2.body, invite: token });
    const { deviceId: devId2 } = (await reg2.json()) as { deviceId: string };

    // Device 1 revokes device 2.
    const res = await signedDelete(app, dev1.id, devId1, devId2);
    expect(res.status).toBe(200);

    // Device 2 can no longer authenticate.
    const body2 = JSON.stringify({ scope: 'pair_device', ttl: 3600 });
    const ts2 = String(Date.now() + 1); // distinct timestamp to avoid replay
    const sigMessage2 = buildSignedRequestString(
      'POST',
      '/api/v1/invites',
      ts2,
      new TextEncoder().encode(body2),
    );
    const sigBytes2 = sign(dev2.id.sign.secretKey, new TextEncoder().encode(sigMessage2));
    const stale = await app.request('/api/v1/invites', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Beam-Sig deviceId="${devId2}", timestamp="${ts2}", signature="${bytesToB64u(sigBytes2)}"`,
      },
      body: body2,
    });
    expect(stale.status).toBe(401);
    expect(((await stale.json()) as { error: string }).error).toBe('unknown_device');
  });

  it('refuses self-revoke', async () => {
    const { app } = makeTestApp();
    const dev1 = fakeIdentityRequest('dev1');
    const reg1 = await postJson(app, '/api/v1/devices', dev1.body);
    const { deviceId: devId1 } = (await reg1.json()) as { deviceId: string };

    const res = await signedDelete(app, dev1.id, devId1, devId1);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('self_revoke');
  });

  it('refuses cross-user revoke', async () => {
    const { app } = makeTestApp();
    // Two completely separate users (each is a fresh bootstrap on a fresh app
    // ... but we can't bootstrap twice on the same server, so we go through
    // invite + register as a new user).
    const dev1 = fakeIdentityRequest('dev1');
    const reg1 = await postJson(app, '/api/v1/devices', dev1.body);
    const { deviceId: devId1 } = (await reg1.json()) as { deviceId: string };

    // dev1 issues a SIGNUP invite (new user).
    const inviteBody = JSON.stringify({ scope: 'signup', ttl: 3600 });
    const ts = String(Date.now());
    const sigMessage = buildSignedRequestString(
      'POST',
      '/api/v1/invites',
      ts,
      new TextEncoder().encode(inviteBody),
    );
    const sigBytes = sign(dev1.id.sign.secretKey, new TextEncoder().encode(sigMessage));
    const inviteRes = await app.request('/api/v1/invites', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Beam-Sig deviceId="${devId1}", timestamp="${ts}", signature="${bytesToB64u(sigBytes)}"`,
      },
      body: inviteBody,
    });
    const { token } = (await inviteRes.json()) as { token: string };

    // dev2 is a new user.
    const dev2 = fakeIdentityRequest('dev2');
    const reg2 = await postJson(app, '/api/v1/devices', { ...dev2.body, invite: token });
    const { deviceId: devId2 } = (await reg2.json()) as { deviceId: string };

    // dev1 (user A) tries to revoke dev2 (user B). Should be forbidden.
    const res = await signedDelete(app, dev1.id, devId1, devId2);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('cross_user');
  });
});
