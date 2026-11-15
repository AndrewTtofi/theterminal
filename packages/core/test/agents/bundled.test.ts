import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bundledClaude, bundledCodex, bundledGemini } from "../../src/agents/bundled.js";

const inside = (dir: string, p: string) => {
  const rel = relative(realpathSync(dir), realpathSync(p));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
};
/** The package directory (the segment after the last node_modules, scoped) that holds `p`. */
const packageOf = (p: string) => {
  const parts = realpathSync(p).split(sep);
  const i = parts.lastIndexOf("node_modules");
  return { name: `${parts[i + 1]}/${parts[i + 2]}`, dir: parts.slice(0, i + 3).join(sep) };
};

describe("bundled agent programs (the installed packages)", () => {
  it("Codex resolves to its platform-native binary inside node_modules", () => {
    const cli = bundledCodex();
    expect(cli).not.toBeNull();
    expect(cli!.args).toEqual([]);
    expect(cli!.file).toMatch(process.platform === "win32" ? /codex\.exe$/ : /codex$/);
    const pkg = packageOf(cli!.file);
    expect(pkg.name).toBe("@openai/codex");
    expect(inside(pkg.dir, cli!.file)).toBe(true);
  });

  it("Gemini resolves to node with the package's bin entry, inside node_modules", () => {
    const cli = bundledGemini();
    expect(cli).not.toBeNull();
    expect(cli!.file).toBe(process.execPath);
    expect(cli!.args).toHaveLength(1);
    const entry = cli!.args[0]!;
    expect(entry).toMatch(/bundle[\\/]gemini\.js$/);
    const pkg = packageOf(entry);
    expect(pkg.name).toBe("@google/gemini-cli");
    expect(inside(pkg.dir, entry)).toBe(true);
  });

  it("Claude resolves to the Claude Code binary in the Agent SDK's platform package", () => {
    const file = bundledClaude();
    expect(file).not.toBeNull();
    const pkg = packageOf(file!);
    expect(pkg.name).toMatch(/^@anthropic-ai\/claude-agent-sdk-/);
    expect(inside(pkg.dir, file!)).toBe(true);
    expect(file).toMatch(process.platform === "win32" ? /claude\.exe$/ : /claude$/);
  });

  it("each default lookup is computed once and then reused", () => {
    expect(bundledCodex()).toBe(bundledCodex());
    expect(bundledGemini()).toBe(bundledGemini());
  });
});

