import { describe, expect, it } from 'vitest';
import { NonceStore } from '../src/nonce-store.js';

describe('NonceStore', () => {
  it('first sight returns false (not a replay)', () => {
    const s = new NonceStore(60_000);
    expect(s.recordOrReject('dev1', 1000)).toBe(false);
  });

  it('second sight of the same (device, ts) returns true', () => {
    const s = new NonceStore(60_000);
    s.recordOrReject('dev1', 1000);
    expect(s.recordOrReject('dev1', 1000)).toBe(true);
  });

  it('treats different timestamps for the same device as distinct', () => {
    const s = new NonceStore(60_000);
    s.recordOrReject('dev1', 1000);
    expect(s.recordOrReject('dev1', 1001)).toBe(false);
  });

  it('treats different devices at the same timestamp as distinct', () => {
    const s = new NonceStore(60_000);
    s.recordOrReject('dev1', 1000);
    expect(s.recordOrReject('dev2', 1000)).toBe(false);
  });

  it('evicts entries past the TTL on the next insert', () => {
    const s = new NonceStore(100); // 100 ms TTL
    for (let i = 0; i < 5; i++) s.recordOrReject(`d${i}`, i, 1000);
    expect(s.size()).toBe(5);
    // Insert one more far in the future — sweep clears the stale entries
    // (recorded at now=1000, cutoff at 1000+1000-100 = 1900 > 1000).
    s.recordOrReject('dnew', 99999, 2000);
    expect(s.size()).toBe(1);
  });
});
