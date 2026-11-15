import { describe, expect, it } from "vitest";
import {
  MAX_CHANGED_FILES,
  MAX_DIFF_BYTES,
  MAX_DIFF_LINES,
  MAX_DIR_ENTRIES,
  MAX_FILE_BYTES,
  MAX_RENDERED_LINES,
  parseUnifiedDiff,
  type DiffLine,
} from "../src/index.js";

const nums = (lines: DiffLine[]) => lines.map((l) => [l.kind, l.oldNo, l.newNo]);

const TWO_HUNKS = [
  "diff --git a/src/app.ts b/src/app.ts",
  "index 1111111..2222222 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,3 +1,4 @@ export function main() {",
  " one",
  "+inserted",
  " two",
  " three",
  "@@ -10,3 +11,2 @@",
  " ten",
  "-eleven",
  " twelve",
].join("\n");

describe("limits", () => {
  it("are the fixed numbers of the Decisions", () => {
    expect([MAX_CHANGED_FILES, MAX_DIFF_LINES, MAX_DIFF_BYTES, MAX_FILE_BYTES, MAX_DIR_ENTRIES, MAX_RENDERED_LINES]).toEqual([
      500, 5000, 1_048_576, 1_048_576, 2000, 20000,
    ]);
  });
});

describe("parseUnifiedDiff", () => {
  it("returns no hunks for an empty diff", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
  });

  it("parses a two-hunk git diff with exact line numbers", () => {
    const hunks = parseUnifiedDiff(TWO_HUNKS);
    expect(hunks).toHaveLength(3);
    const [preamble, first, second] = hunks;
    expect(preamble.header).toBe("");
    expect(preamble.lines.map((l) => l.kind)).toEqual(["meta", "meta", "meta", "meta"]);
    expect(preamble.lines.every((l) => l.oldNo === null && l.newNo === null)).toBe(true);
    expect(preamble.lines[0].text).toBe("diff --git a/src/app.ts b/src/app.ts");

    expect(first.header).toBe("@@ -1,3 +1,4 @@ export function main() {");
    expect(nums(first.lines)).toEqual([
      ["context", 1, 1],
      ["add", null, 2],
      ["context", 2, 3],
      ["context", 3, 4],
    ]);
    expect(first.lines.map((l) => l.text)).toEqual(["one", "inserted", "two", "three"]);

    expect(second.header).toBe("@@ -10,3 +11,2 @@");
    expect(nums(second.lines)).toEqual([
      ["context", 10, 11],
      ["del", 11, null],
      ["context", 12, 12],
    ]);
  });

  it("counts both hunks from the counters even without the git preamble", () => {
    const hunks = parseUnifiedDiff(TWO_HUNKS.split("\n").slice(4).join("\n"));
    expect(hunks.map((h) => h.header)).toEqual(["@@ -1,3 +1,4 @@ export function main() {", "@@ -10,3 +11,2 @@"]);
  });

  it("puts a binary diff in one hunk with an empty header and one meta line", () => {
    const hunks = parseUnifiedDiff("Binary files a/x and b/x differ");
    expect(hunks).toEqual([
      { header: "", lines: [{ kind: "meta", text: "Binary files a/x and b/x differ", oldNo: null, newNo: null }] },
    ]);
  });

  it("marks the no-newline note as meta without moving the counters", () => {
    const hunks = parseUnifiedDiff("@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n");
    expect(hunks).toHaveLength(1);
    expect(nums(hunks[0].lines)).toEqual([
      ["del", 1, null],
      ["meta", null, null],
      ["add", null, 1],
      ["meta", null, null],
    ]);
    expect(hunks[0].lines[1].text).toBe("\\ No newline at end of file");
  });

  it("counts from 1 when a hunk header has no counts", () => {
    const hunks = parseUnifiedDiff("@@ -1 +1 @@\n a\n+b");
    expect(nums(hunks[0].lines)).toEqual([
      ["context", 1, 1],
      ["add", null, 2],
    ]);
  });

  it("treats unrecognised lines as meta and handles CRLF and a trailing newline", () => {
    const hunks = parseUnifiedDiff("@@ -1,2 +1,2 @@\r\n a\r\n?odd\r\n b\r\n");
    expect(hunks).toHaveLength(1);
    expect(hunks[0].lines.map((l) => [l.kind, l.text, l.oldNo, l.newNo])).toEqual([
      ["context", "a", 1, 1],
      ["meta", "?odd", null, null],
      ["context", "b", 2, 2],
    ]);
  });

  it("keeps an empty line inside a hunk as meta rather than inventing a context line", () => {
    const hunks = parseUnifiedDiff("@@ -1,2 +1,2 @@\n a\n\n b");
    expect(nums(hunks[0].lines)).toEqual([
      ["context", 1, 1],
      ["meta", null, null],
      ["context", 2, 2],
    ]);
  });

  it("treats a malformed hunk header as meta and never throws", () => {
    for (const text of ["@@ nonsense @@", "@@ -x,y +z @@", "@@", "@@ -1,2 +1", "\u0000\u0000", "+", "-", " ", "\\"]) {
      expect(() => parseUnifiedDiff(text), text).not.toThrow();
    }
    const hunks = parseUnifiedDiff("@@ nonsense @@\n+x");
    expect(hunks).toEqual([
      {
        header: "",
        lines: [
          { kind: "meta", text: "@@ nonsense @@", oldNo: null, newNo: null },
          { kind: "meta", text: "+x", oldNo: null, newNo: null },
        ],
      },
    ]);
  });

  it("reads --- and +++ inside a hunk as removed and added lines while the counts last", () => {
    const text = ["@@ -1,2 +1,2 @@", "--- not a header", "+++ not either", " kept", "diff --git a/y b/y", "--- a/y", "+++ b/y"].join("\n");
    const hunks = parseUnifiedDiff(text);
    expect(hunks[0].lines.map((l) => [l.kind, l.text, l.oldNo, l.newNo])).toEqual([
      ["del", "-- not a header", 1, null],
      ["add", "++ not either", null, 1],
      ["context", "kept", 2, 2],
      ["meta", "diff --git a/y b/y", null, null],
      ["meta", "--- a/y", null, null],
      ["meta", "+++ b/y", null, null],
    ]);
  });

  it("ignores line numbers too large to be real", () => {
    const hunks = parseUnifiedDiff(`@@ -${"9".repeat(400)} +1 @@\n x`);
    expect(hunks[0].header).toBe("");
    expect(hunks[0].lines[0].kind).toBe("meta");
  });

  it("stays linear on adversarial input", () => {
    const time = (text: string) => {
      const start = performance.now();
      parseUnifiedDiff(text);
      return performance.now() - start;
    };
    const shapes = [
      (n: number) => "@@ -1,1 +1,1 @@".repeat(n),
      (n: number) => `@@ -${"1".repeat(n)}`,
      (n: number) => `@@ -1,${",".repeat(n)}`,
      (n: number) => "@@ ".repeat(n),
      (n: number) => "@@ -1 +1 @@\n".repeat(n),
      (n: number) => "\n".repeat(n),
      (n: number) => `@@ -1 +1 ${" ".repeat(n)}`,
    ];
    for (const shape of shapes) {
      time(shape(20_000));
      const small = Math.max(time(shape(50_000)), 1);
      const big = time(shape(200_000));
      // Four times the input: linear stays near 4x, quadratic would be near 16x.
      expect(big, shape(8).slice(0, 40)).toBeLessThan(small * 10 + 50);
    }
  });

  it("parses a large hunk quickly", () => {
    const body = Array.from({ length: 100_000 }, (_, i) => (i % 3 === 0 ? `+a${i}` : i % 3 === 1 ? `-b${i}` : ` c${i}`)).join("\n");
    const start = performance.now();
    const hunks = parseUnifiedDiff(`@@ -1,66667 +1,66667 @@\n${body}`);
    expect(performance.now() - start).toBeLessThan(2000);
    expect(hunks[0].lines).toHaveLength(100_000);
    const last = hunks[0].lines.at(-1)!;
    expect([last.kind, last.oldNo, last.newNo]).toEqual(["add", null, 66667]);
    expect(hunks[0].lines.at(-2)).toEqual({ kind: "context", text: "c99998", oldNo: 66666, newNo: 66666 });
  });
});