describe("bundled resolution stays inside core's own install", () => {
  let root: string;
  let core: string;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "tt-bundled-")));
    core = join(root, "app", "core");
    mkdirSync(core, { recursive: true });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  const write = (files: Record<string, string>) => {
    for (const [p, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, p)), { recursive: true });
      writeFileSync(join(root, p), content);
    }
  };
  /** A directory link (a junction on Windows, which needs no extra rights). */
  const link = (target: string, at: string) => {
    mkdirSync(dirname(join(root, at)), { recursive: true });
    symlinkSync(join(root, target), join(root, at), "junction");
  };
  const geminiPkg = (bin: unknown) => JSON.stringify({ name: "@google/gemini-cli", bin });
  const GEMINI = "app/core/node_modules/@google/gemini-cli";

  it("Gemini: an entry inside the package linked in core's node_modules is used", () => {
    write({ [`${GEMINI}/package.json`]: geminiPkg({ gemini: "bundle/gemini.js" }), [`${GEMINI}/bundle/gemini.js`]: "" });
    expect(bundledGemini({ coreDir: core })).toEqual({ file: process.execPath, args: [join(root, GEMINI, "bundle/gemini.js")] });
  });

  it("Gemini: a pnpm-style link into a store under a reachable node_modules is followed", () => {
    const store = "node_modules/.pnpm/gemini/node_modules/@google/gemini-cli";
    write({ [`${store}/package.json`]: geminiPkg({ gemini: "bundle/gemini.js" }), [`${store}/bundle/gemini.js`]: "" });
    link(store, GEMINI);
    expect(bundledGemini({ coreDir: core })).toEqual({ file: process.execPath, args: [join(root, store, "bundle/gemini.js")] });
  });

  it("Gemini: an entry escaping the package by .., by absolute path, or missing, is null", () => {
    write({ [`${GEMINI}/package.json`]: geminiPkg({ gemini: "../evil.js" }), "app/core/node_modules/@google/evil.js": "", "outside/evil.js": "" });
    expect(bundledGemini({ coreDir: core })).toBeNull();
    write({ [`${GEMINI}/package.json`]: geminiPkg({ gemini: join(root, "outside/evil.js") }) });
    expect(bundledGemini({ coreDir: core })).toBeNull();
    write({ [`${GEMINI}/package.json`]: geminiPkg({ gemini: "bundle/gemini.js" }) });
    expect(bundledGemini({ coreDir: core })).toBeNull();
  });

  it("ignores a stray copy in an ancestor node_modules and one on NODE_PATH", () => {
    const pkg = (dir: string) => ({ [`${dir}/package.json`]: geminiPkg({ gemini: "bundle/gemini.js" }), [`${dir}/bundle/gemini.js`]: "" });
    write({ ...pkg("node_modules/@google/gemini-cli"), ...pkg("app/node_modules/@google/gemini-cli"), ...pkg("global/@google/gemini-cli") });
    vi.stubEnv("NODE_PATH", join(root, "global"));
    expect(bundledGemini({ coreDir: core })).toBeNull();
  });

  it("ignores a package linked from core's node_modules that really lives outside every reachable node_modules", () => {
    write({ "elsewhere/gemini-cli/package.json": geminiPkg({ gemini: "bundle/gemini.js" }), "elsewhere/gemini-cli/bundle/gemini.js": "" });
    link("elsewhere/gemini-cli", GEMINI);
    expect(bundledGemini({ coreDir: core })).toBeNull();
  });

  it.skipIf(process.platform === "win32")("Gemini: an entry that is a file symlink pointing outside the package is null", () => {
    write({ [`${GEMINI}/package.json`]: geminiPkg({ gemini: "bundle/gemini.js" }), "outside/evil.js": "" });
    mkdirSync(join(root, GEMINI, "bundle"));
    symlinkSync(join(root, "outside/evil.js"), join(root, GEMINI, "bundle/gemini.js"));
    expect(bundledGemini({ coreDir: core })).toBeNull();
  });

  const CODEX = "app/core/node_modules/@openai/codex";
  const codexPkg = JSON.stringify({ name: "@openai/codex", bin: { codex: "bin/codex.js" } });

  it("Codex: the native binary from the platform package linked next to @openai/codex", () => {
    const native = "app/core/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex";
    write({ [`${CODEX}/package.json`]: codexPkg, [`${CODEX}/bin/codex.js`]: "", "app/core/node_modules/@openai/codex-darwin-arm64/package.json": "{}", [native]: "" });
    expect(bundledCodex({ coreDir: core, platform: "darwin", arch: "arm64" })).toEqual({ file: join(root, native), args: [] });
  });

  it.each([
    ["win32", "x64"],
    ["linux", "x64"],
  ] as const)("Codex on %s-%s without its native package is null, never the JS launcher that needs it", (platform, arch) => {
    write({ [`${CODEX}/package.json`]: codexPkg, [`${CODEX}/bin/codex.js`]: "" });
    expect(bundledCodex({ coreDir: core, platform, arch })).toBeNull();
  });

  it("Codex: a native package without its binary, or an unsupported platform, is null", () => {
    write({ [`${CODEX}/package.json`]: codexPkg, [`${CODEX}/bin/codex.js`]: "", "app/core/node_modules/@openai/codex-win32-x64/package.json": "{}" });
    expect(bundledCodex({ coreDir: core, platform: "win32", arch: "x64" })).toBeNull();
    expect(bundledCodex({ coreDir: core, platform: "aix", arch: "ppc64" })).toBeNull();
  });

  it.skipIf(process.platform === "win32")("Codex: a native binary that is a symlink escaping its package is null", () => {
    const native = "app/core/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex";
    write({ [`${CODEX}/package.json`]: codexPkg, "app/core/node_modules/@openai/codex-darwin-arm64/package.json": "{}", "outside/codex": "" });
    mkdirSync(dirname(join(root, native)), { recursive: true });
    symlinkSync(join(root, "outside/codex"), join(root, native));
    expect(bundledCodex({ coreDir: core, platform: "darwin", arch: "arm64" })).toBeNull();
  });

  const SDK = "app/core/node_modules/@anthropic-ai/claude-agent-sdk";
  const SDK_WIN = "app/core/node_modules/@anthropic-ai/claude-agent-sdk-win32-x64";

  it("Claude: the binary inside the SDK's platform package is used; a missing one is null", () => {
    write({ [`${SDK}/package.json`]: "{}", [`${SDK_WIN}/package.json`]: "{}" });
    expect(bundledClaude({ coreDir: core, platform: "win32", arch: "x64" })).toBeNull();
    expect(bundledClaude({ coreDir: core, platform: "darwin", arch: "arm64" })).toBeNull();
    write({ [`${SDK_WIN}/claude.exe`]: "" });
    expect(bundledClaude({ coreDir: core, platform: "win32", arch: "x64" })).toBe(join(root, SDK_WIN, "claude.exe"));
  });

  it.each([
    ["darwin", "arm64", "claude"],
    ["win32", "x64", "claude.exe"],
  ] as const)("Claude on %s-%s in a staged desktop tree without the SDK's platform package is null, so PATH is used", (platform, arch, exe) => {
    // The desktop app's staged core keeps the SDK's JS but not its native Claude Code (not redistributed in 9A).
    write({ [`${SDK}/package.json`]: "{}", [`${SDK}/sdk.mjs`]: "", [`${SDK}/${exe}`]: "", "app/core/node_modules/@anthropic-ai/sdk/package.json": "{}" });
    expect(bundledClaude({ coreDir: core, platform, arch })).toBeNull();
  });

  it.skipIf(process.platform === "win32")("Claude: a binary that is a symlink escaping the SDK's platform package is null", () => {
    write({ [`${SDK}/package.json`]: "{}", [`${SDK_WIN}/package.json`]: "{}", "outside/claude.exe": "" });
    symlinkSync(join(root, "outside/claude.exe"), join(root, SDK_WIN, "claude.exe"));
    expect(bundledClaude({ coreDir: core, platform: "win32", arch: "x64" })).toBeNull();
  });
});
