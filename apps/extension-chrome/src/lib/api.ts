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
  // 10s ceiling so a server URL that silently hangs (firewall dropping
  // packets, captive portal, wrong port) fails out cleanly instead of
  // leaving the popup pinned to "Setting up…" forever.
  let res: Response;
  try {
    res = await fetch(`${serverUrl}/api/v1/devices`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      throw new Error("can't reach server: timed out after 10s");
    }
    throw new Error(`can't reach server: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) {
    const errBody = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(errBody.error ?? `registration failed: ${res.status}`);
  }
  return res.json() as Promise<{ deviceId: string; userId: string }>;
}
