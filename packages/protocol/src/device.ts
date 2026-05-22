import * as v from 'valibot';
import { Base64UrlSchema, UlidSchema } from './primitives.js';

/** Public identity material — what one device shares with another or with the server. */
export const PublicIdentitySchema = v.object({
  signPub: Base64UrlSchema,
  kexPub: Base64UrlSchema,
});
export type PublicIdentity = v.InferOutput<typeof PublicIdentitySchema>;

/**
 * Request body for POST /api/v1/devices.
 *
 * - First device on a fresh server: no invite required (server bootstraps a
 *   user automatically).
 * - Subsequent first device of a new user: requires a signup invite.
 * - New device for an existing user: requires a pair_device invite issued
 *   by an existing device on that user account.
 */
export const DeviceRegistrationRequestSchema = v.object({
  name: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
  platform: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
  identity: PublicIdentitySchema,
  invite: v.optional(v.string()),
});
export type DeviceRegistrationRequest = v.InferOutput<typeof DeviceRegistrationRequestSchema>;

export const DeviceRegistrationResponseSchema = v.object({
  deviceId: UlidSchema,
  userId: UlidSchema,
});
export type DeviceRegistrationResponse = v.InferOutput<typeof DeviceRegistrationResponseSchema>;

/** Request body for POST /api/v1/invites (auth'd by an existing device). */
export const InviteIssueRequestSchema = v.object({
  scope: v.picklist(['signup', 'pair_device']),
  /** TTL in seconds. Server clamps to a max. */
  ttl: v.pipe(v.number(), v.integer(), v.minValue(60), v.maxValue(86400)),
});
export type InviteIssueRequest = v.InferOutput<typeof InviteIssueRequestSchema>;

export const InviteIssueResponseSchema = v.object({
  token: v.string(),
  scope: v.picklist(['signup', 'pair_device']),
  expiresAt: v.pipe(v.number(), v.integer()),
});
export type InviteIssueResponse = v.InferOutput<typeof InviteIssueResponseSchema>;
