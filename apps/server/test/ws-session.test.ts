import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bytesToB64u, generateIdentity, sign } from '@routr/crypto';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { type Db, openDatabase } from '../src/db/index.js';
import { newId } from '../src/ids.js';
import { createLogger } from '../src/logger.js';
import { registerDevice } from '../src/services/devices.js';
import { buildWsAuthMessage } from '../src/ws/messages.js';
import { ConnectionRegistry } from '../src/ws/registry.js';
import { WsSession } from '../src/ws/session.js';

const MIGRATIONS = resolve(fileURLToPath(import.meta.url), '../../drizzle');

function makeDb() {
  const { db } = openDatabase(':memory:');
  migrate(db, { migrationsFolder: MIGRATIONS });
  return db;
}

function makeSession(
  db: Db,
  opts: { heartbeatIntervalMs?: number; heartbeatTimeoutMs?: number } = {},
) {
  const registry = new ConnectionRegistry();
  const log = createLogger({ logLevel: 'fatal' });
  const sent: string[] = [];
  const closes: Array<{ code: number; reason?: string }> = [];
  const session = new WsSession(
    { db, log, registry, ...opts },
    {
      send: (t) => sent.push(t),
      close: (code, reason) => closes.push({ code, reason }),
    },
  );
  return { session, sent, closes, registry };
}

