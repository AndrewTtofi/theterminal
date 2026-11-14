import { describe, expect, it } from "vitest";
import { pathScrubber, usernameScrubber } from "../../src/agents/scrub-paths.js";

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

  describe("left boundary is a denylist", () => {
    const win = pathScrubber([["C:\\Users\\a", "~"]], { caseless: true });
    it.each([
      ['{"o":"a\\n/Users/a/x"}', '{"o":"a\\n~/x"}'],
      ['{"o":"a\\t/Users/a/x\\r/Users/a"}', '{"o":"a\\t~/x\\r~"}'],
      ["\\u00e9/Users/a/x", "\\u00e9~/x"],
      ["-v/Users/a:/x", "-v~:/x"],
      ["docker run -v/Users/a/src:/src", "docker run -v~/src:/src"],
      ["gcc -I/Users/a/inc -L/Users/a/lib", "gcc -I~/inc -L~/lib"],
      ["--prefix/Users/a", "--prefix~"],
      ["\x1b[32m/Users/a/x", "\x1b[32m~/x"],
      ["\\u001b[1;32m/Users/a/x", "\\u001b[1;32m~/x"],
      ["//Users/a/x", "/~/x"],
      ["x//Users/a/x", "x/~/x"],
      ["ssh://h//Users/a", "ssh://h/~"],
      ["file:///Users/a", "file://~"],
      ["\r\x1b[K/Users/a/x", "\r\x1b[K~/x"],
      ["\x1b[2K\x1b[1G/Users/a", "\x1b[2K\x1b[1G~"],
      ["\x1b[0K/Users/a", "\x1b[0K~"],
      ["\x1b[H/Users/a", "\x1b[H~"],
      ["\x1b[?25h/Users/a", "\x1b[?25h~"],
      ["\x1b(B/Users/a", "\x1b(B~"],
      ["\x1b)0/Users/a", "\x1b)0~"],
      ["\\u001b[K/Users/a", "\\u001b[K~"],
      ["\\x1b[K/Users/a", "\\x1b[K~"],
      ["\\033[32m/Users/a", "\\033[32m~"],
      ["\\e[32m/Users/a", "\\e[32m~"],
      ['"\\b/Users/a"', '"\\b~"'],
      ['"\\f/Users/a"', '"\\f~"'],
      ...[")", "@", "!", "*", "$", "+", "#", "%", "?", "~", "\\", "\u0001", "“", "‘", "«"].map(
        (c) => [`${c}/Users/a/x`, `${c}~/x`] as [string, string],
      ),
    ])("scrubs %j", (input, expected) => {
      expect(scrub(input)).toBe(expected);
    });

    it.each([
      ['{"o":"x\\nC:\\\\Users\\\\a\\\\f"}', '{"o":"x\\n~\\\\f"}'],
      ["\x1b[0mC:\\Users\\a", "\x1b[0m~"],
      ["\\\\?\\C:\\Users\\a\\x", "\\\\?\\~\\x"],
      ["x\\\\C:\\\\Users\\\\a", "x\\\\~"],
      ["\x1b[KC:\\Users\\a", "\x1b[K~"],
      ['"\\bC:\\\\Users\\\\a"', '"\\b~"'],
      ["cl /IC:\\Users\\a\\inc /FoC:\\Users\\a\\o\\", "cl /I~\\inc /Fo~\\o\\"],
      ["cl /IC:/Users/a/inc", "cl /I~/inc"],
      ['{"c":"/IC:\\\\Users\\\\a"}', '{"c":"/I~"}'],
      ["1C:\\Users\\a", "1~"],
      ["_C:\\Users\\a", "_~"],
      ["ëC:\\Users\\a", "ë~"],
      ["rC:\\Users\\a", "r~"],
    ])("scrubs Windows %j", (input, expected) => {
      expect(win(input)).toBe(expected);
    });

    it.each(["/Volumes/B/Users/a/x", "x/Users/a", "é/Users/a", "./Users/a", "a-/Users/a", "C:\\Volumes\\B\\Users\\a"])(
      "keeps %j, where the directory continues a longer path",
      (input) => {
        expect(scrub(input)).toBe(input);
      },
    );
  });

  describe("right boundary is a denylist", () => {
    it.each([
      ["/Users/a@h", "~@h"],
      ["/Users/a?x", "~?x"],
      ["/Users/a#x", "~#x"],
      ["/Users/a*", "~*"],
      ["/Users/a+", "~+"],
      ["/Users/a%20b", "~%20b"],
      ["/Users/a$", "~$"],
      ["/Users/a…", "~…"],
      ["in /Users/a...", "in ~..."],
      ["(see /Users/a.)", "(see ~.)"],
      ["/Users/a.,", "~.,"],
      ["/Users/a\u0001", "~\u0001"],
    ])("scrubs %j", (input, expected) => {
      expect(scrub(input)).toBe(expected);
    });

    it.each(["/Users/ab", "/Users/aé", "/Users/a.bak", "/Users/a_b", "/Users/a-b", "/Users/a1", "/Users/a.-x"])("keeps %j", (input) => {
      expect(scrub(input)).toBe(input);
    });
  });

  it("stays linear on large inputs", () => {
    const big = 1_000_000;
    const t = Date.now();
    for (const chunk of ["a", "/", "-a", "\\", "\x1b[1", "\x1b[?1", "\\e[1", "C:", "/Users/a", "-v"]) {
      scrub(chunk.repeat(Math.ceil(big / chunk.length)));
    }
    expect(Date.now() - t).toBeLessThan(3000);
  });

  it("never scrubs a root", () => {
    const roots = pathScrubber([["/", "~"], ["C:\\", "<data>"]], { caseless: false });
    expect(roots("/x C:\\y")).toBe("/x C:\\y");
  });
});

describe("usernameScrubber", () => {
  const user = usernameScrubber("alice", { caseless: true });
  it("treats a trailing dot as a boundary unless a name follows it", () => {
    expect(user("owned by alice.")).toBe("owned by <user>.");
    expect(user("alice... done")).toBe("<user>... done");
    expect(user("alice.bak")).toBe("alice.bak");
  });

  it("replaces the username as a whole word", () => {
    expect(user("-rw-r--r--  1 alice  staff  12 Jan  1 00:00 a.txt")).toBe("-rw-r--r--  1 <user>  staff  12 Jan  1 00:00 a.txt");
    expect(user("alice\n")).toBe("<user>\n");
    expect(user("mail alice@example.com")).toBe("mail <user>@example.com");
    expect(user("owner: alice, ALICE and Alice")).toBe("owner: <user>, <user> and <user>");
  });

  it("leaves longer words that contain it alone", () => {
    for (const s of ["malice", "alicex", "alice_x", "x_alice", "alice.bak", "alice-1", "1alice"]) expect(user(s)).toBe(s);
  });

  it("matches case only when asked, and ignores short or empty names", () => {
    expect(usernameScrubber("alice", { caseless: false })("Alice alice")).toBe("Alice <user>");
    expect(usernameScrubber("al", { caseless: true })("al is here")).toBe("al is here");
    expect(usernameScrubber("", { caseless: true })("x")).toBe("x");
  });

  it("treats regex characters in the name literally", () => {
    expect(usernameScrubber("a+b", { caseless: false })("a+b aab")).toBe("<user> aab");
  });
});
