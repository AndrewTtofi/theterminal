import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BUNDLE_CLAUDE, builderConfig } from "../electron-builder.mjs";

describe("builderConfig", () => {
  const c = builderConfig({});

  it("names the app and packages the shell into asar without rebuilding anything", () => {
    expect(c.productName).toBe("The Terminal");
    expect(c.appId).toBe("org.theterminal.desktop");
    expect(c.asar).toBe(true);
    expect(c.npmRebuild).toBe(false);
    expect(c.files).toEqual(["dist/**/*", "!dist/**/*.map", "package.json"]);
    expect(c.publish).toBeNull();
    expect(c.electronVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("puts staged core (with its node_modules), Node, the UI and the third-party notices under Resources", () => {
    expect(c.extraResources).toEqual([
      { from: "stage", to: ".", filter: ["core/**/*", "node/**/*", "ui/**/*", "licenses/**/*", "THIRD_PARTY_NOTICES.txt"] },
    ]);
  });

  it("ad-hoc signs macOS without the hardened runtime and builds a dmg", () => {
    expect(c.mac?.identity).toBe("-");
    expect(c.mac?.hardenedRuntime).toBe(false);
    expect(c.mac?.target).toEqual([{ target: "dmg" }]);
  });

  it("builds an unsigned per-user one-click NSIS installer for x64", () => {
    expect(c.win?.target).toEqual([{ target: "nsis", arch: ["x64"] }]);
    expect(c.nsis?.oneClick).toBe(true);
    expect(c.nsis?.perMachine).toBe(false);
  });

  it("names artifacts by version, OS and arch", () => {
    expect(c.artifactName).toBe("TheTerminal-${version}-${os}-${arch}.${ext}");
  });

  it("stamps a valid THETERMINAL_VERSION and rejects anything else", () => {
    expect(builderConfig({ THETERMINAL_VERSION: "1.2.3" }).extraMetadata?.version).toBe("1.2.3");
    expect(builderConfig({ THETERMINAL_VERSION: "1.2.3-rc.1" }).extraMetadata?.version).toBe("1.2.3-rc.1");
    expect(c.extraMetadata).toBeUndefined();
    expect(() => builderConfig({ THETERMINAL_VERSION: "1.2" })).toThrow("Invalid THETERMINAL_VERSION");
  });

  it("refuses to sign in 9A", () => {
    expect(() => builderConfig({ THETERMINAL_SIGN: "1" })).toThrow("Signing is configured in Plan 9B");
  });

  it.each(["CSC_LINK", "CSC_NAME", "WIN_CSC_LINK", "CSC_KEY_PASSWORD", "WIN_CSC_KEY_PASSWORD"])("refuses to build while %s is set", (name) => {
    expect(() => builderConfig({ [name]: "x" })).toThrow("Signing is configured in Plan 9B");
  });

  it("does not bundle Claude Code by default, and the switch has a module of its own", async () => {
    expect(BUNDLE_CLAUDE).toBe(false);
    expect((await import("../bundle-claude.mjs")).BUNDLE_CLAUDE).toBe(false);
  });

  it("checks the packed app's Resources after packing", async () => {
    const out = mkdtempSync(join(tmpdir(), "builder-config-"));
    try {
      const context = { appOutDir: out, electronPlatformName: "darwin", arch: 3, packager: { appInfo: { productFilename: "The Terminal" } } };
      await expect((c.afterPack as (ctx: unknown) => Promise<void>)(context)).rejects.toThrow(
        /^Packaged layout is incomplete: core\/package\.json, /,
      );
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});
