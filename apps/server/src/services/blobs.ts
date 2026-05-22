import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { blobs } from '../db/schema.js';
import { newId } from '../ids.js';

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
