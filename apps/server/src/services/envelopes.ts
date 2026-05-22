import { b64uToBytes, verify } from '@routr/crypto';
import { type Envelope, envelopeSignedForm } from '@routr/protocol';
import { and, eq, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { devices, envelopes, recipients } from '../db/schema.js';
import { newId } from '../ids.js';

export type SubmitResult =
  | { ok: true; id: string; deliveredToOnline: string[] }
  | {
      ok: false;
      reason:
        | 'unknown_sender'
        | 'bad_signature'
        | 'recipient_not_found'
        | 'mismatched_wrapped_keys'
        | 'expired'
        | 'duplicate';
    };

export type InboxItem = {
  id: string;
  fromDevice: string;
  createdAt: number;
  expiresAt: number;
  kind: 'url' | 'file' | 'control';
  size: number;
  ciphertext: string;
  senderEphemeralPub: string;
  wrappedKey: string;
  signature: string;
};

/**
 * Validate and accept an envelope from a sender device. Returns the
 * envelope ID (server-assigned) plus the recipient device IDs that were
 * online and got a live push. Recipients that were offline will get the
 * envelope on their next WS connect via {@link listPendingFor}.
 */
export function submitEnvelope(db: Db, env: Envelope): SubmitResult {
  if (env.expiresAt < Date.now()) {
    return { ok: false, reason: 'expired' };
  }

  const wrappedDeviceIds = Object.keys(env.wrappedKeys).sort();
  const toSorted = [...env.to].sort();
  if (
    wrappedDeviceIds.length !== toSorted.length ||
    wrappedDeviceIds.some((k, i) => k !== toSorted[i])
  ) {
    return { ok: false, reason: 'mismatched_wrapped_keys' };
  }

  const sender = db.select().from(devices).where(eq(devices.id, env.from)).get();
  if (!sender) return { ok: false, reason: 'unknown_sender' };

  // Verify signature over the canonical form of the envelope sans id+signature.
  // We use the raw object as it came in over the wire.
  const canonical = envelopeSignedForm(env as unknown as Record<string, unknown>);
  const senderPub = b64uToBytes(sender.signPub);
  const sigBytes = b64uToBytes(env.signature);
  if (!verify(senderPub, sigBytes, new TextEncoder().encode(canonical))) {
    return { ok: false, reason: 'bad_signature' };
  }

  // Confirm every recipient exists.
  for (const deviceId of env.to) {
    const r = db.select({ id: devices.id }).from(devices).where(eq(devices.id, deviceId)).get();
    if (!r) return { ok: false, reason: 'recipient_not_found' };
  }

  const id = newId();
  try {
    db.transaction((tx) => {
      tx.insert(envelopes)
        .values({
          id,
          fromDevice: env.from,
          expiresAt: new Date(env.expiresAt),
          kind: env.kind,
          size: env.size,
          ciphertext: env.ciphertext,
          senderEphemeralPub: env.senderEphemeralPub,
          signature: env.signature,
        })
        .run();
      for (const deviceId of env.to) {
        tx.insert(recipients)
          .values({
            envelopeId: id,
            deviceId,
            wrappedKey: env.wrappedKeys[deviceId] ?? '',
          })
          .run();
      }
    });
  } catch (err) {
    // The signature column has a UNIQUE index — duplicate replays hit it.
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('UNIQUE') && msg.includes('signature')) {
      return { ok: false, reason: 'duplicate' };
    }
    throw err;
  }

  return { ok: true, id, deliveredToOnline: [] };
}

/**
 * Inbox: every undelivered envelope for this device. Caller drains and
 * client acks individually.
 */
export function listPendingFor(db: Db, deviceId: string): InboxItem[] {
  const rows = db
    .select({
      envelopeId: envelopes.id,
      fromDevice: envelopes.fromDevice,
      createdAt: envelopes.createdAt,
      expiresAt: envelopes.expiresAt,
      kind: envelopes.kind,
      size: envelopes.size,
      ciphertext: envelopes.ciphertext,
      senderEphemeralPub: envelopes.senderEphemeralPub,
      signature: envelopes.signature,
      wrappedKey: recipients.wrappedKey,
    })
    .from(recipients)
    .innerJoin(envelopes, eq(envelopes.id, recipients.envelopeId))
    .where(and(eq(recipients.deviceId, deviceId), isNull(recipients.ackedAt)))
    .all();

  return rows.map((r) => ({
    id: r.envelopeId,
    fromDevice: r.fromDevice,
    createdAt: r.createdAt.getTime(),
    expiresAt: r.expiresAt.getTime(),
    kind: r.kind,
    size: r.size,
    ciphertext: r.ciphertext,
    senderEphemeralPub: r.senderEphemeralPub,
    wrappedKey: r.wrappedKey,
    signature: r.signature,
  }));
}

export type AckResult = { ok: true; deleted: boolean } | { ok: false; reason: 'not_found' };

/**
 * Mark this recipient's row acked. If all recipient rows for the envelope
 * are now acked, delete the envelope (which cascade-deletes recipients).
 */
export function ackEnvelope(db: Db, envelopeId: string, deviceId: string): AckResult {
  return db.transaction((tx) => {
    const result = tx
      .update(recipients)
      .set({ ackedAt: new Date() })
      .where(
        and(
          eq(recipients.envelopeId, envelopeId),
          eq(recipients.deviceId, deviceId),
          isNull(recipients.ackedAt),
        ),
      )
      .run();
    if (result.changes === 0) {
      const existing = tx
        .select({ id: recipients.envelopeId, ackedAt: recipients.ackedAt })
        .from(recipients)
        .where(and(eq(recipients.envelopeId, envelopeId), eq(recipients.deviceId, deviceId)))
        .get();
      if (!existing) {
        return { ok: false, reason: 'not_found' } as const;
      }
      // Row exists but already acked — still ok.
    }

    const unacked = tx
      .select({ n: sql<number>`count(*)` })
      .from(recipients)
      .where(and(eq(recipients.envelopeId, envelopeId), isNull(recipients.ackedAt)))
      .get();

    if ((unacked?.n ?? 0) === 0) {
      tx.delete(envelopes).where(eq(envelopes.id, envelopeId)).run();
      return { ok: true, deleted: true } as const;
    }
    return { ok: true, deleted: false } as const;
  });
}

/** Count of envelopes still pending for this device. For tests / metrics. */
export function pendingCountFor(db: Db, deviceId: string): number {
  const row = db
    .select({ n: sql<number>`count(*)` })
    .from(recipients)
    .where(and(eq(recipients.deviceId, deviceId), isNull(recipients.ackedAt)))
    .get();
  return row?.n ?? 0;
}

/** Tests: deleted-when-all-acked sanity check. */
export function envelopeExists(db: Db, envelopeId: string): boolean {
  const r = db
    .select({ id: envelopes.id })
    .from(envelopes)
    .where(eq(envelopes.id, envelopeId))
    .get();
  return !!r;
}

// Silence unused-import linter for combinators we may need later.
void isNotNull;

/**
 * Delete envelopes whose `expiresAt` is in the past. Recipients cascade
 * via the FK ON DELETE. Returns the number of deleted rows.
 *
 * Called periodically by main.ts (and could be called opportunistically
 * from the request path if we wanted to bound table growth more tightly).
 */
export function cleanupExpiredEnvelopes(db: Db, now: Date = new Date()): number {
  const result = db.delete(envelopes).where(lt(envelopes.expiresAt, now)).run();
  return result.changes;
}
