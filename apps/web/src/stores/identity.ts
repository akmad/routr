import { bytesToB64u, generateIdentity } from '@routr/crypto';
import { createContext, useContext } from 'react';
import { registerDevice } from '../lib/api.js';
import { type StoredIdentity, inspectStoredIdentity, saveIdentity } from '../lib/keystore.js';

export type IdentityState =
  | { status: 'loading' }
  | { status: 'unauthenticated' }
  | { status: 'needs-passphrase' }
  | { status: 'authenticated'; identity: StoredIdentity };

export async function attemptLoad(): Promise<IdentityState> {
  const entry = await inspectStoredIdentity();
  if (entry.kind === 'plain') return { status: 'authenticated', identity: entry.identity };
  if (entry.kind === 'encrypted') return { status: 'needs-passphrase' };
  return { status: 'unauthenticated' };
}

export async function setupIdentity(opts: {
  serverUrl: string;
  deviceName: string;
  invite?: string;
}): Promise<StoredIdentity> {
  const { serverUrl, deviceName, invite } = opts;
  const id = generateIdentity();
  const url = serverUrl.replace(/\/$/, '');
  const { deviceId, userId } = await registerDevice(url, {
    name: deviceName,
    platform: 'web',
    identity: { signPub: bytesToB64u(id.sign.publicKey), kexPub: bytesToB64u(id.kex.publicKey) },
    ...(invite ? { invite } : {}),
  });
  const stored: StoredIdentity = {
    deviceId,
    userId,
    serverUrl: url,
    signSecretKey: id.sign.secretKey,
    signPublicKey: id.sign.publicKey,
    kexSecretKey: id.kex.secretKey,
    kexPublicKey: id.kex.publicKey,
  };
  await saveIdentity(stored);
  return stored;
}

export const IdentityContext = createContext<StoredIdentity | null>(null);

export function useIdentity(): StoredIdentity {
  const ctx = useContext(IdentityContext);
  if (!ctx) throw new Error('useIdentity called outside IdentityProvider');
  return ctx;
}
