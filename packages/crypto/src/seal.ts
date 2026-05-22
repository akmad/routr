import { chacha20poly1305 } from '@noble/ciphers/chacha';
import { x25519 } from '@noble/curves/ed25519';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { randomBytes } from '@noble/hashes/utils';

/**
 * Envelope sealing: ECDH(X25519) → HKDF-SHA256 → ChaCha20-Poly1305 wrap of a
 * per-envelope payload key. The payload itself is encrypted once with
 * ChaCha20-Poly1305; each recipient gets their own copy of the payload key,
 * wrapped under a key derived from their X25519 public key.
 *
 * Wire layout per wrapped key (base64url-encoded as a single string):
 *   16 bytes  ChaCha20-Poly1305 tag is appended by the cipher, so the
 *             ciphertext is `key(32) || tag(16)` = 48 bytes total.
 *
 * Wire layout of the encrypted payload:
 *   12 bytes  nonce
 *   N bytes   ciphertext
 *   16 bytes  tag
 *
 * Nonces:
 *   - Key wrap: 12 zero bytes. SAFE because the wrap key is unique per
 *     (sender ephemeral keypair, recipient device) and used exactly once.
 *   - Payload: random 12 bytes per envelope. The payload key is fresh per
 *     envelope, so collision risk is negligible, but a random nonce is
 *     the standard pattern and survives future reuse mistakes.
 */

const WRAP_NONCE = new Uint8Array(12); // 12 zero bytes
const HKDF_INFO_PREFIX = 'routr.wrap.v1:';

/** Encrypt a payload with a fresh symmetric key. Returns the key and the encrypted blob. */
export function encryptPayload(plaintext: Uint8Array): {
  payloadKey: Uint8Array;
  ciphertext: Uint8Array;
} {
  const payloadKey = randomBytes(32);
  const nonce = randomBytes(12);
  const cipher = chacha20poly1305(payloadKey, nonce);
  const sealed = cipher.encrypt(plaintext);
  const out = new Uint8Array(12 + sealed.length);
  out.set(nonce, 0);
  out.set(sealed, 12);
  return { payloadKey, ciphertext: out };
}

/** Decrypt a payload using the recovered key. Throws on bad MAC or short input. */
export function decryptPayload(payloadKey: Uint8Array, blob: Uint8Array): Uint8Array {
  if (blob.length < 12 + 16) {
    throw new Error('payload blob too short');
  }
  const nonce = blob.subarray(0, 12);
  const sealed = blob.subarray(12);
  const cipher = chacha20poly1305(payloadKey, nonce);
  return cipher.decrypt(sealed);
}

/**
 * Wrap a payload key for a specific recipient using a shared X25519
 * ephemeral keypair.
 *
 * @param payloadKey 32-byte symmetric key to wrap.
 * @param ephemeralSecret The sender's per-envelope X25519 secret key.
 * @param ephemeralPublic The matching X25519 public key (used as HKDF salt).
 * @param recipientKexPub The recipient device's X25519 public key.
 * @param recipientDeviceId Recipient's device ID (binds the wrap to a
 *   specific recipient — prevents cross-recipient confusion).
 */
export function wrapKey(
  payloadKey: Uint8Array,
  ephemeralSecret: Uint8Array,
  ephemeralPublic: Uint8Array,
  recipientKexPub: Uint8Array,
  recipientDeviceId: string,
): Uint8Array {
  const shared = x25519.getSharedSecret(ephemeralSecret, recipientKexPub);
  const wrapKey = hkdf(
    sha256,
    shared,
    ephemeralPublic,
    new TextEncoder().encode(HKDF_INFO_PREFIX + recipientDeviceId),
    32,
  );
  const cipher = chacha20poly1305(wrapKey, WRAP_NONCE);
  return cipher.encrypt(payloadKey);
}

/**
 * Unwrap the payload key on the recipient side.
 *
 * @param wrapped Output of {@link wrapKey}.
 * @param ephemeralPublic Sender's per-envelope X25519 public key.
 * @param recipientKexSecret This device's X25519 secret.
 * @param recipientDeviceId This device's ID — must match what the sender
 *   used. If it doesn't, decryption fails (the HKDF derivation diverges).
 */
export function unwrapKey(
  wrapped: Uint8Array,
  ephemeralPublic: Uint8Array,
  recipientKexSecret: Uint8Array,
  recipientDeviceId: string,
): Uint8Array {
  const shared = x25519.getSharedSecret(recipientKexSecret, ephemeralPublic);
  const wrapKey = hkdf(
    sha256,
    shared,
    ephemeralPublic,
    new TextEncoder().encode(HKDF_INFO_PREFIX + recipientDeviceId),
    32,
  );
  const cipher = chacha20poly1305(wrapKey, WRAP_NONCE);
  return cipher.decrypt(wrapped);
}

/** Generate a fresh ephemeral X25519 keypair for a single envelope. */
export function generateEphemeral(): { secretKey: Uint8Array; publicKey: Uint8Array } {
  const secretKey = randomBytes(32);
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) };
}
