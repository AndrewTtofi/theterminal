import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { pickedPath } from "../src/folder-pick.js";

const ABS = resolve("chosen");

describe("pickedPath", () => {
  it("is null when the dialog was canceled", () => {
    expect(pickedPath({ canceled: true, filePaths: ["/x"] })).toBeNull();
    expect(pickedPath({ canceled: true, filePaths: [ABS] })).toBeNull();
  });

  it("is the first chosen absolute path", () => {
    expect(pickedPath({ canceled: false, filePaths: [ABS] })).toBe(ABS);
  });

  it("is null for no path, a relative path, or an overlong one", () => {
    expect(pickedPath({ canceled: false, filePaths: [] })).toBeNull();
    expect(pickedPath({ canceled: false, filePaths: ["relative"] })).toBeNull();
    expect(pickedPath({ canceled: false, filePaths: [""] })).toBeNull();
    expect(pickedPath({ canceled: false, filePaths: [ABS + "a".repeat(4096)] })).toBeNull();
  });
});
