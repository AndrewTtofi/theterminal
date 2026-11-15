import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const UI = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("favicon", () => {
  it("index.html links the SVG favicon that public/ ships", () => {
    expect(readFileSync(join(UI, "index.html"), "utf8")).toContain('<link rel="icon" type="image/svg+xml" href="/favicon.svg" />');
    expect(existsSync(join(UI, "public", "favicon.svg"))).toBe(true);
  });
});
