import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeReadyFile } from "../src/ready-file.js";

const dirs: string[] = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), "tt-ready-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const ready = { type: "ready" as const, url: "http://theterminal.localhost:4317/?token=secret", loopbackUrl: "http://127.0.0.1:4317/", port: 4317 };

describe("writeReadyFile", () => {
  it("writes the loopback URL and port, never the token, and leaves no temp file", () => {
    const d = tempDir();
    const file = join(d, "ready.json");
    writeReadyFile(file, ready, 123);
    const text = readFileSync(file, "utf8");
    expect(JSON.parse(text)).toEqual({ loopbackUrl: "http://127.0.0.1:4317/", port: 4317 });
    expect(text).not.toContain("secret");
    expect(readdirSync(d)).toEqual(["ready.json"]);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("replaces a stale temp file left by an earlier run with the same pid", () => {
    const d = tempDir();
    const file = join(d, "ready.json");
    writeFileSync(`${file}.123.tmp`, "stale");
    writeReadyFile(file, ready, 123);
    expect(JSON.parse(readFileSync(file, "utf8")).port).toBe(4317);
    expect(readdirSync(d)).toEqual(["ready.json"]);
  });
});
