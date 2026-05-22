import { openBeamDb } from './db.js';

/**
 * Local outbox log — what this device has sent, when, to whom. The server
 * doesn't keep this (envelopes are ephemeral). This is purely a sender-side
 * UX affordance.
 */
export type SentItem = {
  id: string;
  at: number;
  kind: 'url' | 'file' | 'note';
  recipientIds: string[];
  /** Short human-readable summary (URL, filename, first line of note text). */
  summary: string;
};

const STORE = 'sent';
const MAX_ITEMS = 200;

function newSentId(): string {
  return crypto.randomUUID();
}

export async function recordSend(
  partial: Omit<SentItem, 'id' | 'at'> & { at?: number },
): Promise<void> {
  const db = await openBeamDb();
  const at = partial.at ?? Date.now();
  await db.put(STORE, { ...partial, id: newSentId(), at });
  // Trim oldest entries beyond MAX_ITEMS.
  const tx = db.transaction(STORE, 'readwrite');
  const idx = tx.store.index('byAt');
  const total = await tx.store.count();
  if (total > MAX_ITEMS) {
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
  const db = await openBeamDb();
  const all = (await db.getAll(STORE)) as SentItem[];
  return all.sort((a, b) => b.at - a.at);
}

export async function clearSent(): Promise<void> {
  const db = await openBeamDb();
  await db.clear(STORE);
}
