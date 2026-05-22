import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  db: Db,
  blobDir: string,
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
    db,
    blobDir,
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

function setup(): {
  db: Db;
  blobDir: string;
  cleanup: () => void;
} {
  const { db } = openDatabase(':memory:');
  migrate(db, { migrationsFolder: MIGRATIONS });
  const blobDir = mkdtempSync(join(tmpdir(), 'routr-cli-test-'));
  return {
    db,
    blobDir,
    cleanup: () => rmSync(blobDir, { recursive: true, force: true }),
  };
}

let env: ReturnType<typeof setup>;

beforeEach(() => {
  env = setup();
});

afterEach(() => {
  env.cleanup();
});

// ─── stats ───────────────────────────────────────────────────────────────────

describe('cli stats', () => {
  it('reports zeros on an empty database', async () => {
    const deps = makeDeps(env.db, env.blobDir);
    const code = await run(['stats'], deps);
    expect(code).toBe(0);
    expect(deps.captured.out).toMatch(/users\s+0/);
    expect(deps.captured.out).toMatch(/devices\s+0/);
  });

  it('reports current counts after seeding', async () => {
    makeDevice(env.db);
    makeDevice(env.db, 'second');
    const deps = makeDeps(env.db, env.blobDir);
    await run(['stats'], deps);
    // Two registrations create two users (no invite ties them together).
    expect(deps.captured.out).toMatch(/users\s+2/);
    expect(deps.captured.out).toMatch(/devices\s+2/);
  });

  it('emits parseable JSON with --json', async () => {
    makeDevice(env.db);
    const deps = makeDeps(env.db, env.blobDir);
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
    const deps = makeDeps(env.db, env.blobDir);
    await run(['users', 'list'], deps);
    expect(deps.captured.out).toContain(d1.userId);
    expect(deps.captured.out).toMatch(/1/); // device count column
  });

  it('list --json: outputs an array with deviceCount', async () => {
    makeDevice(env.db);
    const deps = makeDeps(env.db, env.blobDir);
    await run(['users', 'list', '--json'], deps);
    const parsed = JSON.parse(deps.captured.out) as Array<Record<string, unknown>>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.deviceCount).toBe(1);
  });

  it('remove: cascades to devices when confirmed', async () => {
    const d = makeDevice(env.db);
    const deps = makeDeps(env.db, env.blobDir, { confirmReply: true });
    const code = await run(['users', 'remove', d.userId], deps);
    expect(code).toBe(0);
    expect(deps.captured.out).toMatch(/deleted user/);
    // Verify cascade: no devices left.
    const after = makeDeps(env.db, env.blobDir);
    await run(['stats', '--json'], after);
    expect(JSON.parse(after.captured.out)).toMatchObject({ users: 0, devices: 0 });
  });

  it('remove: aborts when confirm declined', async () => {
    const d = makeDevice(env.db);
    const deps = makeDeps(env.db, env.blobDir, { confirmReply: false });
    const code = await run(['users', 'remove', d.userId], deps);
    expect(code).toBe(2);
    expect(deps.captured.err).toMatch(/aborted/);
    // Still there.
    const after = makeDeps(env.db, env.blobDir);
    await run(['stats', '--json'], after);
    expect(JSON.parse(after.captured.out)).toMatchObject({ users: 1 });
  });

  it('remove --force: skips confirmation', async () => {
    const d = makeDevice(env.db);
    // confirmReply: false would normally abort — --force ignores it.
    const deps = makeDeps(env.db, env.blobDir, { confirmReply: false });
    const code = await run(['users', 'remove', d.userId, '--force'], deps);
    expect(code).toBe(0);
  });

  it('remove: errors on unknown user', async () => {
    const deps = makeDeps(env.db, env.blobDir);
    const code = await run(['users', 'remove', 'nope', '--force'], deps);
    expect(code).toBe(1);
    expect(deps.captured.err).toMatch(/not found/);
  });

  it('remove: missing positional shows usage', async () => {
    const deps = makeDeps(env.db, env.blobDir);
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
    const deps = makeDeps(env.db, env.blobDir);
    await run(['devices', 'list'], deps);
    expect(deps.captured.out).toContain(d1.deviceId);
    expect(deps.captured.out).toContain(d2.deviceId);
  });

  it('list --user-id: filters to one user', async () => {
    const d1 = makeDevice(env.db, 'phone');
    const d2 = makeDevice(env.db, 'laptop'); // different user
    const deps = makeDeps(env.db, env.blobDir);
    await run(['devices', 'list', '--user-id', d1.userId], deps);
    expect(deps.captured.out).toContain(d1.deviceId);
    expect(deps.captured.out).not.toContain(d2.deviceId);
  });

  it('remove: deletes the device', async () => {
    const d = makeDevice(env.db);
    const deps = makeDeps(env.db, env.blobDir, { confirmReply: true });
    const code = await run(['devices', 'remove', d.deviceId], deps);
    expect(code).toBe(0);
    const after = makeDeps(env.db, env.blobDir);
    await run(['stats', '--json'], after);
    expect(JSON.parse(after.captured.out)).toMatchObject({ devices: 0 });
  });

  it('remove: errors on unknown device', async () => {
    const deps = makeDeps(env.db, env.blobDir);
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

    const deps = makeDeps(env.db, env.blobDir);
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

    const deps = makeDeps(env.db, env.blobDir);
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

    const deps = makeDeps(env.db, env.blobDir);
    const code = await run(['blobs', 'prune-orphans'], deps);
    expect(code).toBe(0);
    expect(deps.captured.out).toMatch(/pruned 1 orphan/);
    expect(env.db.select().from(blobs).all()).toHaveLength(0);
  });

  it('prune-orphans: empty state', async () => {
    const deps = makeDeps(env.db, env.blobDir);
    await run(['blobs', 'prune-orphans'], deps);
    expect(deps.captured.out).toMatch(/no orphan blobs/);
  });

  it('prune: rejects nonsense --max-age-days', async () => {
    const deps = makeDeps(env.db, env.blobDir);
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

    const deps = makeDeps(env.db, env.blobDir);
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

    const deps = makeDeps(env.db, env.blobDir);
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

    const deps = makeDeps(env.db, env.blobDir);
    const code = await run(['cleanup'], deps);
    expect(code).toBe(0);
    expect(deps.captured.out).toMatch(/1 envelope/);
    expect(deps.captured.out).toMatch(/1 invite/);
  });
});

// ─── dispatch / help ─────────────────────────────────────────────────────────

describe('cli dispatch', () => {
  it('help: prints usage', async () => {
    const deps = makeDeps(env.db, env.blobDir);
    const code = await run(['help'], deps);
    expect(code).toBe(0);
    expect(deps.captured.out).toMatch(/Commands:/);
  });

  it('no args: prints usage', async () => {
    const deps = makeDeps(env.db, env.blobDir);
    const code = await run([], deps);
    expect(code).toBe(0);
    expect(deps.captured.out).toMatch(/Commands:/);
  });

  it('unknown command: exits 64 with hint', async () => {
    const deps = makeDeps(env.db, env.blobDir);
    const code = await run(['quack'], deps);
    expect(code).toBe(64);
    expect(deps.captured.err).toMatch(/unknown command/);
  });

  it('unknown subcommand: exits 64', async () => {
    const deps = makeDeps(env.db, env.blobDir);
    const code = await run(['users', 'fly'], deps);
    expect(code).toBe(64);
    expect(deps.captured.err).toMatch(/unknown users subcommand/);
  });
});
