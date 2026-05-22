import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { beforeEach, describe, expect, it } from 'vitest';
import { type Db, openDatabase } from '../src/db/index.js';
import { cleanupInvites, consumeInvite, createInvite } from '../src/services/invites.js';

const MIGRATIONS = resolve(fileURLToPath(import.meta.url), '../../drizzle');

function makeDb(): Db {
  const { db } = openDatabase(':memory:');
  migrate(db, { migrationsFolder: MIGRATIONS });
  return db;
}

describe('cleanupInvites', () => {
  let db: Db;

  beforeEach(() => {
    db = makeDb();
  });

  it('deletes invites that have been used', () => {
    const inv = createInvite(db, { scope: 'signup', userId: null, ttlMs: 60_000 });
    expect(consumeInvite(db, inv.token)?.token).toBe(inv.token);
    const n = cleanupInvites(db);
    expect(n).toBe(1);
    // Subsequent consume returns null (row is gone).
    expect(consumeInvite(db, inv.token)).toBeNull();
  });

  it('deletes invites past expiresAt even if unused', () => {
    createInvite(db, { scope: 'signup', userId: null, ttlMs: 60_000 });
    // Pass a "future now" so the unused invite looks expired.
    const future = new Date(Date.now() + 120_000);
    const n = cleanupInvites(db, future);
    expect(n).toBe(1);
  });

  it('leaves valid unused invites alone', () => {
    createInvite(db, { scope: 'signup', userId: null, ttlMs: 60_000 });
    const n = cleanupInvites(db);
    expect(n).toBe(0);
  });
});
