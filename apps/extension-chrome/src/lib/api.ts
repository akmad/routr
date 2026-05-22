import { bytesToB64u, sign } from '@routr/crypto';
import { type StoredIdentity, clearIdentity } from './keystore.js';

/**
 * Wipes the local identity when the server says we're an unknown device
 * (we were revoked elsewhere). Background scripts have no UI to navigate
 * to /setup; clearing keys is enough — the next popup open shows the
 * setup screen and the WS reconnect loop will exit on the next attempt.
 */
async function handleRevoked(): Promise<void> {
  await clearIdentity();
}

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
  const res = await fetch(`${identity.serverUrl}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: authHeader,
      ...(init.headers as Record<string, string> | undefined),
    },
  });
  if (res.status === 401) {
    try {
      const body = (await res.clone().json()) as { error?: string };
      if (body.error === 'unknown_device') void handleRevoked();
    } catch {
      // not JSON — ignore
    }
  }
  return res;
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
