import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { RunResult } from 'better-sqlite3';
import type { ExtractTablesWithRelations } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { SQLiteTransaction } from 'drizzle-orm/sqlite-core';
import * as schema from './schema.js';

export type Db = ReturnType<typeof drizzle<typeof schema>>;

/**
 * Either a full Db handle or an in-progress transaction. Service
 * functions accept this so callers can compose multiple operations into
 * one atomic step.
 */
export type DbExecutor =
  | Db
  | SQLiteTransaction<'sync', RunResult, typeof schema, ExtractTablesWithRelations<typeof schema>>;

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
