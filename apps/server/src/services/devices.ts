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
