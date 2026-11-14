import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bundledClaude, bundledCodex, bundledGemini, type Resolver } from "../../src/agents/bundled.js";

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
  it("Codex resolves to its platform-native binary, or else node with its JS entry, inside node_modules", () => {
    const cli = bundledCodex();
    expect(cli).not.toBeNull();
    const target = cli!.args.length === 0 ? cli!.file : cli!.args[0]!;
    if (cli!.args.length > 0) expect(cli!.file).toBe(process.execPath);
    expect(realpathSync(target).split(sep)).toContain("node_modules");
    const pkg = packageOf(target);
    expect(pkg.name).toBe("@openai/codex");
    expect(inside(pkg.dir, target)).toBe(true);
  });

  it("prefers the platform-native Codex binary when its package is installed", () => {
    const supported = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "win32-x64", "win32-arm64"];
    if (!supported.includes(`${process.platform}-${process.arch}`)) return;
    const cli = bundledCodex()!;
    expect(cli.args).toEqual([]);
    expect(cli.file).toMatch(process.platform === "win32" ? /codex\.exe$/ : /codex$/);
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
});

describe("bundled resolution never leaves a package directory", () => {
  let root: string;
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  /** A fake node_modules tree and a resolver that only knows the given ids. */
  function tree(files: Record<string, string>, ids: Record<string, string>): Resolver {
    root = realpathSync(mkdtempSync(join(tmpdir(), "tt-bundled-")));
    for (const [p, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, p)), { recursive: true });
      writeFileSync(join(root, p), content);
    }
    return (id) => {
      const p = ids[id];
      if (p === undefined) throw Object.assign(new Error(`Cannot find module '${id}'`), { code: "MODULE_NOT_FOUND" });
      return join(root, p);
    };
  }
  const geminiPkg = (bin: unknown) => JSON.stringify({ name: "@google/gemini-cli", bin });
  const GEMINI_IDS = { "@google/gemini-cli/package.json": "nm/@google/gemini-cli/package.json" };

  it("Gemini: an entry inside the package is used; one outside, a missing one or a missing package is null", () => {
    const ok = tree({ "nm/@google/gemini-cli/package.json": geminiPkg({ gemini: "bundle/gemini.js" }), "nm/@google/gemini-cli/bundle/gemini.js": "" }, GEMINI_IDS);
    expect(bundledGemini({ resolve: ok })).toEqual({ file: process.execPath, args: [join(root, "nm/@google/gemini-cli/bundle/gemini.js")] });
    rmSync(root, { recursive: true, force: true });

    const climbs = tree({ "nm/@google/gemini-cli/package.json": geminiPkg({ gemini: "../evil.js" }), "nm/@google/evil.js": "" }, GEMINI_IDS);
    expect(bundledGemini({ resolve: climbs })).toBeNull();
    rmSync(root, { recursive: true, force: true });

    const absolute = tree({ "nm/@google/gemini-cli/package.json": "{}", "outside/evil.js": "" }, GEMINI_IDS);
    writeFileSync(join(root, "nm/@google/gemini-cli/package.json"), geminiPkg({ gemini: join(root, "outside/evil.js") }));
    expect(bundledGemini({ resolve: absolute })).toBeNull();
    rmSync(root, { recursive: true, force: true });

    const missing = tree({ "nm/@google/gemini-cli/package.json": geminiPkg({ gemini: "bundle/gemini.js" }) }, GEMINI_IDS);
    expect(bundledGemini({ resolve: missing })).toBeNull();
    rmSync(root, { recursive: true, force: true });

    expect(bundledGemini({ resolve: tree({}, {}) })).toBeNull();
  });

  const unixOnly = it.skipIf(process.platform === "win32"); // file symlinks need extra rights on Windows

  unixOnly("Gemini: an entry that is a symlink pointing outside the package is null", () => {
    const resolve = tree({ "nm/@google/gemini-cli/package.json": geminiPkg({ gemini: "bundle/gemini.js" }), "outside/evil.js": "" }, GEMINI_IDS);
    mkdirSync(join(root, "nm/@google/gemini-cli/bundle"));
    symlinkSync(join(root, "outside/evil.js"), join(root, "nm/@google/gemini-cli/bundle/gemini.js"));
    expect(bundledGemini({ resolve })).toBeNull();
  });

  const CODEX_IDS = {
    "@openai/codex/package.json": "nm/@openai/codex/package.json",
    "@openai/codex-darwin-arm64/package.json": "nm/@openai/codex-darwin-arm64/package.json",
  };
  const codexPkg = JSON.stringify({ name: "@openai/codex", bin: { codex: "bin/codex.js" } });
  const NATIVE = "nm/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex";

  it("Codex: the native binary inside its platform package wins over the JS entry", () => {
    const resolve = tree({ "nm/@openai/codex/package.json": codexPkg, "nm/@openai/codex/bin/codex.js": "", "nm/@openai/codex-darwin-arm64/package.json": "{}", [NATIVE]: "" }, CODEX_IDS);
    expect(bundledCodex({ resolve, platform: "darwin", arch: "arm64" })).toEqual({ file: join(root, NATIVE), args: [] });
  });

  unixOnly("Codex: a native binary that escapes its package is not used; the contained JS entry is", () => {
    const resolve = tree({ "nm/@openai/codex/package.json": codexPkg, "nm/@openai/codex/bin/codex.js": "", "nm/@openai/codex-darwin-arm64/package.json": "{}", "outside/codex": "" }, CODEX_IDS);
    mkdirSync(dirname(join(root, NATIVE)), { recursive: true });
    symlinkSync(join(root, "outside/codex"), join(root, NATIVE));
    expect(bundledCodex({ resolve, platform: "darwin", arch: "arm64" })).toEqual({ file: process.execPath, args: [join(root, "nm/@openai/codex/bin/codex.js")] });
  });

  it("Codex: no platform package and a JS entry outside the package is null", () => {
    const resolve = tree({ "nm/@openai/codex/package.json": JSON.stringify({ bin: { codex: "../../evil.js" } }), "nm/evil.js": "" }, CODEX_IDS);
    expect(bundledCodex({ resolve, platform: "darwin", arch: "arm64" })).toBeNull();
    expect(bundledCodex({ resolve, platform: "aix", arch: "ppc64" })).toBeNull();
  });

  const CLAUDE_IDS = {
    "@anthropic-ai/claude-agent-sdk": "nm/@anthropic-ai/claude-agent-sdk/sdk.mjs",
    "@anthropic-ai/claude-agent-sdk-win32-x64/package.json": "nm/@anthropic-ai/claude-agent-sdk-win32-x64/package.json",
  };

  const CLAUDE_FILES = { "nm/@anthropic-ai/claude-agent-sdk/sdk.mjs": "", "nm/@anthropic-ai/claude-agent-sdk-win32-x64/package.json": "{}" };

  unixOnly("Claude: a binary that is a symlink escaping the SDK's platform package is null", () => {
    const resolve = tree({ ...CLAUDE_FILES, "outside/claude.exe": "" }, CLAUDE_IDS);
    symlinkSync(join(root, "outside/claude.exe"), join(root, "nm/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe"));
    expect(bundledClaude({ resolve, platform: "win32", arch: "x64" })).toBeNull();
  });

  it("Claude: the binary inside the SDK's platform package is used; a missing one is null", () => {
    const files = CLAUDE_FILES;
    const ok = tree({ ...files, "nm/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe": "" }, CLAUDE_IDS);
    expect(bundledClaude({ resolve: ok, platform: "win32", arch: "x64" })).toBe(join(root, "nm/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe"));
    rmSync(root, { recursive: true, force: true });

    const missing = tree(files, CLAUDE_IDS);
    expect(bundledClaude({ resolve: missing, platform: "win32", arch: "x64" })).toBeNull();
    expect(bundledClaude({ resolve: missing, platform: "darwin", arch: "arm64" })).toBeNull();
  });
});
