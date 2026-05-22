import { Hono } from 'hono';
import type { AppEnv } from '../app.js';
import { requireDeviceAuth } from '../auth.js';
import { getBlobMeta, readBlob, storeBlob } from '../services/blobs.js';

/**
 * Blob storage endpoints. The server stores opaque (already E2EE-encrypted)
 * bytes — it never sees plaintext. The client supplies a sha256 of the
 * ciphertext; the server recomputes and rejects on mismatch.
 *
 *   POST /api/v1/blobs          upload bytes, get back {id, sha256, size}
 *   GET  /api/v1/blobs/:id      download bytes (raw octet-stream)
 *   HEAD /api/v1/blobs/:id      check existence + get sha256/size headers
 *
 * All endpoints require signed-request auth: the device must prove possession
 * of its Ed25519 key. Beyond that, the server does not enforce which devices
 * may read which blobs — possession of the unwrap-key + blob ID gates access
 * cryptographically.
 */
export function blobsRoute(blobDir: string) {
  const route = new Hono<AppEnv>();

  route.post('/', requireDeviceAuth, async (c) => {
    const claimedSha = c.req.header('x-beam-sha256');
    if (!claimedSha || !/^[0-9a-f]{64}$/.test(claimedSha)) {
      return c.json({ error: 'missing_or_bad_sha256_header' }, 400);
    }

    const raw = await c.req.raw.clone().arrayBuffer();
    const data = new Uint8Array(raw);
    if (data.length === 0) {
      return c.json({ error: 'empty_body' }, 400);
    }
    // Bound the size so a single misbehaving client can't DoS the disk.
    // 25 MB MVP cap; tune via env later if we need bigger.
    const MAX_BLOB_BYTES = 25 * 1024 * 1024;
    if (data.length > MAX_BLOB_BYTES) {
      return c.json({ error: 'too_large', max: MAX_BLOB_BYTES }, 413);
    }

    const result = await storeBlob(c.get('db'), blobDir, data, claimedSha);
    if (!result.ok) {
      const status = result.reason === 'sha256_mismatch' ? 400 : 500;
      return c.json({ error: result.reason }, status);
    }
    return c.json({ id: result.meta.id, size: result.meta.size, sha256: result.meta.sha256 }, 201);
  });

  route.on('HEAD', '/:id', requireDeviceAuth, (c) => {
    const meta = getBlobMeta(c.get('db'), c.req.param('id'));
    if (!meta) return c.body(null, 404);
    c.header('x-beam-sha256', meta.sha256);
    c.header('content-length', String(meta.size));
    return c.body(null, 200);
  });

  route.get('/:id', requireDeviceAuth, async (c) => {
    const result = await readBlob(c.get('db'), blobDir, c.req.param('id'));
    if (!result) return c.json({ error: 'not_found' }, 404);
    c.header('content-type', 'application/octet-stream');
    c.header('x-beam-sha256', result.meta.sha256);
    c.header('content-length', String(result.meta.size));
    return c.body(result.bytes as unknown as ArrayBuffer);
  });

  return route;
}
