import { createHash } from "node:crypto";

/** Failed sign-ins in a row that lock a credential for one address. */
export const LOCKOUT_FAILURES = 5;
/** How long such a lock lasts. */
export const LOCKOUT_MS = 15 * 60_000;
/** The most credential and address pairs remembered at once. */
export const LOCKOUT_MAX_KEYS = 10_000;

/** A sign-in refused because its credential is locked for this address. → 423 locked */
export class LockedError extends Error {
  constructor(public readonly retryAfterS: number) {
    super("too many failed sign-ins; try again later");
    this.name = "LockedError";
  }
}

type Entry = { credentialId: string; failures: number; lockedUntilMs: number | null };

/**
 * Failed sign-ins per credential and source address, in memory only. A lock covers the pair, not the credential, so
 * someone who has seen a public key cannot lock its owner out from another address. Keys are
 * sha256(`${credentialId}\n${source}`): no address is kept in the clear, and none ever reaches the database.
 */
export class LockoutStore {
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => Date;
  private readonly failures: number;
  private readonly lockMs: number;
  private readonly max: number;

  constructor(opts: { now?: () => Date; failures?: number; lockMs?: number; max?: number } = {}) {
    this.now = opts.now ?? (() => new Date());
    this.failures = opts.failures ?? LOCKOUT_FAILURES;
    this.lockMs = opts.lockMs ?? LOCKOUT_MS;
    this.max = opts.max ?? LOCKOUT_MAX_KEYS;
  }

  /**
   * Counts one failure. At the limit the pair locks for `lockMs` and the counter resets; `locked` is true only for
   * the failure that locked it (so the caller records `person.locked` once). A failure while locked does not count.
   */
  failure(credentialId: string, source: string): { locked: boolean; until: string | null; failures: number } {
    const key = keyOf(credentialId, source);
    const nowMs = this.now().getTime();
    let entry = this.entries.get(key);
    if (entry?.lockedUntilMs != null) {
      if (entry.lockedUntilMs > nowMs) return { locked: false, until: new Date(entry.lockedUntilMs).toISOString(), failures: 0 };
      entry.lockedUntilMs = null;
      entry.failures = 0;
    }
    if (!entry) {
      if (this.entries.size >= this.max) this.evictOne(nowMs);
      entry = { credentialId, failures: 0, lockedUntilMs: null };
      this.entries.set(key, entry);
    }
    entry.failures += 1;
    if (entry.failures < this.failures) return { locked: false, until: null, failures: entry.failures };
    const failures = entry.failures;
    entry.failures = 0;
    entry.lockedUntilMs = nowMs + this.lockMs;
    return { locked: true, until: new Date(entry.lockedUntilMs).toISOString(), failures };
  }

  /** Throws LockedError (with the seconds left) while the pair is locked. */
  assertNotLocked(credentialId: string, source: string): void {
    const entry = this.entries.get(keyOf(credentialId, source));
    if (entry?.lockedUntilMs == null) return;
    const leftMs = entry.lockedUntilMs - this.now().getTime();
    if (leftMs > 0) throw new LockedError(Math.max(1, Math.ceil(leftMs / 1000)));
  }

  /** A successful sign-in clears the pair. */
  success(credentialId: string, source: string): void {
    this.entries.delete(keyOf(credentialId, source));
  }

  /** Clears every pair of a credential (when it is removed). */
  clear(credentialId: string): void {
    for (const [key, entry] of this.entries) if (entry.credentialId === credentialId) this.entries.delete(key);
  }

  /** Drops the oldest pair that is not locked, or the oldest of all when every pair is locked. */
  private evictOne(nowMs: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.lockedUntilMs === null || entry.lockedUntilMs <= nowMs) {
        this.entries.delete(key);
        return;
      }
    }
    const oldest = this.entries.keys().next();
    if (!oldest.done) this.entries.delete(oldest.value);
  }
}

function keyOf(credentialId: string, source: string): string {
  return createHash("sha256").update(`${credentialId}\n${source}`).digest("hex");
}
