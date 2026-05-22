import { randomBytes } from 'node:crypto';
import { b64uToBytes, verify } from '@routr/crypto';
import * as v from 'valibot';
import type { Db } from '../db/index.js';
import type { Logger } from '../logger.js';
import { getDeviceById, touchLastSeen } from '../services/devices.js';
import { listPendingFor } from '../services/envelopes.js';
import {
  AuthMessageSchema,
  type AuthenticatedMessage,
  type ChallengeMessage,
  type InboxEnvelopeMessage,
  buildWsAuthMessage,
} from './messages.js';
import type { Connection, ConnectionRegistry } from './registry.js';

export type SessionDeps = {
  db: Db;
  log: Logger;
  registry: ConnectionRegistry;
};

type SessionTransport = {
  send: (text: string) => void;
  close: (code: number, reason?: string) => void;
};

type State =
  | { stage: 'awaiting_auth'; nonce: string }
  | { stage: 'authed'; deviceId: string; userId: string; conn: Connection };

/**
 * A WS session's state machine. Transport-agnostic: takes a transport that
 * can send text and close the socket. The Hono WS adapter wires this to a
 * real socket; tests wire it to a buffer.
 */
export class WsSession {
  private state: State;

  constructor(
    private readonly deps: SessionDeps,
    private readonly tx: SessionTransport,
  ) {
    this.state = { stage: 'awaiting_auth', nonce: randomBytes(32).toString('base64url') };
  }

  start(): void {
    const msg: ChallengeMessage = {
      type: 'challenge',
      nonce: (this.state as { nonce: string }).nonce,
    };
    this.tx.send(JSON.stringify(msg));
  }

  onMessage(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.tx.close(4000, 'bad_json');
      return;
    }

    if (this.state.stage === 'awaiting_auth') {
      const auth = v.safeParse(AuthMessageSchema, parsed);
      if (!auth.success) {
        this.tx.close(4001, 'auth_required');
        return;
      }
      this.handleAuth(auth.output.deviceId, auth.output.signature);
      return;
    }

    // Authed state: ignore unknown messages for now. Heartbeats etc. land here.
    if (typeof parsed === 'object' && parsed !== null && 'type' in parsed) {
      const t = (parsed as { type: unknown }).type;
      if (t === 'ping') {
        this.tx.send(JSON.stringify({ type: 'pong' }));
      }
    }
  }

  onClose(): void {
    if (this.state.stage === 'authed') {
      this.deps.registry.remove(this.state.conn);
      this.deps.log.info({ deviceId: this.state.deviceId }, 'ws device disconnected');
    }
  }

  private handleAuth(deviceId: string, signatureB64u: string): void {
    if (this.state.stage !== 'awaiting_auth') return;
    const device = getDeviceById(this.deps.db, deviceId);
    if (!device) {
      this.tx.close(4002, 'unknown_device');
      return;
    }
    const message = buildWsAuthMessage(deviceId, this.state.nonce);
    let sig: Uint8Array;
    let pub: Uint8Array;
    try {
      sig = b64uToBytes(signatureB64u);
      pub = b64uToBytes(device.signPub);
    } catch {
      this.tx.close(4003, 'bad_signature_encoding');
      return;
    }
    if (!verify(pub, sig, message)) {
      this.tx.close(4004, 'bad_signature');
      return;
    }

    const conn: Connection = {
      deviceId,
      send: (msg) => this.tx.send(JSON.stringify(msg)),
      close: (code, reason) => this.tx.close(code, reason),
    };
    this.state = { stage: 'authed', deviceId, userId: device.userId, conn };
    this.deps.registry.add(conn);
    touchLastSeen(this.deps.db, deviceId);

    const ok: AuthenticatedMessage = { type: 'authenticated' };
    this.tx.send(JSON.stringify(ok));

    // Drain the inbox.
    const pending = listPendingFor(this.deps.db, deviceId);
    this.deps.log.info(
      { deviceId, userId: device.userId, pending: pending.length },
      'ws device authenticated',
    );
    for (const item of pending) {
      const msg: InboxEnvelopeMessage = {
        type: 'envelope',
        id: item.id,
        fromDevice: item.fromDevice,
        createdAt: item.createdAt,
        expiresAt: item.expiresAt,
        kind: item.kind,
        size: item.size,
        ciphertext: item.ciphertext,
        senderEphemeralPub: item.senderEphemeralPub,
        wrappedKey: item.wrappedKey,
        signature: item.signature,
      };
      this.tx.send(JSON.stringify(msg));
    }
  }
}
