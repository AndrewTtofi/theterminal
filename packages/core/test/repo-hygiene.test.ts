import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
/** Bidi controls, zero-width, line/paragraph separators, tag characters and other invisibles: write them as escapes. */
const HIDDEN = /[\u{202A}-\u{202E}\u{2066}-\u{2069}\u{200B}-\u{200F}\u{FEFF}\u{061C}\u{2060}-\u{2064}\u{00AD}\u{180E}\u{2028}\u{2029}\u{E0000}-\u{E007F}]/u;

describe("repository text", () => {
  it("holds no raw bidi or invisible characters", () => {
    const files = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" }).split("\0").filter(Boolean);
    const found: string[] = [];
    for (const f of files) {
      let buf: Buffer;
      try {
        buf = readFileSync(join(ROOT, f));
      } catch {
        continue; // deleted in the working tree
      }
      if (buf.includes(0)) continue; // binary
      const lines = buf.toString("utf8").split("\n");
      lines.forEach((line, i) => {
        const m = HIDDEN.exec(line);
        if (m) found.push(`${f}:${i + 1} U+${m[0].codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`);
      });
    }
    expect(found).toEqual([]);
  });
});
