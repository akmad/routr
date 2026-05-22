import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/db/index.js';
import { createLogger } from '../src/logger.js';

function makeTestApp() {
  const { db } = openDatabase(':memory:');
  const log = createLogger({ logLevel: 'fatal' });
  return createApp({ db, log });
}

describe('health endpoint', () => {
  it('returns ok', async () => {
    const app = makeTestApp();
    const res = await app.request('/api/v1/health');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, service: 'routr', version: 1 });
  });

  it('returns 404 with json error for unknown routes', async () => {
    const app = makeTestApp();
    const res = await app.request('/api/v1/nope');
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: 'not_found' });
  });
});
