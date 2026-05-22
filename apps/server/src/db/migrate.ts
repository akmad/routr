import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { loadConfig } from '../config.js';
import { openDatabase } from './index.js';

const MIGRATIONS_DIR = resolve(fileURLToPath(import.meta.url), '../../../drizzle');

export function runMigrations(databaseUrl: string): void {
  const { db, raw } = openDatabase(databaseUrl);
  migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  raw.close();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  runMigrations(config.databaseUrl);
  process.stdout.write(`migrations applied: ${config.databaseUrl}\n`);
}
