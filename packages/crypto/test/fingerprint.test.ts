import { describe, expect, it } from 'vitest';
import { fingerprint, generateIdentity } from '../src/index.js';

describe('fingerprint', () => {
  it('produces a stable string for the same key pair', () => {
    const id = generateIdentity();
    const a = fingerprint(id.sign.publicKey, id.kex.publicKey);
    const b = fingerprint(id.sign.publicKey, id.kex.publicKey);
    expect(a).toBe(b);
  });

  it('produces different strings for different identities', () => {
    const id1 = generateIdentity();
    const id2 = generateIdentity();
    expect(fingerprint(id1.sign.publicKey, id1.kex.publicKey)).not.toBe(
      fingerprint(id2.sign.publicKey, id2.kex.publicKey),
    );
  });

  it('depends on both keys', () => {
    const a = generateIdentity();
    const b = generateIdentity();
    // Same sign key but different kex key → different fingerprint.
    expect(fingerprint(a.sign.publicKey, a.kex.publicKey)).not.toBe(
      fingerprint(a.sign.publicKey, b.kex.publicKey),
    );
    // Same kex key but different sign key → different fingerprint.
    expect(fingerprint(a.sign.publicKey, a.kex.publicKey)).not.toBe(
      fingerprint(b.sign.publicKey, a.kex.publicKey),
    );
  });

  it('formats as 8 groups of 4 lowercase hex chars', () => {
    const id = generateIdentity();
    const fp = fingerprint(id.sign.publicKey, id.kex.publicKey);
    expect(fp).toMatch(/^([0-9a-f]{4} ){7}[0-9a-f]{4}$/);
  });

  it('rejects keys of the wrong length', () => {
    const id = generateIdentity();
    expect(() => fingerprint(new Uint8Array(16), id.kex.publicKey)).toThrow();
    expect(() => fingerprint(id.sign.publicKey, new Uint8Array(31))).toThrow();
  });

  it('produces the expected fingerprint for known-zero keys', () => {
    const zero = new Uint8Array(32);
    const fp = fingerprint(zero, zero);
    // SHA-256(64 zero bytes) = f5a5fd42d16a20302798ef6ed309979b43003d2320d9f0e8ea9831a92759fb4b
    // First 16 bytes hex: f5a5fd42d16a20302798ef6ed309979b
    expect(fp).toBe('f5a5 fd42 d16a 2030 2798 ef6e d309 979b');
  });
});
