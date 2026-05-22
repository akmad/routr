import * as v from 'valibot';

/**
 * Base64url-encoded bytes. Used for keys, signatures, ciphertext, hashes.
 */
export const Base64UrlSchema = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]*$/, 'Must be base64url'));

/**
 * ULID — 26-char Crockford base32. Used for envelope IDs, device IDs.
 */
export const UlidSchema = v.pipe(
  v.string(),
  v.length(26),
  v.regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'Must be a ULID'),
);
