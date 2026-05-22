import { describe, expect, it } from 'vitest';
import { type Rule, type RulePattern, matchesPattern, suggestDevice } from './rules.js';

const dev1 = 'DEV1ABCDEFGHIJKLMNOPQRSTUV';
const dev2 = 'DEV2ABCDEFGHIJKLMNOPQRSTUV';

function rule(name: string, pattern: RulePattern, target: string, priority = 0): Rule {
  return { id: name, name, pattern, targetDeviceId: target, priority };
}

describe('matchesPattern', () => {
  it('url_contains matches a substring in a URL', () => {
    expect(
      matchesPattern(
        { type: 'url_contains', value: 'youtube.com' },
        {
          kind: 'url',
          url: 'https://www.youtube.com/watch?v=xyz',
        },
      ),
    ).toBe(true);
    expect(
      matchesPattern(
        { type: 'url_contains', value: 'youtube.com' },
        {
          kind: 'url',
          url: 'https://twitter.com',
        },
      ),
    ).toBe(false);
  });

  it('url_contains does not match files', () => {
    expect(
      matchesPattern(
        { type: 'url_contains', value: 'foo' },
        {
          kind: 'file',
          name: 'foo.pdf',
          mime: 'application/pdf',
        },
      ),
    ).toBe(false);
  });

  it('url_regex applies a regex and is safe against bad patterns', () => {
    expect(
      matchesPattern(
        { type: 'url_regex', value: '^https://x\\.com/' },
        {
          kind: 'url',
          url: 'https://x.com/post/1',
        },
      ),
    ).toBe(true);
    expect(
      matchesPattern(
        { type: 'url_regex', value: '[invalid' },
        {
          kind: 'url',
          url: 'https://x.com',
        },
      ),
    ).toBe(false);
  });

  it('mime_prefix matches the start of the file mime', () => {
    expect(
      matchesPattern(
        { type: 'mime_prefix', value: 'image/' },
        {
          kind: 'file',
          name: 'pic.png',
          mime: 'image/png',
        },
      ),
    ).toBe(true);
    expect(
      matchesPattern(
        { type: 'mime_prefix', value: 'image/' },
        {
          kind: 'file',
          name: 'doc.pdf',
          mime: 'application/pdf',
        },
      ),
    ).toBe(false);
  });

  it('file_ext is case-insensitive', () => {
    expect(
      matchesPattern(
        { type: 'file_ext', value: 'PDF' },
        {
          kind: 'file',
          name: 'doc.pdf',
          mime: 'application/pdf',
        },
      ),
    ).toBe(true);
    expect(
      matchesPattern(
        { type: 'file_ext', value: 'pdf' },
        {
          kind: 'file',
          name: 'doc.PDF',
          mime: 'application/pdf',
        },
      ),
    ).toBe(true);
  });

  it('file_ext handles dotless filenames', () => {
    expect(
      matchesPattern(
        { type: 'file_ext', value: 'pdf' },
        {
          kind: 'file',
          name: 'noext',
          mime: 'application/pdf',
        },
      ),
    ).toBe(false);
  });

  it('kind matches url or file', () => {
    expect(
      matchesPattern({ type: 'kind', value: 'url' }, { kind: 'url', url: 'https://x.com' }),
    ).toBe(true);
    expect(
      matchesPattern(
        { type: 'kind', value: 'file' },
        {
          kind: 'file',
          name: 'x.pdf',
          mime: 'application/pdf',
        },
      ),
    ).toBe(true);
    expect(
      matchesPattern(
        { type: 'kind', value: 'url' },
        {
          kind: 'file',
          name: 'x.pdf',
          mime: 'application/pdf',
        },
      ),
    ).toBe(false);
  });
});

describe('suggestDevice', () => {
  it('returns the first matching rule (highest priority first)', () => {
    const rules = [
      rule('a', { type: 'url_contains', value: 'youtube.com' }, dev1, 10),
      rule('b', { type: 'url_contains', value: 'com' }, dev2, 0),
    ];
    expect(suggestDevice(rules, { kind: 'url', url: 'https://youtube.com' })).toBe(dev1);
  });

  it('falls through to lower-priority rules when first does not match', () => {
    const rules = [
      rule('a', { type: 'url_contains', value: 'youtube.com' }, dev1, 10),
      rule('b', { type: 'kind', value: 'url' }, dev2, 0),
    ];
    expect(suggestDevice(rules, { kind: 'url', url: 'https://twitter.com' })).toBe(dev2);
  });

  it('returns null when nothing matches', () => {
    const rules = [rule('a', { type: 'url_contains', value: 'foo' }, dev1)];
    expect(suggestDevice(rules, { kind: 'url', url: 'https://bar.com' })).toBeNull();
  });

  it('returns null on empty rule list', () => {
    expect(suggestDevice([], { kind: 'url', url: 'https://anywhere' })).toBeNull();
  });
});
