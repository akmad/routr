import type { InboxEnvelopeMessage } from './messages.js';

export type Connection = {
  deviceId: string;
  send: (msg: InboxEnvelopeMessage) => void;
  close: (code: number, reason?: string) => void;
};

/**
 * In-process registry of authenticated WS connections keyed by device ID.
 * Multiple connections per device are allowed (e.g. user has two browser
 * tabs open) — all of them receive the same pushed envelopes.
 *
 * v1 is single-process. Horizontal scaling will swap this for a Redis
 * pubsub fan-out without changing the call sites.
 */
export class ConnectionRegistry {
  private byDevice = new Map<string, Set<Connection>>();

  add(conn: Connection): void {
    let set = this.byDevice.get(conn.deviceId);
    if (!set) {
      set = new Set();
      this.byDevice.set(conn.deviceId, set);
    }
    set.add(conn);
  }

  remove(conn: Connection): void {
    const set = this.byDevice.get(conn.deviceId);
    if (!set) return;
    set.delete(conn);
    if (set.size === 0) this.byDevice.delete(conn.deviceId);
  }

  /** Returns the number of connections that received the message. */
  push(deviceId: string, msg: InboxEnvelopeMessage): number {
    const set = this.byDevice.get(deviceId);
    if (!set) return 0;
    let delivered = 0;
    for (const conn of set) {
      try {
        conn.send(msg);
        delivered++;
      } catch {
        // Connection broken; the WS handler will clean it up via onClose.
      }
    }
    return delivered;
  }

  isOnline(deviceId: string): boolean {
    return (this.byDevice.get(deviceId)?.size ?? 0) > 0;
  }

  size(): number {
    let n = 0;
    for (const set of this.byDevice.values()) n += set.size;
    return n;
  }

  /**
   * Number of distinct devices with at least one active connection.
   * Differs from size() when a device has multiple tabs/windows open —
   * useful for the admin dashboard to answer "how many of my devices
   * are currently reachable", not "how many sockets are open".
   */
  uniqueDevices(): number {
    return this.byDevice.size;
  }
}
