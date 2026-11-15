import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createColorRecorder, loadWindowColor, parseWindowColor, saveWindowColor } from "../src/window-color.js";

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

describe("createColorRecorder", () => {
  it("saves a changed colour once and skips an unchanged one", async () => {
    const saved: string[] = [];
    const r = createColorRecorder({ read: async () => " #FAFAFA ", save: (c) => void saved.push(c), initial: "#0d1016" });
    await r.record();
    await r.record();
    expect(saved).toEqual(["#fafafa"]);
  });
  it("skips the write when the colour equals the initial one", async () => {
    const saved: string[] = [];
    await createColorRecorder({ read: async () => "#0d1016", save: (c) => void saved.push(c), initial: "#0d1016" }).record();
    expect(saved).toEqual([]);
  });
  it("keeps the old colour when the read or the save fails, and retries later", async () => {
    const saved: string[] = [];
    let fail = true;
    const r = createColorRecorder({
      read: async () => {
        if (fail) throw new Error("gone");
        return "#111111";
      },
      save: (c) => void saved.push(c),
    });
    await r.record();
    expect(saved).toEqual([]);
    fail = false;
    await r.record();
    expect(saved).toEqual(["#111111"]);
    const bad = createColorRecorder({ read: async () => "#222222", save: () => { throw new Error("disk"); } });
    await expect(bad.record()).resolves.toBeUndefined();
  });
  it("ignores an invalid value", async () => {
    const saved: string[] = [];
    for (const v of ["red", "#fff; x", null, 5]) await createColorRecorder({ read: async () => v, save: (c) => void saved.push(c) }).record();
    expect(saved).toEqual([]);
  });
});
