import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { builderConfig } from "../electron-builder.mjs";

const DESKTOP = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = join(DESKTOP, "..", "..");
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];

const read = (...p: string[]) => readFileSync(join(...p));
const isPng = (b: Buffer, at = 0) => PNG_MAGIC.every((v, i) => b[at + i] === v);
/** Width and height from a PNG's IHDR chunk. */
const pngSize = (b: Buffer, at = 0) => ({ w: b.readUInt32BE(at + 16), h: b.readUInt32BE(at + 20) });

describe("app icons", () => {
  it("icon.png is a 1024x1024 PNG", () => {
    const b = read(DESKTOP, "build", "icon.png");
    expect(isPng(b)).toBe(true);
    expect(b.toString("latin1", 12, 16)).toBe("IHDR");
    expect(pngSize(b)).toEqual({ w: 1024, h: 1024 });
  });

  it("icon.ico is an ICO of at least 4 PNG entries, including 16, 32, 48 and 256", () => {
    const b = read(DESKTOP, "build", "icon.ico");
    expect([...b.subarray(0, 4)]).toEqual([0, 0, 1, 0]);
    const count = b.readUInt16LE(4);
    expect(count).toBeGreaterThanOrEqual(4);
    const sizes: number[] = [];
    for (let i = 0; i < count; i++) {
      const e = 6 + i * 16;
      const size = b.readUInt32LE(e + 8);
      const offset = b.readUInt32LE(e + 12);
      expect(offset + size).toBeLessThanOrEqual(b.length);
      expect(isPng(b, offset)).toBe(true);
      const { w, h } = pngSize(b, offset);
      expect(w).toBe(h);
      // A 256 entry stores 0 in its one-byte width.
      expect(b[e] === 0 ? 256 : b[e]).toBe(w);
      sizes.push(w);
    }
    expect(sizes).toEqual(expect.arrayContaining([16, 32, 48, 256]));
  });

  it("icon.icns is an icns container whose length is the file size, with ic07 to ic10 PNG entries", () => {
    const b = read(DESKTOP, "build", "icon.icns");
    expect(b.toString("latin1", 0, 4)).toBe("icns");
    expect(b.readUInt32BE(4)).toBe(b.length);
    const types = new Map<string, number>();
    for (let at = 8; at < b.length; ) {
      const len = b.readUInt32BE(at + 4);
      expect(len).toBeGreaterThan(8);
      expect(isPng(b, at + 8)).toBe(true);
      types.set(b.toString("latin1", at, at + 4), pngSize(b, at + 8).w);
      at += len;
    }
    expect(Object.fromEntries(types)).toMatchObject({ ic07: 128, ic08: 256, ic09: 512, ic10: 1024 });
  });

  it("electron-builder uses the icons for macOS and Windows", () => {
    const c = builderConfig({});
    expect(c.mac?.icon).toBe("build/icon.icns");
    expect(c.win?.icon).toBe("build/icon.ico");
  });

  it("the mark and the favicon are SVG in the brand colours, with no script or external reference", () => {
    for (const file of [join(REPO, "assets", "brand", "mark.svg"), join(REPO, "apps", "ui", "public", "favicon.svg"), join(REPO, "assets", "brand", "wordmark.svg")]) {
      const svg = readFileSync(file, "utf8");
      expect(svg, file).toMatch(/^<svg [^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
      expect(svg, file).toContain("#4fc3d9");
      expect(svg, file).not.toMatch(/<script|href=|url\(|@import|@font-face/i);
    }
    expect(readFileSync(join(REPO, "assets", "brand", "mark.svg"), "utf8")).toContain("#0d1016");
  });
});
