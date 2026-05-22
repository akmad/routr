import { describe, expect, it } from 'vitest';
import { generateIdentity, parsePublicIdentity, publicOf } from '../src/keys.js';

describe('identity', () => {
  it('generates 32-byte keys', () => {
    const id = generateIdentity();
    expect(id.sign.publicKey.length).toBe(32);
    expect(id.sign.secretKey.length).toBe(32);
    expect(id.kex.publicKey.length).toBe(32);
    expect(id.kex.secretKey.length).toBe(32);
  });

  it('generates distinct keys each call', () => {
    const a = generateIdentity();
    const b = generateIdentity();
    expect(a.sign.secretKey).not.toEqual(b.sign.secretKey);
    expect(a.kex.secretKey).not.toEqual(b.kex.secretKey);
  });

  it('sign and kex keys are independent', () => {
    const id = generateIdentity();
    expect(id.sign.secretKey).not.toEqual(id.kex.secretKey);
    expect(id.sign.publicKey).not.toEqual(id.kex.publicKey);
  });

  it('round-trips the public form', () => {
    const id = generateIdentity();
    const pub = publicOf(id);
    const parsed = parsePublicIdentity(pub);
    expect(parsed.signPub).toEqual(id.sign.publicKey);
    expect(parsed.kexPub).toEqual(id.kex.publicKey);
  });
});
