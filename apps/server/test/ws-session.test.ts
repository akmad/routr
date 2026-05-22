import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bytesToB64u, generateIdentity, sign } from '@routr/crypto';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { beforeEach, describe, expect, it } from 'vitest';
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

function makeSession(db: Db) {
  const registry = new ConnectionRegistry();
  const log = createLogger({ logLevel: 'fatal' });
  const sent: string[] = [];
  const closes: Array<{ code: number; reason?: string }> = [];
  const session = new WsSession(
    { db, log, registry },
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
});
