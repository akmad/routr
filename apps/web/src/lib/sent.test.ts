import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { clearSent, listSent, recordSend } from './sent.js';

afterEach(async () => {
  await clearSent();
});

describe('sent log', () => {
  it('records and lists most-recent-first', async () => {
    await recordSend({
      kind: 'url',
      recipientIds: ['dev1'],
      summary: 'https://example.com',
      at: 1000,
    });
    await recordSend({
      kind: 'note',
      recipientIds: ['dev1'],
      summary: 'hi',
      at: 2000,
    });
    const items = await listSent();
    expect(items).toHaveLength(2);
    expect(items[0]?.kind).toBe('note');
    expect(items[1]?.kind).toBe('url');
  });

  it('clearSent empties the store', async () => {
    await recordSend({ kind: 'url', recipientIds: ['x'], summary: 'a' });
    expect((await listSent()).length).toBe(1);
    await clearSent();
    expect(await listSent()).toEqual([]);
  });

  it('trims to MAX_ITEMS (oldest evicted)', async () => {
    // MAX_ITEMS is 200; insert 205 to force trim.
    for (let i = 0; i < 205; i++) {
      await recordSend({
        kind: 'url',
        recipientIds: ['x'],
        summary: `n${i}`,
        at: i,
      });
    }
    const items = await listSent();
    expect(items.length).toBe(200);
    // Oldest (n0..n4) should be gone; most recent (n204) at the top.
    expect(items[0]?.summary).toBe('n204');
    expect(items.find((it) => it.summary === 'n0')).toBeUndefined();
  });
});
