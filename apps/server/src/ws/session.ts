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
  /**
   * How often the server pings the client. Default 30s. Tests inject a
   * much smaller value (along with `heartbeatTimeoutMs`) so timing-based
   * assertions run fast.
   */
  heartbeatIntervalMs?: number;
  /**
   * Close the connection if no message arrives within this window. Default
   * 90s — three missed heartbeats before eviction. The client only has to
   * respond to a `ping` (or send anything at all) within the window to
   * stay alive.
   */
  heartbeatTimeoutMs?: number;
};

const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 90_000;

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
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private deadTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatTimeoutMs: number;

  constructor(
    private readonly deps: SessionDeps,
    private readonly tx: SessionTransport,
  ) {
    this.state = { stage: 'awaiting_auth', nonce: randomBytes(32).toString('base64url') };
    this.heartbeatIntervalMs = deps.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.heartbeatTimeoutMs = deps.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
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

    // Authed state: any inbound message is proof of life — reset the dead
    // timer. We still respond to client-initiated pings and silently accept
    // pongs (their only purpose is to reset the timer above).
    this.resetDeadTimer();
    if (typeof parsed === 'object' && parsed !== null && 'type' in parsed) {
      const t = (parsed as { type: unknown }).type;
      if (t === 'ping') {
        this.tx.send(JSON.stringify({ type: 'pong' }));
      }
    }
  }

  onClose(): void {
    this.stopHeartbeat();
    if (this.state.stage === 'authed') {
      this.deps.registry.remove(this.state.conn);
      this.deps.log.info({ deviceId: this.state.deviceId }, 'ws device disconnected');
    }
  }

  private startHeartbeat(): void {
    // Server-initiated heartbeat. We send `{type:'ping'}` on the configured
    // cadence so dead TCP connections get noticed: well-behaved clients reply
    // with `{type:'pong'}` (or any other message), which resets the dead
    // timer. If nothing arrives within heartbeatTimeoutMs, we evict the
    // session with 4005 — the registry loses the entry and the device's
    // `online` flag flips to false on the next /devices poll.
    this.heartbeatTimer = setInterval(() => {
      this.tx.send(JSON.stringify({ type: 'ping' }));
    }, this.heartbeatIntervalMs);
    this.resetDeadTimer();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.deadTimer) {
      clearTimeout(this.deadTimer);
      this.deadTimer = null;
    }
  }

  private resetDeadTimer(): void {
    if (this.deadTimer) clearTimeout(this.deadTimer);
    this.deadTimer = setTimeout(() => {
      this.deps.log.info(
        { deviceId: this.state.stage === 'authed' ? this.state.deviceId : null },
        'ws heartbeat timeout — closing',
      );
      this.tx.close(4005, 'heartbeat_timeout');
    }, this.heartbeatTimeoutMs);
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
    this.startHeartbeat();

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
