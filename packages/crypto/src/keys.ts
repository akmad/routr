import { ed25519, x25519 } from '@noble/curves/ed25519';
import { randomBytes } from '@noble/hashes/utils';
import { b64uToBytes, bytesToB64u } from './base64url.js';

/**
 * A device's long-term identity. The signing key is for proving authorship
 * of envelopes; the key-exchange key is for deriving shared secrets to
 * wrap per-envelope symmetric keys.
 */
export type Identity = {
  sign: {
    /** Ed25519 public key, 32 bytes. */
    publicKey: Uint8Array;
    /** Ed25519 secret key seed, 32 bytes. */
    secretKey: Uint8Array;
  };
  kex: {
    /** X25519 public key, 32 bytes. */
    publicKey: Uint8Array;
    /** X25519 secret key, 32 bytes. */
    secretKey: Uint8Array;
  };
};

/**
 * Generate a fresh identity. Call this exactly once per device, on first
 * launch. Persist the secret keys to platform secure storage (Keychain,
 * Credential Manager, IndexedDB behind a passphrase, etc.) and never
 * transmit them.
 */
export function generateIdentity(): Identity {
  const signSecret = randomBytes(32);
  const kexSecret = randomBytes(32);
  return {
    sign: {
      secretKey: signSecret,
      publicKey: ed25519.getPublicKey(signSecret),
    },
    kex: {
      secretKey: kexSecret,
      publicKey: x25519.getPublicKey(kexSecret),
    },
  };
}

/** Wire form of a device's public keys. */
export type PublicIdentity = {
  signPub: string;
  kexPub: string;
};

export function publicOf(identity: Identity): PublicIdentity {
  return {
    signPub: bytesToB64u(identity.sign.publicKey),
    kexPub: bytesToB64u(identity.kex.publicKey),
  };
}

export type ParsedPublicIdentity = {
  signPub: Uint8Array;
  kexPub: Uint8Array;
};

export function parsePublicIdentity(p: PublicIdentity): ParsedPublicIdentity {
  return {
    signPub: b64uToBytes(p.signPub),
    kexPub: b64uToBytes(p.kexPub),
  };
}
