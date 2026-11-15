import { describe, expect, it } from "vitest";
import { formatUsd, joinAnd, plural, visibleControls } from "../src/index.js";

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

describe("visibleControls", () => {
  it("shows controls, bidi and zero-width characters as escapes and keeps line breaks and tabs", () => {
    expect(visibleControls("a\u202eb")).toBe("a\\u202eb");
    expect(visibleControls("x\u001b[31m")).toBe("x\\u001b[31m");
    expect(visibleControls("y\r\b\f")).toBe("y\\r\\b\\f");
    expect(visibleControls("z\u200b\u2066")).toBe("z\\u200b\\u2066");
    expect(visibleControls("line\nnext\tcol")).toBe("line\nnext\tcol");
  });

  it("shows the Arabic letter mark, invisible operators, the byte-order mark, line and paragraph separators and the soft hyphen", () => {
    expect(visibleControls("a\u061cb")).toBe("a\\u061cb");
    for (const c of ["\u2060", "\u2061", "\u2062", "\u2063", "\u2064"]) {
      expect(visibleControls(c)).toBe(`\\u${c.charCodeAt(0).toString(16)}`);
    }
    expect(visibleControls("\ufeffx")).toBe("\\ufeffx");
    expect(visibleControls("a\u2028b\u2029c")).toBe("a\\u2028b\\u2029c");
    expect(visibleControls("co\u00adop")).toBe("co\\u00adop");
  });
});