describe('WsSession', () => {
  let db: Db;

  beforeEach(() => {
    db = makeDb();
  });

  it('sends a challenge on start', () => {
    const { session, sent } = makeSession(db);
    session.start();
    expect(sent).toHaveLength(1);
    const msg = JSON.parse(sent[0] as string);
    expect(msg.type).toBe('challenge');
    expect(typeof msg.nonce).toBe('string');
    expect(msg.nonce.length).toBeGreaterThan(0);
  });

  it('closes with 4001 for non-auth message before auth', () => {
    const { session, closes } = makeSession(db);
    session.start();
    session.onMessage(JSON.stringify({ type: 'ping' }));
    expect(closes[0]?.code).toBe(4001);
  });

  it('closes with 4000 for unparseable JSON', () => {
    const { session, closes } = makeSession(db);
    session.start();
    session.onMessage('not json {{{');
    expect(closes[0]?.code).toBe(4000);
  });

  it('closes with 4002 for unknown device', () => {
    const { session, sent, closes } = makeSession(db);
    session.start();
    const nonce = (JSON.parse(sent[0] as string) as { nonce: string }).nonce;
    // Use a valid ULID that doesn't exist in the DB.
    session.onMessage(
      JSON.stringify({
        type: 'auth',
        deviceId: newId(),
        signature: bytesToB64u(new Uint8Array(64)),
      }),
    );
    void nonce;
    expect(closes[0]?.code).toBe(4002);
  });

  it('authenticates a valid device and sends authenticated + drains inbox', () => {
    const id = generateIdentity();
    const reg = registerDevice(db, {
      name: 'test',
      platform: 'web',
      signPub: bytesToB64u(id.sign.publicKey),
      kexPub: bytesToB64u(id.kex.publicKey),
    });
    if (!reg.ok) throw new Error('setup failed');

    const { session, sent, closes, registry } = makeSession(db);
    session.start();
    const nonce = (JSON.parse(sent[0] as string) as { nonce: string }).nonce;

    const authBytes = buildWsAuthMessage(reg.deviceId, nonce);
    const sigBytes = sign(id.sign.secretKey, authBytes);

    session.onMessage(
      JSON.stringify({
        type: 'auth',
        deviceId: reg.deviceId,
        signature: bytesToB64u(sigBytes),
      }),
    );

    expect(closes).toHaveLength(0);
    const authMsg = JSON.parse(sent[1] as string) as { type: string };
    expect(authMsg.type).toBe('authenticated');
    expect(registry.isOnline(reg.deviceId)).toBe(true);
  });

  it('closes with 4004 for bad signature', () => {
    const id = generateIdentity();
    const reg = registerDevice(db, {
      name: 'test',
      platform: 'web',
      signPub: bytesToB64u(id.sign.publicKey),
      kexPub: bytesToB64u(id.kex.publicKey),
    });
    if (!reg.ok) throw new Error('setup failed');

    const { session, sent, closes } = makeSession(db);
    session.start();
    const nonce = (JSON.parse(sent[0] as string) as { nonce: string }).nonce;
    void nonce;

    // Sign with a different key.
    const other = generateIdentity();
    const authBytes = buildWsAuthMessage(reg.deviceId, nonce);
    const badSig = sign(other.sign.secretKey, authBytes);

    session.onMessage(
      JSON.stringify({ type: 'auth', deviceId: reg.deviceId, signature: bytesToB64u(badSig) }),
    );
    expect(closes[0]?.code).toBe(4004);
  });

  it('removes connection from registry on close', () => {
    const id = generateIdentity();
    const reg = registerDevice(db, {
      name: 'test',
      platform: 'web',
      signPub: bytesToB64u(id.sign.publicKey),
      kexPub: bytesToB64u(id.kex.publicKey),
    });
    if (!reg.ok) throw new Error('setup failed');

    const { session, sent, registry } = makeSession(db);
    session.start();
    const nonce = (JSON.parse(sent[0] as string) as { nonce: string }).nonce;
    const authBytes = buildWsAuthMessage(reg.deviceId, nonce);
    session.onMessage(
      JSON.stringify({
        type: 'auth',
        deviceId: reg.deviceId,
        signature: bytesToB64u(sign(id.sign.secretKey, authBytes)),
      }),
    );
    expect(registry.isOnline(reg.deviceId)).toBe(true);
    session.onClose();
    expect(registry.isOnline(reg.deviceId)).toBe(false);
  });

  it('responds to ping with pong after auth', () => {
    const id = generateIdentity();
    const reg = registerDevice(db, {
      name: 'test',
      platform: 'web',
      signPub: bytesToB64u(id.sign.publicKey),
      kexPub: bytesToB64u(id.kex.publicKey),
    });
    if (!reg.ok) throw new Error('setup failed');

    const { session, sent } = makeSession(db);
    session.start();
    const nonce = (JSON.parse(sent[0] as string) as { nonce: string }).nonce;
    const authBytes = buildWsAuthMessage(reg.deviceId, nonce);
    session.onMessage(
      JSON.stringify({
        type: 'auth',
        deviceId: reg.deviceId,
        signature: bytesToB64u(sign(id.sign.secretKey, authBytes)),
      }),
    );
    session.onMessage(JSON.stringify({ type: 'ping' }));
    const pong = JSON.parse(sent[sent.length - 1] as string) as { type: string };
    expect(pong.type).toBe('pong');
  });

  it('pushed envelopes are forwarded with type "envelope" wire shape', () => {
    const id = generateIdentity();
    const reg = registerDevice(db, {
      name: 'test',
      platform: 'web',
      signPub: bytesToB64u(id.sign.publicKey),
      kexPub: bytesToB64u(id.kex.publicKey),
    });
    if (!reg.ok) throw new Error('setup failed');

    const { session, sent, registry } = makeSession(db);
    session.start();
    const nonce = (JSON.parse(sent[0] as string) as { nonce: string }).nonce;
    const authBytes = buildWsAuthMessage(reg.deviceId, nonce);
    session.onMessage(
      JSON.stringify({
        type: 'auth',
        deviceId: reg.deviceId,
        signature: bytesToB64u(sign(id.sign.secretKey, authBytes)),
      }),
    );

    const pushed = registry.push(reg.deviceId, {
      type: 'envelope',
      id: 'X'.repeat(26),
      fromDevice: reg.deviceId,
      createdAt: 0,
      expiresAt: 0,
      kind: 'url',
      size: 0,
      ciphertext: '',
      senderEphemeralPub: '',
      wrappedKey: '',
      signature: '',
    });
    expect(pushed).toBe(1);

    const lastFrame = JSON.parse(sent[sent.length - 1] as string) as { type: string };
    // Regression guard: clients only listen for type === 'envelope'.
    expect(lastFrame.type).toBe('envelope');
  });
});

