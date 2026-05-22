import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';

export type Db = ReturnType<typeof drizzle<typeof schema>>;

export function openDatabase(databaseUrl: string): { db: Db; raw: Database.Database } {
  if (databaseUrl !== ':memory:') {
    mkdirSync(dirname(databaseUrl), { recursive: true });
  }
  const raw = new Database(databaseUrl);
  raw.pragma('journal_mode = WAL');
  raw.pragma('foreign_keys = ON');
  raw.pragma('synchronous = NORMAL');
  const db = drizzle(raw, { schema });
  return { db, raw };
}
