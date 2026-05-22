import { describe, expect, it } from 'vitest';
import {
  type EncryptedBlob,
  UnsupportedAlgorithmError,
  WrongPassphraseError,
  isEncryptedBlob,
  unwrapWithPassphrase,
  wrapWithPassphrase,
} from '../src/passphrase.js';

const SAMPLE = new TextEncoder().encode('hello, beam — this is identity bytes pretend');

describe('passphrase wrap / unwrap', () => {
  it('round-trips arbitrary bytes', async () => {
    const blob = await wrapWithPassphrase(SAMPLE, 'correct horse battery staple');
    const recovered = await unwrapWithPassphrase(blob, 'correct horse battery staple');
    expect(recovered).toEqual(SAMPLE);
  });

  it('produces a distinct ciphertext each call (random salt + nonce)', async () => {
    const b1 = await wrapWithPassphrase(SAMPLE, 'pw');
    const b2 = await wrapWithPassphrase(SAMPLE, 'pw');
    expect(b1.ciphertext).not.toBe(b2.ciphertext);
    expect(b1.salt).not.toBe(b2.salt);
    expect(b1.nonce).not.toBe(b2.nonce);
  });

  it('emits a self-describing blob with the current algorithm tag', async () => {
    const blob = await wrapWithPassphrase(SAMPLE, 'pw');
    expect(blob.algorithm).toBe('routr-passphrase-v1');
    expect(blob.iterations).toBe(600_000);
    expect(typeof blob.salt).toBe('string');
    expect(typeof blob.nonce).toBe('string');
    expect(typeof blob.ciphertext).toBe('string');
  });

  it('throws WrongPassphraseError on a wrong passphrase', async () => {
    const blob = await wrapWithPassphrase(SAMPLE, 'right');
    await expect(unwrapWithPassphrase(blob, 'wrong')).rejects.toBeInstanceOf(WrongPassphraseError);
  });

  it('throws WrongPassphraseError on a tampered ciphertext', async () => {
    const blob = await wrapWithPassphrase(SAMPLE, 'right');
    // Flip a bit in the ciphertext: base64url-decode → tamper → re-encode.
    // Easier: just mutate one character at a known position.
    const tampered: EncryptedBlob = {
      ...blob,
      ciphertext: `${blob.ciphertext.slice(0, -2)}AA`,
    };
    await expect(unwrapWithPassphrase(tampered, 'right')).rejects.toBeInstanceOf(
      WrongPassphraseError,
    );
  });

  it('rejects an empty passphrase on wrap', async () => {
    await expect(wrapWithPassphrase(SAMPLE, '')).rejects.toThrow(/empty/);
  });

  it('throws UnsupportedAlgorithmError when the algorithm tag is unknown', async () => {
    const blob = await wrapWithPassphrase(SAMPLE, 'pw');
    // biome-ignore lint/suspicious/noExplicitAny: test fixture intentionally violates the type
    const fake: EncryptedBlob = { ...blob, algorithm: 'routr-passphrase-v999' as any };
    await expect(unwrapWithPassphrase(fake, 'pw')).rejects.toBeInstanceOf(
      UnsupportedAlgorithmError,
    );
  });

  it('honors the iterations field on the stored blob (forward-compat hook)', async () => {
    // Generate with default iterations, then claim a different count on the blob.
    // The unwrap should run with the claimed count and (in this case) produce
    // a different derived key → decrypt fails. This proves the iterations
    // field is actually used during unwrap rather than being ignored.
    const blob = await wrapWithPassphrase(SAMPLE, 'pw');
    const wrongIters: EncryptedBlob = { ...blob, iterations: 100_000 };
    await expect(unwrapWithPassphrase(wrongIters, 'pw')).rejects.toBeInstanceOf(
      WrongPassphraseError,
    );
  });

  it('isEncryptedBlob: accepts the shape produced by wrapWithPassphrase', async () => {
    const blob = await wrapWithPassphrase(SAMPLE, 'pw');
    expect(isEncryptedBlob(blob)).toBe(true);
  });

  it('isEncryptedBlob: rejects plain identities and other random objects', () => {
    expect(isEncryptedBlob(null)).toBe(false);
    expect(isEncryptedBlob('string')).toBe(false);
    expect(isEncryptedBlob({})).toBe(false);
    expect(isEncryptedBlob({ deviceId: 'D', userId: 'U' })).toBe(false);
    expect(isEncryptedBlob({ algorithm: 'x', iterations: 1 })).toBe(false);
  });
});
