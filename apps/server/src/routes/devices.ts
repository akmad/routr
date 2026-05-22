import { DeviceRegistrationRequestSchema } from '@routr/protocol';
import { Hono } from 'hono';
import * as v from 'valibot';
import type { AppEnv } from '../app.js';
import { getDeviceById, registerDevice } from '../services/devices.js';

export const devicesRoute = new Hono<AppEnv>();

devicesRoute.post('/', async (c) => {
  const raw = await c.req.json().catch(() => null);
  const parsed = v.safeParse(DeviceRegistrationRequestSchema, raw);
  if (!parsed.success) {
    return c.json({ error: 'invalid_body', issues: parsed.issues }, 400);
  }

  const result = registerDevice(c.get('db'), {
    name: parsed.output.name,
    platform: parsed.output.platform,
    signPub: parsed.output.identity.signPub,
    kexPub: parsed.output.identity.kexPub,
    invite: parsed.output.invite,
  });

  if (!result.ok) {
    const status = result.reason === 'invite_required' ? 403 : 400;
    return c.json({ error: result.reason }, status);
  }
  return c.json({ deviceId: result.deviceId, userId: result.userId }, 201);
});

devicesRoute.get('/:id', (c) => {
  const id = c.req.param('id');
  const device = getDeviceById(c.get('db'), id);
  if (!device) return c.json({ error: 'not_found' }, 404);
  return c.json({
    id: device.id,
    userId: device.userId,
    name: device.name,
    platform: device.platform,
    signPub: device.signPub,
    kexPub: device.kexPub,
  });
});
