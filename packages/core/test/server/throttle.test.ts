import { describe, expect, it } from "vitest";
import { AUTH_THROTTLE, Throttle } from "../../src/server/throttle.js";

/** A clock the test moves by hand. */
function clock(start = Date.UTC(2026, 10, 15, 12, 0, 0)) {
  let t = start;
  return { now: () => new Date(t), advance: (ms: number) => (t += ms) };
}

const make = (c = clock(), max?: number) => ({ c, throttle: new Throttle({ ...AUTH_THROTTLE, now: c.now, ...(max === undefined ? {} : { max }) }) });
const hitN = (t: Throttle, key: string, n: number) => Array.from({ length: n }, () => t.hit(key));

describe("Throttle", () => {
  it("AUTH_THROTTLE is ten hits a minute", () => {
    expect(AUTH_THROTTLE).toEqual({ limit: 10, windowMs: 60_000 });
  });

  it("allows ten hits, refuses the eleventh with retryAfterS 60, and allows again after windowMs", () => {
    const { c, throttle } = make();
    expect(hitN(throttle, "1.2.3.4", 10)).toEqual(Array(10).fill({ allowed: true }));
    expect(throttle.hit("1.2.3.4")).toEqual({ allowed: false, retryAfterS: 60 });
    c.advance(60_000);
    expect(throttle.hit("1.2.3.4")).toEqual({ allowed: true });
  });

  it("counts retryAfterS down to the end of the window, rounded up, and never below 1", () => {
    const { c, throttle } = make();
    hitN(throttle, "k", 10);
    c.advance(30_500);
    expect(throttle.hit("k")).toEqual({ allowed: false, retryAfterS: 30 });
    c.advance(29_499);
    expect(throttle.hit("k")).toEqual({ allowed: false, retryAfterS: 1 });
    c.advance(1);
    expect(throttle.hit("k")).toEqual({ allowed: true });
  });

  it("refused hits do not extend the window", () => {
    const { c, throttle } = make();
    hitN(throttle, "k", 10);
    for (let i = 0; i < 59; i += 1) {
      c.advance(1_000);
      expect(throttle.hit("k").allowed).toBe(false);
    }
    c.advance(1_000);
    expect(throttle.hit("k")).toEqual({ allowed: true });
  });

  it("starts a full fresh window after the old one ends", () => {
    const { c, throttle } = make();
    hitN(throttle, "k", 10);
    c.advance(60_000);
    expect(hitN(throttle, "k", 10)).toEqual(Array(10).fill({ allowed: true }));
    expect(throttle.hit("k")).toEqual({ allowed: false, retryAfterS: 60 });
  });

  it("keeps two keys independent", () => {
    const { throttle } = make();
    hitN(throttle, "a", 10);
    expect(throttle.hit("a").allowed).toBe(false);
    expect(throttle.hit("b")).toEqual({ allowed: true });
    expect(hitN(throttle, "b", 9)).toEqual(Array(9).fill({ allowed: true }));
    expect(throttle.hit("b").allowed).toBe(false);
  });

  it("holds 10000 keys by default; the 10001st evicts the oldest", () => {
    const { throttle } = make();
    hitN(throttle, "key-0", 10);
    for (let i = 1; i < 10_000; i += 1) throttle.hit(`key-${i}`);
    expect(throttle.size).toBe(10_000);
    expect(throttle.hit("key-0").allowed).toBe(false);
    throttle.hit("key-10000");
    expect(throttle.size).toBe(10_000);
    // key-0's bucket was the oldest and is gone, so it starts again.
    expect(throttle.hit("key-0")).toEqual({ allowed: true });
  });

  it("never grows past max, however many keys an attacker rotates through", () => {
    const { c, throttle } = make(clock(), 100);
    for (let i = 0; i < 5_000; i += 1) {
      throttle.hit(`rotating-${i}`);
      if (i % 7 === 0) c.advance(13);
      expect(throttle.size).toBeLessThanOrEqual(100);
    }
    expect(throttle.size).toBe(100);
  });

  it("evicts by window start: a key whose window restarted is younger than one that has not", () => {
    const { c, throttle } = make(clock(), 2);
    throttle.hit("a");
    c.advance(1_000);
    hitN(throttle, "b", 10);
    c.advance(60_000); // a's and b's windows have both ended
    throttle.hit("a"); // a starts a new window, so b is now the oldest
    throttle.hit("c"); // evicts b, not a
    expect(throttle.hit("b")).toEqual({ allowed: true });
    expect(throttle.size).toBe(2);
  });

  it("does not let a key evict itself while it is blocked", () => {
    const { throttle } = make(clock(), 1);
    hitN(throttle, "only", 10);
    expect(throttle.hit("only").allowed).toBe(false);
    expect(throttle.size).toBe(1);
  });

  it("rejects nonsense options", () => {
    expect(() => new Throttle({ limit: 0, windowMs: 1_000 })).toThrow(RangeError);
    expect(() => new Throttle({ limit: 1.5, windowMs: 1_000 })).toThrow(RangeError);
    expect(() => new Throttle({ limit: 1, windowMs: 0 })).toThrow(RangeError);
    expect(() => new Throttle({ limit: 1, windowMs: Number.NaN })).toThrow(RangeError);
    expect(() => new Throttle({ limit: 1, windowMs: 1_000, max: 0 })).toThrow(RangeError);
  });

  it("uses the real clock by default", () => {
    const throttle = new Throttle({ limit: 1, windowMs: 60_000 });
    expect(throttle.hit("k")).toEqual({ allowed: true });
    expect(throttle.hit("k")).toEqual({ allowed: false, retryAfterS: 60 });
  });
});
