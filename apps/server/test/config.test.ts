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
});
