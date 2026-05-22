import { describe, expect, it } from 'vitest';
import { b64uToBytes, bytesToB64u } from '../src/base64url.js';

describe('base64url', () => {
  it('round-trips empty', () => {
    expect(bytesToB64u(new Uint8Array())).toBe('');
    expect(b64uToBytes('')).toEqual(new Uint8Array());
  });

  it('round-trips random bytes', () => {
    for (let i = 0; i < 20; i++) {
      const len = Math.floor(Math.random() * 100);
      const bytes = new Uint8Array(len);
      crypto.getRandomValues(bytes);
      const encoded = bytesToB64u(bytes);
      expect(encoded).toMatch(/^[A-Za-z0-9_-]*$/);
      expect(b64uToBytes(encoded)).toEqual(bytes);
    }
  });

  it('uses URL-safe alphabet', () => {
    // 0xff 0xff produces "//" in regular base64, "__" in base64url.
    expect(bytesToB64u(new Uint8Array([0xff, 0xff]))).toBe('__8');
    // 0xfb produces "+" in regular base64, "-" in base64url.
    expect(bytesToB64u(new Uint8Array([0xfb, 0xff, 0xff]))).toBe('-___');
  });

  it('omits padding', () => {
    expect(bytesToB64u(new Uint8Array([1]))).not.toContain('=');
    expect(bytesToB64u(new Uint8Array([1, 2]))).not.toContain('=');
  });
});
