/**
 * Canonical JSON serialization.
 *
 * Used to produce a deterministic byte-string for cryptographic signing
 * and verification. Both signer and verifier must serialize the same
 * value to the same bytes.
 *
 * Rules:
 *   - Object keys sorted lexicographically (UTF-16 code unit order, same
 *     as Array.prototype.sort with no comparator — sufficient for our
 *     ASCII field names).
 *   - No insignificant whitespace.
 *   - Strings JSON.stringify'd (handles escaping).
 *   - Numbers: JSON.stringify (no trailing zeros, no leading +). Non-finite
 *     numbers are rejected.
 *   - undefined, functions, symbols, NaN, Infinity are rejected.
 *   - Arrays preserve order.
 *
 * This is NOT RFC 8785 / JCS — it's a simpler subset that's sufficient
 * because our schemas only use ASCII keys, integers, and ASCII strings
 * for the signed fields. If you need wider Unicode key support, upgrade
 * to a JCS implementation.
 */
export function canonicalize(value: unknown): string {
  return stringify(value);
}

function stringify(value: unknown): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) {
        throw new TypeError(`canonicalize: non-finite number ${value}`);
      }
      return JSON.stringify(value);
    case 'string':
      return JSON.stringify(value);
    case 'undefined':
    case 'function':
    case 'symbol':
    case 'bigint':
      throw new TypeError(`canonicalize: unsupported type ${typeof value}`);
  }

  if (Array.isArray(value)) {
    return `[${value.map(stringify).join(',')}]`;
  }

  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts: string[] = [];
  for (const key of keys) {
    const v = obj[key];
    if (v === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${stringify(v)}`);
  }
  return `{${parts.join(',')}}`;
}

/**
 * The signed canonical form of an envelope omits the `signature` and `id`
 * fields. `id` is server-assigned after the signature is created.
 */
export function envelopeSignedForm(envelope: Record<string, unknown>): string {
  const { signature: _sig, id: _id, ...rest } = envelope;
  return canonicalize(rest);
}
