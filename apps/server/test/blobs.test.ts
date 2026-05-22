import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bytesToB64u, generateIdentity, sign } from '@routr/crypto';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type AppEnv, createApp } from '../src/app.js';
import { buildSignedRequestString } from '../src/auth.js';
import { type Db, openDatabase } from '../src/db/index.js';
import { createLogger } from '../src/logger.js';
import { registerDevice } from '../src/services/devices.js';

const MIGRATIONS = resolve(fileURLToPath(import.meta.url), '../../drizzle');

type TestApp = Hono<AppEnv>;

function makeTestApp(): { app: TestApp; db: Db; blobDir: string } {
  const { db } = openDatabase(':memory:');
  migrate(db, { migrationsFolder: MIGRATIONS });
  const log = createLogger({ logLevel: 'fatal' });
  const blobDir = mkdtempSync(join(tmpdir(), 'routr-blob-test-'));
  const { app } = createApp({ db, log, blobStorageDir: blobDir, disableRateLimits: true });
  return { app, db, blobDir };
}

function makeDevice(db: Db) {
  const id = generateIdentity();
  const r = registerDevice(db, {
    name: 'tester',
    platform: 'web',
    signPub: bytesToB64u(id.sign.publicKey),
    kexPub: bytesToB64u(id.kex.publicKey),
  });
  if (!r.ok) throw new Error(`registration failed: ${r.reason}`);
  return { identity: id, deviceId: r.deviceId };
}

function signedHeaders(
  identity: ReturnType<typeof generateIdentity>,
  deviceId: string,
  method: string,
  path: string,
  body: Uint8Array,
): Record<string, string> {
  const ts = String(Date.now());
  const sigInput = buildSignedRequestString(method, path, ts, body);
  const sigBytes = sign(identity.sign.secretKey, new TextEncoder().encode(sigInput));
  return {
    authorization: `Beam-Sig deviceId="${deviceId}", timestamp="${ts}", signature="${bytesToB64u(sigBytes)}"`,
  };
}

