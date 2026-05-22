import { count, eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { devices, users } from '../db/schema.js';
import { newId } from '../ids.js';
import { consumeInvite } from './invites.js';

export type RegisterDeviceArgs = {
  name: string;
  platform: string;
  signPub: string;
  kexPub: string;
  invite?: string;
};

export type RegisterDeviceResult =
  | { ok: true; deviceId: string; userId: string }
  | { ok: false; reason: 'invite_required' | 'invite_invalid' | 'duplicate_key' };

/**
 * Register a new device.
 *
 *   - No users in the DB AND no invite → bootstrap a new user owning this
 *     device. (First-run convenience: the very first person to hit a fresh
 *     server claims it.)
 *   - Invite with scope=signup → create a new user owning this device.
 *   - Invite with scope=pair_device → attach this device to the user
 *     referenced by the invite (an existing device on that account issued
 *     the invite).
 *   - Anything else → reject.
 */
export function registerDevice(db: Db, args: RegisterDeviceArgs): RegisterDeviceResult {
  return db.transaction((tx) => {
    const existing = tx
      .select({ id: devices.id })
      .from(devices)
      .where(eq(devices.signPub, args.signPub))
      .get();
    if (existing) return { ok: false, reason: 'duplicate_key' } as const;

    let userId: string;

    if (args.invite) {
      const invite = consumeInvite(tx, args.invite);
      if (!invite) return { ok: false, reason: 'invite_invalid' } as const;

      if (invite.scope === 'signup') {
        userId = newId();
        tx.insert(users).values({ id: userId, displayName: args.name }).run();
      } else if (invite.scope === 'pair_device') {
        if (!invite.userId) return { ok: false, reason: 'invite_invalid' } as const;
        userId = invite.userId;
      } else {
        return { ok: false, reason: 'invite_invalid' } as const;
      }
    } else {
      const [usersRow] = tx.select({ n: count() }).from(users).all();
      if (!usersRow || usersRow.n > 0) {
        return { ok: false, reason: 'invite_required' } as const;
      }
      userId = newId();
      tx.insert(users).values({ id: userId, displayName: args.name }).run();
    }

    const deviceId = newId();
    tx.insert(devices)
      .values({
        id: deviceId,
        userId,
        name: args.name,
        platform: args.platform,
        signPub: args.signPub,
        kexPub: args.kexPub,
      })
      .run();
    return { ok: true, deviceId, userId } as const;
  });
}

export function getDeviceById(db: Db, id: string) {
  return db.select().from(devices).where(eq(devices.id, id)).get();
}

export function listDevicesForUser(db: Db, userId: string) {
  return db
    .select({
      id: devices.id,
      name: devices.name,
      platform: devices.platform,
      kexPub: devices.kexPub,
      signPub: devices.signPub,
    })
    .from(devices)
    .where(eq(devices.userId, userId))
    .all();
}

export type RevokeResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' | 'cross_user' | 'self_revoke' };

/**
 * Revoke a device — hard-delete the row. The schema FKs cascade so the
 * device's sent envelopes, recipients, and trusts are removed too.
 *
 * Constraints:
 *   - The revoker must be a different device than the target (`requesterDeviceId !== targetDeviceId`).
 *   - The two devices must belong to the same user.
 *
 * Self-revoke is intentionally disallowed: if a device is compromised, the
 * attacker would just self-revoke other devices. We require a different
 * device to issue the revocation — this lets the user revoke a stolen
 * phone from their laptop, but doesn't let the stolen phone revoke the
 * laptop.
 */
export function revokeDevice(
  db: Db,
  requesterDeviceId: string,
  targetDeviceId: string,
): RevokeResult {
  if (requesterDeviceId === targetDeviceId) {
    return { ok: false, reason: 'self_revoke' };
  }
  const requester = db
    .select({ userId: devices.userId })
    .from(devices)
    .where(eq(devices.id, requesterDeviceId))
    .get();
  const target = db
    .select({ userId: devices.userId })
    .from(devices)
    .where(eq(devices.id, targetDeviceId))
    .get();
  if (!target) return { ok: false, reason: 'not_found' };
  if (!requester || requester.userId !== target.userId) {
    return { ok: false, reason: 'cross_user' };
  }
  db.delete(devices).where(eq(devices.id, targetDeviceId)).run();
  return { ok: true };
}
