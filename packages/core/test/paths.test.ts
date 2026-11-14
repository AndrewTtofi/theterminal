import { describe, it, expect } from "vitest";
import { defaultDataDir } from "../src/paths.js";

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
