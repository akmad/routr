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

  it('defaults size caps to 25 MiB blob / 1 MiB envelope', () => {
    const cfg = loadConfig({});
    expect(cfg.maxBlobBytes).toBe(25 * 1024 * 1024);
    expect(cfg.maxEnvelopeBytes).toBe(1 * 1024 * 1024);
  });

  it('parses size cap overrides from env', () => {
    const cfg = loadConfig({
      MAX_BLOB_BYTES: '1048576',
      MAX_ENVELOPE_BYTES: '524288',
    });
    expect(cfg.maxBlobBytes).toBe(1_048_576);
    expect(cfg.maxEnvelopeBytes).toBe(524_288);
  });

  it('rejects non-positive size caps', () => {
    expect(() => loadConfig({ MAX_BLOB_BYTES: '0' })).toThrow();
    expect(() => loadConfig({ MAX_ENVELOPE_BYTES: '-1' })).toThrow();
    expect(() => loadConfig({ MAX_BLOB_BYTES: 'cookies' })).toThrow();
  });
});
