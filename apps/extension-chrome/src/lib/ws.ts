import { bytesToB64u, sign } from '@routr/crypto';
import type { StoredIdentity } from './keystore.js';

export type InboxMessage = {
  id: string;
  fromDevice: string;
  kind: 'url' | 'file' | 'note' | 'control';
  ciphertext: string;
  senderEphemeralPub: string;
  wrappedKey: string;
  signature: string;
  createdAt: number;
  expiresAt: number;
  size: number;
};

type EnvelopeMsg = InboxMessage & { type: 'envelope' };
type ServerMsg =
  | { type: 'challenge'; nonce: string }
  | { type: 'authenticated' }
  | EnvelopeMsg
  | { type: 'ping' }
  | { type: 'pong' };

export class BeamSocket {
  private ws: WebSocket | null = null;
  private identity: StoredIdentity;
  onEnvelope: ((env: InboxMessage) => void) | null = null;
  onConnected: (() => void) | null = null;
  onDisconnected: (() => void) | null = null;

  constructor(identity: StoredIdentity) {
    this.identity = identity;
  }

  connect() {
    const wsUrl = `${this.identity.serverUrl.replace(/^http/, 'ws')}/api/v1/ws`;
    this.ws = new WebSocket(wsUrl);
    this.ws.onmessage = (e) => {
      const msg = JSON.parse(e.data as string) as ServerMsg;
      if (msg.type === 'challenge') {
        this.handleChallenge(msg.nonce);
      } else if (msg.type === 'authenticated') {
        this.onConnected?.();
      } else if (msg.type === 'envelope') {
        const { type: _t, ...rest } = msg;
        this.onEnvelope?.(rest as InboxMessage);
      } else if (msg.type === 'ping') {
        // Server-initiated heartbeat — respond so it knows we're alive.
        this.send({ type: 'pong' });
      }
    };
    this.ws.onclose = () => this.onDisconnected?.();
  }

  private handleChallenge(nonce: string) {
    const msgBytes = new TextEncoder().encode(
      `routr.ws.auth.v1\n${this.identity.deviceId}\n${nonce}\n`,
    );
    this.send({
      type: 'auth',
      deviceId: this.identity.deviceId,
      signature: bytesToB64u(sign(this.identity.signSecretKey, msgBytes)),
    });
  }

  send(msg: unknown) {
    this.ws?.send(JSON.stringify(msg));
  }

  disconnect() {
    this.ws?.close();
    this.ws = null;
  }
}
