// Per-key token buckets (BACKEND_DESIGN.md §7.2): per-user on the
// contribution POSTs (suggested 60 requests/minute), per-IP on
// POST /api/auth/apple and POST /api/auth/apple/notifications (suggested
// 10/minute). In-process and per-instance; the farm runs as one process.
// Answered 429 carries Retry-After.

export class TokenBucket {
  private state = new Map<string, { tokens: number; updatedAtMs: number }>();

  constructor(
    private readonly capacity: number,
    private readonly refillPerMinute: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Consumes one token for key; false when the bucket is empty. */
  take(key: string): boolean {
    const t = this.now();
    let s = this.state.get(key);
    if (s === undefined) {
      s = { tokens: this.capacity, updatedAtMs: t };
      this.state.set(key, s);
    } else {
      s.tokens = Math.min(
        this.capacity,
        s.tokens + ((t - s.updatedAtMs) * this.refillPerMinute) / 60000,
      );
      s.updatedAtMs = t;
    }
    if (s.tokens < 1) return false;
    s.tokens -= 1;
    this.prune(t);
    return true;
  }

  /** Seconds until one token is available; 0 when take() would succeed. */
  retryAfterSec(key: string): number {
    const s = this.state.get(key);
    if (s === undefined) return 0;
    const t = this.now();
    const tokens = Math.min(
      this.capacity,
      s.tokens + ((t - s.updatedAtMs) * this.refillPerMinute) / 60000,
    );
    if (tokens >= 1) return 0;
    return Math.max(
      1,
      Math.ceil(((1 - tokens) / this.refillPerMinute) * 60),
    );
  }

  // The map grows with distinct keys; drop buckets idle long enough to be
  // full again, so a long-lived process doesn't leak memory.
  private prune(t: number): void {
    if (this.state.size < 100_000) return;
    const fullAfterMs = (this.capacity / this.refillPerMinute) * 60000;
    for (const [k, s] of this.state) {
      if (t - s.updatedAtMs > fullAfterMs) this.state.delete(k);
    }
  }
}
