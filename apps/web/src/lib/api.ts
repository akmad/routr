import { bytesToB64u, sign } from '@routr/crypto';
import type { StoredIdentity } from './keystore.js';

export async function signedFetch(
  identity: StoredIdentity,
  path: string,
  init: RequestInit & { body?: string },
): Promise<Response> {
  const method = (init.method ?? 'GET').toUpperCase();
  const bodyStr = init.body ?? '';
  const bodyBytes = new TextEncoder().encode(bodyStr);
  const hashBuf = await crypto.subtle.digest('SHA-256', bodyBytes);
  const hashHex = Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  const timestamp = String(Date.now());
  const sigInput = `${method}\n${path}\n${timestamp}\n${hashHex}\n`;
  const sigBytes = sign(identity.signSecretKey, new TextEncoder().encode(sigInput));
  const authHeader = `Beam-Sig deviceId="${identity.deviceId}", timestamp="${timestamp}", signature="${bytesToB64u(sigBytes)}"`;
  return fetch(`${identity.serverUrl}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: authHeader,
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

export async function registerDevice(
  serverUrl: string,
  body: {
    name: string;
    platform: string;
    identity: { signPub: string; kexPub: string };
    invite?: string;
  },
): Promise<{ deviceId: string; userId: string }> {
  const res = await fetch(`${serverUrl}/api/v1/devices`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = (await res.json()) as { error?: string };
    throw new Error(err.error ?? `registration failed: ${res.status}`);
  }
  return res.json() as Promise<{ deviceId: string; userId: string }>;
}
