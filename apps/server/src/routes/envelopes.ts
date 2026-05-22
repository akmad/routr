import { EnvelopeSchema } from '@routr/protocol';
import { Hono } from 'hono';
import * as v from 'valibot';
import type { AppEnv } from '../app.js';
import { requireDeviceAuth } from '../auth.js';
import { ackEnvelope, ackEnvelopesBulk, submitEnvelope } from '../services/envelopes.js';
import type { ConnectionRegistry } from '../ws/registry.js';

export function envelopesRoute(registry: ConnectionRegistry) {
  const route = new Hono<AppEnv>();

  route.post('/', async (c) => {
    const raw = await c.req.json().catch(() => null);
    const parsed = v.safeParse(EnvelopeSchema, raw);
    if (!parsed.success) {
      return c.json({ error: 'invalid_body', issues: parsed.issues }, 400);
    }
    const env = parsed.output;

    const result = submitEnvelope(c.get('db'), env);
    if (!result.ok) {
      const status =
        result.reason === 'unknown_sender' ? 404 : result.reason === 'duplicate' ? 409 : 400;
      c.get('log').warn(
        { from: env.from, reason: result.reason, kind: env.kind },
        'envelope rejected',
      );
      return c.json({ error: result.reason }, status);
    }
    c.get('log').info(
      { id: result.id, from: env.from, to: env.to.length, kind: env.kind, size: env.size },
      'envelope accepted',
    );

    // Live push to online recipients.
    const delivered: string[] = [];
    for (const deviceId of env.to) {
      const n = registry.push(deviceId, {
        type: 'envelope',
        id: result.id,
        fromDevice: env.from,
        createdAt: env.createdAt,
        expiresAt: env.expiresAt,
        kind: env.kind,
        size: env.size,
        ciphertext: env.ciphertext,
        senderEphemeralPub: env.senderEphemeralPub,
        wrappedKey: env.wrappedKeys[deviceId] ?? '',
        signature: env.signature,
      });
      if (n > 0) delivered.push(deviceId);
    }

    return c.json({ id: result.id, deliveredToOnline: delivered }, 201);
  });

  route.post('/:id/ack', requireDeviceAuth, (c) => {
    const id = c.req.param('id');
    const deviceId = c.get('deviceId');
    const result = ackEnvelope(c.get('db'), id, deviceId);
    if (!result.ok) {
      return c.json({ error: result.reason }, 404);
    }
    return c.json({ ok: true, deleted: result.deleted });
  });

  route.post('/ack-batch', requireDeviceAuth, async (c) => {
    const raw = await c.req.json().catch(() => null);
    if (
      !raw ||
      typeof raw !== 'object' ||
      !Array.isArray((raw as { ids?: unknown }).ids) ||
      ((raw as { ids: unknown[] }).ids as unknown[]).some((x) => typeof x !== 'string')
    ) {
      return c.json({ error: 'invalid_body' }, 400);
    }
    const ids = (raw as { ids: string[] }).ids;
    // Bound the batch to keep a single transaction sane.
    if (ids.length > 500) return c.json({ error: 'too_many', max: 500 }, 400);
    const result = ackEnvelopesBulk(c.get('db'), ids, c.get('deviceId'));
    return c.json({ ok: true, ...result });
  });

  return route;
}
