import {
  type EncryptedBlob,
  b64uToBytes,
  bytesToB64u,
  isEncryptedBlob,
  unwrapWithPassphrase,
  wrapWithPassphrase,
} from '@routr/crypto';
import { openBeamDb } from './db.js';

export type StoredIdentity = {
  deviceId: string;
  userId: string;
  serverUrl: string;
  signSecretKey: Uint8Array;
  signPublicKey: Uint8Array;
  kexSecretKey: Uint8Array;
  kexPublicKey: Uint8Array;
};

/**
 * Either the plain-text identity sits at IDB key `identity`, OR an
 * encrypted blob sits at IDB key `identity-encrypted`. They are never
 * both present; setting/removing a passphrase migrates between the two.
 */
const PLAIN_KEY = 'identity';
const ENCRYPTED_KEY = 'identity-encrypted';

export type StoredEntry =
  | { kind: 'plain'; identity: StoredIdentity }
  | { kind: 'encrypted'; blob: EncryptedBlob }
  | { kind: 'absent' };

/**
 * Inspect what's in IDB without unlocking anything. The caller uses
 * this to decide whether to render the passphrase prompt.
 */
export async function inspectStoredIdentity(): Promise<StoredEntry> {
  const db = await openBeamDb();
  const encrypted = (await db.get('identity', ENCRYPTED_KEY)) as unknown;
  if (isEncryptedBlob(encrypted)) {
    return { kind: 'encrypted', blob: encrypted };
  }
  const plain = (await db.get('identity', PLAIN_KEY)) as StoredIdentity | undefined;
  if (plain) {
    return { kind: 'plain', identity: plain };
  }
  return { kind: 'absent' };
}

/** Original plain-text loader (kept for callers that only handle the unencrypted case). */
export async function loadIdentity(): Promise<StoredIdentity | undefined> {
  const entry = await inspectStoredIdentity();
  return entry.kind === 'plain' ? entry.identity : undefined;
}

export async function saveIdentity(identity: StoredIdentity): Promise<void> {
  const db = await openBeamDb();
  await db.put('identity', identity, PLAIN_KEY);
  // Ensure the encrypted form is gone if we're saving plain (no overlap).
  await db.delete('identity', ENCRYPTED_KEY);
}

export async function clearIdentity(): Promise<void> {
  const db = await openBeamDb();
  await db.delete('identity', PLAIN_KEY);
  await db.delete('identity', ENCRYPTED_KEY);
}

// ─── Encrypted variant ───────────────────────────────────────────────────────

// Serialize/deserialize StoredIdentity → bytes via JSON with base64url-encoded
// Uint8Array fields. Stable, version-independent, and the result lands inside
// an authenticated encrypted blob so we don't need additional integrity checks.
type SerializedIdentity = {
  deviceId: string;
  userId: string;
  serverUrl: string;
  signSecretKey: string;
  signPublicKey: string;
  kexSecretKey: string;
  kexPublicKey: string;
};

function identityToBytes(identity: StoredIdentity): Uint8Array {
  const serialized: SerializedIdentity = {
    deviceId: identity.deviceId,
    userId: identity.userId,
    serverUrl: identity.serverUrl,
    signSecretKey: bytesToB64u(identity.signSecretKey),
    signPublicKey: bytesToB64u(identity.signPublicKey),
    kexSecretKey: bytesToB64u(identity.kexSecretKey),
    kexPublicKey: bytesToB64u(identity.kexPublicKey),
  };
  return new TextEncoder().encode(JSON.stringify(serialized));
}

function identityFromBytes(bytes: Uint8Array): StoredIdentity {
  const obj = JSON.parse(new TextDecoder().decode(bytes)) as SerializedIdentity;
  return {
    deviceId: obj.deviceId,
    userId: obj.userId,
    serverUrl: obj.serverUrl,
    signSecretKey: b64uToBytes(obj.signSecretKey),
    signPublicKey: b64uToBytes(obj.signPublicKey),
    kexSecretKey: b64uToBytes(obj.kexSecretKey),
    kexPublicKey: b64uToBytes(obj.kexPublicKey),
  };
}

export async function saveEncryptedIdentity(
  identity: StoredIdentity,
  passphrase: string,
): Promise<void> {
  const blob = await wrapWithPassphrase(identityToBytes(identity), passphrase);
  const db = await openBeamDb();
  await db.put('identity', blob, ENCRYPTED_KEY);
  // Wipe the plain-text copy.
  await db.delete('identity', PLAIN_KEY);
}

export async function loadEncryptedIdentity(passphrase: string): Promise<StoredIdentity> {
  const entry = await inspectStoredIdentity();
  if (entry.kind !== 'encrypted') {
    throw new Error('no encrypted identity stored');
  }
  const bytes = await unwrapWithPassphrase(entry.blob, passphrase);
  return identityFromBytes(bytes);
}
