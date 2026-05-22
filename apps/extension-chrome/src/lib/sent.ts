import { openDB } from 'idb';

/**
 * Local outbox log for the extension. Mirrors the web's lib/sent.ts but
 * with its own IndexedDB origin (the extension and the web app are
 * separate Beam devices and don't share storage).
 */
export type SentItem = {
  id: string;
  at: number;
  kind: 'url' | 'file' | 'note';
  recipientIds: string[];
  summary: string;
};

const DB_NAME = 'beam-ext-sent';
const STORE = 'sent';
const MAX_ITEMS = 200;

async function open() {
  return openDB(DB_NAME, 1, {
    upgrade(db) {
      const s = db.createObjectStore(STORE, { keyPath: 'id' });
      s.createIndex('byAt', 'at');
    },
  });
}

function newSentId(): string {
  return crypto.randomUUID();
}

export async function recordSend(
  partial: Omit<SentItem, 'id' | 'at'> & { at?: number },
): Promise<void> {
  const db = await open();
  const at = partial.at ?? Date.now();
  await db.put(STORE, { ...partial, id: newSentId(), at });
  const tx = db.transaction(STORE, 'readwrite');
  const total = await tx.store.count();
  if (total > MAX_ITEMS) {
    const idx = tx.store.index('byAt');
    const toDelete = total - MAX_ITEMS;
    let cursor = await idx.openCursor();
    let n = 0;
    while (cursor && n < toDelete) {
      await cursor.delete();
      cursor = await cursor.continue();
      n++;
    }
  }
  await tx.done;
}

export async function listSent(): Promise<SentItem[]> {
  const db = await open();
  const all = (await db.getAll(STORE)) as SentItem[];
  return all.sort((a, b) => b.at - a.at);
}

export async function clearSent(): Promise<void> {
  const db = await open();
  await db.clear(STORE);
}