describe('WsSession heartbeat', () => {
  let db: Db;

  beforeEach(() => {
    db = makeDb();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function authedSession(opts: { heartbeatIntervalMs: number; heartbeatTimeoutMs: number }) {
    const id = generateIdentity();
    const reg = registerDevice(db, {
      name: 'test',
      platform: 'web',
      signPub: bytesToB64u(id.sign.publicKey),
      kexPub: bytesToB64u(id.kex.publicKey),
    });
    if (!reg.ok) throw new Error('setup failed');

    const { session, sent, closes, registry } = makeSession(db, opts);
    session.start();
    const nonce = (JSON.parse(sent[0] as string) as { nonce: string }).nonce;
    const authBytes = buildWsAuthMessage(reg.deviceId, nonce);
    session.onMessage(
      JSON.stringify({
        type: 'auth',
        deviceId: reg.deviceId,
        signature: bytesToB64u(sign(id.sign.secretKey, authBytes)),
      }),
    );
    return { session, sent, closes, registry, deviceId: reg.deviceId };
  }

  it('emits server→client pings on the configured cadence', () => {
    const { sent } = authedSession({ heartbeatIntervalMs: 1000, heartbeatTimeoutMs: 10_000 });
    // No pings yet.
    expect(sent.filter((s) => s.includes('"ping"'))).toHaveLength(0);

    vi.advanceTimersByTime(1000);
    expect(sent.filter((s) => s.includes('"ping"'))).toHaveLength(1);

    vi.advanceTimersByTime(1000);
    expect(sent.filter((s) => s.includes('"ping"'))).toHaveLength(2);

    vi.advanceTimersByTime(3000);
    expect(sent.filter((s) => s.includes('"ping"'))).toHaveLength(5);
  });

  it('closes 4005 when no inbound message arrives within the timeout', () => {
    const { closes, session } = authedSession({
      heartbeatIntervalMs: 10_000, // pings won't fire before the timeout
      heartbeatTimeoutMs: 500,
    });
    expect(closes).toHaveLength(0);
    vi.advanceTimersByTime(499);
    expect(closes).toHaveLength(0);
    vi.advanceTimersByTime(2);
    expect(closes[0]?.code).toBe(4005);
    expect(closes[0]?.reason).toBe('heartbeat_timeout');
    session.onClose();
  });

  it('any inbound message resets the dead timer', () => {
    const { closes, session } = authedSession({
      heartbeatIntervalMs: 10_000,
      heartbeatTimeoutMs: 500,
    });
    vi.advanceTimersByTime(400);
    // Client checks in with a pong — keeps us alive.
    session.onMessage(JSON.stringify({ type: 'pong' }));
    vi.advanceTimersByTime(400);
    expect(closes).toHaveLength(0);
    // Now stop replying — should die.
    vi.advanceTimersByTime(200);
    expect(closes[0]?.code).toBe(4005);
  });

  it('a client pong silently resets the timer (no echo, no close)', () => {
    const { sent, closes, session } = authedSession({
      heartbeatIntervalMs: 10_000,
      heartbeatTimeoutMs: 500,
    });
    const before = sent.length;
    session.onMessage(JSON.stringify({ type: 'pong' }));
    // Pong itself emits nothing — it's pure liveness.
    expect(sent.length).toBe(before);
    expect(closes).toHaveLength(0);
  });

  it('onClose stops heartbeat and dead timers', () => {
    const { sent, session } = authedSession({
      heartbeatIntervalMs: 1000,
      heartbeatTimeoutMs: 10_000,
    });
    session.onClose();
    const before = sent.length;
    vi.advanceTimersByTime(5000);
    // No additional pings emitted after onClose.
    expect(sent.length).toBe(before);
  });
});
