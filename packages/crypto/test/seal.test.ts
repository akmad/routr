import { describe, expect, it } from 'vitest';
import { generateIdentity } from '../src/keys.js';
import {
  decryptPayload,
  encryptPayload,
  generateEphemeral,
  unwrapKey,
  wrapKey,
} from '../src/seal.js';

describe('payload encryption', () => {
  const enc = new TextEncoder();

  it('round-trips plaintext', () => {
    const pt = enc.encode('https://example.com/?q=hello');
    const { payloadKey, ciphertext } = encryptPayload(pt);
    expect(payloadKey.length).toBe(32);
    expect(ciphertext.length).toBe(12 + pt.length + 16);
    const out = decryptPayload(payloadKey, ciphertext);
    expect(out).toEqual(pt);
  });

  it('rejects ciphertext shorter than the AEAD overhead', () => {
    const { payloadKey } = encryptPayload(enc.encode('x'));
    expect(() => decryptPayload(payloadKey, new Uint8Array(10))).toThrow();
  });

  it('rejects ciphertext tampering', () => {
    const pt = enc.encode('hi');
    const { payloadKey, ciphertext } = encryptPayload(pt);
    // Flip one byte of the tag.
    const lastIdx = ciphertext.length - 1;
    ciphertext[lastIdx] = ((ciphertext[lastIdx] ?? 0) ^ 0xff) & 0xff;
    expect(() => decryptPayload(payloadKey, ciphertext)).toThrow();
  });

  it('uses a distinct nonce per call (random)', () => {
    const a = encryptPayload(enc.encode('x'));
    const b = encryptPayload(enc.encode('x'));
    // First 12 bytes are the nonce.
    expect(a.ciphertext.slice(0, 12)).not.toEqual(b.ciphertext.slice(0, 12));
  });
});

describe('key wrap', () => {
  it('round-trips a payload key for one recipient', () => {
    const recipient = generateIdentity();
    const ephem = generateEphemeral();
    const payloadKey = new Uint8Array(32);
    crypto.getRandomValues(payloadKey);
    const wrapped = wrapKey(
      payloadKey,
      ephem.secretKey,
      ephem.publicKey,
      recipient.kex.publicKey,
      '01HBEAMDEVICEAAAAAAAAAAAAA',
    );
    const out = unwrapKey(
      wrapped,
      ephem.publicKey,
      recipient.kex.secretKey,
      '01HBEAMDEVICEAAAAAAAAAAAAA',
    );
    expect(out).toEqual(payloadKey);
  });

  it('fails to unwrap with the wrong device id (key binding)', () => {
    const recipient = generateIdentity();
    const ephem = generateEphemeral();
    const payloadKey = new Uint8Array(32);
    crypto.getRandomValues(payloadKey);
    const wrapped = wrapKey(
      payloadKey,
      ephem.secretKey,
      ephem.publicKey,
      recipient.kex.publicKey,
      '01HBEAMDEVICEAAAAAAAAAAAAA',
    );
    expect(() =>
      unwrapKey(wrapped, ephem.publicKey, recipient.kex.secretKey, 'SOMEOTHERID'),
    ).toThrow();
  });

  it('fails to unwrap with a different recipient key', () => {
    const intended = generateIdentity();
    const other = generateIdentity();
    const ephem = generateEphemeral();
    const payloadKey = new Uint8Array(32);
    crypto.getRandomValues(payloadKey);
    const wrapped = wrapKey(
      payloadKey,
      ephem.secretKey,
      ephem.publicKey,
      intended.kex.publicKey,
      'DEVICE1',
    );
    expect(() => unwrapKey(wrapped, ephem.publicKey, other.kex.secretKey, 'DEVICE1')).toThrow();
  });

  it('produces different wraps for different recipients of the same key', () => {
    const a = generateIdentity();
    const b = generateIdentity();
    const ephem = generateEphemeral();
    const payloadKey = new Uint8Array(32);
    crypto.getRandomValues(payloadKey);
    const wrappedA = wrapKey(payloadKey, ephem.secretKey, ephem.publicKey, a.kex.publicKey, 'A');
    const wrappedB = wrapKey(payloadKey, ephem.secretKey, ephem.publicKey, b.kex.publicKey, 'B');
    expect(wrappedA).not.toEqual(wrappedB);
    // Both unwrap to the same key.
    expect(unwrapKey(wrappedA, ephem.publicKey, a.kex.secretKey, 'A')).toEqual(payloadKey);
    expect(unwrapKey(wrappedB, ephem.publicKey, b.kex.secretKey, 'B')).toEqual(payloadKey);
  });
});

describe('end-to-end seal', () => {
  it('sender → multiple recipients round-trip', () => {
    const sender = generateIdentity();
    void sender;
    const r1 = generateIdentity();
    const r2 = generateIdentity();
    const ephem = generateEphemeral();
    const enc = new TextEncoder();
    const plaintext = enc.encode(JSON.stringify({ url: 'https://example.com' }));

    const { payloadKey, ciphertext } = encryptPayload(plaintext);
    const w1 = wrapKey(payloadKey, ephem.secretKey, ephem.publicKey, r1.kex.publicKey, 'r1');
    const w2 = wrapKey(payloadKey, ephem.secretKey, ephem.publicKey, r2.kex.publicKey, 'r2');

    const k1 = unwrapKey(w1, ephem.publicKey, r1.kex.secretKey, 'r1');
    const k2 = unwrapKey(w2, ephem.publicKey, r2.kex.secretKey, 'r2');
    expect(k1).toEqual(payloadKey);
    expect(k2).toEqual(payloadKey);

    expect(new TextDecoder().decode(decryptPayload(k1, ciphertext))).toBe(
      JSON.stringify({ url: 'https://example.com' }),
    );
  });
});
