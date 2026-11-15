import type { PresenceEntry, Principal, Role } from "@theterminal/shared";

export type { PresenceEntry };

/**
 * Who is here and what they look at. In memory only: never written to the ledger, never persisted. An entry holds
 * exactly the fields below (no session id, address, user agent or credential detail).
 *
 * Bounds: at most `maxPerPerson` sockets per person (the oldest of that person is dropped), at most `maxSockets` in
 * all (a new socket is refused; `join` returns false). A socket not refreshed (`join` or `update`) for `ttlMs` is
 * expired: lazily on every read and write, and by `sweep()`, which the caller runs on a timer to announce expiry.
 */
export type PresenceOptions = { now?: () => Date; maxSockets?: number; maxPerPerson?: number; ttlMs?: number };

const VIEW = /^[a-z_:-]{1,40}$/;
const PROJECT = /^[A-Za-z0-9_.:-]{1,100}$/;
const MAX_NAME = 100;

type Slot = { personId: string; name: string; role: Role; projectId: string | null; view: string | null; since: number; seen: number; tick: number };

const positive = (n: number, what: string) => {
  if (!Number.isSafeInteger(n) || n < 1) throw new RangeError(`Presence ${what} must be a positive integer.`);
  return n;
};

export class PresenceRegistry {
  private readonly now: () => Date;
  private readonly maxSockets: number;
  private readonly maxPerPerson: number;
  private readonly ttlMs: number;
  private readonly sockets = new Map<string, Slot>(); // insertion order = join order
  private readonly listeners = new Set<(people: PresenceEntry[]) => void>();
  private tick = 0;
  private last = "[]";

  constructor(opts: PresenceOptions = {}) {
    this.now = opts.now ?? (() => new Date());
    this.maxSockets = positive(opts.maxSockets ?? 1000, "maxSockets");
    this.maxPerPerson = positive(opts.maxPerPerson ?? 8, "maxPerPerson");
    this.ttlMs = positive(opts.ttlMs ?? 5 * 60_000, "ttlMs");
  }

  /** How many live sockets are held. */
  get size(): number {
    this.expire();
    return this.sockets.size;
  }

  /** Whether the socket is held (and not expired). */
  has(socketId: string): boolean {
    this.expire();
    return this.sockets.has(socketId);
  }

  /** Adds a socket. False when the global bound refuses it. */
  join(socketId: string, principal: Principal): boolean {
    this.expire();
    const t = this.now().getTime();
    const existing = this.sockets.get(socketId);
    if (existing) this.sockets.delete(socketId);
    else if (this.sockets.size >= this.maxSockets) {
      this.changed();
      return false;
    }
    const mine = [...this.sockets].filter(([, s]) => s.personId === principal.personId);
    for (const [id] of mine.slice(0, Math.max(0, mine.length - this.maxPerPerson + 1))) this.sockets.delete(id);
    this.sockets.set(socketId, {
      personId: principal.personId,
      name: principal.name.slice(0, MAX_NAME),
      role: principal.role,
      projectId: null,
      view: null,
      since: t,
      seen: t,
      tick: ++this.tick,
    });
    this.changed();
    return true;
  }

  /** Records what a socket looks at. A malformed view or project id ignores the whole update. */
  update(socketId: string, where: { projectId: string | null; view: string | null }): void {
    this.expire();
    const s = this.sockets.get(socketId);
    if (!s) return this.changed();
    const { projectId, view } = where ?? {};
    const okView = view === null || (typeof view === "string" && VIEW.test(view));
    const okProject = projectId === null || (typeof projectId === "string" && PROJECT.test(projectId));
    if (okView && okProject) {
      s.projectId = projectId;
      s.view = view;
      s.tick = ++this.tick;
    }
    s.seen = this.now().getTime(); // any well-formed or malformed message from a live socket is a sign of life
    this.changed();
  }

  leave(socketId: string): void {
    this.expire();
    this.sockets.delete(socketId);
    this.changed();
  }

  /** One entry per person (their most recently active socket), in order of arrival. */
  list(): PresenceEntry[] {
    this.expire();
    return this.snapshot();
  }

  /** Expires stale sockets and notifies if that changed the list. */
  sweep(): void {
    this.expire();
    this.changed();
  }

  onChange(fn: (people: PresenceEntry[]) => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  private expire(): void {
    const cutoff = this.now().getTime() - this.ttlMs;
    for (const [id, s] of this.sockets) if (s.seen <= cutoff) this.sockets.delete(id);
  }

  private snapshot(): PresenceEntry[] {
    const byPerson = new Map<string, { best: Slot; since: number }>();
    for (const s of this.sockets.values()) {
      const cur = byPerson.get(s.personId);
      if (!cur) byPerson.set(s.personId, { best: s, since: s.since });
      else byPerson.set(s.personId, { best: s.tick > cur.best.tick ? s : cur.best, since: Math.min(cur.since, s.since) });
    }
    return [...byPerson.values()]
      .sort((a, b) => a.since - b.since || (a.best.personId < b.best.personId ? -1 : 1))
      .map(({ best, since }) => ({
        personId: best.personId,
        name: best.name,
        role: best.role,
        projectId: best.projectId,
        view: best.view,
        since: new Date(since).toISOString(),
      }));
  }

  private changed(): void {
    const people = this.snapshot();
    const key = JSON.stringify(people);
    if (key === this.last) return;
    this.last = key;
    for (const fn of [...this.listeners]) {
      try {
        fn(people);
      } catch {
        // a broken listener must not stop the others or the registry
      }
    }
  }
}
