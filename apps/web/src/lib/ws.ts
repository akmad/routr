import { bytesToB64u, sign } from '@routr/crypto';
import type { StoredIdentity } from './keystore.js';

export type InboxMessage = {
  id: string;
  fromDevice: string;
  kind: 'url' | 'file' | 'control';
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
  | { type: 'pong' };

/**
 * Beam WS client with exponential backoff reconnect.
 *
 * Backoff: 1s, 2s, 4s, 8s, capped at 30s. Resets to 1s on every successful
 * authentication. `disconnect()` is sticky — once called, no further auto-
 * reconnect happens (so tearing down a React component cleans up cleanly).
 */
export class BeamSocket {
  private ws: WebSocket | null = null;
  private identity: StoredIdentity;
  private closed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelayMs = 1000;
  private static readonly MAX_BACKOFF_MS = 30_000;

  onEnvelope: ((env: InboxMessage) => void) | null = null;
  onConnected: (() => void) | null = null;
  onDisconnected: (() => void) | null = null;
  onRevoked: (() => void) | null = null;

  constructor(identity: StoredIdentity) {
    this.identity = identity;
  }

  connect() {
    this.closed = false;
    this.open();
  }

  private open() {
    const wsUrl = `${this.identity.serverUrl.replace(/^http/, 'ws')}/api/v1/ws`;
    this.ws = new WebSocket(wsUrl);
    this.ws.onmessage = (e) => {
      const msg = JSON.parse(e.data as string) as ServerMsg;
      if (msg.type === 'challenge') {
        this.handleChallenge(msg.nonce);
      } else if (msg.type === 'authenticated') {
        // Successful round-trip — reset backoff.
        this.reconnectDelayMs = 1000;
        this.onConnected?.();
      } else if (msg.type === 'envelope') {
        // Server sends a flat envelope shape — strip `type` before handing
        // it to consumers.
        const { type: _t, ...rest } = msg;
        this.onEnvelope?.(rest as InboxMessage);
      }
    };
    this.ws.onclose = (ev) => {
      this.onDisconnected?.();
      // 4002 = server saw an unknown device (revoked or forgotten). Stop
      // reconnecting and let the consumer bounce to setup.
      if (ev.code === 4002) {
        this.closed = true;
        this.onRevoked?.();
        return;
      }
      if (!this.closed) this.scheduleReconnect();
    };
    this.ws.onerror = () => {
      // Browsers fire close after error, so let onclose handle the retry.
    };
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(delay * 2, BeamSocket.MAX_BACKOFF_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closed) this.open();
    }, delay);
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
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }
}
