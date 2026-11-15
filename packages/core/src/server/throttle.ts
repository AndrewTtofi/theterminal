/**
 * A fixed-window hit counter per key (for the auth routes, the key is the client address). A key's window starts at
 * its first hit and lasts `windowMs`; within it `limit` hits are allowed and the rest refused with the seconds left.
 * Refused hits do not extend the window.
 *
 * Memory is bounded: at most `max` keys are held. The buckets live in a Map ordered by window start (a bucket whose
 * window restarts is moved to the end), so the first entry is always the oldest window, and when a new key arrives
 * at capacity that entry is evicted in O(1). Ended windows are therefore evicted before live ones.
 */
export type ThrottleResult = { allowed: true } | { allowed: false; retryAfterS: number };

export type ThrottleOptions = { limit: number; windowMs: number; now?: () => Date; max?: number };

export const AUTH_THROTTLE = { limit: 10, windowMs: 60_000 };

const DEFAULT_MAX = 10_000;

type Bucket = { start: number; count: number };

export class Throttle {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly max: number;
  private readonly now: () => Date;
  private readonly buckets = new Map<string, Bucket>();

  constructor(opts: ThrottleOptions) {
    const max = opts.max ?? DEFAULT_MAX;
    if (!Number.isSafeInteger(opts.limit) || opts.limit < 1) throw new RangeError("Throttle limit must be a positive integer.");
    if (!Number.isFinite(opts.windowMs) || opts.windowMs <= 0) throw new RangeError("Throttle windowMs must be a positive number.");
    if (!Number.isSafeInteger(max) || max < 1) throw new RangeError("Throttle max must be a positive integer.");
    this.limit = opts.limit;
    this.windowMs = opts.windowMs;
    this.max = max;
    this.now = opts.now ?? (() => new Date());
  }

  /** How many keys are held; never more than `max`. */
  get size(): number {
    return this.buckets.size;
  }

  hit(key: string): ThrottleResult {
    const t = this.now().getTime();
    const bucket = this.buckets.get(key);
    if (bucket !== undefined && t - bucket.start < this.windowMs) {
      if (bucket.count < this.limit) {
        bucket.count += 1;
        return { allowed: true };
      }
      return { allowed: false, retryAfterS: Math.max(1, Math.ceil((bucket.start + this.windowMs - t) / 1000)) };
    }
    // A new window: drop the old bucket (if any) and append, so Map order stays the order of window starts.
    if (bucket !== undefined) this.buckets.delete(key);
    while (this.buckets.size >= this.max) {
      const oldest = this.buckets.keys().next();
      if (oldest.done === true) break;
      this.buckets.delete(oldest.value);
    }
    this.buckets.set(key, { start: t, count: 1 });
    return { allowed: true };
  }
}
