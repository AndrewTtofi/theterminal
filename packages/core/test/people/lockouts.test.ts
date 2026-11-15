import { describe, expect, it } from "vitest";
import { LOCKOUT_FAILURES, LOCKOUT_MS, LockedError, LockoutStore } from "../../src/people/lockouts.js";

const A = "198.51.100.7";
const B = "198.51.100.8";

function clock(start = Date.parse("2026-11-15T10:00:00.000Z")) {
  let t = start;
  return { now: () => new Date(t), advance: (ms: number) => { t += ms; } };
}

describe("LockoutStore", () => {
  it("defaults to five failures and fifteen minutes", () => {
    expect(LOCKOUT_FAILURES).toBe(5);
    expect(LOCKOUT_MS).toBe(15 * 60_000);
  });

  it("locks a credential and address pair at the fifth failure, once, and only for that address", () => {
    const c = clock();
    const s = new LockoutStore({ now: c.now });
    const results = Array.from({ length: 5 }, () => s.failure("cred-1", A));
    expect(results.filter((r) => r.locked)).toHaveLength(1);
    expect(results[4]).toEqual({ locked: true, until: "2026-11-15T10:15:00.000Z", failures: 5 });
    expect(results.slice(0, 4).map((r) => r.failures)).toEqual([1, 2, 3, 4]);

    let thrown: unknown;
    try {
      s.assertNotLocked("cred-1", A);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(LockedError);
    expect((thrown as LockedError).retryAfterS).toBeGreaterThan(0);
    expect((thrown as LockedError).retryAfterS).toBeLessThanOrEqual(900);
    expect(() => s.assertNotLocked("cred-1", B)).not.toThrow();
    expect(() => s.assertNotLocked("cred-2", A)).not.toThrow();
  });

  it("a failure while locked neither counts nor locks again", () => {
    const c = clock();
    const s = new LockoutStore({ now: c.now });
    for (let i = 0; i < 5; i++) s.failure("cred-1", A);
    expect(s.failure("cred-1", A).locked).toBe(false);
    expect(() => s.assertNotLocked("cred-1", A)).toThrow(LockedError);
  });

  it("the lock lapses after lockMs, and success clears the pair", () => {
    const c = clock();
    const s = new LockoutStore({ now: c.now });
    for (let i = 0; i < 5; i++) s.failure("cred-1", A);
    c.advance(LOCKOUT_MS);
    expect(() => s.assertNotLocked("cred-1", A)).not.toThrow();
    s.success("cred-1", A);
    expect(s.failure("cred-1", A).failures).toBe(1);
    s.failure("cred-1", A);
    s.success("cred-1", A);
    expect(s.failure("cred-1", A).failures).toBe(1);
  });

  it("clear(credentialId) clears every address of that credential and no other credential", () => {
    const s = new LockoutStore();
    for (let i = 0; i < 5; i++) {
      s.failure("cred-1", A);
      s.failure("cred-1", B);
      s.failure("cred-2", A);
    }
    s.clear("cred-1");
    expect(() => s.assertNotLocked("cred-1", A)).not.toThrow();
    expect(() => s.assertNotLocked("cred-1", B)).not.toThrow();
    expect(() => s.assertNotLocked("cred-2", A)).toThrow(LockedError);
  });

  it("the 10001st key evicts the oldest", () => {
    const s = new LockoutStore();
    s.failure("cred-0", A);
    s.failure("cred-0", A);
    for (let i = 1; i < 10_000; i++) s.failure(`cred-${i}`, A);
    expect(s.failure("cred-1", A).failures).toBe(2); // still held
    s.failure("cred-10000", A); // the 10001st key
    expect(s.failure("cred-0", A).failures).toBe(1); // the oldest was evicted
  });

  it("evicts an unlocked key before a locked one", () => {
    const s = new LockoutStore({ max: 3 });
    for (let i = 0; i < 5; i++) s.failure("locked", A);
    s.failure("b", A);
    s.failure("c", A);
    s.failure("d", A);
    expect(() => s.assertNotLocked("locked", A)).toThrow(LockedError);
  });

  it("keeps no address in what it stores", () => {
    const s = new LockoutStore();
    s.failure("cred-1", A);
    expect(JSON.stringify([...(s as unknown as { entries: Map<string, unknown> }).entries.keys()])).not.toContain("198.51");
  });
});
