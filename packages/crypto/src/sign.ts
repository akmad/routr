import { ed25519 } from '@noble/curves/ed25519';

/**
 * Sign a message with an Ed25519 secret key seed.
 *
 * @param secretKey 32-byte Ed25519 seed (the secretKey from Identity).
 * @param message Message bytes (typically the UTF-8 of canonical JSON).
 * @returns 64-byte signature.
 */
export function sign(secretKey: Uint8Array, message: Uint8Array): Uint8Array {
  return ed25519.sign(message, secretKey);
}

/**
 * Verify an Ed25519 signature.
 *
 * @returns true if valid, false otherwise. Never throws.
 */
export function verify(publicKey: Uint8Array, signature: Uint8Array, message: Uint8Array): boolean {
  try {
    return ed25519.verify(signature, message, publicKey);
  } catch {
    return false;
  }
}
