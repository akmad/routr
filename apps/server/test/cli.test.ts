import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bytesToB64u, generateIdentity } from '@routr/crypto';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type CliDeps, run } from '../src/cli.js';
import { type Db, openDatabase } from '../src/db/index.js';
import { blobs, devices, envelopes, inviteTokens, users } from '../src/db/schema.js';
import { newId, newToken } from '../src/ids.js';

const MIGRATIONS = resolve(fileURLToPath(import.meta.url), '../../drizzle');

type Captured = {
  out: string;
  err: string;
};

// Sync string-buffer writer. We need synchronous capture because the CLI
// returns the moment writes complete — a PassThrough's `data` event fires
// async, leaving captured.out empty when the test reads it.
function bufferWriter(target: { value: string }): NodeJS.WritableStream {
  // biome-ignore lint/suspicious/noExplicitAny: minimal stub matching the WritableStream shape we use
  const stub: any = {
    write(chunk: string | Uint8Array): boolean {
      target.value += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      return true;
    },
    end() {},
    on() {
      return stub;
    },
    off() {
      return stub;
    },
    once() {
      return stub;
    },
  };
  return stub as NodeJS.WritableStream;
}

function makeDeps(
  env: TestEnv,
  opts?: { confirmReply?: boolean },
): CliDeps & {
  captured: Captured;
} {
  const outBuf = { value: '' };
  const errBuf = { value: '' };
  const captured: Captured = {
    get out() {
      return outBuf.value;
    },
    get err() {
      return errBuf.value;
    },
  } as Captured;
  return {
    db: env.db,
    rawDb: env.rawDb,
    blobDir: env.blobDir,
    out: bufferWriter(outBuf),
    err: bufferWriter(errBuf),
    confirm: async () => opts?.confirmReply ?? true,
    captured,
  };
}

// Seed a user+device directly so we can populate the DB without going through
// registerDevice (which requires an invite after the first user).
function makeDevice(db: Db, name = 'tester') {
  const id = generateIdentity();
  const userId = newId();
  const deviceId = newId();
  db.insert(users).values({ id: userId, displayName: name }).run();
  db.insert(devices)
    .values({
      id: deviceId,
      userId,
      name,
      platform: 'web',
      signPub: bytesToB64u(id.sign.publicKey),
      kexPub: bytesToB64u(id.kex.publicKey),
    })
    .run();
  return { identity: id, deviceId, userId };
}

type TestEnv = {
  db: Db;
  rawDb: ReturnType<typeof openDatabase>['raw'];
  blobDir: string;
  cleanup: () => void;
};

function setup(): TestEnv {
  // Use a temp file rather than :memory: so the `backup` command has a real
  // file to snapshot from. SQLite's online backup API works on either, but
  // a file makes the test closer to the production code path.
  const dbPath = join(tmpdir(), `routr-cli-test-${Date.now()}-${Math.random()}.db`);
  const { db, raw } = openDatabase(dbPath);
  migrate(db, { migrationsFolder: MIGRATIONS });
  const blobDir = mkdtempSync(join(tmpdir(), 'routr-cli-test-blobs-'));
  return {
    db,
    rawDb: raw,
    blobDir,
    cleanup: () => {
      try {
        raw.close();
      } catch {
        /* ignore */
      }
      rmSync(blobDir, { recursive: true, force: true });
      rmSync(dbPath, { force: true });
      rmSync(`${dbPath}-shm`, { force: true });
      rmSync(`${dbPath}-wal`, { force: true });
    },
  };
}

let env: TestEnv;

beforeEach(() => {
  env = setup();
});

afterEach(() => {
  env.cleanup();
});

// ─── stats ───────────────────────────────────────────────────────────────────

