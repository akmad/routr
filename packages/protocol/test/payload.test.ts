import { safeParse } from 'valibot';
import { describe, expect, it } from 'vitest';
import {
  ControlPayloadSchema,
  FilePayloadSchema,
  NotePayloadSchema,
  PayloadSchema,
  UrlPayloadSchema,
} from '../src/index.js';

describe('UrlPayloadSchema', () => {
  it('accepts a valid URL payload', () => {
    const r = safeParse(UrlPayloadSchema, { kind: 'url', url: 'https://example.com' });
    expect(r.success).toBe(true);
  });
  it('rejects a non-URL string', () => {
    const r = safeParse(UrlPayloadSchema, { kind: 'url', url: 'not a url' });
    expect(r.success).toBe(false);
  });
});

describe('NotePayloadSchema', () => {
  it('accepts a note with just text', () => {
    const r = safeParse(NotePayloadSchema, { kind: 'note', text: 'hi' });
    expect(r.success).toBe(true);
  });
  it('accepts a note with optional title', () => {
    const r = safeParse(NotePayloadSchema, { kind: 'note', text: 'hi', title: 'hello' });
    expect(r.success).toBe(true);
  });
  it('rejects empty kind', () => {
    const r = safeParse(NotePayloadSchema, { kind: 'note' });
    expect(r.success).toBe(false);
  });
});

describe('FilePayloadSchema', () => {
  it('requires all file fields including fileKey', () => {
    const r = safeParse(FilePayloadSchema, {
      kind: 'file',
      filename: 'x.pdf',
      mime: 'application/pdf',
      sha256: 'abc',
      size: 100,
      blobId: 'blob-id',
      fileKey: 'fk',
    });
    expect(r.success).toBe(true);
  });
  it('rejects a file payload missing fileKey', () => {
    const r = safeParse(FilePayloadSchema, {
      kind: 'file',
      filename: 'x.pdf',
      mime: 'application/pdf',
      sha256: 'abc',
      size: 100,
      blobId: 'blob-id',
    });
    expect(r.success).toBe(false);
  });
  it('rejects a negative size', () => {
    const r = safeParse(FilePayloadSchema, {
      kind: 'file',
      filename: 'x.pdf',
      mime: 'application/pdf',
      sha256: 'abc',
      size: -1,
      blobId: 'blob-id',
      fileKey: 'fk',
    });
    expect(r.success).toBe(false);
  });
});

describe('ControlPayloadSchema', () => {
  it('accepts a known op', () => {
    const r = safeParse(ControlPayloadSchema, {
      kind: 'control',
      op: 'device_revoked',
      data: {},
    });
    expect(r.success).toBe(true);
  });
  it('rejects an unknown op', () => {
    const r = safeParse(ControlPayloadSchema, {
      kind: 'control',
      op: 'something_made_up',
      data: {},
    });
    expect(r.success).toBe(false);
  });
});

describe('PayloadSchema discriminated variant', () => {
  it('dispatches on kind', () => {
    expect(safeParse(PayloadSchema, { kind: 'url', url: 'https://x.com' }).success).toBe(true);
    expect(safeParse(PayloadSchema, { kind: 'note', text: 'hi' }).success).toBe(true);
    expect(safeParse(PayloadSchema, { kind: 'unknown', x: 1 }).success).toBe(false);
  });
});
