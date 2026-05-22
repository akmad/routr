import { randomBytes } from 'node:crypto';

/**
 * ULID — 26 chars, Crockford base32. 48 bits ms timestamp + 80 bits randomness.
 *
 * Lexicographically sortable by time. Implemented inline to avoid an extra
 * dependency.
 */
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function newId(now: number = Date.now()): string {
  const timeChars: string[] = [];
  let time = now;
  for (let i = 0; i < 10; i++) {
    timeChars.unshift(ENCODING[time % 32] as string);
    time = Math.floor(time / 32);
  }
  const random = randomBytes(10);
  const randomChars: string[] = [];
  for (let i = 0; i < 16; i++) {
    randomChars.push(ENCODING[encodeBits(random, i)] as string);
  }
  return timeChars.join('') + randomChars.join('');
}

function encodeBits(bytes: Uint8Array, index: number): number {
  // Extract 5 bits from the byte stream starting at bit (index * 5).
  const bitOffset = index * 5;
  const byteOffset = Math.floor(bitOffset / 8);
  const bitInByte = bitOffset % 8;
  if (bitInByte + 5 <= 8) {
    return ((bytes[byteOffset] as number) >> (8 - bitInByte - 5)) & 0x1f;
  }
  const hi = ((bytes[byteOffset] as number) << (bitInByte + 5 - 8)) & 0x1f;
  const lo = (bytes[byteOffset + 1] as number) >> (16 - bitInByte - 5);
  return (hi | lo) & 0x1f;
}

/** Generate a URL-safe random token (43 chars, ~256 bits of entropy). */
export function newToken(): string {
  return randomBytes(32).toString('base64url');
}