describe('cli stats', () => {
  it('reports zeros on an empty database', async () => {
    const deps = makeDeps(env);
    const code = await run(['stats'], deps);
    expect(code).toBe(0);
    expect(deps.captured.out).toMatch(/users\s+0/);
    expect(deps.captured.out).toMatch(/devices\s+0/);
  });

  it('reports current counts after seeding', async () => {
    makeDevice(env.db);
    makeDevice(env.db, 'second');
    const deps = makeDeps(env);
    await run(['stats'], deps);
    // Two registrations create two users (no invite ties them together).
    expect(deps.captured.out).toMatch(/users\s+2/);
    expect(deps.captured.out).toMatch(/devices\s+2/);
  });

  it('emits parseable JSON with --json', async () => {
    makeDevice(env.db);
    const deps = makeDeps(env);
    await run(['stats', '--json'], deps);
    const parsed = JSON.parse(deps.captured.out);
    expect(parsed).toMatchObject({ users: 1, devices: 1 });
  });
});

// ─── users list / remove ──────────────────────────────────────────────────────

describe('cli users', () => {
  it('list: shows users with their device counts', async () => {
    const d1 = makeDevice(env.db, 'alice-phone');
    makeDevice(env.db, 'bob-laptop');
    const deps = makeDeps(env);
    await run(['users', 'list'], deps);
    expect(deps.captured.out).toContain(d1.userId);
    expect(deps.captured.out).toMatch(/1/); // device count column
  });

  it('list --json: outputs an array with deviceCount', async () => {
    makeDevice(env.db);
    const deps = makeDeps(env);
    await run(['users', 'list', '--json'], deps);
    const parsed = JSON.parse(deps.captured.out) as Array<Record<string, unknown>>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.deviceCount).toBe(1);
  });

  it('remove: cascades to devices when confirmed', async () => {
    const d = makeDevice(env.db);
    const deps = makeDeps(env, { confirmReply: true });
    const code = await run(['users', 'remove', d.userId], deps);
    expect(code).toBe(0);
    expect(deps.captured.out).toMatch(/deleted user/);
    // Verify cascade: no devices left.
    const after = makeDeps(env);
    await run(['stats', '--json'], after);
    expect(JSON.parse(after.captured.out)).toMatchObject({ users: 0, devices: 0 });
  });

  it('remove: aborts when confirm declined', async () => {
    const d = makeDevice(env.db);
    const deps = makeDeps(env, { confirmReply: false });
    const code = await run(['users', 'remove', d.userId], deps);
    expect(code).toBe(2);
    expect(deps.captured.err).toMatch(/aborted/);
    // Still there.
    const after = makeDeps(env);
    await run(['stats', '--json'], after);
    expect(JSON.parse(after.captured.out)).toMatchObject({ users: 1 });
  });

  it('remove --force: skips confirmation', async () => {
    const d = makeDevice(env.db);
    // confirmReply: false would normally abort — --force ignores it.
    const deps = makeDeps(env, { confirmReply: false });
    const code = await run(['users', 'remove', d.userId, '--force'], deps);
    expect(code).toBe(0);
  });

  it('remove: errors on unknown user', async () => {
    const deps = makeDeps(env);
    const code = await run(['users', 'remove', 'nope', '--force'], deps);
    expect(code).toBe(1);
    expect(deps.captured.err).toMatch(/not found/);
  });

  it('remove: missing positional shows usage', async () => {
    const deps = makeDeps(env);
    const code = await run(['users', 'remove'], deps);
    expect(code).toBe(64);
    expect(deps.captured.err).toMatch(/usage: users remove/);
  });
});

// ─── devices list / remove ───────────────────────────────────────────────────

