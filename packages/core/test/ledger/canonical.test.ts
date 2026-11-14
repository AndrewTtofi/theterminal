import { describe, it, expect } from "vitest";
import { canonicalJson } from "../../src/ledger/canonical.js";

describe("canonicalJson", () => {
  it("sorts keys recursively with no whitespace", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });
  it("keeps array order and handles null", () => {
    expect(canonicalJson({ x: [3, { b: 1, a: null }] })).toBe('{"x":[3,{"a":null,"b":1}]}');
  });
  it("rejects undefined and functions", () => {
    expect(() => canonicalJson({ a: undefined })).toThrow();
    expect(() => canonicalJson({ a: () => 1 })).toThrow();
    expect(() => canonicalJson(undefined)).toThrow();
  });
});
