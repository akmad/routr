import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  bytesToB64u,
  encryptPayload,
  generateEphemeral,
  generateIdentity,
  sign,
  wrapKey,
} from '@routr/crypto';
import { canonicalize } from '@routr/protocol';
import { PROTOCOL_VERSION } from '@routr/protocol';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import type { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { type AppEnv, createApp } from '../src/app.js';
import { buildSignedRequestString } from '../src/auth.js';
import { type Db, openDatabase } from '../src/db/index.js';
import { newId } from '../src/ids.js';
import { createLogger } from '../src/logger.js';
import { registerDevice } from '../src/services/devices.js';
import {
  ackEnvelope,
  ackEnvelopesBulk,
  cleanupExpiredEnvelopes,
  envelopeExists,
  listPendingFor,
  pendingCountFor,
  submitEnvelope,
} from '../src/services/envelopes.js';
import { createInvite } from '../src/services/invites.js';

const MIGRATIONS = resolve(fileURLToPath(import.meta.url), '../../drizzle');

function makeDb(): Db {
  const { db } = openDatabase(':memory:');
  migrate(db, { migrationsFolder: MIGRATIONS });
  return db;
}

function makeTestApp(): { app: Hono<AppEnv>; db: Db } {
  const db = makeDb();
  const log = createLogger({ logLevel: 'fatal' });
  const { app } = createApp({ db, log, disableRateLimits: true });
  return { app, db };
}

/** Create a signed Envelope as a sender device would. */
function makeEnvelope(
  senderIdentity: ReturnType<typeof generateIdentity>,
  senderDeviceId: string,
  recipientDeviceId: string,
  recipientKexPub: Uint8Array,
) {
  const plaintext = new TextEncoder().encode(
    JSON.stringify({ kind: 'url', url: 'https://example.com' }),
  );
  const { payloadKey, ciphertext } = encryptPayload(plaintext);
  const ephem = generateEphemeral();
  const wrapped = wrapKey(
    payloadKey,
    ephem.secretKey,
    ephem.publicKey,
    recipientKexPub,
    recipientDeviceId,
  );

  const now = Date.now();
  const envelope = {
    v: PROTOCOL_VERSION,
    id: '',
    from: senderDeviceId,
    to: [recipientDeviceId],
    createdAt: now,
    expiresAt: now + 86400_000,
    kind: 'url' as const,
    size: plaintext.length,
    ciphertext: bytesToB64u(ciphertext),
    senderEphemeralPub: bytesToB64u(ephem.publicKey),
    wrappedKeys: { [recipientDeviceId]: bytesToB64u(wrapped) },
    signature: '',
  };

  const signedForm = canonicalize(
    Object.fromEntries(Object.entries(envelope).filter(([k]) => k !== 'id' && k !== 'signature')),
  );
  const sig = sign(senderIdentity.sign.secretKey, new TextEncoder().encode(signedForm));
  return { ...envelope, signature: bytesToB64u(sig) };
}

describe('submitEnvelope', () => {
  let db: Db;
  let senderIdentity: ReturnType<typeof generateIdentity>;
  let recipientIdentity: ReturnType<typeof generateIdentity>;
  let senderDeviceId: string;
  let recipientDeviceId: string;

  beforeEach(() => {
    db = makeDb();
    senderIdentity = generateIdentity();
    recipientIdentity = generateIdentity();
    const r1 = registerDevice(db, {
      name: 'sender',
      platform: 'web',
      signPub: bytesToB64u(senderIdentity.sign.publicKey),
      kexPub: bytesToB64u(senderIdentity.kex.publicKey),
    });
    if (!r1.ok) throw new Error('r1 registration failed');
    // r1 bootstrap created a user; r2 needs a signup invite for its own user.
    const invite = createInvite(db, { scope: 'signup', userId: null, ttlMs: 60_000 });
    const r2 = registerDevice(db, {
      name: 'recipient',
      platform: 'android',
      signPub: bytesToB64u(recipientIdentity.sign.publicKey),
      kexPub: bytesToB64u(recipientIdentity.kex.publicKey),
      invite: invite.token,
    });
    if (!r2.ok) throw new Error(`r2 registration failed: ${r2.reason}`);
    senderDeviceId = r1.deviceId;
    recipientDeviceId = r2.deviceId;
  });

  it('stores an envelope and makes it visible in the inbox', () => {
    const env = makeEnvelope(
      senderIdentity,
      senderDeviceId,
      recipientDeviceId,
      recipientIdentity.kex.publicKey,
    );
    const result = submitEnvelope(db, env);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const pending = listPendingFor(db, recipientDeviceId);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.kind).toBe('url');
    expect(pending[0]?.fromDevice).toBe(senderDeviceId);
  });

  it('rejects an expired envelope', () => {
    const env = makeEnvelope(
      senderIdentity,
      senderDeviceId,
      recipientDeviceId,
      recipientIdentity.kex.publicKey,
    );
    const expired = { ...env, expiresAt: Date.now() - 1 };
    const result = submitEnvelope(db, expired);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('expired');
  });

  it('rejects a tampered signature', () => {
    const env = makeEnvelope(
      senderIdentity,
      senderDeviceId,
      recipientDeviceId,
      recipientIdentity.kex.publicKey,
    );
    const tampered = { ...env, signature: bytesToB64u(new Uint8Array(64)) };
    const result = submitEnvelope(db, tampered);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('bad_signature');
  });

  it('rejects mismatched wrappedKeys vs to', () => {
    const env = makeEnvelope(
      senderIdentity,
      senderDeviceId,
      recipientDeviceId,
      recipientIdentity.kex.publicKey,
    );
    const mismatched = { ...env, wrappedKeys: { WRONGDEVICEIDAAAAAAAAAAAA0: 'abc' } };
    const result = submitEnvelope(db, mismatched);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('mismatched_wrapped_keys');
  });

  it('rejects unknown recipient device', () => {
    const env = makeEnvelope(
      senderIdentity,
      senderDeviceId,
      recipientDeviceId,
      recipientIdentity.kex.publicKey,
    );
    const fakeId = newId();
    const unknown = {
      ...env,
      to: [fakeId],
      wrappedKeys: { [fakeId]: bytesToB64u(new Uint8Array(48)) },
    };
    // Re-sign with the modified to/wrappedKeys.
    const signedForm = canonicalize(
      Object.fromEntries(Object.entries(unknown).filter(([k]) => k !== 'id' && k !== 'signature')),
    );
    const sig = sign(senderIdentity.sign.secretKey, new TextEncoder().encode(signedForm));
    const result = submitEnvelope(db, { ...unknown, signature: bytesToB64u(sig) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('recipient_not_found');
  });

  it('accepts an envelope addressed to multiple recipients (multi-wrappedKeys)', () => {
    // Register a third device on a third user so we have two recipients.
    const recipient2Identity = generateIdentity();
    const inv2 = createInvite(db, { scope: 'signup', userId: null, ttlMs: 60_000 });
    const r3 = registerDevice(db, {
      name: 'recipient2',
      platform: 'ios',
      signPub: bytesToB64u(recipient2Identity.sign.publicKey),
      kexPub: bytesToB64u(recipient2Identity.kex.publicKey),
      invite: inv2.token,
    });
    if (!r3.ok) throw new Error('r3');

    // Build an envelope with two recipients (each wrapped separately).
    const plaintext = new TextEncoder().encode(
      JSON.stringify({ kind: 'url', url: 'https://multi.example.com' }),
    );
    const { payloadKey, ciphertext } = encryptPayload(plaintext);
    const ephem = generateEphemeral();
    const wrapped1 = wrapKey(
      payloadKey,
      ephem.secretKey,
      ephem.publicKey,
      recipientIdentity.kex.publicKey,
      recipientDeviceId,
    );
    const wrapped2 = wrapKey(
      payloadKey,
      ephem.secretKey,
      ephem.publicKey,
      recipient2Identity.kex.publicKey,
      r3.deviceId,
    );
    const now = Date.now();
    const env = {
      v: PROTOCOL_VERSION,
      id: '',
      from: senderDeviceId,
      to: [recipientDeviceId, r3.deviceId],
      createdAt: now,
      expiresAt: now + 86400_000,
      kind: 'url' as const,
      size: plaintext.length,
      ciphertext: bytesToB64u(ciphertext),
      senderEphemeralPub: bytesToB64u(ephem.publicKey),
      wrappedKeys: {
        [recipientDeviceId]: bytesToB64u(wrapped1),
        [r3.deviceId]: bytesToB64u(wrapped2),
      },
      signature: '',
    };
    const signedForm = canonicalize(
      Object.fromEntries(Object.entries(env).filter(([k]) => k !== 'id' && k !== 'signature')),
    );
    const sig = sign(senderIdentity.sign.secretKey, new TextEncoder().encode(signedForm));
    const result = submitEnvelope(db, { ...env, signature: bytesToB64u(sig) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Each recipient sees the envelope in their own pending list.
    expect(pendingCountFor(db, recipientDeviceId)).toBe(1);
    expect(pendingCountFor(db, r3.deviceId)).toBe(1);
  });

  it('rejects a byte-identical replay (UNIQUE signature)', () => {
    const env = makeEnvelope(
      senderIdentity,
      senderDeviceId,
      recipientDeviceId,
      recipientIdentity.kex.publicKey,
    );
    const first = submitEnvelope(db, env);
    expect(first.ok).toBe(true);
    const replay = submitEnvelope(db, env);
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.reason).toBe('duplicate');
  });
});

describe('cleanupExpiredEnvelopes', () => {
  it('deletes envelopes whose expiresAt is past', () => {
    const db = makeDb();
    const senderIdentity = generateIdentity();
    const recipientIdentity = generateIdentity();
    const r1 = registerDevice(db, {
      name: 'sender',
      platform: 'web',
      signPub: bytesToB64u(senderIdentity.sign.publicKey),
      kexPub: bytesToB64u(senderIdentity.kex.publicKey),
    });
    if (!r1.ok) throw new Error('r1');
    const inv = createInvite(db, { scope: 'signup', userId: null, ttlMs: 60_000 });
    const r2 = registerDevice(db, {
      name: 'recipient',
      platform: 'android',
      signPub: bytesToB64u(recipientIdentity.sign.publicKey),
      kexPub: bytesToB64u(recipientIdentity.kex.publicKey),
      invite: inv.token,
    });
    if (!r2.ok) throw new Error('r2');

    const env = makeEnvelope(
      senderIdentity,
      r1.deviceId,
      r2.deviceId,
      recipientIdentity.kex.publicKey,
    );
    const submit = submitEnvelope(db, env);
    if (!submit.ok) throw new Error('submit');

    // The envelope's expiresAt is now + 86400_000 — sweep at way-future shows 1 deleted.
    const future = new Date(Date.now() + 100 * 86400_000);
    const deleted = cleanupExpiredEnvelopes(db, future);
    expect(deleted).toBe(1);
    expect(envelopeExists(db, submit.id)).toBe(false);
  });

  it('leaves non-expired envelopes alone', () => {
    const db = makeDb();
    const senderIdentity = generateIdentity();
    const recipientIdentity = generateIdentity();
    const r1 = registerDevice(db, {
      name: 'sender',
      platform: 'web',
      signPub: bytesToB64u(senderIdentity.sign.publicKey),
      kexPub: bytesToB64u(senderIdentity.kex.publicKey),
    });
    if (!r1.ok) throw new Error('r1');
    const inv = createInvite(db, { scope: 'signup', userId: null, ttlMs: 60_000 });
    const r2 = registerDevice(db, {
      name: 'recipient',
      platform: 'android',
      signPub: bytesToB64u(recipientIdentity.sign.publicKey),
      kexPub: bytesToB64u(recipientIdentity.kex.publicKey),
      invite: inv.token,
    });
    if (!r2.ok) throw new Error('r2');

    const env = makeEnvelope(
      senderIdentity,
      r1.deviceId,
      r2.deviceId,
      recipientIdentity.kex.publicKey,
    );
    const submit = submitEnvelope(db, env);
    if (!submit.ok) throw new Error('submit');

    const deleted = cleanupExpiredEnvelopes(db, new Date());
    expect(deleted).toBe(0);
    expect(envelopeExists(db, submit.id)).toBe(true);
  });
});

describe('ackEnvelope', () => {
  let db: Db;
  let senderIdentity: ReturnType<typeof generateIdentity>;
  let recipientIdentity: ReturnType<typeof generateIdentity>;
  let senderDeviceId: string;
  let recipientDeviceId: string;

  beforeEach(() => {
    db = makeDb();
    senderIdentity = generateIdentity();
    recipientIdentity = generateIdentity();
    const r1 = registerDevice(db, {
      name: 'sender',
      platform: 'web',
      signPub: bytesToB64u(senderIdentity.sign.publicKey),
      kexPub: bytesToB64u(senderIdentity.kex.publicKey),
    });
    if (!r1.ok) throw new Error('setup failed: r1');
    const inv2 = createInvite(db, { scope: 'signup', userId: null, ttlMs: 60_000 });
    const r2 = registerDevice(db, {
      name: 'recipient',
      platform: 'android',
      signPub: bytesToB64u(recipientIdentity.sign.publicKey),
      kexPub: bytesToB64u(recipientIdentity.kex.publicKey),
      invite: inv2.token,
    });
    if (!r2.ok) throw new Error('setup failed: r2');
    senderDeviceId = r1.deviceId;
    recipientDeviceId = r2.deviceId;
  });

  it('acks and deletes when all recipients acked', () => {
    const env = makeEnvelope(
      senderIdentity,
      senderDeviceId,
      recipientDeviceId,
      recipientIdentity.kex.publicKey,
    );
    const submit = submitEnvelope(db, env);
    if (!submit.ok) throw new Error('submit failed');

    expect(pendingCountFor(db, recipientDeviceId)).toBe(1);
    const ack = ackEnvelope(db, submit.id, recipientDeviceId);
    expect(ack).toEqual({ ok: true, deleted: true });
    expect(pendingCountFor(db, recipientDeviceId)).toBe(0);
    expect(envelopeExists(db, submit.id)).toBe(false);
  });

  it('returns not_found for a nonexistent envelope/device pair', () => {
    const result = ackEnvelope(db, newId(), recipientDeviceId);
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it('double-ack after cascade-delete returns not_found', () => {
    const env = makeEnvelope(
      senderIdentity,
      senderDeviceId,
      recipientDeviceId,
      recipientIdentity.kex.publicKey,
    );
    const submit = submitEnvelope(db, env);
    if (!submit.ok) throw new Error('submit failed');
    const first = ackEnvelope(db, submit.id, recipientDeviceId);
    expect(first).toEqual({ ok: true, deleted: true });
    // After cascade-delete both envelope and recipient rows are gone.
    const second = ackEnvelope(db, submit.id, recipientDeviceId);
    expect(second).toEqual({ ok: false, reason: 'not_found' });
  });

  it('ackEnvelopesBulk acks many in one transaction', () => {
    const env1 = makeEnvelope(
      senderIdentity,
      senderDeviceId,
      recipientDeviceId,
      recipientIdentity.kex.publicKey,
    );
    const env2 = makeEnvelope(
      senderIdentity,
      senderDeviceId,
      recipientDeviceId,
      recipientIdentity.kex.publicKey,
    );
    const s1 = submitEnvelope(db, env1);
    const s2 = submitEnvelope(db, env2);
    if (!s1.ok || !s2.ok) throw new Error('submit');

    expect(pendingCountFor(db, recipientDeviceId)).toBe(2);
    const result = ackEnvelopesBulk(db, [s1.id, s2.id], recipientDeviceId);
    expect(result.acked).toBe(2);
    expect(result.deletedEnvelopes).toBe(2);
    expect(pendingCountFor(db, recipientDeviceId)).toBe(0);
  });

  it('ackEnvelopesBulk silently skips unknown ids', () => {
    const result = ackEnvelopesBulk(db, [newId(), newId()], recipientDeviceId);
    expect(result.acked).toBe(0);
    expect(result.deletedEnvelopes).toBe(0);
  });

  it('ackEnvelopesBulk handles empty input', () => {
    const result = ackEnvelopesBulk(db, [], recipientDeviceId);
    expect(result).toEqual({ acked: 0, deletedEnvelopes: 0 });
  });
});

describe('POST /api/v1/envelopes + POST /api/v1/envelopes/:id/ack', () => {
  it('full round-trip: submit then ack via REST', async () => {
    const { app, db } = makeTestApp();

    const senderIdentity = generateIdentity();
    const recipientIdentity = generateIdentity();

    const r1 = registerDevice(db, {
      name: 'sender',
      platform: 'web',
      signPub: bytesToB64u(senderIdentity.sign.publicKey),
      kexPub: bytesToB64u(senderIdentity.kex.publicKey),
    });
    if (!r1.ok) throw new Error('setup failed: r1');
    const inv3 = createInvite(db, { scope: 'signup', userId: null, ttlMs: 60_000 });
    const r2 = registerDevice(db, {
      name: 'recipient',
      platform: 'ios',
      signPub: bytesToB64u(recipientIdentity.sign.publicKey),
      kexPub: bytesToB64u(recipientIdentity.kex.publicKey),
      invite: inv3.token,
    });
    if (!r2.ok) throw new Error('setup failed: r2');

    const env = makeEnvelope(
      senderIdentity,
      r1.deviceId,
      r2.deviceId,
      recipientIdentity.kex.publicKey,
    );

    const postRes = await app.request('/api/v1/envelopes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(env),
    });
    expect(postRes.status).toBe(201);
    const { id } = (await postRes.json()) as { id: string };
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);

    // Ack via signed request from recipient.
    const ackBody = JSON.stringify({});
    const ts = String(Date.now());
    const path = `/api/v1/envelopes/${id}/ack`;
    const bodyBytes = new TextEncoder().encode(ackBody);
    const sigStr = buildSignedRequestString('POST', path, ts, bodyBytes);
    const sigBytes = sign(recipientIdentity.sign.secretKey, new TextEncoder().encode(sigStr));
    const authHeader = `Beam-Sig deviceId="${r2.deviceId}", timestamp="${ts}", signature="${bytesToB64u(sigBytes)}"`;

    const ackRes = await app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: authHeader },
      body: ackBody,
    });
    expect(ackRes.status).toBe(200);
    expect(await ackRes.json()).toEqual({ ok: true, deleted: true });
  });

  it('returns 413 too_large when body exceeds the configured maxEnvelopeBytes', async () => {
    const db = makeDb();
    const log = createLogger({ logLevel: 'fatal' });
    const { app } = createApp({ db, log, disableRateLimits: true, maxEnvelopeBytes: 256 });

    // Body large enough to trip the limit; content doesn't need to be a
    // valid envelope because the size check fires before JSON parsing.
    const oversized = JSON.stringify({ pad: 'x'.repeat(512) });
    expect(oversized.length).toBeGreaterThan(256);

    const res = await app.request('/api/v1/envelopes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: oversized,
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'too_large', max: 256 });
  });
});
