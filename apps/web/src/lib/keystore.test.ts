import 'fake-indexeddb/auto';
import { generateIdentity } from '@routr/crypto';
import { WrongPassphraseError } from '@routr/crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type StoredIdentity,
  clearIdentity,
  inspectStoredIdentity,
  loadEncryptedIdentity,
  loadIdentity,
  saveEncryptedIdentity,
  saveIdentity,
} from './keystore.js';

function makeIdentity(): StoredIdentity {
  const id = generateIdentity();
  return {
    deviceId: '01HKEYSTORE000000000000000',
    userId: '01HUSER000000000000000000A',
    serverUrl: 'https://example.test',
    signSecretKey: id.sign.secretKey,
    signPublicKey: id.sign.publicKey,
    kexSecretKey: id.kex.secretKey,
    kexPublicKey: id.kex.publicKey,
  };
}

beforeEach(async () => {
  await clearIdentity();
});

afterEach(async () => {
  await clearIdentity();
});

describe('plain-text storage', () => {
  it('saveIdentity + loadIdentity round-trips the same bytes', async () => {
    const id = makeIdentity();
    await saveIdentity(id);
    const loaded = await loadIdentity();
    expect(loaded).toBeDefined();
    expect(loaded?.deviceId).toBe(id.deviceId);
    expect(loaded?.signSecretKey).toEqual(id.signSecretKey);
    expect(loaded?.kexPublicKey).toEqual(id.kexPublicKey);
  });

  it('loadIdentity returns undefined when nothing is stored', async () => {
    expect(await loadIdentity()).toBeUndefined();
  });

  it('inspectStoredIdentity reports `plain` after saveIdentity', async () => {
    await saveIdentity(makeIdentity());
    const entry = await inspectStoredIdentity();
    expect(entry.kind).toBe('plain');
  });

  it('inspectStoredIdentity reports `absent` when nothing is stored', async () => {
    const entry = await inspectStoredIdentity();
    expect(entry.kind).toBe('absent');
  });

  it('clearIdentity wipes both plain and encrypted entries', async () => {
    await saveIdentity(makeIdentity());
    await clearIdentity();
    expect(await loadIdentity()).toBeUndefined();
    expect((await inspectStoredIdentity()).kind).toBe('absent');
  });
});

describe('encrypted storage', () => {
  it('saveEncryptedIdentity + loadEncryptedIdentity round-trips with the right passphrase', async () => {
    const id = makeIdentity();
    await saveEncryptedIdentity(id, 'correct horse battery staple');
    const loaded = await loadEncryptedIdentity('correct horse battery staple');
    expect(loaded.deviceId).toBe(id.deviceId);
    expect(loaded.userId).toBe(id.userId);
    expect(loaded.serverUrl).toBe(id.serverUrl);
    expect(loaded.signSecretKey).toEqual(id.signSecretKey);
    expect(loaded.signPublicKey).toEqual(id.signPublicKey);
    expect(loaded.kexSecretKey).toEqual(id.kexSecretKey);
    expect(loaded.kexPublicKey).toEqual(id.kexPublicKey);
  });

  it('loadEncryptedIdentity throws WrongPassphraseError on the wrong passphrase', async () => {
    await saveEncryptedIdentity(makeIdentity(), 'right');
    await expect(loadEncryptedIdentity('wrong')).rejects.toBeInstanceOf(WrongPassphraseError);
  });

  it('inspectStoredIdentity reports `encrypted` after saveEncryptedIdentity', async () => {
    await saveEncryptedIdentity(makeIdentity(), 'pw');
    const entry = await inspectStoredIdentity();
    expect(entry.kind).toBe('encrypted');
    if (entry.kind === 'encrypted') {
      expect(entry.blob.algorithm).toBe('routr-passphrase-v1');
    }
  });

  it('saveEncryptedIdentity removes any pre-existing plain identity', async () => {
    await saveIdentity(makeIdentity());
    expect((await inspectStoredIdentity()).kind).toBe('plain');
    await saveEncryptedIdentity(makeIdentity(), 'pw');
    expect((await inspectStoredIdentity()).kind).toBe('encrypted');
    // The plain-text key is gone — loadIdentity returns undefined.
    expect(await loadIdentity()).toBeUndefined();
  });

  it('saveIdentity (plain) removes any pre-existing encrypted blob', async () => {
    await saveEncryptedIdentity(makeIdentity(), 'pw');
    expect((await inspectStoredIdentity()).kind).toBe('encrypted');
    await saveIdentity(makeIdentity());
    expect((await inspectStoredIdentity()).kind).toBe('plain');
  });

  it('loadIdentity (plain-only loader) returns undefined when only encrypted is stored', async () => {
    await saveEncryptedIdentity(makeIdentity(), 'pw');
    expect(await loadIdentity()).toBeUndefined();
  });
});
