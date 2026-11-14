import { describe, expect, it } from "vitest";
import { which } from "../../src/agents/which.js";

const only = (...found: string[]) => (p: string) => found.includes(p);

describe("which", () => {
  it("returns the first executable match on PATH (POSIX)", () => {
    const env = { PATH: "/opt/a/bin:/usr/local/bin:/usr/bin" };
    expect(which("claude", { env, platform: "linux", isExecutable: only("/usr/local/bin/claude", "/usr/bin/claude") })).toBe(
      "/usr/local/bin/claude",
    );
  });

  it("returns null when nothing matches or PATH is unset", () => {
    expect(which("claude", { env: { PATH: "/usr/bin" }, platform: "darwin", isExecutable: only() })).toBeNull();
    expect(which("claude", { env: {}, platform: "darwin", isExecutable: () => true })).toBeNull();
  });

  it("skips empty and relative PATH entries", () => {
    const env = { PATH: ":.:bin:/usr/bin" };
    const seen: string[] = [];
    which("claude", { env, platform: "linux", isExecutable: (p) => (seen.push(p), false) });
    expect(seen).toEqual(["/usr/bin/claude"]);
  });

  it("on Windows, reads Path case-insensitively and tries claude.exe then claude.cmd", () => {
    const env = { Path: "C:\\Tools;C:\\Users\\a\\AppData\\Roaming\\npm" };
    const seen: string[] = [];
    const found = which("claude", {
      env, platform: "win32",
      isExecutable: (p) => (seen.push(p), p === "C:\\Users\\a\\AppData\\Roaming\\npm\\claude.cmd"),
    });
    expect(found).toBe("C:\\Users\\a\\AppData\\Roaming\\npm\\claude.cmd");
    expect(seen).toEqual([
      "C:\\Tools\\claude.exe",
      "C:\\Tools\\claude.cmd",
      "C:\\Users\\a\\AppData\\Roaming\\npm\\claude.exe",
      "C:\\Users\\a\\AppData\\Roaming\\npm\\claude.cmd",
    ]);
  });
});
