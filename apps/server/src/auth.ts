import { createHash } from 'node:crypto';
import { b64uToBytes, verify } from '@routr/crypto';
import type { Context, MiddlewareHandler } from 'hono';
import type { AppEnv } from './app.js';
import { getDeviceById } from './services/devices.js';

const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Header format:
 *   Authorization: Beam-Sig deviceId="...", timestamp="...", signature="..."
 *
 * The signature is Ed25519 over the UTF-8 of:
 *
 *   METHOD\n
 *   /path?query\n
 *   timestamp\n
 *   sha256_hex(body)\n
 *
 * `body` is the raw request body bytes (empty string for GET).
 */
export function buildSignedRequestString(
  method: string,
  pathAndQuery: string,
  timestamp: string,
  body: Uint8Array,
): string {
  const bodyHash = createHash('sha256').update(body).digest('hex');
  return `${method.toUpperCase()}\n${pathAndQuery}\n${timestamp}\n${bodyHash}\n`;
}

function parseAuthHeader(header: string | undefined): Record<string, string> | null {
  if (!header) return null;
  const prefix = 'Beam-Sig ';
  if (!header.startsWith(prefix)) return null;
  const rest = header.slice(prefix.length);
  const parts: Record<string, string> = {};
  for (const piece of rest.split(',')) {
    const m = piece.trim().match(/^([a-zA-Z0-9_]+)="([^"]*)"$/);
    if (!m) return null;
    parts[m[1] as string] = m[2] as string;
  }
  return parts;
}

export const requireDeviceAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const result = await authenticate(c);
  if (!result.ok) {
    return c.json({ error: result.reason }, 401);
  }
  c.set('deviceId', result.deviceId);
  c.set('userId', result.userId);
  await next();
};

type AuthResult = { ok: true; deviceId: string; userId: string } | { ok: false; reason: string };

async function authenticate(c: Context<AppEnv>): Promise<AuthResult> {
  const parsed = parseAuthHeader(c.req.header('authorization'));
  if (!parsed) return { ok: false, reason: 'missing_auth' };

  const { deviceId, timestamp, signature } = parsed;
  if (!deviceId || !timestamp || !signature) {
    return { ok: false, reason: 'malformed_auth' };
  }

  const tsMs = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(tsMs)) return { ok: false, reason: 'bad_timestamp' };
  if (Math.abs(Date.now() - tsMs) > MAX_CLOCK_SKEW_MS) {
    return { ok: false, reason: 'clock_skew' };
  }

  const db = c.get('db');
  const device = getDeviceById(db, deviceId);
  if (!device) return { ok: false, reason: 'unknown_device' };

  const bodyBytes = new Uint8Array(await c.req.raw.clone().arrayBuffer());
  const url = new URL(c.req.url);
  const message = new TextEncoder().encode(
    buildSignedRequestString(c.req.method, url.pathname + url.search, timestamp, bodyBytes),
  );

  const sigBytes = b64uToBytes(signature);
  const pubBytes = b64uToBytes(device.signPub);
  if (!verify(pubBytes, sigBytes, message)) {
    return { ok: false, reason: 'bad_signature' };
  }

  return { ok: true, deviceId: device.id, userId: device.userId };
}
