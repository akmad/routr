import { describe, expect, it } from 'vitest';
import { formatBytes } from './format.js';

describe('formatBytes', () => {
  it('renders sub-KB as bytes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1)).toBe('1 B');
    expect(formatBytes(1023)).toBe('1023 B');
  });

  it('renders KB as whole numbers', () => {
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(1500)).toBe('1 KB');
    expect(formatBytes(1536)).toBe('2 KB');
    expect(formatBytes(1024 * 1023)).toBe('1023 KB');
  });

  it('renders MB with one decimal', () => {
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
    expect(formatBytes(1024 * 1024 * 5.5)).toBe('5.5 MB');
    expect(formatBytes(1024 * 1024 * 1023)).toBe('1023.0 MB');
  });

  it('renders GB with one decimal for very large files', () => {
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1.0 GB');
    expect(formatBytes(1024 * 1024 * 1024 * 2.7)).toBe('2.7 GB');
  });
});
