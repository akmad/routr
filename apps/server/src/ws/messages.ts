import { Base64UrlSchema, UlidSchema } from '@routr/protocol';
import * as v from 'valibot';

/** Server → client: opening challenge for signed-challenge auth. */
export type ChallengeMessage = {
  type: 'challenge';
  nonce: string;
};

/** Client → server: signed auth response. */
export const AuthMessageSchema = v.object({
  type: v.literal('auth'),
  deviceId: UlidSchema,
  signature: Base64UrlSchema,
});
export type AuthMessage = v.InferOutput<typeof AuthMessageSchema>;

/** Server → client: auth succeeded. */
export type AuthenticatedMessage = { type: 'authenticated' };

/** Server → client: a queued or live envelope for this device. */
export type InboxEnvelopeMessage = {
  type: 'envelope';
  id: string;
  fromDevice: string;
  createdAt: number;
  expiresAt: number;
  kind: 'url' | 'file' | 'note' | 'control';
  size: number;
  ciphertext: string;
  senderEphemeralPub: string;
  wrappedKey: string;
  signature: string;
};

/** Client → server: heartbeat (no payload). */
export const PingMessageSchema = v.object({ type: v.literal('ping') });

export type ServerMessage = ChallengeMessage | AuthenticatedMessage | InboxEnvelopeMessage;

export const CLIENT_AUTH_DOMAIN = 'routr.ws.auth.v1';

/** Build the canonical bytes a client signs to authenticate a WS connection. */
export function buildWsAuthMessage(deviceId: string, nonce: string): Uint8Array {
  return new TextEncoder().encode(`${CLIENT_AUTH_DOMAIN}\n${deviceId}\n${nonce}\n`);
}