describe('POST /api/v1/blobs + GET /api/v1/blobs/:id', () => {
  let app: TestApp;
  let db: Db;
  let blobDir: string;

  beforeEach(() => {
    const t = makeTestApp();
    app = t.app;
    db = t.db;
    blobDir = t.blobDir;
  });

  afterEach(() => {
    rmSync(blobDir, { recursive: true, force: true });
  });

  it('uploads, downloads, and verifies sha256 round-trip', async () => {
    const { identity, deviceId } = makeDevice(db);
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const sha = createHash('sha256').update(bytes).digest('hex');

    const postRes = await app.request('/api/v1/blobs', {
      method: 'POST',
      headers: {
        'x-beam-sha256': sha,
        'content-type': 'application/octet-stream',
        ...signedHeaders(identity, deviceId, 'POST', '/api/v1/blobs', bytes),
      },
      body: bytes,
    });
    expect(postRes.status).toBe(201);
    const meta = (await postRes.json()) as { id: string; size: number; sha256: string };
    expect(meta.size).toBe(10);
    expect(meta.sha256).toBe(sha);

    const path = `/api/v1/blobs/${meta.id}`;
    const getRes = await app.request(path, {
      method: 'GET',
      headers: signedHeaders(identity, deviceId, 'GET', path, new Uint8Array(0)),
    });
    expect(getRes.status).toBe(200);
    expect(getRes.headers.get('x-beam-sha256')).toBe(sha);
    const downloaded = new Uint8Array(await getRes.arrayBuffer());
    expect(Array.from(downloaded)).toEqual(Array.from(bytes));
  });

  it('rejects sha256 mismatch', async () => {
    const { identity, deviceId } = makeDevice(db);
    const bytes = new Uint8Array([1, 2, 3]);
    const wrongSha = 'a'.repeat(64);

    const res = await app.request('/api/v1/blobs', {
      method: 'POST',
      headers: {
        'x-beam-sha256': wrongSha,
        'content-type': 'application/octet-stream',
        ...signedHeaders(identity, deviceId, 'POST', '/api/v1/blobs', bytes),
      },
      body: bytes,
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toEqual({ error: 'sha256_mismatch' });
  });

  it('rejects missing sha256 header', async () => {
    const { identity, deviceId } = makeDevice(db);
    const bytes = new Uint8Array([1, 2, 3]);

    const res = await app.request('/api/v1/blobs', {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        ...signedHeaders(identity, deviceId, 'POST', '/api/v1/blobs', bytes),
      },
      body: bytes,
    });
    expect(res.status).toBe(400);
  });

  it('rejects empty body', async () => {
    const { identity, deviceId } = makeDevice(db);
    const sha = createHash('sha256').update(new Uint8Array(0)).digest('hex');
    const res = await app.request('/api/v1/blobs', {
      method: 'POST',
      headers: {
        'x-beam-sha256': sha,
        'content-type': 'application/octet-stream',
        ...signedHeaders(identity, deviceId, 'POST', '/api/v1/blobs', new Uint8Array(0)),
      },
      body: '',
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toEqual({ error: 'empty_body' });
  });

  it('rejects unauthenticated upload', async () => {
    const sha = 'a'.repeat(64);
    const res = await app.request('/api/v1/blobs', {
      method: 'POST',
      headers: { 'x-beam-sha256': sha, 'content-type': 'application/octet-stream' },
      body: new Uint8Array([1, 2, 3]),
    });
    expect(res.status).toBe(401);
  });

  it('returns 404 for unknown blob ID', async () => {
    const { identity, deviceId } = makeDevice(db);
    const path = '/api/v1/blobs/01JZZZZZZZZZZZZZZZZZZZZZZZ';
    const res = await app.request(path, {
      method: 'GET',
      headers: signedHeaders(identity, deviceId, 'GET', path, new Uint8Array(0)),
    });
    expect(res.status).toBe(404);
  });

  it('HEAD returns metadata headers without body', async () => {
    const { identity, deviceId } = makeDevice(db);
    const bytes = new Uint8Array([9, 8, 7, 6]);
    const sha = createHash('sha256').update(bytes).digest('hex');

    const postRes = await app.request('/api/v1/blobs', {
      method: 'POST',
      headers: {
        'x-beam-sha256': sha,
        'content-type': 'application/octet-stream',
        ...signedHeaders(identity, deviceId, 'POST', '/api/v1/blobs', bytes),
      },
      body: bytes,
    });
    const { id } = (await postRes.json()) as { id: string };

    const headPath = `/api/v1/blobs/${id}`;
    const headRes = await app.request(headPath, {
      method: 'HEAD',
      headers: signedHeaders(identity, deviceId, 'HEAD', headPath, new Uint8Array(0)),
    });
    expect(headRes.status).toBe(200);
    expect(headRes.headers.get('x-beam-sha256')).toBe(sha);
    expect(headRes.headers.get('content-length')).toBe('4');
  });
});

describe('cleanupOldBlobs', () => {
  let app: TestApp;
  let db: Db;
  let blobDir: string;

  beforeEach(() => {
    const t = makeTestApp();
    app = t.app;
    db = t.db;
    blobDir = t.blobDir;
  });

  afterEach(() => {
    rmSync(blobDir, { recursive: true, force: true });
  });

  it('removes blobs whose uploadedAt is older than maxAgeMs', async () => {
    const { cleanupOldBlobs } = await import('../src/services/blobs.js');
    const { identity, deviceId } = makeDevice(db);
    const bytes = new Uint8Array([1, 2, 3]);
    const sha = createHash('sha256').update(bytes).digest('hex');
    const res = await app.request('/api/v1/blobs', {
      method: 'POST',
      headers: {
        'x-beam-sha256': sha,
        'content-type': 'application/octet-stream',
        ...signedHeaders(identity, deviceId, 'POST', '/api/v1/blobs', bytes),
      },
      body: bytes,
    });
    expect(res.status).toBe(201);

    // maxAgeMs = -1000 → cutoff is 1s in the future, so any present-or-past
    // upload counts as 'old'. Using 0 would race against millisecond
    // precision (uploadedAt could equal cutoff and the < comparison miss).
    const n = await cleanupOldBlobs(db, blobDir, -1000);
    expect(n).toBe(1);
  });
});

describe('pruneOrphanedBlobs', () => {
  let db: Db;
  let blobDir: string;

  beforeEach(() => {
    const t = makeTestApp();
    db = t.db;
    blobDir = t.blobDir;
  });

  afterEach(() => {
    rmSync(blobDir, { recursive: true, force: true });
  });

  async function olderThanCutoff(path: string): Promise<void> {
    // Backdate the file's mtime so the minAgeMs guard treats it as eligible.
    const { utimes } = await import('node:fs/promises');
    const t = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await utimes(path, t, t);
  }

  it('returns 0 when the blob dir is empty', async () => {
    const { pruneOrphanedBlobs } = await import('../src/services/blobs.js');
    expect(await pruneOrphanedBlobs(db, blobDir)).toBe(0);
  });

  it('returns 0 when the blob dir does not exist', async () => {
    const { pruneOrphanedBlobs } = await import('../src/services/blobs.js');
    rmSync(blobDir, { recursive: true, force: true });
    expect(await pruneOrphanedBlobs(db, blobDir)).toBe(0);
  });

  it('deletes ULID-named files that have no row in blobs', async () => {
    const { pruneOrphanedBlobs } = await import('../src/services/blobs.js');
    const { writeFile } = await import('node:fs/promises');
    const orphanId = '01HAAAAAAAAAAAAAAAAAAAAAAA';
    const orphanPath = join(blobDir, orphanId);
    await writeFile(orphanPath, new Uint8Array([7, 7, 7]));
    await olderThanCutoff(orphanPath);

    const n = await pruneOrphanedBlobs(db, blobDir);
    expect(n).toBe(1);
    const { existsSync } = await import('node:fs');
    expect(existsSync(orphanPath)).toBe(false);
  });

  it('leaves files alone that are still tracked in the blobs table', async () => {
    const { pruneOrphanedBlobs, storeBlob } = await import('../src/services/blobs.js');
    const bytes = new Uint8Array([1, 2, 3]);
    const sha = createHash('sha256').update(bytes).digest('hex');
    const r = await storeBlob(db, blobDir, bytes, sha);
    if (!r.ok) throw new Error('store failed');
    // Backdate so the mtime guard isn't the reason it survives.
    await olderThanCutoff(join(blobDir, r.meta.id));

    expect(await pruneOrphanedBlobs(db, blobDir)).toBe(0);
    const { existsSync } = await import('node:fs');
    expect(existsSync(join(blobDir, r.meta.id))).toBe(true);
  });

  it('ignores non-ULID-named files (dotfiles, README, etc.)', async () => {
    const { pruneOrphanedBlobs } = await import('../src/services/blobs.js');
    const { writeFile } = await import('node:fs/promises');
    const keep = ['.gitkeep', 'README.md', 'not-a-ulid.txt'];
    for (const name of keep) {
      const p = join(blobDir, name);
      await writeFile(p, '');
      await olderThanCutoff(p);
    }

    expect(await pruneOrphanedBlobs(db, blobDir)).toBe(0);
    const { existsSync } = await import('node:fs');
    for (const name of keep) {
      expect(existsSync(join(blobDir, name))).toBe(true);
    }
  });

  it('skips files modified within minAgeMs (race with in-flight uploads)', async () => {
    const { pruneOrphanedBlobs } = await import('../src/services/blobs.js');
    const { writeFile } = await import('node:fs/promises');
    const freshOrphan = '01HBBBBBBBBBBBBBBBBBBBBBBB';
    await writeFile(join(blobDir, freshOrphan), new Uint8Array([1]));
    // No backdating — file is fresh. Default minAgeMs (1h) should skip it.

    expect(await pruneOrphanedBlobs(db, blobDir)).toBe(0);
    const { existsSync } = await import('node:fs');
    expect(existsSync(join(blobDir, freshOrphan))).toBe(true);
  });
});
