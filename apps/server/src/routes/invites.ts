import { InviteIssueRequestSchema } from '@routr/protocol';
import { Hono } from 'hono';
import * as v from 'valibot';
import type { AppEnv } from '../app.js';
import { requireDeviceAuth } from '../auth.js';
import { createInvite } from '../services/invites.js';

export const invitesRoute = new Hono<AppEnv>();

invitesRoute.post('/', requireDeviceAuth, async (c) => {
  const raw = await c.req.json().catch(() => null);
  const parsed = v.safeParse(InviteIssueRequestSchema, raw);
  if (!parsed.success) {
    return c.json({ error: 'invalid_body', issues: parsed.issues }, 400);
  }

  const userId = c.get('userId');
  const scope = parsed.output.scope;
  // signup invites are scoped to whoever creates them — they create a new
  // user, but we don't pre-attach to a user. pair_device invites stay
  // bound to the issuer's user.
  const invite = createInvite(c.get('db'), {
    scope,
    userId: scope === 'pair_device' ? userId : null,
    ttlMs: parsed.output.ttl * 1000,
  });

  return c.json({ token: invite.token, scope: invite.scope, expiresAt: invite.expiresAt }, 201);
});
