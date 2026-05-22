import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bytesToB64u, generateIdentity } from '@routr/crypto';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/db/index.js';
import { createLogger } from '../src/logger.js';

const MIGRATIONS = resolve(fileURLToPath(import.meta.url), '../../drizzle');

function makeAppWithRateLimits() {
  const { db } = openDatabase(':memory:');
  migrate(db, { migrationsFolder: MIGRATIONS });
  const log = createLogger({ logLevel: 'fatal' });
  // Rate limits enabled (default).
  return createApp({ db, log }).app;
}

function newDeviceBody() {
  const id = generateIdentity();
  return {
    name: 'rate-test',
    platform: 'web',
    identity: {
      signPub: bytesToB64u(id.sign.publicKey),
      kexPub: bytesToB64u(id.kex.publicKey),
    },
  };
}

describe('rate limiting on POST /api/v1/devices', () => {
  it('429s after the configured burst is exhausted', async () => {
    const app = makeAppWithRateLimits();
    const headers = { 'content-type': 'application/json', 'x-forwarded-for': '10.0.0.42' };

    // Capacity is 10 in app.ts. We can't claim all 10 are 201s — only the
    // first is (bootstrap), the rest 403 invite_required — but they all
    // consume tokens. The 11th should be rate-limited (429).
    for (let i = 0; i < 10; i++) {
      const res = await app.request('/api/v1/devices', {
        method: 'POST',
        headers,
        body: JSON.stringify(newDeviceBody()),
      });
      // 201 (first) or 403 (subsequent, invite required) — both consume a token.
      expect([201, 403]).toContain(res.status);
    }

    const blocked = await app.request('/api/v1/devices', {
      method: 'POST',
      headers,
      body: JSON.stringify(newDeviceBody()),
    });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).toBeTruthy();
    expect((await blocked.json()) as { error: string }).toEqual({ error: 'rate_limited' });
  });

  it('tracks per-IP independently', async () => {
    const app = makeAppWithRateLimits();
    // Burn through 10 from IP A.
    for (let i = 0; i < 10; i++) {
      await app.request('/api/v1/devices', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '1.2.3.4' },
        body: JSON.stringify(newDeviceBody()),
      });
    }
    // IP A is now blocked.
    const blocked = await app.request('/api/v1/devices', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '1.2.3.4' },
      body: JSON.stringify(newDeviceBody()),
    });
    expect(blocked.status).toBe(429);

    // IP B should still get through.
    const fresh = await app.request('/api/v1/devices', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '5.6.7.8' },
      body: JSON.stringify(newDeviceBody()),
    });
    expect([201, 403]).toContain(fresh.status); // not 429
  });
});
