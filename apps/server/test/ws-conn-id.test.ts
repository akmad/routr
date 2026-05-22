import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bytesToB64u, generateIdentity, sign } from '@routr/crypto';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { type Db, openDatabase } from '../src/db/index.js';
import type { Logger } from '../src/logger.js';
import { registerDevice } from '../src/services/devices.js';
import { buildWsAuthMessage } from '../src/ws/messages.js';
import { ConnectionRegistry } from '../src/ws/registry.js';
import { WsSession } from '../src/ws/session.js';

const MIGRATIONS = resolve(fileURLToPath(import.meta.url), '../../drizzle');

type LogLine = Record<string, unknown>;

function capturingLogger(): { log: Logger; lines: LogLine[] } {
  const lines: LogLine[] = [];
  const log = pino({ level: 'info', base: undefined }, {
    write(chunk: string): void {
      for (const piece of chunk.split('\n')) {
        if (!piece.trim()) continue;
        try {
          lines.push(JSON.parse(piece) as LogLine);
        } catch {
          // ignore
        }
      }
    },
  } as unknown as NodeJS.WritableStream) as unknown as Logger;
  return { log, lines };
}

function makeDb(): Db {
  const { db } = openDatabase(':memory:');
  migrate(db, { migrationsFolder: MIGRATIONS });
  return db;
}

describe('WS session connection IDs', () => {
  it('exposes a `connId` on the session and tags it as a UUID', () => {
    const db = makeDb();
    const { log } = capturingLogger();
    const session = new WsSession(
      { db, log, registry: new ConnectionRegistry() },
      { send: () => {}, close: () => {} },
    );
    expect(session.connId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('two sessions get distinct connIds', () => {
    const db = makeDb();
    const { log } = capturingLogger();
    const a = new WsSession(
      { db, log, registry: new ConnectionRegistry() },
      { send: () => {}, close: () => {} },
    );
    const b = new WsSession(
      { db, log, registry: new ConnectionRegistry() },
      { send: () => {}, close: () => {} },
    );
    expect(a.connId).not.toBe(b.connId);
  });

  it('emits authenticated + disconnected log lines tagged with the connId', () => {
    const db = makeDb();
    const id = generateIdentity();
    const reg = registerDevice(db, {
      name: 'test',
      platform: 'web',
      signPub: bytesToB64u(id.sign.publicKey),
      kexPub: bytesToB64u(id.kex.publicKey),
    });
    if (!reg.ok) throw new Error('registration failed');

    const { log, lines } = capturingLogger();
    const sent: string[] = [];
    const session = new WsSession(
      { db, log, registry: new ConnectionRegistry() },
      { send: (t) => sent.push(t), close: () => {} },
    );

    session.start();
    const nonce = (JSON.parse(sent[0] as string) as { nonce: string }).nonce;
    const sig = sign(id.sign.secretKey, buildWsAuthMessage(reg.deviceId, nonce));
    session.onMessage(
      JSON.stringify({ type: 'auth', deviceId: reg.deviceId, signature: bytesToB64u(sig) }),
    );
    session.onClose();

    const auth = lines.find((l) => l.msg === 'ws device authenticated');
    const disc = lines.find((l) => l.msg === 'ws device disconnected');
    expect(auth?.connId).toBe(session.connId);
    expect(disc?.connId).toBe(session.connId);
  });
});
