import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { eq, lt } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { blobs } from '../db/schema.js';
import { newId } from '../ids.js';

// ULID format: 26 chars, Crockford base32. Used to filter out non-blob
// files (dotfiles, lockfiles, accidental drops) before considering a file
// as an orphan candidate.
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export type BlobMeta = {
  id: string;
  size: number;
  sha256: string;
  uploadedAt: Date;
};

export type StoreBlobResult =
  | { ok: true; meta: BlobMeta }
  | { ok: false; reason: 'sha256_mismatch' | 'write_failed' };

/**
 * Store an opaque (already-encrypted) blob on disk and record metadata.
 * The client claims a sha256 — the server recomputes it and rejects on mismatch.
 * Size is taken from the actual byte length so the server cannot be tricked.
 */
export async function storeBlob(
  db: Db,
  blobDir: string,
  data: Uint8Array,
  claimedSha256: string,
): Promise<StoreBlobResult> {
  if (!existsSync(blobDir)) mkdirSync(blobDir, { recursive: true });

  const actual = createHash('sha256').update(data).digest('hex');
  if (actual !== claimedSha256) {
    return { ok: false, reason: 'sha256_mismatch' };
  }

  const id = newId();
  const path = join(blobDir, id);
  try {
    await writeFile(path, data);
  } catch {
    return { ok: false, reason: 'write_failed' };
  }

  const now = new Date();
  db.insert(blobs)
    .values({ id, envelopeId: null, size: data.length, sha256: actual, uploadedAt: now })
    .run();

  return { ok: true, meta: { id, size: data.length, sha256: actual, uploadedAt: now } };
}

export async function readBlob(
  db: Db,
  blobDir: string,
  id: string,
): Promise<{ meta: BlobMeta; bytes: Uint8Array } | null> {
  const row = db.select().from(blobs).where(eq(blobs.id, id)).get();
  if (!row || row.deletedAt) return null;
  const path = join(blobDir, id);
  try {
    const buf = await readFile(path);
    return {
      meta: { id: row.id, size: row.size, sha256: row.sha256, uploadedAt: row.uploadedAt },
      bytes: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
    };
  } catch {
    return null;
  }
}

export function getBlobMeta(db: Db, id: string): BlobMeta | null {
  const row = db.select().from(blobs).where(eq(blobs.id, id)).get();
  if (!row || row.deletedAt) return null;
  return { id: row.id, size: row.size, sha256: row.sha256, uploadedAt: row.uploadedAt };
}

/** Soft-delete: mark the row deleted and unlink the file. Used in tests/cleanup. */
export async function deleteBlob(db: Db, blobDir: string, id: string): Promise<boolean> {
  const row = db.select().from(blobs).where(eq(blobs.id, id)).get();
  if (!row) return false;
  db.update(blobs).set({ deletedAt: new Date() }).where(eq(blobs.id, id)).run();
  try {
    await unlink(join(blobDir, id));
  } catch {
    // file already gone — fine
  }
  return true;
}

/** Returns the on-disk file size (useful for sanity checks). */
export async function blobFileSize(blobDir: string, id: string): Promise<number | null> {
  try {
    const s = await stat(join(blobDir, id));
    return s.size;
  } catch {
    return null;
  }
}

/**
 * Sweep files in `blobDir` that have no corresponding row in the `blobs`
 * table. Orphans accumulate when a previous `unlink` failed silently, a
 * DB restore reverts past blob inserts, or a botched migration leaves
 * stragglers. Files newer than `minAgeMs` are skipped to avoid racing a
 * concurrent storeBlob() that's between writeFile() and the row insert.
 *
 * Defaults: 1-hour minimum age. Returns the number of files removed.
 * Non-ULID-named files (dotfiles, README.md, etc) are always left alone.
 */
export async function pruneOrphanedBlobs(
  db: Db,
  blobDir: string,
  minAgeMs: number = 60 * 60 * 1000,
): Promise<number> {
  if (!existsSync(blobDir)) return 0;
  const known = new Set(
    db
      .select({ id: blobs.id })
      .from(blobs)
      .all()
      .map((r) => r.id),
  );
  let entries: string[];
  try {
    entries = await readdir(blobDir);
  } catch {
    return 0;
  }
  const cutoff = Date.now() - minAgeMs;
  let removed = 0;
  for (const name of entries) {
    if (!ULID_RE.test(name)) continue;
    if (known.has(name)) continue;
    const path = join(blobDir, name);
    try {
      const s = await stat(path);
      // Only consider regular files; skip directories and special types.
      if (!s.isFile()) continue;
      if (s.mtimeMs > cutoff) continue;
      await unlink(path);
      removed++;
    } catch {
      // File vanished between readdir and stat/unlink, or stat failed —
      // either way nothing to do.
    }
  }
  return removed;
}

/**
 * Delete blob rows + on-disk files older than `maxAgeMs`. Schema doesn't
 * track which envelope references which blob (envelope payload encrypts
 * that mapping), so we age blobs out by upload time. Default keep window
 * is 7 days — long enough for normal "send to my offline phone" cases
 * but bounded so an abandoned uploader doesn't fill the disk.
 */
export async function cleanupOldBlobs(
  db: Db,
  blobDir: string,
  maxAgeMs: number = 7 * 24 * 60 * 60 * 1000,
): Promise<number> {
  const cutoff = new Date(Date.now() - maxAgeMs);
  const stale = db.select({ id: blobs.id }).from(blobs).where(lt(blobs.uploadedAt, cutoff)).all();
  if (stale.length === 0) return 0;
  // Delete rows first (cheap, transactional), then unlink files lazily.
  db.transaction((tx) => {
    for (const row of stale) {
      tx.delete(blobs).where(eq(blobs.id, row.id)).run();
    }
  });
  // Best-effort file removal — if a file is already gone, ignore.
  for (const row of stale) {
    try {
      await unlink(join(blobDir, row.id));
    } catch {
      // ignore
    }
  }
  return stale.length;
}
