// The pure parts of staging: which Node archive to fetch, how to check it, what to remove from deployed core, and
// what a complete staged tree (or a packed app's Resources) must and must not contain.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

/**
 * The pinned Node archive for a platform, from `node-runtime.json`.
 * @param {{ version: string; targets: Record<string, { file: string; sha256: string; member: string }> }} manifest
 * @param {string} platform
 * @param {string} arch
 * @returns {{ url: string; file: string; sha256: string; member: string }}
 */
export function nodeArchive(manifest, platform, arch) {
  const target = Object.hasOwn(manifest.targets, `${platform}-${arch}`) ? manifest.targets[`${platform}-${arch}`] : undefined;
  if (target === undefined) throw new Error(`No pinned Node runtime for ${platform}-${arch}`);
  return { url: `https://nodejs.org/dist/v${manifest.version}/${target.file}`, file: target.file, sha256: target.sha256, member: target.member };
}

/**
 * Throws unless the file's SHA-256 is `expected`.
 * @param {string} file
 * @param {string} expected
 */
export function verifySha256(file, expected) {
  const actual = createHash("sha256").update(readFileSync(file)).digest("hex");
  if (actual !== expected.toLowerCase()) throw new Error(`Checksum mismatch for ${basename(file)}`);
}

/** Removed from `pnpm deploy`'s output: core's sources and tests, and pnpm's own metadata (the tree is hoisted). */
export const PRUNE = Object.freeze([
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

/** The Agent SDK's platform packages, each carrying a native Claude Code binary. */
const CLAUDE_NATIVE = /^@anthropic-ai\/claude-agent-sdk-/;

/**
 * Whether staging leaves out the package `name` (`@scope/name`). Claude Code's native binary is not redistributed
 * unless `bundleClaude` is set; the Agent SDK's JS stays, so Claude can still run the Owner's own Claude Code.
 * @param {string} name
 * @param {boolean} bundleClaude
 */
export function isExcludedPackage(name, bundleClaude) {
  return !bundleClaude && CLAUDE_NATIVE.test(name);
}

/**
 * Every `@scope/name` package directory under `nodeModules`, at any depth, as sorted paths relative to it ("/"-separated).
 * @param {string} nodeModules
 * @returns {string[]}
 */
function scopedPackages(nodeModules) {
  const out = [];
  const walk = (/** @type {string} */ dir, /** @type {string} */ rel) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const sub = join(dir, e.name);
      if (e.name.startsWith("@")) {
        for (const p of readdirSync(sub, { withFileTypes: true })) {
          if (!p.isDirectory()) continue;
          out.push(`${rel}${e.name}/${p.name}`);
          walk(join(sub, p.name, "node_modules"), `${rel}${e.name}/${p.name}/node_modules/`);
        }
      } else {
        walk(join(sub, "node_modules"), `${rel}${e.name}/node_modules/`);
      }
    }
  };
  walk(nodeModules, "");
  return out.sort();
}

/**
 * What a staged tree (`<stage>` with `core`, `node` and `ui`, or a packed app's Resources) is missing or must not
 * contain, as "/"-separated paths relative to it. Empty when the tree is good.
 * @param {string} stageDir
 * @param {NodeJS.Platform} platform
 * @param {string} arch
 * @param {{ bundleClaude?: boolean }} [opts]
 * @returns {string[]}
 */
export function assertLayout(stageDir, platform, arch, opts = {}) {
  const bundleClaude = opts.bundleClaude ?? false;
  const pa = `${platform}-${arch}`;
  const nm = join(stageDir, "core", "node_modules");
  const problems = [];
  const need = (/** @type {string} */ rel, ok = existsSync(join(stageDir, ...rel.split("/")))) => {
    if (!ok) problems.push(rel);
  };

  let coreName;
  try {
    coreName = JSON.parse(readFileSync(join(stageDir, "core", "package.json"), "utf8")).name;
  } catch {
    coreName = undefined;
  }
  need("core/package.json", coreName === "@theterminal/core");
  need("core/dist/cli.js");
  need("core/dist/host.js");
  need(`core/node_modules/better-sqlite3/prebuilds/${pa}.node`);
  let keyring = false;
  try {
    keyring = readdirSync(join(nm, "@napi-rs"), { withFileTypes: true }).some((e) => e.isDirectory() && e.name.startsWith(`keyring-${pa}`));
  } catch {
    keyring = false;
  }
  need(`core/node_modules/@napi-rs/keyring-${pa}*`, keyring);
  need(`core/node_modules/@openai/codex-${pa}`);
  need("core/node_modules/@anthropic-ai/claude-agent-sdk");
  if (bundleClaude) need(`core/node_modules/@anthropic-ai/claude-agent-sdk-${pa}`);
  need("core/node_modules/@google/gemini-cli/package.json");
  need(`node/${platform === "win32" ? "node.exe" : "node"}`);
  need("ui/index.html");

  for (const entry of PRUNE) {
    if (existsSync(join(stageDir, "core", ...entry.split("/")))) problems.push(`forbidden: core/${entry}`);
  }
  for (const pkg of scopedPackages(nm)) {
    const name = pkg.split("/").slice(-2).join("/");
    if (isExcludedPackage(name, bundleClaude)) problems.push(`forbidden: core/node_modules/${pkg}`);
  }
  return problems;
}
