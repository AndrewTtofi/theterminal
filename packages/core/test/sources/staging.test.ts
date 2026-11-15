import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ImportLimitError, ImportStaging, PossibleSecretsError } from "../../src/sources/staging.js";

const identity = (s: string) => s;
const body = (s: string | Buffer) => Readable.from([Buffer.from(s)]);
/** `total` bytes in chunks of `chunk`, generated lazily, recording how many were pulled. */
function lazyBytes(total: number, chunk = 64): { stream: Readable; pulled: () => number } {
  let sent = 0;
  const stream = new Readable({
    read() {
      if (sent >= total) return void this.push(null);
      const n = Math.min(chunk, total - sent);
      sent += n;
      this.push(Buffer.alloc(n, 0x61));
    },
  });
  return { stream, pulled: () => sent };
}

let root: string;
let dir: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "staging-")));
  dir = join(root, "staging", "u1");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("ImportStaging", () => {
  it("adds files and lists them in finish()", async () => {
    const s = new ImportStaging(dir, { includeSecrets: false, redact: identity });
    expect(await s.add("a.txt", body("A"))).toBe("added");
    expect(await s.add("src/b.ts", body("BB"))).toBe("added");
    expect(await s.add("docs\\c.md", body("CCC"))).toBe("added");
    const r = s.finish();
    expect(r.files).toEqual(["a.txt", "src/b.ts", "docs/c.md"]);
    expect(r.bytes).toBe(6);
    expect(r.skipped).toEqual([]);
    expect(r.skippedCount).toBe(0);
    expect(readFileSync(join(dir, "src", "b.ts"), "utf8")).toBe("BB");
    expect(readFileSync(join(dir, "docs", "c.md"), "utf8")).toBe("CCC");
  });

  it("skips refused paths with their reasons", async () => {
    const s = new ImportStaging(dir, { includeSecrets: false, redact: identity });
    expect(await s.add("../x", body("x"))).toBe("skipped");
    expect(await s.add(".git/config", body("[core]\n\tfsmonitor = evil\n"))).toBe("skipped");
    expect(await s.add("con.txt", body("x"))).toBe("skipped");
    const r = s.finish();
    expect(r.files).toEqual([]);
    expect(r.skipped).toEqual([
      { path: "../x", reason: "dot_dot" },
      { path: ".git/config", reason: "git" },
      { path: "con.txt", reason: "unstorable" },
    ]);
    expect(r.skippedCount).toBe(3);
    expect(existsSync(join(root, "staging", "x"))).toBe(false);
    expect(existsSync(join(dir, ".git"))).toBe(false);
  });

  it("skips a second name that differs only by case as duplicate", async () => {
    const s = new ImportStaging(dir, { includeSecrets: false, redact: identity });
    expect(await s.add("a.txt", body("lower"))).toBe("added");
    expect(await s.add("A.txt", body("upper"))).toBe("skipped");
    const r = s.finish();
    expect(r.files).toEqual(["a.txt"]);
    expect(r.skipped).toEqual([{ path: "A.txt", reason: "duplicate" }]);
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("lower");
  });

  it("refuses the file after the limit with ImportLimitError(files)", async () => {
    const s = new ImportStaging(dir, { includeSecrets: false, redact: identity, limits: { files: 3, bytes: 1000, fileBytes: 100 } });
    for (const n of [1, 2, 3]) await s.add(`f${n}.txt`, body("x"));
    const fourth = lazyBytes(10);
    await expect(s.add("f4.txt", fourth.stream)).rejects.toEqual(new ImportLimitError("files"));
    expect(fourth.pulled()).toBe(0);
    expect(existsSync(join(dir, "f4.txt"))).toBe(false);
  });

  it("allows 2000 files by default and refuses the 2001st", async () => {
    const s = new ImportStaging(dir, { includeSecrets: false, redact: identity });
    for (let i = 0; i < 2000; i++) await s.add(`d${i % 20}/f${i}.txt`, body(""));
    await expect(s.add("one-more.txt", body("x"))).rejects.toMatchObject({ name: "ImportLimitError", limit: "files" });
  }, 60_000);

  it("refuses a stream over fileBytes while streaming and leaves no partial file", async () => {
    const s = new ImportStaging(dir, { includeSecrets: false, redact: identity, limits: { files: 10, bytes: 100_000, fileBytes: 1000 } });
    const big = lazyBytes(1001, 100);
    await expect(s.add("big.bin", big.stream)).rejects.toMatchObject({ name: "ImportLimitError", limit: "file_bytes" });
    expect(existsSync(join(dir, "big.bin"))).toBe(false);
    expect(big.stream.destroyed).toBe(true);
    // Exactly fileBytes is fine.
    expect(await s.add("ok.bin", lazyBytes(1000, 100).stream)).toBe("added");
  });

  it("stops reading a stream as soon as it passes the limit, whatever its length", async () => {
    const s = new ImportStaging(dir, { includeSecrets: false, redact: identity, limits: { files: 10, bytes: 100_000, fileBytes: 1000 } });
    const huge = lazyBytes(10_000_000, 100);
    await expect(s.add("huge.bin", huge.stream)).rejects.toBeInstanceOf(ImportLimitError);
    expect(huge.pulled()).toBeLessThan(100_000);
  });

  it("refuses the file that takes the total over bytes", async () => {
    const s = new ImportStaging(dir, { includeSecrets: false, redact: identity, limits: { files: 10, bytes: 150, fileBytes: 100 } });
    await s.add("a.bin", lazyBytes(100).stream);
    await expect(s.add("b.bin", lazyBytes(51).stream)).rejects.toMatchObject({ name: "ImportLimitError", limit: "bytes" });
    expect(existsSync(join(dir, "b.bin"))).toBe(false);
  });

  it("removes the partial file when the body fails mid-stream", async () => {
    const s = new ImportStaging(dir, { includeSecrets: false, redact: identity });
    let n = 0;
    const broken = new Readable({
      read() {
        if (n++ === 0) this.push(Buffer.from("half"));
        else this.destroy(new Error("client went away"));
      },
    });
    await expect(s.add("half.txt", broken)).rejects.toThrow("client went away");
    expect(existsSync(join(dir, "half.txt"))).toBe(false);
    expect(s.finish().files).toEqual([]);
  });

  it("refuses possible secrets in finish() unless included", async () => {
    const s = new ImportStaging(dir, { includeSecrets: false, redact: identity });
    await s.add("a.txt", body("A"));
    await s.add(".env", body("TOKEN=TESTKEY"));
    expect(existsSync(join(dir, ".env"))).toBe(false);
    expect(() => s.finish()).toThrow(PossibleSecretsError);
    try {
      s.finish();
    } catch (e) {
      expect((e as PossibleSecretsError).names).toEqual([".env"]);
    }

    const kept = new ImportStaging(join(root, "staging", "u2"), { includeSecrets: true, redact: identity });
    await kept.add(".env", body("TOKEN=TESTKEY"));
    expect(kept.finish().files).toEqual([".env"]);
    expect(readFileSync(join(root, "staging", "u2", ".env"), "utf8")).toBe("TOKEN=TESTKEY");
  });

  it("names at most 20 possible secrets, cleaned", async () => {
    const redact = (s: string) => s.replace(/ghp_TESTKEY\w*/g, "[redacted]");
    const s = new ImportStaging(dir, { includeSecrets: false, redact });
    await s.add("ghp_TESTKEY0123456789.txt", body("x"));
    await s.add("a‮b.pem", body("x"));
    for (let i = 0; i < 25; i++) await s.add(`k${i}.key`, body("x"));
    try {
      s.finish();
      expect.unreachable();
    } catch (e) {
      const names = (e as PossibleSecretsError).names;
      expect(names).toHaveLength(20);
      expect(names[0]).toBe("[redacted].txt");
      expect(names[1]).toBe("a\\u202eb.pem");
    }
  });

  it("dispose() removes the directory and never throws", async () => {
    const s = new ImportStaging(dir, { includeSecrets: false, redact: identity });
    await s.add("a/b/c.txt", body("x"));
    expect(readdirSync(dir)).toEqual(["a"]);
    s.dispose();
    expect(existsSync(dir)).toBe(false);
    expect(() => s.dispose()).not.toThrow();
  });
});