describe('cli devices', () => {
  it('list: shows all devices', async () => {
    const d1 = makeDevice(env.db, 'phone');
    const d2 = makeDevice(env.db, 'laptop');
    const deps = makeDeps(env);
    await run(['devices', 'list'], deps);
    expect(deps.captured.out).toContain(d1.deviceId);
    expect(deps.captured.out).toContain(d2.deviceId);
  });

  it('list --user-id: filters to one user', async () => {
    const d1 = makeDevice(env.db, 'phone');
    const d2 = makeDevice(env.db, 'laptop'); // different user
    const deps = makeDeps(env);
    await run(['devices', 'list', '--user-id', d1.userId], deps);
    expect(deps.captured.out).toContain(d1.deviceId);
    expect(deps.captured.out).not.toContain(d2.deviceId);
  });

  it('remove: deletes the device', async () => {
    const d = makeDevice(env.db);
    const deps = makeDeps(env, { confirmReply: true });
    const code = await run(['devices', 'remove', d.deviceId], deps);
    expect(code).toBe(0);
    const after = makeDeps(env);
    await run(['stats', '--json'], after);
    expect(JSON.parse(after.captured.out)).toMatchObject({ devices: 0 });
  });

  it('remove: errors on unknown device', async () => {
    const deps = makeDeps(env);
    const code = await run(['devices', 'remove', 'fake', '--force'], deps);
    expect(code).toBe(1);
    expect(deps.captured.err).toMatch(/not found/);
  });
});

// ─── envelopes prune ─────────────────────────────────────────────────────────

describe('cli envelopes prune', () => {
  it('removes envelopes past their expiresAt', async () => {
    const sender = makeDevice(env.db);
    const past = new Date(Date.now() - 60_000);
    const future = new Date(Date.now() + 60_000);
    env.db
      .insert(envelopes)
      .values([
        {
          id: newId(),
          fromDevice: sender.deviceId,
          expiresAt: past,
          kind: 'url',
          size: 1,
          ciphertext: 'a',
          senderEphemeralPub: 'b',
          signature: 'sig-expired',
        },
        {
          id: newId(),
          fromDevice: sender.deviceId,
          expiresAt: future,
          kind: 'url',
          size: 1,
          ciphertext: 'a',
          senderEphemeralPub: 'b',
          signature: 'sig-live',
        },
      ])
      .run();

    const deps = makeDeps(env);
    const code = await run(['envelopes', 'prune'], deps);
    expect(code).toBe(0);
    expect(deps.captured.out).toMatch(/pruned 1/);

    const remaining = env.db.select().from(envelopes).all();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.signature).toBe('sig-live');
  });
});

// ─── blobs prune / prune-orphans ─────────────────────────────────────────────

describe('cli blobs', () => {
  it('prune: removes blobs older than --max-age-days', async () => {
    const oldBlobId = newId();
    const freshBlobId = newId();
    writeFileSync(join(env.blobDir, oldBlobId), 'data');
    writeFileSync(join(env.blobDir, freshBlobId), 'data');
    env.db
      .insert(blobs)
      .values([
        {
          id: oldBlobId,
          envelopeId: null,
          size: 4,
          sha256: 'x',
          uploadedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
        },
        {
          id: freshBlobId,
          envelopeId: null,
          size: 4,
          sha256: 'x',
          uploadedAt: new Date(Date.now() - 1 * 60 * 60 * 1000),
        },
      ])
      .run();

    const deps = makeDeps(env);
    await run(['blobs', 'prune', '--max-age-days', '7'], deps);
    expect(deps.captured.out).toMatch(/pruned 1/);

    const remaining = env.db.select().from(blobs).all();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.id).toBe(freshBlobId);
  });

  it('prune-orphans: removes blobs with no envelope reference', async () => {
    const orphan = newId();
    writeFileSync(join(env.blobDir, orphan), 'data');
    env.db
      .insert(blobs)
      .values({
        id: orphan,
        envelopeId: null,
        size: 4,
        sha256: 'x',
        uploadedAt: new Date(),
      })
      .run();

    const deps = makeDeps(env);
    const code = await run(['blobs', 'prune-orphans'], deps);
    expect(code).toBe(0);
    expect(deps.captured.out).toMatch(/pruned 1 orphan/);
    expect(env.db.select().from(blobs).all()).toHaveLength(0);
  });

  it('prune-orphans: empty state', async () => {
    const deps = makeDeps(env);
    await run(['blobs', 'prune-orphans'], deps);
    expect(deps.captured.out).toMatch(/no orphan blobs/);
  });

  it('prune: rejects nonsense --max-age-days', async () => {
    const deps = makeDeps(env);
    const code = await run(['blobs', 'prune', '--max-age-days', 'banana'], deps);
    expect(code).toBe(64);
    expect(deps.captured.err).toMatch(/invalid --max-age-days/);
  });
});

