import { describe, expect, it } from "vitest";
import type { Principal } from "@theterminal/shared";
import { PresenceRegistry, type PresenceEntry } from "../../src/server/presence.js";

function clock(start = Date.UTC(2026, 10, 15, 12, 0, 0)) {
  let t = start;
  return { now: () => new Date(t), advance: (ms: number) => (t += ms) };
}

const who = (id: string, role: Principal["role"] = "reviewer", name = id.toUpperCase()): Principal => ({
  personId: id,
  name,
  role,
  listener: "local",
  method: "passkey",
  sessionId: `SESSION-${id}`,
});

const make = (opts: { maxPerPerson?: number; maxSockets?: number; ttlMs?: number } = {}) => {
  const c = clock();
  return { c, reg: new PresenceRegistry({ now: c.now, ...opts }) };
};

describe("PresenceRegistry", () => {
  it("lists one entry per person with only the plan's fields", () => {
    const { reg } = make();
    reg.join("s1", who("ann", "owner"));
    reg.join("s2", who("bob"));
    const list = reg.list();
    expect(list).toHaveLength(2);
    expect(Object.keys(list[0]!).sort()).toEqual(["name", "personId", "projectId", "role", "since", "view"]);
    expect(list[0]).toMatchObject({ personId: "ann", name: "ANN", role: "owner", projectId: null, view: null });
    expect(JSON.stringify(list)).not.toContain("SESSION");
  });

  it("collapses several sockets of one person; the most recent socket wins", () => {
    const { reg } = make();
    reg.join("s1", who("ann"));
    reg.join("s2", who("ann"));
    reg.update("s1", { projectId: "p1", view: "board" });
    reg.update("s2", { projectId: "p2", view: "ledger" });
    reg.update("s1", { projectId: "p1", view: "agents" });
    expect(reg.list()).toHaveLength(1);
    expect(reg.list()[0]).toMatchObject({ projectId: "p1", view: "agents" });
    reg.leave("s1");
    expect(reg.list()[0]).toMatchObject({ projectId: "p2", view: "ledger" });
    reg.leave("s2");
    expect(reg.list()).toEqual([]);
  });

  it("broadcasts valid updates and ignores a malformed view or project", () => {
    const { reg } = make();
    reg.join("s1", who("ann"));
    const seen: PresenceEntry[][] = [];
    reg.onChange((p) => seen.push(p));
    reg.update("s1", { projectId: "p1", view: "board" });
    expect(seen).toHaveLength(1);
    expect(seen[0]![0]).toMatchObject({ view: "board" });
    reg.update("s1", { projectId: "p1", view: "<script>" });
    reg.update("s1", { projectId: "p1", view: "a".repeat(41) });
    reg.update("s1", { projectId: "<x>", view: "board" });
    reg.update("s1", { projectId: 5, view: 7 } as never);
    reg.update("nope", { projectId: "p1", view: "board" });
    expect(seen).toHaveLength(1);
    expect(reg.list()[0]).toMatchObject({ projectId: "p1", view: "board" });
    reg.update("s1", { projectId: null, view: null });
    expect(reg.list()[0]).toMatchObject({ projectId: null, view: null });
  });

  it("notifies on join and leave, not on no-ops, and unsubscribes", () => {
    const { reg } = make();
    let n = 0;
    const off = reg.onChange(() => n++);
    reg.join("s1", who("ann"));
    expect(n).toBe(1);
    reg.join("s2", who("ann")); // same visible entry
    expect(n).toBe(1);
    reg.leave("s1");
    reg.leave("s1");
    reg.leave("s2");
    expect(n).toBe(2);
    off();
    reg.join("s3", who("bob"));
    expect(n).toBe(2);
  });

  it("a throwing listener does not stop the others", () => {
    const { reg } = make();
    let n = 0;
    reg.onChange(() => {
      throw new Error("boom");
    });
    reg.onChange(() => n++);
    reg.join("s1", who("ann"));
    expect(n).toBe(1);
  });

  it("bounds sockets per person by dropping that person's oldest", () => {
    const { reg } = make({ maxPerPerson: 2 });
    expect(reg.join("a", who("ann"))).toBe(true);
    reg.join("b", who("ann"));
    reg.join("c", who("ann"));
    expect(reg.size).toBe(2);
    reg.update("a", { projectId: "p1", view: "board" }); // dropped socket: ignored
    expect(reg.list()[0]).toMatchObject({ projectId: null });
    reg.join("x", who("bob"));
    expect(reg.size).toBe(3);
  });

  it("bounds sockets globally by refusing new ones, and recovers on leave", () => {
    const { reg } = make({ maxSockets: 2 });
    expect(reg.join("a", who("ann"))).toBe(true);
    expect(reg.join("b", who("bob"))).toBe(true);
    expect(reg.join("c", who("cat"))).toBe(false);
    expect(reg.size).toBe(2);
    expect(reg.list().map((e) => e.personId)).toEqual(["ann", "bob"]);
    reg.leave("a");
    expect(reg.join("c", who("cat"))).toBe(true);
  });

  it("re-joining an existing socket id replaces it without growing", () => {
    const { reg } = make({ maxSockets: 1 });
    reg.join("a", who("ann"));
    expect(reg.join("a", who("ann", "maintainer"))).toBe(true);
    expect(reg.size).toBe(1);
    expect(reg.list()[0]!.role).toBe("maintainer");
  });

  it("expires entries that are not refreshed; update refreshes", () => {
    const { reg, c } = make({ ttlMs: 1000 });
    reg.join("a", who("ann"));
    reg.join("b", who("bob"));
    c.advance(800);
    reg.update("a", { projectId: "p1", view: "board" });
    c.advance(400);
    expect(reg.list().map((e) => e.personId)).toEqual(["ann"]);
    expect(reg.size).toBe(1);
  });

  it("sweep removes expired entries and notifies once", () => {
    const { reg, c } = make({ ttlMs: 1000 });
    reg.join("a", who("ann"));
    const seen: PresenceEntry[][] = [];
    reg.onChange((p) => seen.push(p));
    reg.sweep();
    expect(seen).toHaveLength(0);
    c.advance(1001);
    reg.sweep();
    reg.sweep();
    expect(seen).toEqual([[]]);
  });

  it("expired sockets free capacity for a new join", () => {
    const { reg, c } = make({ maxSockets: 1, ttlMs: 1000 });
    reg.join("a", who("ann"));
    c.advance(1001);
    expect(reg.join("b", who("bob"))).toBe(true);
    expect(reg.list().map((e) => e.personId)).toEqual(["bob"]);
  });

  it("since is the ISO time the person arrived", () => {
    const { reg, c } = make();
    reg.join("a", who("ann"));
    c.advance(5000);
    reg.join("b", who("ann"));
    expect(reg.list()[0]!.since).toBe("2026-11-15T12:00:00.000Z");
  });

  it("rejects invalid options", () => {
    expect(() => new PresenceRegistry({ maxSockets: 0 })).toThrow(RangeError);
    expect(() => new PresenceRegistry({ maxPerPerson: 0 })).toThrow(RangeError);
    expect(() => new PresenceRegistry({ ttlMs: 0 })).toThrow(RangeError);
  });
});
