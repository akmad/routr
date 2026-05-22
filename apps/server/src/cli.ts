import { cp, mkdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import type Database from 'better-sqlite3';
import { eq, isNull, sql } from 'drizzle-orm';
import { type Config, loadConfig } from './config.js';
import { type Db, openDatabase } from './db/index.js';
import { runMigrations } from './db/migrate.js';
import { blobs, devices, envelopes, inviteTokens, recipients, users } from './db/schema.js';
import { cleanupOldBlobs } from './services/blobs.js';
import { cleanupExpiredEnvelopes } from './services/envelopes.js';
import { cleanupInvites } from './services/invites.js';

/**
 * Local admin CLI for self-hosters. Operates directly on the SQLite DB
 * rather than via the API — admin = filesystem access to the server's
 * data dir, no separate admin role.
 *
 * Commands:
 *   stats
 *   users   list [--json]
 *   users   remove <user-id> [--force]
 *   devices list [--user-id <id>] [--json]
 *   devices remove <device-id> [--force]
 *   envelopes prune
 *   blobs   prune [--max-age-days <n>]
 *   blobs   prune-orphans
 *   invites list [--json]
 *   invites prune
 *   cleanup
 *   backup  <output-dir>
 */

const USAGE = `beam-admin <command> [args]

Commands:
  stats                              counts of users/devices/envelopes/blobs
  users list [--json]                list users with device counts
  users remove <id> [--force]        delete a user and all associated data
  devices list [--user-id <id>]      list devices (optionally for one user)
  devices remove <id> [--force]      force-revoke a device
  envelopes prune                    delete envelopes past their expiresAt
  blobs prune [--max-age-days N]     delete blobs older than N days (default 7)
  blobs prune-orphans                delete blobs with no associated envelope
  invites list [--json]              list active invite tokens
  invites prune                      delete used/expired invites
  cleanup                            run envelopes/blobs/invites prunes
  backup <output-dir>                online backup: writes <dir>/routr.db and <dir>/blobs/

Global flags:
  --json                             machine-readable output where supported

Environment:
  DATABASE_URL                       path to SQLite db (default data/routr.db)
  BLOB_STORAGE_DIR                   blob storage dir (default data/blobs)
`;

export type CliDeps = {
  db: Db;
  /** Raw better-sqlite3 handle. Required for `backup` (uses the SQLite online-backup API). */
  rawDb: Database.Database;
  blobDir: string;
  out: NodeJS.WritableStream;
  err: NodeJS.WritableStream;
  /** Returns true if the user confirms a destructive action. Tests inject a deterministic answerer. */
  confirm: (prompt: string) => Promise<boolean>;
  now?: () => Date;
};

// ─── Output helpers ──────────────────────────────────────────────────────────

function writeln(out: NodeJS.WritableStream, line: string): void {
  out.write(`${line}\n`);
}

function table(out: NodeJS.WritableStream, headers: string[], rows: string[][]): void {
  if (rows.length === 0) {
    writeln(out, '(no rows)');
    return;
  }
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const fmt = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join('  ');
  writeln(out, fmt(headers));
  writeln(out, widths.map((w) => '─'.repeat(w)).join('  '));
  for (const r of rows) writeln(out, fmt(r));
}

function json(out: NodeJS.WritableStream, value: unknown): void {
  writeln(out, JSON.stringify(value, null, 2));
}

function fmtTs(ms: number | Date | null | undefined): string {
  if (ms == null) return '—';
  const d = ms instanceof Date ? ms : new Date(ms);
  return d.toISOString();
}

// ─── Commands ────────────────────────────────────────────────────────────────

export async function cmdStats(deps: CliDeps, opts: { jsonOut: boolean }): Promise<number> {
  const { db, out } = deps;
  const usersN = db.select({ n: sql<number>`count(*)` }).from(users).get()?.n ?? 0;
  const devicesN = db.select({ n: sql<number>`count(*)` }).from(devices).get()?.n ?? 0;
  const envelopesN = db.select({ n: sql<number>`count(*)` }).from(envelopes).get()?.n ?? 0;
  const blobsN = db.select({ n: sql<number>`count(*)` }).from(blobs).get()?.n ?? 0;
  const pendingN =
    db.select({ n: sql<number>`count(*)` }).from(recipients).where(isNull(recipients.ackedAt)).get()
      ?.n ?? 0;

  const stats = {
    users: usersN,
    devices: devicesN,
    envelopesStored: envelopesN,
    pendingRecipients: pendingN,
    blobs: blobsN,
  };

  if (opts.jsonOut) {
    json(out, stats);
  } else {
    table(
      out,
      ['metric', 'count'],
      [
        ['users', String(stats.users)],
        ['devices', String(stats.devices)],
        ['envelopes (stored)', String(stats.envelopesStored)],
        ['recipients (pending ack)', String(stats.pendingRecipients)],
        ['blobs', String(stats.blobs)],
      ],
    );
  }
  return 0;
}

export async function cmdUsersList(deps: CliDeps, opts: { jsonOut: boolean }): Promise<number> {
  const { db, out } = deps;
  const userRows = db
    .select({ id: users.id, displayName: users.displayName, createdAt: users.createdAt })
    .from(users)
    .all();
  const deviceRows = db.select({ userId: devices.userId }).from(devices).all();
  const countByUser = new Map<string, number>();
  for (const d of deviceRows) {
    countByUser.set(d.userId, (countByUser.get(d.userId) ?? 0) + 1);
  }
  const rows = userRows.map((u) => ({
    id: u.id,
    displayName: u.displayName,
    createdAt: u.createdAt,
    deviceCount: countByUser.get(u.id) ?? 0,
  }));

  if (opts.jsonOut) {
    json(
      out,
      rows.map((r) => ({
        id: r.id,
        displayName: r.displayName,
        createdAt: fmtTs(r.createdAt),
        deviceCount: r.deviceCount,
      })),
    );
  } else {
    table(
      out,
      ['id', 'name', 'devices', 'created'],
      rows.map((r) => [r.id, r.displayName, String(r.deviceCount), fmtTs(r.createdAt)]),
    );
  }
  return 0;
}

export async function cmdUsersRemove(
  deps: CliDeps,
  userId: string,
  opts: { force: boolean },
): Promise<number> {
  const { db, err, out, confirm } = deps;
  const user = db.select().from(users).where(eq(users.id, userId)).get();
  if (!user) {
    writeln(err, `user not found: ${userId}`);
    return 1;
  }
  const deviceCount =
    db.select({ n: sql<number>`count(*)` }).from(devices).where(eq(devices.userId, userId)).get()
      ?.n ?? 0;

  if (!opts.force) {
    const yes = await confirm(
      `Delete user ${user.displayName} (${userId}) and all ${deviceCount} device(s)? FKs cascade — envelopes, recipients, trusts, peers, auth credentials, invites all go too. (y/N): `,
    );
    if (!yes) {
      writeln(err, 'aborted');
      return 2;
    }
  }
  db.delete(users).where(eq(users.id, userId)).run();
  writeln(out, `deleted user ${userId} (${deviceCount} device(s) cascade-deleted)`);
  return 0;
}

export async function cmdDevicesList(
  deps: CliDeps,
  opts: { userId?: string; jsonOut: boolean },
): Promise<number> {
  const { db, out } = deps;
  const query = db
    .select({
      id: devices.id,
      userId: devices.userId,
      name: devices.name,
      platform: devices.platform,
      createdAt: devices.createdAt,
      lastSeenAt: devices.lastSeenAt,
    })
    .from(devices);
  const rows = opts.userId ? query.where(eq(devices.userId, opts.userId)).all() : query.all();

  if (opts.jsonOut) {
    json(
      out,
      rows.map((r) => ({
        id: r.id,
        userId: r.userId,
        name: r.name,
        platform: r.platform,
        createdAt: fmtTs(r.createdAt),
        lastSeenAt: fmtTs(r.lastSeenAt),
      })),
    );
  } else {
    table(
      out,
      ['id', 'user', 'name', 'platform', 'last seen'],
      rows.map((r) => [r.id, r.userId, r.name, r.platform, fmtTs(r.lastSeenAt)]),
    );
  }
  return 0;
}

export async function cmdDevicesRemove(
  deps: CliDeps,
  deviceId: string,
  opts: { force: boolean },
): Promise<number> {
  const { db, err, out, confirm } = deps;
  const device = db.select().from(devices).where(eq(devices.id, deviceId)).get();
  if (!device) {
    writeln(err, `device not found: ${deviceId}`);
    return 1;
  }
  if (!opts.force) {
    const yes = await confirm(
      `Revoke device ${device.name} (${deviceId}, user ${device.userId})? It will lose access immediately. (y/N): `,
    );
    if (!yes) {
      writeln(err, 'aborted');
      return 2;
    }
  }
  db.delete(devices).where(eq(devices.id, deviceId)).run();
  writeln(out, `revoked device ${deviceId}`);
  return 0;
}

export async function cmdEnvelopesPrune(deps: CliDeps): Promise<number> {
  const { db, out } = deps;
  const n = cleanupExpiredEnvelopes(db, deps.now?.());
  writeln(out, `pruned ${n} expired envelope(s)`);
  return 0;
}

export async function cmdBlobsPrune(deps: CliDeps, opts: { maxAgeDays: number }): Promise<number> {
  const { db, out, blobDir } = deps;
  const maxAgeMs = opts.maxAgeDays * 24 * 60 * 60 * 1000;
  const n = await cleanupOldBlobs(db, blobDir, maxAgeMs);
  writeln(out, `pruned ${n} blob(s) older than ${opts.maxAgeDays} day(s)`);
  return 0;
}

export async function cmdBlobsPruneOrphans(deps: CliDeps): Promise<number> {
  const { db, out, blobDir } = deps;
  const orphans = db.select({ id: blobs.id }).from(blobs).where(isNull(blobs.envelopeId)).all();
  if (orphans.length === 0) {
    writeln(out, 'no orphan blobs');
    return 0;
  }
  db.transaction((tx) => {
    for (const row of orphans) {
      tx.delete(blobs).where(eq(blobs.id, row.id)).run();
    }
  });
  for (const row of orphans) {
    try {
      await unlink(join(blobDir, row.id));
    } catch {
      // File may already be gone — best-effort.
    }
  }
  writeln(out, `pruned ${orphans.length} orphan blob(s)`);
  return 0;
}

export async function cmdInvitesList(deps: CliDeps, opts: { jsonOut: boolean }): Promise<number> {
  const { db, out } = deps;
  const now = (deps.now?.() ?? new Date()).getTime();
  const rows = db
    .select({
      token: inviteTokens.token,
      userId: inviteTokens.userId,
      scope: inviteTokens.scope,
      expiresAt: inviteTokens.expiresAt,
      usedAt: inviteTokens.usedAt,
    })
    .from(inviteTokens)
    .all();

  const active = rows.filter((r) => r.usedAt == null && new Date(r.expiresAt).getTime() > now);

  if (opts.jsonOut) {
    json(
      out,
      active.map((r) => ({
        token: r.token,
        userId: r.userId,
        scope: r.scope,
        expiresAt: fmtTs(r.expiresAt),
      })),
    );
  } else {
    table(
      out,
      ['token', 'user', 'scope', 'expires'],
      active.map((r) => [r.token, r.userId ?? '—', r.scope, fmtTs(r.expiresAt)]),
    );
  }
  return 0;
}

export async function cmdInvitesPrune(deps: CliDeps): Promise<number> {
  const { db, out } = deps;
  const n = cleanupInvites(db, deps.now?.());
  writeln(out, `pruned ${n} used/expired invite(s)`);
  return 0;
}

export async function cmdCleanup(deps: CliDeps): Promise<number> {
  const { out, db, blobDir } = deps;
  const envN = cleanupExpiredEnvelopes(db, deps.now?.());
  const blobN = await cleanupOldBlobs(db, blobDir);
  const inviteN = cleanupInvites(db, deps.now?.());
  writeln(out, `cleanup done: ${envN} envelope(s), ${blobN} blob(s), ${inviteN} invite(s)`);
  return 0;
}

export async function cmdBackup(deps: CliDeps, outputDir: string): Promise<number> {
  const { rawDb, blobDir, out, err } = deps;
  await mkdir(outputDir, { recursive: true });

  const dbDest = join(outputDir, 'routr.db');
  // SQLite online backup: snapshots the DB while it's open, including any
  // in-flight writes (uses the SQLite Online Backup API under the hood).
  // Safe to run with the server still serving requests.
  try {
    await rawDb.backup(dbDest);
  } catch (e) {
    writeln(err, `backup failed (db): ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }

  const blobDest = join(outputDir, 'blobs');
  // Best-effort blob copy. Blobs are content-addressed (sha256 ids) and
  // immutable once uploaded; a new blob landing mid-copy just isn't in
  // the snapshot, which matches the DB snapshot's view (the blobs row
  // for it wouldn't be there either).
  try {
    const exists = await stat(blobDir).catch(() => null);
    if (exists?.isDirectory()) {
      await cp(blobDir, blobDest, { recursive: true, force: true });
    } else {
      await mkdir(blobDest, { recursive: true });
    }
  } catch (e) {
    writeln(err, `backup failed (blobs): ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }

  writeln(out, `wrote ${dbDest}`);
  writeln(out, `wrote ${blobDest}/`);
  return 0;
}

// ─── Dispatch ────────────────────────────────────────────────────────────────

export async function run(argv: string[], deps: CliDeps): Promise<number> {
  const [cmd, ...tail] = argv;
  const [sub, ...rest] = tail;

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    deps.out.write(USAGE);
    return 0;
  }

  try {
    switch (cmd) {
      case 'stats': {
        const { values } = parseArgs({ args: tail, options: { json: { type: 'boolean' } } });
        return await cmdStats(deps, { jsonOut: values.json === true });
      }
      case 'users': {
        if (sub === 'list') {
          const { values } = parseArgs({ args: rest, options: { json: { type: 'boolean' } } });
          return await cmdUsersList(deps, { jsonOut: values.json === true });
        }
        if (sub === 'remove') {
          const { values, positionals } = parseArgs({
            args: rest,
            options: { force: { type: 'boolean' } },
            allowPositionals: true,
          });
          const id = positionals[0];
          if (!id) {
            writeln(deps.err, 'usage: users remove <user-id> [--force]');
            return 64;
          }
          return await cmdUsersRemove(deps, id, { force: values.force === true });
        }
        writeln(deps.err, `unknown users subcommand: ${sub}`);
        return 64;
      }
      case 'devices': {
        if (sub === 'list') {
          const { values } = parseArgs({
            args: rest,
            options: { json: { type: 'boolean' }, 'user-id': { type: 'string' } },
          });
          return await cmdDevicesList(deps, {
            jsonOut: values.json === true,
            userId: typeof values['user-id'] === 'string' ? values['user-id'] : undefined,
          });
        }
        if (sub === 'remove') {
          const { values, positionals } = parseArgs({
            args: rest,
            options: { force: { type: 'boolean' } },
            allowPositionals: true,
          });
          const id = positionals[0];
          if (!id) {
            writeln(deps.err, 'usage: devices remove <device-id> [--force]');
            return 64;
          }
          return await cmdDevicesRemove(deps, id, { force: values.force === true });
        }
        writeln(deps.err, `unknown devices subcommand: ${sub}`);
        return 64;
      }
      case 'envelopes': {
        if (sub === 'prune') return await cmdEnvelopesPrune(deps);
        writeln(deps.err, `unknown envelopes subcommand: ${sub}`);
        return 64;
      }
      case 'blobs': {
        if (sub === 'prune') {
          const { values } = parseArgs({
            args: rest,
            options: { 'max-age-days': { type: 'string' } },
          });
          const maxAgeDays = values['max-age-days']
            ? Number.parseInt(values['max-age-days'], 10)
            : 7;
          if (!Number.isFinite(maxAgeDays) || maxAgeDays < 0) {
            writeln(deps.err, `invalid --max-age-days: ${values['max-age-days']}`);
            return 64;
          }
          return await cmdBlobsPrune(deps, { maxAgeDays });
        }
        if (sub === 'prune-orphans') return await cmdBlobsPruneOrphans(deps);
        writeln(deps.err, `unknown blobs subcommand: ${sub}`);
        return 64;
      }
      case 'invites': {
        if (sub === 'list') {
          const { values } = parseArgs({ args: rest, options: { json: { type: 'boolean' } } });
          return await cmdInvitesList(deps, { jsonOut: values.json === true });
        }
        if (sub === 'prune') return await cmdInvitesPrune(deps);
        writeln(deps.err, `unknown invites subcommand: ${sub}`);
        return 64;
      }
      case 'cleanup':
        return await cmdCleanup(deps);
      case 'backup': {
        // First positional after the command name is the output directory.
        // Note: tail = ['backup', 'output-dir']? No — `cmd` is consumed already,
        // so tail starts at 'output-dir'. We just want tail[0].
        const dest = tail[0];
        if (!dest) {
          writeln(deps.err, 'usage: backup <output-dir>');
          return 64;
        }
        return await cmdBackup(deps, dest);
      }
      default:
        writeln(deps.err, `unknown command: ${cmd}`);
        deps.out.write(USAGE);
        return 64;
    }
  } catch (err) {
    writeln(deps.err, `error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

// ─── Stdin confirmer (production) ────────────────────────────────────────────

function stdinConfirm(prompt: string): Promise<boolean> {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    let buf = '';
    const onData = (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl >= 0) {
        process.stdin.off('data', onData);
        process.stdin.pause();
        const answer = buf.slice(0, nl).trim().toLowerCase();
        resolve(answer === 'y' || answer === 'yes');
      }
    };
    process.stdin.resume();
    process.stdin.on('data', onData);
  });
}

// ─── Entry point ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const config: Config = loadConfig();
  runMigrations(config.databaseUrl);
  const { db, raw } = openDatabase(config.databaseUrl);
  const code = await run(process.argv.slice(2), {
    db,
    rawDb: raw,
    blobDir: config.blobStorageDir,
    out: process.stdout,
    err: process.stderr,
    confirm: stdinConfirm,
  });
  process.exit(code);
}

// Run directly when invoked as a script.
if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
