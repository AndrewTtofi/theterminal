import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, isAbsolute } from "node:path";
import { PREVIEW_LIMITS } from "@theterminal/shared";

/**
 * Screenshots of previews (plan 12 Ruling 22): PNG files under `<data>/projects/<id>/artifacts/`, each named by the
 * sha256 of its bytes, so the same image is stored once. Only the hash, size and device go in the ledger.
 */

export class InvalidScreenshotError extends Error {
  constructor() {
    super("not a PNG within the size limit");
    this.name = "InvalidScreenshotError";
  }
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** The largest side the ledger accepts. */
const MAX_SIDE = 20_000;
const PROJECT_ID = /^[A-Za-z0-9_-]{1,100}$/;
const SHA256 = /^[0-9a-f]{64}$/;

/** The size a PNG's first chunk (IHDR) states, or null when the bytes are not a PNG. */
export function pngSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24 || !buf.subarray(0, 8).equals(SIGNATURE)) return null;
  if (buf.readUInt32BE(8) !== 13 || buf.toString("latin1", 12, 16) !== "IHDR") return null;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

const artifactsDir = (dataDir: string, projectId: string): string => join(dataDir, "projects", projectId, "artifacts");

/**
 * Stores a PNG as `<sha256>.png` in the project's artifacts folder, once (an existing file of that name is kept).
 * InvalidScreenshotError for anything that is not a PNG, is empty, is over the size limit or states a side over 20,000.
 */
export function storeScreenshot(
  dataDir: string,
  projectId: string,
  png: Buffer,
): { sha256: string; bytes: number; width: number; height: number; file: string } {
  if (!PROJECT_ID.test(projectId)) throw new TypeError("not a project id");
  const size = pngSize(png);
  if (size === null || png.length > PREVIEW_LIMITS.screenshotBytes || size.width > MAX_SIDE || size.height > MAX_SIDE) {
    throw new InvalidScreenshotError();
  }
  const sha256 = createHash("sha256").update(png).digest("hex");
  const dir = artifactsDir(dataDir, projectId);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${sha256}.png`);
  if (screenshotFile(dataDir, projectId, sha256) === null) {
    // Written aside and renamed, so a reader never sees half a file.
    const tmp = join(dir, `.${randomUUID()}.tmp`);
    try {
      writeFileSync(tmp, png, { flag: "wx" });
      renameSync(tmp, file);
    } finally {
      rmSync(tmp, { force: true });
    }
  }
  return { sha256, bytes: png.length, ...size, file };
}

/** The stored file of a screenshot: a regular file (not a link) inside the project's artifacts folder, or null. */
export function screenshotFile(dataDir: string, projectId: string, sha256: string): string | null {
  if (!PROJECT_ID.test(projectId) || !SHA256.test(sha256)) return null;
  const dir = artifactsDir(dataDir, projectId);
  const file = join(dir, `${sha256}.png`);
  try {
    if (!lstatSync(file).isFile()) return null;
    const rel = relative(realpathSync.native(dir), realpathSync.native(file));
    if (rel !== `${sha256}.png` || isAbsolute(rel)) return null;
  } catch {
    return null;
  }
  return file;
}
