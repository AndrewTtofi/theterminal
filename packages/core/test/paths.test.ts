import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { defaultDataDir, defaultUiDir } from "../src/paths.js";

describe("defaultDataDir", () => {
  it("uses Application Support on macOS", () => {
    expect(defaultDataDir("darwin", { HOME: "/Users/a" })).toBe("/Users/a/Library/Application Support/TheTerminal");
  });
  it("uses APPDATA on Windows", () => {
    expect(defaultDataDir("win32", { APPDATA: "C:\\Users\\a\\AppData\\Roaming" })).toBe(
      "C:\\Users\\a\\AppData\\Roaming\\TheTerminal",
    );
  });
  it("uses XDG-style path elsewhere", () => {
    expect(defaultDataDir("linux", { HOME: "/home/a" })).toBe("/home/a/.local/share/theterminal");
  });
});

describe("defaultUiDir", () => {
  it("resolves apps/ui/dist relative to the core package when index.html exists", () => {
    const root = mkdtempSync(join(tmpdir(), "tt-ui-"));
    const coreDist = join(root, "packages", "core", "dist");
    mkdirSync(coreDist, { recursive: true });
    mkdirSync(join(root, "apps", "ui", "dist"), { recursive: true });
    writeFileSync(join(root, "apps", "ui", "dist", "index.html"), "<html></html>");
    expect(defaultUiDir(pathToFileURL(join(coreDist, "cli.js")).href)).toBe(join(root, "apps", "ui", "dist"));
  });
  it("returns undefined when the UI has not been built", () => {
    const root = mkdtempSync(join(tmpdir(), "tt-ui-"));
    mkdirSync(join(root, "packages", "core", "dist"), { recursive: true });
    expect(defaultUiDir(pathToFileURL(join(root, "packages", "core", "dist", "cli.js")).href)).toBeUndefined();
  });
});
