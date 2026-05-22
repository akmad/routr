import { describe, expect, it } from 'vitest';
import { canonicalize, envelopeSignedForm } from '../src/canonical.js';

describe('canonicalize', () => {
  it('serializes primitives', () => {
    expect(canonicalize(null)).toBe('null');
    expect(canonicalize(true)).toBe('true');
    expect(canonicalize(false)).toBe('false');
    expect(canonicalize(0)).toBe('0');
    expect(canonicalize(-1.5)).toBe('-1.5');
    expect(canonicalize('hi')).toBe('"hi"');
  });

  it('escapes strings via JSON.stringify', () => {
    expect(canonicalize('a\nb')).toBe('"a\\nb"');
    expect(canonicalize('"')).toBe('"\\""');
  });

  it('sorts object keys lexicographically', () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalize({ z: 1, a: 1, m: 1 })).toBe('{"a":1,"m":1,"z":1}');
  });

  it('preserves array order', () => {
    expect(canonicalize([3, 1, 2])).toBe('[3,1,2]');
  });

  it('handles nested structures', () => {
    expect(canonicalize({ b: [1, { y: 2, x: 3 }], a: 'hi' })).toBe(
      '{"a":"hi","b":[1,{"x":3,"y":2}]}',
    );
  });

  it('omits undefined object values', () => {
    expect(canonicalize({ a: 1, b: undefined, c: 2 })).toBe('{"a":1,"c":2}');
  });

  it('rejects non-finite numbers', () => {
    expect(() => canonicalize(Number.NaN)).toThrow(/non-finite/);
    expect(() => canonicalize(Number.POSITIVE_INFINITY)).toThrow(/non-finite/);
    expect(() => canonicalize(Number.NEGATIVE_INFINITY)).toThrow(/non-finite/);
  });

  it('rejects undefined at top level', () => {
    expect(() => canonicalize(undefined)).toThrow(/unsupported/);
  });

  it('rejects functions', () => {
    expect(() => canonicalize(() => 1)).toThrow(/unsupported/);
  });

  it('rejects bigint', () => {
    expect(() => canonicalize(1n)).toThrow(/unsupported/);
  });

  it('is stable across object key insertion order', () => {
    const a = canonicalize({ a: 1, b: 2, c: 3 });
    const b = canonicalize({ c: 3, b: 2, a: 1 });
    const c = canonicalize({ b: 2, a: 1, c: 3 });
    expect(a).toBe(b);
    expect(b).toBe(c);
  });
});

describe('envelopeSignedForm', () => {
  it('omits id and signature', () => {
    const env = {
      id: 'ULID_HERE',
      signature: 'SIG_HERE',
      v: 1,
      from: 'A',
      to: ['B'],
      kind: 'url',
    };
    const signed = envelopeSignedForm(env);
    expect(signed).not.toContain('SIG_HERE');
    expect(signed).not.toContain('ULID_HERE');
    expect(signed).toContain('"from":"A"');
  });

  it('produces same output regardless of id and signature placeholder', () => {
    const a = envelopeSignedForm({ id: '', signature: '', v: 1, from: 'A' });
    const b = envelopeSignedForm({ id: 'xyz', signature: 'sig', v: 1, from: 'A' });
    expect(a).toBe(b);
  });
});
