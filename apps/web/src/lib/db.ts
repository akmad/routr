import { openDB } from 'idb';

/**
 * Single source of truth for the local IndexedDB schema.
 *
 * The 'identity' store holds this device's keys (one entry under the
 * key 'identity'). The 'rules' store holds user-defined routing rules
 * keyed by `id`.
 *
 * Version history:
 *   v1: 'identity' store
 *   v2: 'rules' store added
 *
 * All other modules should import this opener instead of calling
 * `openDB('beam', ...)` themselves — otherwise concurrent opens at
 * different versions cause schema-upgrade contention.
 */
export const DB_NAME = 'beam';
export const DB_VERSION = 3;

export async function openBeamDb() {
  return openDB(DB_NAME, DB_VERSION, {
    upgrade(db, oldVersion) {
      if (oldVersion < 1) db.createObjectStore('identity');
      if (oldVersion < 2) db.createObjectStore('rules', { keyPath: 'id' });
      if (oldVersion < 3) {
        const sent = db.createObjectStore('sent', { keyPath: 'id' });
        sent.createIndex('byAt', 'at');
      }
    },
  });
}