// ─── invites list / prune ────────────────────────────────────────────────────

describe('cli invites', () => {
  it('list: shows only active (non-used, non-expired) tokens', async () => {
    const now = Date.now();
    env.db
      .insert(inviteTokens)
      .values([
        {
          token: 'active-tok',
          userId: null,
          scope: 'signup',
          expiresAt: new Date(now + 3600_000),
        },
        {
          token: 'used-tok',
          userId: null,
          scope: 'signup',
          expiresAt: new Date(now + 3600_000),
          usedAt: new Date(now - 60_000),
        },
        {
          token: 'expired-tok',
          userId: null,
          scope: 'signup',
          expiresAt: new Date(now - 60_000),
        },
      ])
      .run();

    const deps = makeDeps(env);
    await run(['invites', 'list'], deps);
    expect(deps.captured.out).toContain('active-tok');
    expect(deps.captured.out).not.toContain('used-tok');
    expect(deps.captured.out).not.toContain('expired-tok');
  });

  it('prune: drops used and expired tokens, keeps active', async () => {
    const now = Date.now();
    env.db
      .insert(inviteTokens)
      .values([
        {
          token: 'keep',
          userId: null,
          scope: 'signup',
          expiresAt: new Date(now + 3600_000),
        },
        {
          token: 'expired',
          userId: null,
          scope: 'signup',
          expiresAt: new Date(now - 60_000),
        },
      ])
      .run();

    const deps = makeDeps(env);
    await run(['invites', 'prune'], deps);
    expect(deps.captured.out).toMatch(/pruned 1/);

    const left = env.db.select({ token: inviteTokens.token }).from(inviteTokens).all();
    expect(left.map((r) => r.token)).toEqual(['keep']);
  });
});

// ─── cleanup ─────────────────────────────────────────────────────────────────

describe('cli cleanup', () => {
  it('runs envelope/blob/invite prunes and reports totals', async () => {
    const sender = makeDevice(env.db);
    env.db
      .insert(envelopes)
      .values({
        id: newId(),
        fromDevice: sender.deviceId,
        expiresAt: new Date(Date.now() - 60_000),
        kind: 'url',
        size: 1,
        ciphertext: 'a',
        senderEphemeralPub: 'b',
        signature: 'expired-sig-1',
      })
      .run();
    env.db
      .insert(inviteTokens)
      .values({
        token: newToken(),
        userId: null,
        scope: 'signup',
        expiresAt: new Date(Date.now() - 60_000),
      })
      .run();

    const deps = makeDeps(env);
    const code = await run(['cleanup'], deps);
    expect(code).toBe(0);
    expect(deps.captured.out).toMatch(/1 envelope/);
    expect(deps.captured.out).toMatch(/1 invite/);
  });
});

// ─── backup ──────────────────────────────────────────────────────────────────

