import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadWindowColor, parseWindowColor, saveWindowColor } from "../src/window-color.js";

const dirs: string[] = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), "tt-wc-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("parseWindowColor", () => {
  it("rejects anything that is not a plain #rgb or #rrggbb", () => {
    for (const v of ["red", "#fff; x", 1, null, undefined, "", "#ffff", "#12345g", "rgb(0,0,0)", "#0d101680"]) {
      expect(parseWindowColor(v)).toBeNull();
    }
  });
  it("accepts and normalises", () => {
    expect(parseWindowColor(" #0D1016 ")).toBe("#0d1016");
    expect(parseWindowColor("#FFF")).toBe("#fff");
  });
});

describe("loadWindowColor / saveWindowColor", () => {
  it("defaults to Ice's background for a missing file, corrupt JSON or an invalid colour", () => {
    const d = tempDir();
    const f = join(d, "window.json");
    expect(loadWindowColor(f)).toBe("#0d1016");
    writeFileSync(f, "{not json");
    expect(loadWindowColor(f)).toBe("#0d1016");
    writeFileSync(f, JSON.stringify({ backgroundColor: "red" }));
    expect(loadWindowColor(f)).toBe("#0d1016");
    writeFileSync(f, "null");
    expect(loadWindowColor(f)).toBe("#0d1016");
  });
  it("round-trips a saved colour and leaves no temp file", () => {
    const d = tempDir();
    const f = join(d, "window.json");
    saveWindowColor(f, "#FAFAFA");
    expect(loadWindowColor(f)).toBe("#fafafa");
    expect(readFileSync(f, "utf8")).not.toContain("FAFAFA");
    expect(readdirSync(d)).toEqual(["window.json"]);
  });
});
