import { sql } from 'drizzle-orm';
import { integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * A user account on this server. Has no email/password directly — auth
 * lives in `authCredentials` (WebAuthn, invite tokens, etc.) and identity
 * is rooted in `devices`.
 */
export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  displayName: text('display_name').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});

/**
 * A device belongs to one user. Identity public keys are uploaded at
 * registration and never change for the lifetime of the device.
 */
export const devices = sqliteTable(
  'devices',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    platform: text('platform').notNull(),
    signPub: text('sign_pub').notNull(),
    kexPub: text('kex_pub').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    lastSeenAt: integer('last_seen_at', { mode: 'timestamp_ms' }),
  },
  (t) => ({
    userIdx: uniqueIndex('devices_signpub_idx').on(t.signPub),
  }),
);

/**
 * A trust attestation: one device signed another's identity. Two devices
 * with mutual trust attestations are "paired" for the same user.
 */
export const deviceTrusts = sqliteTable(
  'device_trusts',
  {
    signerDeviceId: text('signer_device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    signedDeviceId: text('signed_device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    /** Ed25519 signature by signer over the signed device's identity bytes. */
    signature: text('signature').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.signerDeviceId, t.signedDeviceId] }),
  }),
);

/**
 * An envelope is the server-visible wrapper for a message. The server
 * stores it until all recipients have acked (or it expires) and then
 * deletes it. The ciphertext + wrapped keys are stored as-is; the server
 * never decrypts.
 */
export const envelopes = sqliteTable(
  'envelopes',
  {
    id: text('id').primaryKey(),
    fromDevice: text('from_device')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    kind: text('kind', { enum: ['url', 'file', 'note', 'control'] }).notNull(),
    size: integer('size').notNull(),
    /** base64url, inline ciphertext for url/control. For file, encodes a manifest. */
    ciphertext: text('ciphertext').notNull(),
    senderEphemeralPub: text('sender_ephemeral_pub').notNull(),
    /**
     * Sender's Ed25519 signature over the canonical envelope form. Unique
     * across the table — prevents byte-identical replay attacks where an
     * attacker captures a valid envelope and re-POSTs it.
     */
    signature: text('signature').notNull(),
  },
  (t) => ({
    signatureIdx: uniqueIndex('envelopes_signature_uniq').on(t.signature),
  }),
);

/**
 * Per-recipient row: the wrapped symmetric key for that recipient plus an
 * ack timestamp. The envelope is eligible for deletion when every
 * recipient row has a non-null `ackedAt`.
 */
export const recipients = sqliteTable(
  'recipients',
  {
    envelopeId: text('envelope_id')
      .notNull()
      .references(() => envelopes.id, { onDelete: 'cascade' }),
    deviceId: text('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    /** base64url ciphertext containing the wrapped per-envelope payload key. */
    wrappedKey: text('wrapped_key').notNull(),
    ackedAt: integer('acked_at', { mode: 'timestamp_ms' }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.envelopeId, t.deviceId] }),
  }),
);

/**
 * Blob storage record. Encrypted file contents live on disk
 * (`config.blobStorageDir/<id>`); the row tracks metadata.
 */
export const blobs = sqliteTable('blobs', {
  id: text('id').primaryKey(),
  envelopeId: text('envelope_id').references(() => envelopes.id, {
    onDelete: 'set null',
  }),
  size: integer('size').notNull(),
  sha256: text('sha256').notNull(),
  uploadedAt: integer('uploaded_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  deletedAt: integer('deleted_at', { mode: 'timestamp_ms' }),
});

/**
 * A peer relationship — another user this user has invited (or has been
 * invited by) to share with. Phase 1: same-server peer. Phase 2:
 * cross-server (peerServer non-null).
 */
export const peers = sqliteTable(
  'peers',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    peerUserId: text('peer_user_id').notNull(),
    /** null = same server. Otherwise the peer's home server URL. */
    peerServer: text('peer_server'),
    peerPubkey: text('peer_pubkey').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.peerUserId] }),
  }),
);

/**
 * WebAuthn credentials. One row per registered credential per user.
 */
export const authCredentials = sqliteTable('auth_credentials', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  type: text('type', { enum: ['webauthn'] }).notNull(),
  publicKey: text('public_key').notNull(),
  counter: integer('counter').notNull().default(0),
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});

/**
 * One-shot invite tokens. Used for: first-device user creation,
 * pairing a new device to an existing user, peer-invite exchange.
 */
export const inviteTokens = sqliteTable('invite_tokens', {
  token: text('token').primaryKey(),
  userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
  scope: text('scope', { enum: ['signup', 'pair_device', 'peer'] }).notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  usedAt: integer('used_at', { mode: 'timestamp_ms' }),
});
