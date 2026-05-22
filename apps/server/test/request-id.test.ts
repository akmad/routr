import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/db/index.js';
import type { Logger } from '../src/logger.js';

const MIGRATIONS = resolve(fileURLToPath(import.meta.url), '../../drizzle');

type LogLine = Record<string, unknown>;

/**
 * Builds an app whose root logger writes every line as a JSON object into
 * an in-memory array. Tests assert on the fields each line carries.
 */
function makeAppWithCapturedLogs(): { app: ReturnType<typeof createApp>['app']; lines: LogLine[] } {
  const lines: LogLine[] = [];
  const log = pino(
    { level: 'info', base: undefined },
    {
      write(chunk: string): void {
        for (const piece of chunk.split('\n')) {
          if (!piece.trim()) continue;
          try {
            lines.push(JSON.parse(piece) as LogLine);
          } catch {
            // ignore non-JSON lines
          }
        }
      },
    } as unknown as NodeJS.WritableStream,
    // The 2-arg pino() form returns a less general type than the default;
    // cast to our app's Logger alias to satisfy AppDeps.
  ) as unknown as Logger;
  const { db } = openDatabase(':memory:');
  migrate(db, { migrationsFolder: MIGRATIONS });
  const { app } = createApp({ db, log, disableRateLimits: true });
  return { app, lines };
}

describe('request IDs', () => {
  it('sets x-request-id on every response, even unknown routes', async () => {
    const { app } = makeAppWithCapturedLogs();
    const res = await app.request('/api/v1/nope');
    const reqId = res.headers.get('x-request-id');
    expect(reqId).toBeTruthy();
    // Default UUID v4 is 36 chars including dashes.
    expect(reqId?.length).toBeGreaterThanOrEqual(8);
  });

  it('honors a well-formed incoming X-Request-ID header verbatim', async () => {
    const { app, lines } = makeAppWithCapturedLogs();
    const res = await app.request('/api/v1/devices', {
      method: 'GET',
      headers: { 'x-request-id': 'caller-supplied-abc-123' },
    });
    expect(res.headers.get('x-request-id')).toBe('caller-supplied-abc-123');
    // The lifecycle log lines reference the same id.
    const begin = lines.find((l) => l.msg === 'request begin');
    expect(begin?.reqId).toBe('caller-supplied-abc-123');
  });

  it('rejects a malformed incoming X-Request-ID and generates a fresh UUID', async () => {
    const { app } = makeAppWithCapturedLogs();
    const res = await app.request('/api/v1/devices', {
      method: 'GET',
      // Has whitespace + special chars — not in our allowlist.
      headers: { 'x-request-id': 'bad id with spaces' },
    });
    const reqId = res.headers.get('x-request-id');
    expect(reqId).not.toBe('bad id with spaces');
    expect(reqId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('two parallel requests get distinct reqIds in their log lines', async () => {
    const { app, lines } = makeAppWithCapturedLogs();
    await Promise.all([app.request('/api/v1/devices'), app.request('/api/v1/devices')]);
    const begins = lines.filter((l) => l.msg === 'request begin');
    expect(begins.length).toBe(2);
    expect(begins[0]?.reqId).toBeTruthy();
    expect(begins[1]?.reqId).toBeTruthy();
    expect(begins[0]?.reqId).not.toBe(begins[1]?.reqId);
  });

  it('emits "request begin" then "request end" with method/path/status/ms', async () => {
    const { app, lines } = makeAppWithCapturedLogs();
    await app.request('/api/v1/devices');
    const begin = lines.find((l) => l.msg === 'request begin');
    const end = lines.find((l) => l.msg === 'request end');
    expect(begin).toBeDefined();
    expect(end).toBeDefined();
    expect(begin?.method).toBe('GET');
    expect(begin?.path).toBe('/api/v1/devices');
    expect(end?.status).toBeGreaterThanOrEqual(100);
    expect(typeof end?.ms).toBe('number');
    expect(begin?.reqId).toBe(end?.reqId);
  });

  it('does NOT log lifecycle lines for /api/v1/health (too noisy)', async () => {
    const { app, lines } = makeAppWithCapturedLogs();
    await app.request('/api/v1/health');
    expect(lines.find((l) => l.msg === 'request begin')).toBeUndefined();
    expect(lines.find((l) => l.msg === 'request end')).toBeUndefined();
  });

  it('still sets the x-request-id header on /api/v1/health even when not logging', async () => {
    const { app } = makeAppWithCapturedLogs();
    const res = await app.request('/api/v1/health');
    expect(res.headers.get('x-request-id')).toBeTruthy();
  });
});
