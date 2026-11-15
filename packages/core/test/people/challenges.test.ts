import { describe, expect, it } from "vitest";
import { ChallengeStore } from "../../src/people/challenges.js";

function clock(start = Date.parse("2026-11-15T10:00:00.000Z")) {
  let t = start;
  return { now: () => new Date(t), advance: (ms: number) => { t += ms; } };
}

describe("ChallengeStore", () => {
  it("issues 32 random bytes as base64url", () => {
    const s = new ChallengeStore();
    const a = s.issue("login", "198.51.100.7");
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(s.issue("login", "198.51.100.7")).not.toBe(a);
  });

  it("consume is true once, then false", () => {
    const s = new ChallengeStore();
    const ch = s.issue("login", "198.51.100.7");
    expect(s.consume(ch, "login")).toBe(true);
    expect(s.consume(ch, "login")).toBe(false);
    expect(s.consume("unknown", "login")).toBe(false);
  });

  it("a different scope is false, and burns the challenge", () => {
    const s = new ChallengeStore();
    const ch = s.issue("join:inv-1", "198.51.100.7");
    expect(s.consume(ch, "join:inv-2")).toBe(false);
    expect(s.consume(ch, "join:inv-1")).toBe(false);
  });

  it("is false after ttlMs", () => {
    const c = clock();
    const s = new ChallengeStore({ now: c.now });
    const ch = s.issue("login", "198.51.100.7");
    const kept = s.issue("login", "198.51.100.7");
    c.advance(299_999);
    expect(s.consume(kept, "login")).toBe(true);
    c.advance(1);
    expect(s.consume(ch, "login")).toBe(false);
  });

  it("1001 issues from one client do not evict another client's challenge", () => {
    const s = new ChallengeStore();
    const theirs = s.issue("login", "198.51.100.8");
    for (let i = 0; i < 1001; i++) s.issue("login", "198.51.100.7");
    expect(s.consume(theirs, "login")).toBe(true);
  });

  it("the 21st open challenge of one client evicts that client's oldest", () => {
    const s = new ChallengeStore();
    const issued = Array.from({ length: 21 }, () => s.issue("login", "198.51.100.7"));
    expect(s.consume(issued[0]!, "login")).toBe(false);
    expect(s.consume(issued[1]!, "login")).toBe(true);
    expect(s.consume(issued[20]!, "login")).toBe(true);
  });

  it("the 10001st challenge overall evicts the oldest overall", () => {
    const s = new ChallengeStore();
    const first = s.issue("login", "client-0");
    const second = s.issue("login", "client-1");
    for (let i = 2; i < 10_000; i++) s.issue("login", `client-${i}`);
    s.issue("login", "client-10000");
    expect(s.consume(first, "login")).toBe(false);
    expect(s.consume(second, "login")).toBe(true);
  });
});
