import { and, eq, isNotNull, isNull, lt, or } from 'drizzle-orm';
import type { Db, DbExecutor } from '../db/index.js';
import { inviteTokens } from '../db/schema.js';
import { newToken } from '../ids.js';

export type InviteScope = 'signup' | 'pair_device' | 'peer';

export type Invite = {
  token: string;
  userId: string | null;
  scope: InviteScope;
  expiresAt: number;
};

export function createInvite(
  db: Db,
  args: { scope: InviteScope; userId: string | null; ttlMs: number },
): Invite {
  const token = newToken();
  const expiresAt = Date.now() + args.ttlMs;
  db.insert(inviteTokens)
    .values({
      token,
      userId: args.userId,
      scope: args.scope,
      expiresAt: new Date(expiresAt),
    })
    .run();
  return { token, userId: args.userId, scope: args.scope, expiresAt };
}

/**
 * Look up and mark a token as used. Returns null if the token doesn't
 * exist, is expired, or has already been used.
 *
 * Designed to be called from within an enclosing transaction (so the
 * "consume" is atomic with whatever the caller does next, e.g. inserting
 * a device row). Pass either a Db or a transaction handle.
 */
export function consumeInvite(tx: DbExecutor, token: string): Invite | null {
  const row = tx
    .select()
    .from(inviteTokens)
    .where(and(eq(inviteTokens.token, token), isNull(inviteTokens.usedAt)))
    .get();
  if (!row) return null;
  if (row.expiresAt.getTime() < Date.now()) return null;
  tx.update(inviteTokens).set({ usedAt: new Date() }).where(eq(inviteTokens.token, token)).run();
  return {
    token: row.token,
    userId: row.userId,
    scope: row.scope as InviteScope,
    expiresAt: row.expiresAt.getTime(),
  };
}

/**
 * Delete used invites + expired-but-unused invites. Used invites can be
 * removed immediately after redemption (they're single-use); expired
 * unused ones are dead by definition.
 */
export function cleanupInvites(db: Db, now: Date = new Date()): number {
  const result = db
    .delete(inviteTokens)
    .where(or(isNotNull(inviteTokens.usedAt), lt(inviteTokens.expiresAt, now)))
    .run();
  return result.changes;
}
