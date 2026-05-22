import * as v from 'valibot';
import { Base64UrlSchema, UlidSchema } from './primitives.js';

/**
 * The server-visible envelope. The server can read every field here but
 * NEVER the encrypted payload.
 *
 * A message addressed to N recipient devices produces ONE envelope with N
 * entries in `wrappedKeys` and ONE shared ciphertext. Each recipient
 * unwraps their own copy of the symmetric key, then decrypts the
 * ciphertext.
 */
export const EnvelopeSchema = v.object({
  /** Protocol version. */
  v: v.pipe(v.number(), v.integer()),

  /** Server-assigned ULID. Clients send with empty string; server fills in. */
  id: v.union([UlidSchema, v.literal('')]),

  /** Device ID of the sender. */
  from: UlidSchema,

  /** Device IDs of the recipients. Order must match wrappedKeys keys. */
  to: v.array(UlidSchema),

  /** Unix ms. Server may overwrite to its own clock to prevent skew abuse. */
  createdAt: v.pipe(v.number(), v.integer()),

  /** Unix ms. After this the server may delete the envelope. */
  expiresAt: v.pipe(v.number(), v.integer()),

  /** What kind of payload. Server uses this for routing hints and quota. */
  kind: v.picklist(['url', 'file', 'note', 'control']),

  /** Plaintext size in bytes. Server enforces quotas against this. */
  size: v.pipe(v.number(), v.integer(), v.minValue(0)),

  /**
   * The encrypted payload, base64url. Inline for small messages
   * (URLs, controls). For files this contains an encrypted manifest
   * pointing to a separately-uploaded blob.
   */
  ciphertext: Base64UrlSchema,

  /**
   * The ephemeral X25519 public key the sender used to derive shared
   * secrets with each recipient. base64url, 32 bytes.
   */
  senderEphemeralPub: Base64UrlSchema,

  /**
   * Wrapped copies of the per-envelope symmetric key, one per recipient.
   * Keyed by recipient device ID. Each value is base64url ciphertext.
   */
  wrappedKeys: v.record(UlidSchema, Base64UrlSchema),

  /**
   * Ed25519 signature over the canonical form of all the above fields
   * (with `signature` omitted). base64url, 64 bytes.
   */
  signature: Base64UrlSchema,
});

export type Envelope = v.InferOutput<typeof EnvelopeSchema>;
