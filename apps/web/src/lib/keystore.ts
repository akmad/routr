import { openDB } from 'idb';

export type StoredIdentity = {
  deviceId: string;
  userId: string;
  serverUrl: string;
  signSecretKey: Uint8Array;
  signPublicKey: Uint8Array;
  kexSecretKey: Uint8Array;
  kexPublicKey: Uint8Array;
};

async function open() {
  return openDB('beam', 1, {
    upgrade(db) {
      db.createObjectStore('identity');
    },
  });
}

export async function loadIdentity(): Promise<StoredIdentity | undefined> {
  return (await open()).get('identity', 'identity') as Promise<StoredIdentity | undefined>;
}

export async function saveIdentity(identity: StoredIdentity): Promise<void> {
  await (await open()).put('identity', identity, 'identity');
}

export async function clearIdentity(): Promise<void> {
  await (await open()).delete('identity', 'identity');
}
