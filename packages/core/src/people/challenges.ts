import { randomBytes } from "node:crypto";

/** How long a challenge can be answered. */
export const CHALLENGE_TTL_MS = 300_000;
/** The most open challenges at once, and per client. */
export const CHALLENGE_MAX = 10_000;
export const CHALLENGE_PER_CLIENT = 20;

type Held = { scope: string; client: string; expiresMs: number };

/**
 * Sign-in and registration challenges, in memory only: each is answered once, within its time, for the scope it was
 * issued for (`join:<inviteId>`, `login` or `me:<personId>`). A client (the request's address, never stored anywhere
 * else) holds at most `perClient` open challenges, and issuing more evicts only its own oldest, so one address cannot
 * push out another's. The global cap evicts the oldest overall.
 */
export class ChallengeStore {
  /** Insertion order is issue order, and every challenge lives equally long, so the first entries expire first. */
  private readonly held = new Map<string, Held>();
  private readonly byClient = new Map<string, Set<string>>();
  private readonly now: () => Date;
  private readonly ttlMs: number;
  private readonly max: number;
  private readonly perClient: number;

  constructor(opts: { now?: () => Date; ttlMs?: number; max?: number; perClient?: number } = {}) {
    this.now = opts.now ?? (() => new Date());
    this.ttlMs = opts.ttlMs ?? CHALLENGE_TTL_MS;
    this.max = opts.max ?? CHALLENGE_MAX;
    this.perClient = opts.perClient ?? CHALLENGE_PER_CLIENT;
  }

  /** A new challenge: 32 random bytes, base64url. */
  issue(scope: string, client: string): string {
    const nowMs = this.now().getTime();
    this.sweep(nowMs);
    const own = this.byClient.get(client);
    if (own && own.size >= this.perClient) this.drop(own.values().next().value!);
    if (this.held.size >= this.max) this.drop(this.held.keys().next().value!);
    const challenge = randomBytes(32).toString("base64url");
    this.held.set(challenge, { scope, client, expiresMs: nowMs + this.ttlMs });
    const set = this.byClient.get(client) ?? new Set<string>();
    set.add(challenge);
    this.byClient.set(client, set);
    return challenge;
  }

  /** True once for a live challenge of this scope. Any attempt uses the challenge up, whatever the answer. */
  consume(challenge: string, scope: string): boolean {
    if (typeof challenge !== "string") return false;
    const held = this.held.get(challenge);
    if (!held) return false;
    this.drop(challenge);
    return held.scope === scope && held.expiresMs > this.now().getTime();
  }

  private sweep(nowMs: number): void {
    for (const [challenge, held] of this.held) {
      if (held.expiresMs > nowMs) return;
      this.drop(challenge);
    }
  }

  private drop(challenge: string): void {
    const held = this.held.get(challenge);
    if (!held) return;
    this.held.delete(challenge);
    const set = this.byClient.get(held.client);
    set?.delete(challenge);
    if (set?.size === 0) this.byClient.delete(held.client);
  }
}
