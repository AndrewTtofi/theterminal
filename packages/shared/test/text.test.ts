import { describe, expect, it } from "vitest";
import { formatUsd, joinAnd, plural } from "../src/index.js";

describe("plural", () => {
  it("uses the singular for one and the plural otherwise", () => {
    expect(plural(1, "card")).toBe("1 card");
    expect(plural(5, "card")).toBe("5 cards");
    expect(plural(0, "line")).toBe("0 lines");
    expect(plural(2, "entry", "entries")).toBe("2 entries");
    expect(plural(1, "entry", "entries")).toBe("1 entry");
  });
});

describe("joinAnd", () => {
  it("joins with commas and a final and", () => {
    expect(joinAnd([])).toBe("");
    expect(joinAnd(["a"])).toBe("a");
    expect(joinAnd(["a", "b"])).toBe("a and b");
    expect(joinAnd(["a", "b", "c"])).toBe("a, b and c");
  });
});

describe("formatUsd", () => {
  it("formats dollars with two decimals and thousands separators", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(12.5)).toBe("$12.50");
    expect(formatUsd(0.29)).toBe("$0.29");
    expect(formatUsd(1000)).toBe("$1,000.00");
    expect(formatUsd(1_000_000)).toBe("$1,000,000.00");
    expect(formatUsd(12.3456)).toBe("$12.35");
  });
});
