import { openBeamDb } from './db.js';

export type StoredIdentity = {
  deviceId: string;
  userId: string;
  serverUrl: string;
  signSecretKey: Uint8Array;
  signPublicKey: Uint8Array;
  kexSecretKey: Uint8Array;
  kexPublicKey: Uint8Array;
};

export async function loadIdentity(): Promise<StoredIdentity | undefined> {
  return (await openBeamDb()).get('identity', 'identity') as Promise<StoredIdentity | undefined>;
}

export async function saveIdentity(identity: StoredIdentity): Promise<void> {
  await (await openBeamDb()).put('identity', identity, 'identity');
}

export async function clearIdentity(): Promise<void> {
  await (await openBeamDb()).delete('identity', 'identity');
}
