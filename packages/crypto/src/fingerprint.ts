import { sha256 } from '@noble/hashes/sha256';

/**
 * Short device fingerprint for human verification during pairing.
 *
 * Derived from SHA-256(signPub || kexPub). Truncated to 16 bytes and
 * formatted as 8 groups of 4 lowercase hex chars separated by spaces.
 * This gives 128 bits of preimage resistance and is short enough to
 * read out loud / compare across devices.
 *
 * Example: "a3f1 9c7e 4b22 e108 5d1f 7c8e 0a44 b937"
 *
 * Both devices independently compute the same string from the same pair
 * of public keys; a user comparing them out-of-band (over the phone, in
 * person, etc.) confirms that no MITM has substituted keys.
 */
export function fingerprint(signPub: Uint8Array, kexPub: Uint8Array): string {
  if (signPub.length !== 32 || kexPub.length !== 32) {
    throw new Error('fingerprint: both keys must be 32 bytes');
  }
  const concat = new Uint8Array(64);
  concat.set(signPub, 0);
  concat.set(kexPub, 32);
  const digest = sha256(concat).slice(0, 16);

  const hex = Array.from(digest)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  // Insert a space every 4 chars.
  const groups: string[] = [];
  for (let i = 0; i < hex.length; i += 4) {
    groups.push(hex.slice(i, i + 4));
  }
  return groups.join(' ');
}
