import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/db/index.js';
import { createLogger } from '../src/logger.js';

function makeTestApp() {
  const { db } = openDatabase(':memory:');
  const log = createLogger({ logLevel: 'fatal' });
  const { app } = createApp({ db, log, disableRateLimits: true });
  return app;
}

describe('health endpoint', () => {
  it('returns ok with uptime', async () => {
    const app = makeTestApp();
    const res = await app.request('/api/v1/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      service: string;
      version: number;
      uptimeSec: number;
    };
    expect(body.ok).toBe(true);
    expect(body.service).toBe('routr');
    expect(body.version).toBe(1);
    expect(typeof body.uptimeSec).toBe('number');
    expect(body.uptimeSec).toBeGreaterThanOrEqual(0);
  });

  it('returns 404 with json error for unknown routes', async () => {
    const app = makeTestApp();
    const res = await app.request('/api/v1/nope');
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: 'not_found' });
  });
});
