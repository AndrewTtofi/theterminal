import { afterEach, describe, expect, it, vi } from "vitest";
import { LEARN_TOPICS } from "@theterminal/shared";
import { LEARN_READ_KEY, markRead, readTopics } from "../src/learn-store";

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("learn-store", () => {
  it("round-trips read topic ids", () => {
    const [a, b] = LEARN_TOPICS;
    markRead(a!.id);
    markRead(b!.id);
    markRead(a!.id);
    expect([...readTopics()].sort()).toEqual([a!.id, b!.id].sort());
  });

  it("drops ids that are not in the catalog and survives bad stored data", () => {
    localStorage.setItem(LEARN_READ_KEY, JSON.stringify([LEARN_TOPICS[0]!.id, "nope", 5, "x".repeat(10_000)]));
    expect([...readTopics()]).toEqual([LEARN_TOPICS[0]!.id]);
    localStorage.setItem(LEARN_READ_KEY, "{not json");
    expect(readTopics().size).toBe(0);
    localStorage.setItem(LEARN_READ_KEY, JSON.stringify({ a: 1 }));
    expect(readTopics().size).toBe(0);
  });

  it("ignores an unknown id and never stores more than the catalog holds", () => {
    markRead("nope");
    expect(localStorage.getItem(LEARN_READ_KEY)).toBeNull();
    for (const t of LEARN_TOPICS) markRead(t.id);
    expect(JSON.parse(localStorage.getItem(LEARN_READ_KEY)!)).toHaveLength(LEARN_TOPICS.length);
  });

  it("fails quietly when storage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("full");
    });
    expect(readTopics().size).toBe(0);
    expect(() => markRead(LEARN_TOPICS[0]!.id)).not.toThrow();
  });
});
