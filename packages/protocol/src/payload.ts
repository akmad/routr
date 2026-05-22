import * as v from 'valibot';

/**
 * Plaintext payload — what the recipient device decrypts to. NEVER seen by
 * the server.
 */

export const UrlPayloadSchema = v.object({
  kind: v.literal('url'),
  url: v.pipe(v.string(), v.url()),
  title: v.optional(v.string()),
  note: v.optional(v.string()),
});

export const FilePayloadSchema = v.object({
  kind: v.literal('file'),
  filename: v.string(),
  mime: v.string(),
  /** SHA-256 hex of the plaintext file bytes — recipient verifies after decrypt. */
  sha256: v.string(),
  /** Total plaintext size in bytes. */
  size: v.pipe(v.number(), v.integer(), v.minValue(0)),
  /** Server-side blob ID. The actual ciphertext lives at /api/v1/blobs/:id. */
  blobId: v.string(),
  /**
   * base64url 32-byte ChaCha20-Poly1305 key for the blob ciphertext.
   * Lives inside the envelope payload (which itself is E2EE), so the server
   * never sees it. The blob ciphertext uses the same layout as the envelope
   * payload: nonce(12) || ciphertext || tag(16).
   */
  fileKey: v.string(),
});

export const ControlPayloadSchema = v.object({
  kind: v.literal('control'),
  op: v.picklist(['rule_sync', 'device_added', 'device_revoked']),
  data: v.unknown(),
});

export const PayloadSchema = v.variant('kind', [
  UrlPayloadSchema,
  FilePayloadSchema,
  ControlPayloadSchema,
]);

export type UrlPayload = v.InferOutput<typeof UrlPayloadSchema>;
export type FilePayload = v.InferOutput<typeof FilePayloadSchema>;
export type ControlPayload = v.InferOutput<typeof ControlPayloadSchema>;
export type Payload = v.InferOutput<typeof PayloadSchema>;
