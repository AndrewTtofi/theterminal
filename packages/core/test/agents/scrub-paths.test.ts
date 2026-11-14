import { describe, expect, it } from "vitest";
import { pathScrubber } from "../../src/agents/scrub-paths.js";

// Fake paths only; none of them exist, so only the raw spellings are scrubbed.
const dirs: [string, string][] = [
  ["/Users/a", "~"],
  ["/data/d", "<data>"],
  ["/data/d/projects/p/worktrees/r", "."],
];
const scrub = pathScrubber(dirs, { caseless: false });

describe("pathScrubber", () => {
  it("replaces whole directories, longest first", () => {
    expect(scrub("/Users/a/x")).toBe("~/x");
    expect(scrub("cat /Users/a")).toBe("cat ~");
    expect(scrub("/data/d/projects/p/worktrees/r/src/a.ts")).toBe("./src/a.ts");
    expect(scrub("/data/d/other")).toBe("<data>/other");
    expect(scrub("HOME=/Users/a; cd '/Users/a/y'")).toBe("HOME=~; cd '~/y'");
    expect(scrub("home is /Users/a.")).toBe("home is ~.");
    expect(scrub("\\Users\\a\\x")).toBe("~\\x");
  });

  it("only matches a whole path component on the right", () => {
    expect(scrub("/Users/ab/x")).toBe("/Users/ab/x");
    expect(scrub("/Users/aé/x")).toBe("/Users/aé/x");
    expect(scrub("/Users/a.bak")).toBe("/Users/a.bak");
  });

  it("requires a left boundary, but allows file:// URLs", () => {
    expect(scrub("/Volumes/B/Users/a/x")).toBe("/Volumes/B/Users/a/x");
    expect(scrub("file:///Users/a/x")).toBe("file://~/x");
    const app = pathScrubber([["/app", "~"]], { caseless: false });
    expect(app("https://h/app/x")).toBe("https://h/app/x");
    expect(app("/app/x and (/app)")).toBe("~/x and (~)");
  });

  it("scrubs JSON-escaped spellings and keeps the JSON valid", () => {
    const win = pathScrubber([["C:\\Users\\a", "~"]], { caseless: true });
    const json = JSON.stringify({ p: "C:\\Users\\a\\x" });
    expect(json).toBe('{"p":"C:\\\\Users\\\\a\\\\x"}');
    expect(win(json)).toBe('{"p":"~\\\\x"}');
    expect(JSON.parse(win(json))).toEqual({ p: "~\\x" });
    expect(win("C:\\Users\\a\\x")).toBe("~\\x");
    expect(win("c:/users/A/x")).toBe("~/x");

    const escapedSlash = '{"p":"\\/Users\\/a\\/x","u":"file:\\/\\/\\/Users\\/a"}';
    expect(scrub(escapedSlash)).toBe('{"p":"~\\/x","u":"file:\\/\\/~"}');
    expect(JSON.parse(scrub(escapedSlash))).toEqual({ p: "~/x", u: "file://~" });
  });

  it("matches without case when caseless, which is the default on macOS and Windows", () => {
    expect(pathScrubber(dirs, { caseless: true })("/users/A/x")).toBe("~/x");
    expect(scrub("/users/A/x")).toBe("/users/A/x");
    const caselessByDefault = process.platform === "darwin" || process.platform === "win32";
    expect(pathScrubber(dirs)("/USERS/A/x")).toBe(caselessByDefault ? "~/x" : "/USERS/A/x");
  });

  it("never scrubs a root", () => {
    const roots = pathScrubber([["/", "~"], ["C:\\", "<data>"]], { caseless: false });
    expect(roots("/x C:\\y")).toBe("/x C:\\y");
  });
});
