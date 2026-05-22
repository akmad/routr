import { describe, expect, it } from 'vitest';
import { generateIdentity } from '../src/keys.js';
import { sign, verify } from '../src/sign.js';

describe('sign/verify', () => {
  const enc = new TextEncoder();

  it('signs and verifies a message', () => {
    const id = generateIdentity();
    const msg = enc.encode('hello beam');
    const sig = sign(id.sign.secretKey, msg);
    expect(sig.length).toBe(64);
    expect(verify(id.sign.publicKey, sig, msg)).toBe(true);
  });

  it('rejects modified messages', () => {
    const id = generateIdentity();
    const msg = enc.encode('hello beam');
    const sig = sign(id.sign.secretKey, msg);
    const tampered = enc.encode('hello bean');
    expect(verify(id.sign.publicKey, sig, tampered)).toBe(false);
  });

  it('rejects signatures from a different key', () => {
    const a = generateIdentity();
    const b = generateIdentity();
    const msg = enc.encode('hello beam');
    const sig = sign(a.sign.secretKey, msg);
    expect(verify(b.sign.publicKey, sig, msg)).toBe(false);
  });

  it('returns false (does not throw) on garbage input', () => {
    const id = generateIdentity();
    expect(verify(id.sign.publicKey, new Uint8Array(64), enc.encode('x'))).toBe(false);
    expect(verify(new Uint8Array(31), new Uint8Array(64), enc.encode('x'))).toBe(false);
  });
});
