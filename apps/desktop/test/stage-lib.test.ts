import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import manifest from "../node-runtime.json" with { type: "json" };
import { PRUNE, assertLayout, isExcludedPackage, nodeArchive, verifySha256 } from "../scripts/stage-lib.mjs";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "stage-lib-"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function write(files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(tmp, rel)), { recursive: true });
    writeFileSync(join(tmp, rel), content);
  }
}

describe("nodeArchive", () => {
  it("names the pinned archive, its checksum and the member to extract", () => {
    expect(nodeArchive(manifest, "darwin", "arm64")).toEqual({
      url: "https://nodejs.org/dist/v24.22.2/node-v24.22.2-darwin-arm64.tar.gz",
      file: "node-v24.22.2-darwin-arm64.tar.gz",
      sha256: "aa9549349e47dffaa42dcf95d6e06ade8c4bdafc980979883b88767670df385a",
      member: "node-v24.22.2-darwin-arm64/bin/node",
    });
    expect(nodeArchive(manifest, "win32", "x64").member).toBe("node-v24.22.2-win-x64/node.exe");
  });

  it("throws for a platform without a pinned runtime", () => {
    expect(() => nodeArchive(manifest, "linux", "x64")).toThrow("No pinned Node runtime for linux-x64");
  });
});

describe("verifySha256", () => {
  it("passes when the hash matches and throws naming the file otherwise", () => {
    const file = join(tmp, "archive.tar.gz");
    writeFileSync(file, "some bytes");
    const good = createHash("sha256").update("some bytes").digest("hex");
    expect(() => verifySha256(file, good)).not.toThrow();
    expect(() => verifySha256(file, "0".repeat(64))).toThrow("Checksum mismatch for archive.tar.gz");
  });
});

describe("PRUNE", () => {
  it("lists the development files and pnpm metadata removed from staged core", () => {
    expect(PRUNE).toEqual([
      "src",
      "test",
      "tsconfig.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "node_modules/.pnpm",
      "node_modules/.bin",
      "node_modules/.modules.yaml",
      "node_modules/.pnpm-workspace-state-v1.json",
    ]);
  });
});

describe("isExcludedPackage", () => {
  it("excludes the Agent SDK's native Claude Code packages unless Claude is bundled", () => {
    for (const name of ["@anthropic-ai/claude-agent-sdk-darwin-arm64", "@anthropic-ai/claude-agent-sdk-win32-x64", "@anthropic-ai/claude-agent-sdk-linux-x64-musl"]) {
      expect(isExcludedPackage(name, false)).toBe(true);
      expect(isExcludedPackage(name, true)).toBe(false);
    }
  });

  it("keeps the Agent SDK's JS, the Anthropic SDK, Codex and Gemini CLI", () => {
    for (const name of ["@anthropic-ai/claude-agent-sdk", "@anthropic-ai/sdk", "@openai/codex-darwin-arm64", "@google/gemini-cli"]) {
      expect(isExcludedPackage(name, false)).toBe(false);
    }
  });
});

describe("assertLayout", () => {
  const NM = "core/node_modules";
  const tree = (p: string, a: string, exe: string): Record<string, string> => ({
    "core/package.json": JSON.stringify({ name: "@theterminal/core" }),
    "core/dist/cli.js": "",
    "core/dist/host.js": "",
    [`${NM}/better-sqlite3/prebuilds/${p}-${a}.node`]: "",
    [`${NM}/@napi-rs/keyring-${p}-${a}${p === "win32" ? "-msvc" : ""}/package.json`]: "{}",
    [`${NM}/@openai/codex-${p}-${a}/package.json`]: "{}",
    [`${NM}/@anthropic-ai/claude-agent-sdk/package.json`]: "{}",
    [`${NM}/@google/gemini-cli/package.json`]: "{}",
    [`node/${exe}`]: "",
    "ui/index.html": "",
  });

  it("is empty for a complete tree", () => {
    write(tree("darwin", "arm64", "node"));
    expect(assertLayout(tmp, "darwin", "arm64")).toEqual([]);
  });

  it("is empty for a complete Windows tree with node.exe", () => {
    write(tree("win32", "x64", "node.exe"));
    expect(assertLayout(tmp, "win32", "x64")).toEqual([]);
  });

  it("names a missing platform package", () => {
    const files = tree("darwin", "arm64", "node");
    delete files[`${NM}/@openai/codex-darwin-arm64/package.json`];
    write(files);
    expect(assertLayout(tmp, "darwin", "arm64")).toEqual(["core/node_modules/@openai/codex-darwin-arm64"]);
  });

  it("names a pruned entry that is still there", () => {
    write({ ...tree("darwin", "arm64", "node"), [`${NM}/.pnpm/lock.yaml`]: "" });
    expect(assertLayout(tmp, "darwin", "arm64")).toEqual(["forbidden: core/node_modules/.pnpm"]);
  });

  it("rejects core with another package name", () => {
    write({ ...tree("darwin", "arm64", "node"), "core/package.json": JSON.stringify({ name: "other" }) });
    expect(assertLayout(tmp, "darwin", "arm64")).toEqual(["core/package.json"]);
  });

  it("rejects the native Claude Code package, at any depth, while Claude is not bundled", () => {
    write({
      ...tree("darwin", "arm64", "node"),
      [`${NM}/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`]: "",
      [`${NM}/@anthropic-ai/claude-agent-sdk/node_modules/@anthropic-ai/claude-agent-sdk-darwin-x64/claude`]: "",
    });
    expect(assertLayout(tmp, "darwin", "arm64")).toEqual([
      "forbidden: core/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64",
      "forbidden: core/node_modules/@anthropic-ai/claude-agent-sdk/node_modules/@anthropic-ai/claude-agent-sdk-darwin-x64",
    ]);
  });

  it("requires the native Claude Code package when Claude is bundled", () => {
    write(tree("darwin", "arm64", "node"));
    expect(assertLayout(tmp, "darwin", "arm64", { bundleClaude: true })).toEqual(["core/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64"]);
    write({ [`${NM}/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`]: "" });
    expect(assertLayout(tmp, "darwin", "arm64", { bundleClaude: true })).toEqual([]);
  });

  it("names everything missing from an empty tree", () => {
    expect(assertLayout(tmp, "darwin", "arm64")).toEqual([
      "core/package.json",
      "core/dist/cli.js",
      "core/dist/host.js",
      "core/node_modules/better-sqlite3/prebuilds/darwin-arm64.node",
      "core/node_modules/@napi-rs/keyring-darwin-arm64*",
      "core/node_modules/@openai/codex-darwin-arm64",
      "core/node_modules/@anthropic-ai/claude-agent-sdk",
      "core/node_modules/@google/gemini-cli/package.json",
      "node/node",
      "ui/index.html",
    ]);
  });
});
