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

describe('security headers middleware', () => {
  it('sets defensive headers on a successful response', async () => {
    const app = makeTestApp();
    const res = await app.request('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('also sets defensive headers on 404 responses', async () => {
    const app = makeTestApp();
    const res = await app.request('/api/v1/nope');
    expect(res.status).toBe(404);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });
});