describe('cli backup', () => {
  it('writes a consistent SQLite snapshot + copies the blob dir', async () => {
    // Seed: one device (so the users + devices tables have rows) and one blob.
    const d = makeDevice(env.db, 'alice');
    const blobId = newId();
    writeFileSync(join(env.blobDir, blobId), 'sample blob payload');
    env.db
      .insert(blobs)
      .values({
        id: blobId,
        envelopeId: null,
        size: 19,
        sha256: 'placeholder',
        uploadedAt: new Date(),
      })
      .run();

    const outputDir = mkdtempSync(join(tmpdir(), 'routr-cli-backup-test-'));
    try {
      const deps = makeDeps(env);
      const code = await run(['backup', outputDir], deps);
      expect(code).toBe(0);
      expect(deps.captured.out).toMatch(/routr\.db/);
      expect(deps.captured.out).toMatch(/blobs\//);

      // Verify the backup DB exists and has the rows we put in.
      const backupDbPath = join(outputDir, 'routr.db');
      expect(statSync(backupDbPath).isFile()).toBe(true);
      const { raw: backupRaw, db: backupDb } = openDatabase(backupDbPath);
      try {
        const usersRow = backupRaw
          .prepare('select id, display_name from users where id = ?')
          .get(d.userId) as { id: string; display_name: string } | undefined;
        expect(usersRow).toBeDefined();
        expect(usersRow?.display_name).toBe('alice');
        const deviceRow = backupRaw
          .prepare('select id from devices where id = ?')
          .get(d.deviceId) as { id: string } | undefined;
        expect(deviceRow?.id).toBe(d.deviceId);
        void backupDb; // unused, but keeps drizzle handle alive symmetrically
      } finally {
        backupRaw.close();
      }

      // Verify the blob file made it.
      const copiedBlob = join(outputDir, 'blobs', blobId);
      expect(statSync(copiedBlob).isFile()).toBe(true);
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it('creates the output dir if it does not exist', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'routr-cli-backup-parent-'));
    const outputDir = join(parent, 'fresh', 'nested', 'dir');
    try {
      const deps = makeDeps(env);
      const code = await run(['backup', outputDir], deps);
      expect(code).toBe(0);
      expect(statSync(outputDir).isDirectory()).toBe(true);
      expect(statSync(join(outputDir, 'routr.db')).isFile()).toBe(true);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('handles a missing/empty blob dir by emitting an empty blobs/ subdir', async () => {
    // Replace the env's blob dir with a path that doesn't exist.
    const missingBlobs = join(tmpdir(), `routr-missing-${Date.now()}`);
    const deps: CliDeps & { captured: Captured } = makeDeps(env);
    // biome-ignore lint/suspicious/noExplicitAny: test override
    (deps as any).blobDir = missingBlobs;

    const outputDir = mkdtempSync(join(tmpdir(), 'routr-cli-backup-empty-'));
    try {
      const code = await run(['backup', outputDir], deps);
      expect(code).toBe(0);
      expect(statSync(join(outputDir, 'blobs')).isDirectory()).toBe(true);
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it('missing positional shows usage', async () => {
    const deps = makeDeps(env);
    const code = await run(['backup'], deps);
    expect(code).toBe(64);
    expect(deps.captured.err).toMatch(/usage: backup/);
  });
});

// ─── dispatch / help ─────────────────────────────────────────────────────────

describe('cli dispatch', () => {
  it('help: prints usage', async () => {
    const deps = makeDeps(env);
    const code = await run(['help'], deps);
    expect(code).toBe(0);
    expect(deps.captured.out).toMatch(/Commands:/);
  });

  it('no args: prints usage', async () => {
    const deps = makeDeps(env);
    const code = await run([], deps);
    expect(code).toBe(0);
    expect(deps.captured.out).toMatch(/Commands:/);
  });

  it('unknown command: exits 64 with hint', async () => {
    const deps = makeDeps(env);
    const code = await run(['quack'], deps);
    expect(code).toBe(64);
    expect(deps.captured.err).toMatch(/unknown command/);
  });

  it('unknown subcommand: exits 64', async () => {
    const deps = makeDeps(env);
    const code = await run(['users', 'fly'], deps);
    expect(code).toBe(64);
    expect(deps.captured.err).toMatch(/unknown users subcommand/);
  });
});
