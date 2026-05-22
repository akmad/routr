import { chacha20poly1305 } from '@noble/ciphers/chacha';
import { randomBytes } from '@noble/hashes/utils';
import { b64uToBytes, bytesToB64u } from './base64url.js';

/**
 * Passphrase-based wrap/unwrap of arbitrary bytes.
 *
 * Pipeline: PBKDF2-SHA-256 over the UTF-8 passphrase (+ random 16-byte
 * salt) → 32-byte key → ChaCha20-Poly1305 with a random 12-byte nonce.
 * Same AEAD as the rest of the project so the failure modes are
 * familiar; PBKDF2 is delegated to WebCrypto (native, much faster than
 * a pure-JS PBKDF2 at the iteration count we want).
 *
 * 600k SHA-256 iterations is OWASP's 2023 floor for PBKDF2-SHA-256.
 * On a modern laptop that's roughly 200–400 ms — slow enough to make
 * offline cracking expensive, fast enough to not annoy a user typing
 * a passphrase on app load.
 *
 * The output blob is self-describing (`algorithm`, `iterations`, salt,
 * nonce, ciphertext) so future versions can change parameters and
 * unwrap old blobs as long as the algorithm tag is recognized.
 */

const ALGORITHM = 'routr-passphrase-v1' as const;
const PBKDF2_ITERATIONS = 600_000;
const SALT_LEN = 16;
const NONCE_LEN = 12;
const KEY_LEN = 32;

export type EncryptedBlob = {
  algorithm: typeof ALGORITHM;
  iterations: number;
  /** base64url-encoded random salt */
  salt: string;
  /** base64url-encoded ChaCha20-Poly1305 nonce */
  nonce: string;
  /** base64url-encoded ciphertext (includes Poly1305 tag) */
  ciphertext: string;
};

export class WrongPassphraseError extends Error {
  constructor() {
    super('wrong passphrase or corrupted blob');
    this.name = 'WrongPassphraseError';
  }
}

export class UnsupportedAlgorithmError extends Error {
  constructor(algorithm: string) {
    super(`unsupported passphrase algorithm: ${algorithm}`);
    this.name = 'UnsupportedAlgorithmError';
  }
}

async function deriveKey(
  passphrase: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const passBytes = new TextEncoder().encode(passphrase);
  const cryptoKey = await crypto.subtle.importKey('raw', passBytes, 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      // Cast through unknown — the lib.dom.d.ts type is `BufferSource`, but
      // the crypto package is also consumed by Node-only code (server CLI)
      // whose tsconfig doesn't include DOM. Uint8Array satisfies the runtime
      // contract on both Node 19+ and modern browsers.
      // biome-ignore lint/suspicious/noExplicitAny: see note above
      salt: salt as any,
      iterations,
    },
    cryptoKey,
    KEY_LEN * 8,
  );
  return new Uint8Array(bits);
}

export async function wrapWithPassphrase(
  plain: Uint8Array,
  passphrase: string,
): Promise<EncryptedBlob> {
  if (passphrase.length === 0) {
    throw new Error('passphrase must not be empty');
  }
  const salt = randomBytes(SALT_LEN);
  const nonce = randomBytes(NONCE_LEN);
  const key = await deriveKey(passphrase, salt, PBKDF2_ITERATIONS);
  const cipher = chacha20poly1305(key, nonce);
  const ct = cipher.encrypt(plain);
  return {
    algorithm: ALGORITHM,
    iterations: PBKDF2_ITERATIONS,
    salt: bytesToB64u(salt),
    nonce: bytesToB64u(nonce),
    ciphertext: bytesToB64u(ct),
  };
}

export async function unwrapWithPassphrase(
  blob: EncryptedBlob,
  passphrase: string,
): Promise<Uint8Array> {
  if (blob.algorithm !== ALGORITHM) {
    throw new UnsupportedAlgorithmError(blob.algorithm);
  }
  const salt = b64uToBytes(blob.salt);
  const nonce = b64uToBytes(blob.nonce);
  const ct = b64uToBytes(blob.ciphertext);
  const key = await deriveKey(passphrase, salt, blob.iterations);
  const cipher = chacha20poly1305(key, nonce);
  try {
    return cipher.decrypt(ct);
  } catch {
    throw new WrongPassphraseError();
  }
}

/** Type guard: does this object look like an EncryptedBlob we can decrypt? */
export function isEncryptedBlob(value: unknown): value is EncryptedBlob {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.algorithm === 'string' &&
    typeof v.iterations === 'number' &&
    typeof v.salt === 'string' &&
    typeof v.nonce === 'string' &&
    typeof v.ciphertext === 'string'
  );
}
