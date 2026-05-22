import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { captureBuildInfo } from '../src/build-info.js';
import { openDatabase } from '../src/db/index.js';
import { createLogger } from '../src/logger.js';

function makeTestApp(opts?: { buildInfo?: ReturnType<typeof captureBuildInfo> }) {
  const { db } = openDatabase(':memory:');
  const log = createLogger({ logLevel: 'fatal' });
  const { app } = createApp({ db, log, disableRateLimits: true, buildInfo: opts?.buildInfo });
  return app;
}

type HealthBody = {
  ok: boolean;
  service: string;
  version: number;
  uptimeSec: number;
  gitSha: string;
  nodeVersion: string;
  startedAt: string;
};

describe('health endpoint', () => {
  it('returns the legacy fields (ok, service, version, uptimeSec)', async () => {
    const app = makeTestApp();
    const res = await app.request('/api/v1/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as HealthBody;
    expect(body.ok).toBe(true);
    expect(body.service).toBe('routr');
    expect(body.version).toBe(1);
    expect(typeof body.uptimeSec).toBe('number');
    expect(body.uptimeSec).toBeGreaterThanOrEqual(0);
  });

  it('returns build-info fields (gitSha, nodeVersion, startedAt)', async () => {
    const buildInfo = {
      gitSha: 'abcdef0123456789abcdef0123456789abcdef01',
      nodeVersion: 'v22.9.0',
      startedAt: '2026-05-22T15:00:00.000Z',
    };
    const app = makeTestApp({ buildInfo });
    const res = await app.request('/api/v1/health');
    const body = (await res.json()) as HealthBody;
    expect(body.gitSha).toBe(buildInfo.gitSha);
    expect(body.nodeVersion).toBe(buildInfo.nodeVersion);
    expect(body.startedAt).toBe(buildInfo.startedAt);
  });

  it('honors a well-formed BEAM_GIT_SHA env override (Docker build path)', () => {
    const captured = captureBuildInfo({
      BEAM_GIT_SHA: 'deadbeefcafebabe1234567890abcdef12345678',
    });
    expect(captured.gitSha).toBe('deadbeefcafebabe1234567890abcdef12345678');
  });

  it('returns 404 with json error for unknown routes', async () => {
    const app = makeTestApp();
    const res = await app.request('/api/v1/nope');
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: 'not_found' });
  });
});
