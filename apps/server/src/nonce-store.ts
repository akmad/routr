/**
 * Replay defense for signed REST requests (L2 from M4.3 review).
 *
 * The Beam-Sig signed-request scheme allows a ±5 min clock-skew window.
 * Within that window, a captured signature is replayable. This module
 * tracks recently-seen (deviceId, timestamp) tuples in-process so the
 * server can reject duplicates.
 *
 * The store auto-evicts entries older than the clock-skew window — they
 * can't be replayed anyway because the auth middleware rejects them on
 * the timestamp check. So memory usage is bounded by the request rate
 * times the window.
 *
 * For a single-process self-host this is sufficient. A fleet deployment
 * needs a shared store (redis SETEX, postgres on-conflict, etc).
 */
export class NonceStore {
  private seen = new Map<string, number>();
  private ttlMs: number;

  constructor(ttlMs: number) {
    this.ttlMs = ttlMs;
  }

  /**
   * Returns true if this (deviceId, timestamp) was already seen — caller
   * should reject as a replay. Returns false on first sight and records it.
   */
  recordOrReject(deviceId: string, timestampMs: number, now: number = Date.now()): boolean {
    const key = `${deviceId}:${timestampMs}`;
    if (this.seen.has(key)) return true;
    this.seen.set(key, now);
    this.evictExpired(now);
    return false;
  }

  size(): number {
    return this.seen.size;
  }

  private evictExpired(now: number): void {
    // Size is bounded by request-rate × TTL anyway, so sweeping each insert
    // is cheap in practice and keeps the invariant simple.
    const cutoff = now - this.ttlMs;
    for (const [k, t] of this.seen) {
      if (t < cutoff) this.seen.delete(k);
    }
  }
}
