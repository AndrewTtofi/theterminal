import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PREVIEW_LIMITS } from "@theterminal/shared";
import { PNG_1X1, pngOf } from "../fixtures/png.js";
import { InvalidScreenshotError, pngSize, screenshotFile, storeScreenshot } from "../../src/preview/screenshots.js";

const JPEG = Buffer.from("ffd8ffe000104a46494600010100000100010000ffd9", "hex");

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "tt-shots-"));
});
afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

describe("pngSize", () => {
  it("reads the IHDR size of a PNG and refuses anything else", () => {
    expect(pngSize(PNG_1X1)).toEqual({ width: 1, height: 1 });
    expect(pngSize(pngOf(393, 852))).toEqual({ width: 393, height: 852 });
    expect(pngSize(JPEG)).toBeNull();
    expect(pngSize(PNG_1X1.subarray(0, 20))).toBeNull();
    expect(pngSize(pngOf(0, 10))).toBeNull();
  });
});

describe("storeScreenshot", () => {
  it("names the file by its sha256 under the project's artifacts, once", () => {
    const sha = createHash("sha256").update(PNG_1X1).digest("hex");
    const a = storeScreenshot(dataDir, "p1", PNG_1X1);
    expect(a).toEqual({ sha256: sha, bytes: PNG_1X1.length, width: 1, height: 1, file: join(dataDir, "projects", "p1", "artifacts", `${sha}.png`) });
    expect(readFileSync(a.file)).toEqual(PNG_1X1);
    const b = storeScreenshot(dataDir, "p1", PNG_1X1);
    expect(b).toEqual(a);
    expect(readdirSync(join(dataDir, "projects", "p1", "artifacts"))).toEqual([`${sha}.png`]);
  });

  it("refuses a JPEG, an empty buffer and anything over the size limit, writing nothing", () => {
    expect(() => storeScreenshot(dataDir, "p1", JPEG)).toThrow(InvalidScreenshotError);
    expect(() => storeScreenshot(dataDir, "p1", Buffer.alloc(0))).toThrow(InvalidScreenshotError);
    const big = Buffer.concat([pngOf(10, 10), Buffer.alloc(PREVIEW_LIMITS.screenshotBytes)]);
    expect(() => storeScreenshot(dataDir, "p1", big)).toThrow(InvalidScreenshotError);
    expect(existsSync(join(dataDir, "projects", "p1", "artifacts"))).toBe(false);
  });

  it("refuses a project id that is not a plain name", () => {
    expect(() => storeScreenshot(dataDir, "../p1", PNG_1X1)).toThrow();
    expect(() => storeScreenshot(dataDir, join("a", "b"), PNG_1X1)).toThrow();
  });
});

describe("screenshotFile", () => {
  it("finds a stored file and nothing else", () => {
    const { sha256, file } = storeScreenshot(dataDir, "p1", PNG_1X1);
    expect(screenshotFile(dataDir, "p1", sha256)).toBe(file);
    expect(screenshotFile(dataDir, "p2", sha256)).toBeNull();
    expect(screenshotFile(dataDir, "p1", "0".repeat(64))).toBeNull();
    expect(screenshotFile(dataDir, "p1", "../x")).toBeNull();
    expect(screenshotFile(dataDir, "..", sha256)).toBeNull();
  });

  it("does not follow a directory or a link named like a screenshot", () => {
    const dir = join(dataDir, "projects", "p1", "artifacts");
    mkdirSync(join(dir, `${"a".repeat(64)}.png`), { recursive: true });
    expect(screenshotFile(dataDir, "p1", "a".repeat(64))).toBeNull();
    const outside = join(dataDir, "outside.png");
    writeFileSync(outside, PNG_1X1);
    try {
      symlinkSync(outside, join(dir, `${"b".repeat(64)}.png`));
    } catch {
      return; // no symlinks without privileges on Windows
    }
    expect(screenshotFile(dataDir, "p1", "b".repeat(64))).toBeNull();
  });
});
