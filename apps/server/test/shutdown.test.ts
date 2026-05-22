import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../src/logger.js';
import { gracefulShutdown } from '../src/shutdown.js';
import { ConnectionRegistry } from '../src/ws/registry.js';

// Minimal stub matching the `ServerLike` shape gracefulShutdown expects.
// `delayMs` controls how long server.close() takes to fire its callback,
// simulating in-flight requests draining.
function makeStubServer(delayMs: number, errOnClose?: Error) {
  const close = vi.fn((cb?: (err?: Error) => void) => {
    setTimeout(() => cb?.(errOnClose), delayMs);
  });
  return { close } as { close: typeof close };
}

function silentLogger(): Logger {
  return pino({ level: 'silent' }) as unknown as Logger;
}

function fakeDb() {
  return { close: vi.fn() } as unknown as import('better-sqlite3').Database;
}

describe('gracefulShutdown', () => {
  it('completes immediately when no work is in flight', async () => {
    const server = makeStubServer(0);
    const registry = new ConnectionRegistry();
    const rawDb = fakeDb();
    const start = Date.now();
    await gracefulShutdown({ server, registry, rawDb, log: silentLogger() });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(100);
    expect(server.close).toHaveBeenCalled();
    expect((rawDb as unknown as { close: ReturnType<typeof vi.fn> }).close).toHaveBeenCalled();
  });

  it('waits for in-flight HTTP to drain before closing the DB', async () => {
    const drainMs = 150;
    const server = makeStubServer(drainMs);
    const registry = new ConnectionRegistry();
    const rawDb = fakeDb();

    let closedAt = 0;
    (rawDb as unknown as { close: ReturnType<typeof vi.fn> }).close.mockImplementation(() => {
      closedAt = Date.now();
    });

    const start = Date.now();
    await gracefulShutdown({ server, registry, rawDb, log: silentLogger() });

    // DB close fires AFTER server.close completes (after `drainMs`).
    expect(closedAt - start).toBeGreaterThanOrEqual(drainMs - 20);
  });

  it('force-closes after timeoutMs when server.close never fires', async () => {
    // Server.close is called but its callback is never invoked. Without the
    // timeout backstop, gracefulShutdown would hang forever.
    const server = { close: vi.fn() };
    const registry = new ConnectionRegistry();
    const rawDb = fakeDb();

    const start = Date.now();
    await gracefulShutdown({ server, registry, rawDb, log: silentLogger(), timeoutMs: 200 });
    const elapsed = Date.now() - start;

    expect(elapsed).toBeGreaterThanOrEqual(180);
    expect(elapsed).toBeLessThan(500);
    expect(server.close).toHaveBeenCalled();
    expect((rawDb as unknown as { close: ReturnType<typeof vi.fn> }).close).toHaveBeenCalled();
  });

  it('closes every registered WS connection with code 1001', async () => {
    const closeCalls: Array<{ code: number; reason?: string }> = [];
    const send = vi.fn();
    const close = vi.fn((code: number, reason?: string) => {
      closeCalls.push({ code, reason });
    });

    const registry = new ConnectionRegistry();
    registry.add({ deviceId: 'd1', send, close });
    registry.add({ deviceId: 'd2', send, close });
    registry.add({ deviceId: 'd1', send, close }); // 2nd connection same device

    const server = makeStubServer(0);
    await gracefulShutdown({ server, registry, rawDb: fakeDb(), log: silentLogger() });

    expect(closeCalls).toHaveLength(3);
    for (const c of closeCalls) {
      expect(c.code).toBe(1001);
      expect(c.reason).toMatch(/shutting down/);
    }
    expect(registry.size()).toBe(0);
  });

  it('survives a DB close that throws (logs but does not propagate)', async () => {
    const rawDb = fakeDb();
    (rawDb as unknown as { close: ReturnType<typeof vi.fn> }).close.mockImplementation(() => {
      throw new Error('disk full');
    });
    const server = makeStubServer(0);
    // Should resolve, not reject.
    await gracefulShutdown({
      server,
      registry: new ConnectionRegistry(),
      rawDb,
      log: silentLogger(),
    });
  });
});
