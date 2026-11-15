import { createHash, randomBytes } from "node:crypto";
import { SESSION_TTL_MS, type Listener, type SignInMethod } from "@theterminal/shared";
import type Database from "better-sqlite3";
import type { Db } from "../db.js";

export type Session = {
  id: string;
  personId: string;
  listener: Listener;
  method: SignInMethod;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
};

/** How often a session in use has its `last_seen_at` written. */
const TOUCH_MS = 60_000;
const SESSION_ID = /^[A-Za-z0-9_-]{43}$/;
const HASH_PREFIX = /^[0-9a-f]{8}$/;

type Row = {
  id_hash: string; person_id: string; listener: Listener; method: SignInMethod; created_at: string; last_seen_at: string;
  expires_at: string; revoked_at: string | null;
};

const hashOf = (id: string): string => createHash("sha256").update(id).digest("hex");

/**
 * Signed-in sessions. The id is handed out once and only its sha256 is stored, so a copy of the database signs nobody
 * in. A session works only on the listener it was created on, and a revoked one stops working on its next lookup.
 */
export class SessionStore {
  private readonly now: () => Date;
  private readonly ttlMs: number;
  private readonly listeners = new Set<(personId: string, sessionIdHash: string | null) => void>();
  private readonly select: Database.Statement;
  private readonly touch: Database.Statement;

  constructor(
    private readonly db: Db,
    opts: { now?: () => Date; ttlMs?: number } = {},
  ) {
    this.now = opts.now ?? (() => new Date());
    this.ttlMs = opts.ttlMs ?? SESSION_TTL_MS;
    // Both run on every request.
    this.select = db.prepare("SELECT * FROM sessions WHERE id_hash = ?");
    this.touch = db.prepare("UPDATE sessions SET last_seen_at = ? WHERE id_hash = ?");
  }

  create(personId: string, listener: Listener, method: SignInMethod): { id: string; session: Session } {
    const now = this.now();
    const id = randomBytes(32).toString("base64url");
    const createdAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + this.ttlMs).toISOString();
    // Expired rows are dropped as new ones arrive; revoked ones stay until they would have expired.
    this.db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(createdAt);
    this.db
      .prepare(
        `INSERT INTO sessions (id_hash, person_id, listener, method, created_at, last_seen_at, expires_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(hashOf(id), personId, listener, method, createdAt, createdAt, expiresAt);
    return { id, session: { id, personId, listener, method, createdAt, lastSeenAt: createdAt, expiresAt } };
  }

  /** The live session for `id` on this listener; null when revoked, expired, on another listener or unknown. */
  lookup(id: string, listener: Listener): Session | null {
    if (typeof id !== "string" || !SESSION_ID.test(id)) return null;
    const hash = hashOf(id);
    const r = this.select.get(hash) as Row | undefined;
    if (!r || r.revoked_at !== null || r.listener !== listener) return null;
    const now = this.now();
    if (Date.parse(r.expires_at) <= now.getTime()) return null;
    let lastSeenAt = r.last_seen_at;
    if (now.getTime() - Date.parse(r.last_seen_at) >= TOUCH_MS) {
      lastSeenAt = now.toISOString();
      this.touch.run(lastSeenAt, hash);
    }
    return {
      id, personId: r.person_id, listener: r.listener, method: r.method, createdAt: r.created_at, lastSeenAt, expiresAt: r.expires_at,
    };
  }

  revoke(id: string): void {
    if (typeof id !== "string") return;
    this.revokeHash(hashOf(id));
  }

  /** Revokes the person's live session(s) whose id hash starts with the 8-character `prefix`; false when none. */
  revokeByHashPrefix(personId: string, prefix: string): boolean {
    if (typeof prefix !== "string" || !HASH_PREFIX.test(prefix)) return false;
    const hashes = (
      this.db
        .prepare("SELECT id_hash FROM sessions WHERE person_id = ? AND substr(id_hash, 1, 8) = ? AND revoked_at IS NULL")
        .all(personId, prefix) as { id_hash: string }[]
    ).map((r) => r.id_hash);
    let any = false;
    for (const h of hashes) any = this.revokeHash(h) || any;
    return any;
  }

  /** Revokes every session of the person and tells listeners once (`null`: all of them); the number revoked. */
  revokeAll(personId: string): number {
    const n = this.db
      .prepare("UPDATE sessions SET revoked_at = ? WHERE person_id = ? AND revoked_at IS NULL")
      .run(this.now().toISOString(), personId).changes;
    this.emit(personId, null);
    return n;
  }

  /** The person's live sessions, oldest first. `id` is the hash prefix: the session id itself is never kept. */
  list(personId: string): (Session & { idHashPrefix: string })[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM sessions WHERE person_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at, rowid",
      )
      .all(personId, this.now().toISOString()) as Row[];
    return rows.map((r) => {
      const idHashPrefix = r.id_hash.slice(0, 8);
      return {
        id: idHashPrefix, idHashPrefix, personId: r.person_id, listener: r.listener, method: r.method, createdAt: r.created_at,
        lastSeenAt: r.last_seen_at, expiresAt: r.expires_at,
      };
    });
  }

  /** Called after each revocation with the session's hash, or null when every session of the person went. */
  onRevoke(fn: (personId: string, sessionIdHash: string | null) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private revokeHash(hash: string): boolean {
    const r = this.select.get(hash) as Row | undefined;
    if (!r || r.revoked_at !== null) return false;
    this.db.prepare("UPDATE sessions SET revoked_at = ? WHERE id_hash = ?").run(this.now().toISOString(), hash);
    this.emit(r.person_id, hash);
    return true;
  }

  private emit(personId: string, hash: string | null): void {
    for (const fn of this.listeners) {
      try {
        fn(personId, hash);
      } catch {
        // A listener failing must not undo or block the revocation.
      }
    }
  }
}
