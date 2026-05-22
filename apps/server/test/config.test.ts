import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('config', () => {
  it('applies defaults when env is empty', () => {
    const cfg = loadConfig({});
    expect(cfg.port).toBe(8080);
    expect(cfg.host).toBe('0.0.0.0');
    expect(cfg.databaseUrl).toBe('data/routr.db');
    expect(cfg.logLevel).toBe('info');
  });

  it('parses PORT as integer', () => {
    expect(loadConfig({ PORT: '3000' }).port).toBe(3000);
  });

  it('rejects invalid log level', () => {
    expect(() => loadConfig({ LOG_LEVEL: 'shouty' })).toThrow();
  });

  it('rejects out-of-range port', () => {
    expect(() => loadConfig({ PORT: '0' })).toThrow();
    expect(() => loadConfig({ PORT: '99999' })).toThrow();
  });

  it('defaults rate-limit values to the legacy hardcoded ones', () => {
    const cfg = loadConfig({});
    expect(cfg.rateLimitDevicesCapacity).toBe(10);
    expect(cfg.rateLimitDevicesRefillPerSecond).toBeCloseTo(0.2);
    expect(cfg.rateLimitEnvelopesCapacity).toBe(60);
    expect(cfg.rateLimitEnvelopesRefillPerSecond).toBe(1);
  });

  it('parses rate-limit overrides from env', () => {
    const cfg = loadConfig({
      RATE_LIMIT_DEVICES_CAPACITY: '50',
      RATE_LIMIT_DEVICES_REFILL_PER_SECOND: '0.5',
      RATE_LIMIT_ENVELOPES_CAPACITY: '200',
      RATE_LIMIT_ENVELOPES_REFILL_PER_SECOND: '5',
    });
    expect(cfg.rateLimitDevicesCapacity).toBe(50);
    expect(cfg.rateLimitDevicesRefillPerSecond).toBeCloseTo(0.5);
    expect(cfg.rateLimitEnvelopesCapacity).toBe(200);
    expect(cfg.rateLimitEnvelopesRefillPerSecond).toBe(5);
  });

  it('rejects non-numeric or negative rate-limit values', () => {
    expect(() => loadConfig({ RATE_LIMIT_DEVICES_CAPACITY: 'cookies' })).toThrow();
    expect(() => loadConfig({ RATE_LIMIT_ENVELOPES_REFILL_PER_SECOND: '-1' })).toThrow();
    expect(() => loadConfig({ RATE_LIMIT_DEVICES_CAPACITY: '0' })).toThrow();
  });
});
