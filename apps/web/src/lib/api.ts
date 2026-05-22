import { bytesToB64u, sign } from '@routr/crypto';
import { type StoredIdentity, clearIdentity } from './keystore.js';

/**
 * Called from any layer (signedFetch, BeamSocket) when the server indicates
 * this device has been revoked / forgotten. Clears local identity and bounces
 * to /setup. Wired this way so all entry points handle revocation uniformly.
 */
export async function handleRevoked(): Promise<void> {
  await clearIdentity();
  if (typeof window !== 'undefined') window.location.href = '/setup';
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

  // Detect server-side revocation: a valid signature against an unknown
  // device means this identity was forgotten/revoked. Clean up and bounce.
  if (res.status === 401) {
    const cloned = res.clone();
    try {
      const body = (await cloned.json()) as { error?: string };
      if (body.error === 'unknown_device') {
        void handleRevoked();
      }
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
