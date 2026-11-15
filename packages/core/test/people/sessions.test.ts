import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { SESSION_TTL_MS } from "@theterminal/shared";
import { openDatabase, type Db } from "../../src/db.js";
import { SessionStore } from "../../src/people/sessions.js";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

let db: Db;
let t: number;
const now = () => new Date(t);

beforeEach(() => {
  db = openDatabase(":memory:");
  t = Date.parse("2026-11-15T10:00:00.000Z");
});

describe("SessionStore", () => {
  it("returns a 43-character id and stores only its sha256", () => {
    const s = new SessionStore(db, { now });
    const { id, session } = s.create("p1", "local", "passkey");
    expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(session).toEqual({
      id, personId: "p1", listener: "local", method: "passkey",
      createdAt: "2026-11-15T10:00:00.000Z", lastSeenAt: "2026-11-15T10:00:00.000Z",
      expiresAt: new Date(t + SESSION_TTL_MS).toISOString(),
    });
    const rows = db.prepare("SELECT * FROM sessions").all() as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id_hash).toBe(sha256(id));
    expect(JSON.stringify(rows)).not.toContain(id);
  });

  it("is bound to the listener it was created on", () => {
    const s = new SessionStore(db, { now });
    const { id } = s.create("p1", "local", "passkey");
    expect(s.lookup(id, "local")?.personId).toBe("p1");
    expect(s.lookup(id, "remote")).toBeNull();
    const remote = s.create("p1", "remote", "key").id;
    expect(s.lookup(remote, "local")).toBeNull();
    expect(s.lookup(remote, "remote")?.method).toBe("key");
  });

  it("unknown and malformed ids are null", () => {
    const s = new SessionStore(db, { now });
    expect(s.lookup("x".repeat(43), "local")).toBeNull();
    expect(s.lookup("", "local")).toBeNull();
    expect(s.lookup(undefined as unknown as string, "local")).toBeNull();
  });

  it("is null after revoke, immediately, and fires onRevoke with the hash", () => {
    const s = new SessionStore(db, { now });
    const seen: [string, string | null][] = [];
    s.onRevoke((p, h) => seen.push([p, h]));
    const { id } = s.create("p1", "local", "passkey");
    s.revoke(id);
    expect(s.lookup(id, "local")).toBeNull();
    expect(seen).toEqual([["p1", sha256(id)]]);
  });

  it("is null after ttlMs", () => {
    const s = new SessionStore(db, { now, ttlMs: 60_000 });
    const { id } = s.create("p1", "local", "passkey");
    t += 59_999;
    expect(s.lookup(id, "local")).not.toBeNull();
    t += 1;
    expect(s.lookup(id, "local")).toBeNull();
  });

  it("touches last_seen_at at most once a minute", () => {
    const s = new SessionStore(db, { now });
    const { id } = s.create("p1", "local", "passkey");
    t += 30_000;
    expect(s.lookup(id, "local")!.lastSeenAt).toBe("2026-11-15T10:00:00.000Z");
    t += 30_000;
    expect(s.lookup(id, "local")!.lastSeenAt).toBe("2026-11-15T10:01:00.000Z");
    t += 10_000;
    s.lookup(id, "local");
    const row = db.prepare("SELECT last_seen_at FROM sessions").get() as { last_seen_at: string };
    expect(row.last_seen_at).toBe("2026-11-15T10:01:00.000Z");
  });

  it("revokeAll returns the count and fires onRevoke(personId, null)", () => {
    const s = new SessionStore(db, { now });
    const seen: [string, string | null][] = [];
    s.onRevoke((p, h) => seen.push([p, h]));
    const a = s.create("p1", "local", "passkey").id;
    const b = s.create("p1", "remote", "key").id;
    const other = s.create("p2", "local", "passkey").id;
    expect(s.revokeAll("p1")).toBe(2);
    expect(seen).toEqual([["p1", null]]);
    expect(s.lookup(a, "local")).toBeNull();
    expect(s.lookup(b, "remote")).toBeNull();
    expect(s.lookup(other, "local")).not.toBeNull();
    expect(s.revokeAll("p1")).toBe(0);
  });

  it("lists a person's live sessions with an 8-character hash prefix and revokes one by it", () => {
    const s = new SessionStore(db, { now });
    const seen: [string, string | null][] = [];
    s.onRevoke((p, h) => seen.push([p, h]));
    const a = s.create("p1", "local", "passkey").id;
    const b = s.create("p1", "remote", "key").id;
    s.create("p2", "local", "passkey");
    const listed = s.list("p1");
    expect(listed.map((x) => x.idHashPrefix).sort()).toEqual([sha256(a).slice(0, 8), sha256(b).slice(0, 8)].sort());
    expect(JSON.stringify(listed)).not.toContain(a);
    expect(s.revokeByHashPrefix("p2", sha256(a).slice(0, 8))).toBe(false); // not theirs
    expect(s.revokeByHashPrefix("p1", "zz")).toBe(false);
    expect(s.revokeByHashPrefix("p1", sha256(a).slice(0, 8))).toBe(true);
    expect(seen).toEqual([["p1", sha256(a)]]);
    expect(s.lookup(a, "local")).toBeNull();
    expect(s.lookup(b, "remote")).not.toBeNull();
    expect(s.list("p1")).toHaveLength(1);
  });
});
