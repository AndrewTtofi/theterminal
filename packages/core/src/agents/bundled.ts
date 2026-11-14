import { readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The agent programs shipped inside The Terminal as dependencies of this package: Codex and Gemini CLI, and the
 * Claude Code binary that comes with the Agent SDK. Their versions are pinned to the ones the adapters' protocol
 * handling was verified against.
 *
 * Every lookup goes through Node's module resolution (never a shell or PATH), and a resolved file is used only if
 * its real path, symlinks followed, stays inside the real directory of the package it came from.
 */

/** A program to spawn: a native binary with no arguments, or this Node with a JS entry point. */
export type BundledCli = { file: string; args: string[] };

/** Resolves module `id` as code in the file `from` would. Injectable for tests. */
export type Resolver = (id: string, from: string) => string;

export type BundledOptions = {
  resolve?: Resolver;
  platform?: NodeJS.Platform;
  arch?: string;
};

const HERE = fileURLToPath(import.meta.url);
const nodeResolve: Resolver = (id, from) => createRequire(from).resolve(id);

/** The real path of `file` when it is a regular file inside `dir` (both with symlinks followed), else null. */
function contained(dir: string, file: string): string | null {
  try {
    const realDir = realpathSync(dir);
    const real = realpathSync(file);
    const rel = relative(realDir, real);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
    return statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}

/** The path a module id resolves to from `from`, or null when it is not installed. */
function tryResolve(r: Resolver, id: string, from: string): string | null {
  try {
    return r(id, from);
  } catch {
    return null;
  }
}

/** The JS entry a package's `bin` names for `name`, contained in the package, or null. */
function binEntry(pkgJson: string, name: string): string | null {
  let pkg: unknown;
  try {
    pkg = JSON.parse(readFileSync(pkgJson, "utf8"));
  } catch {
    return null;
  }
  if (typeof pkg !== "object" || pkg === null) return null;
  const bin = (pkg as { bin?: unknown }).bin;
  const entry = typeof bin === "string" ? bin : typeof bin === "object" && bin !== null ? (bin as Record<string, unknown>)[name] : undefined;
  if (typeof entry !== "string" || entry === "") return null;
  const dir = dirname(pkgJson);
  return contained(dir, resolve(dir, entry));
}

/** Codex's Rust target triple for a platform, as its npm launcher names them. */
const CODEX_TARGETS: Record<string, string> = {
  "linux-x64": "x86_64-unknown-linux-musl",
  "linux-arm64": "aarch64-unknown-linux-musl",
  "darwin-x64": "x86_64-apple-darwin",
  "darwin-arm64": "aarch64-apple-darwin",
  "win32-x64": "x86_64-pc-windows-msvc",
  "win32-arm64": "aarch64-pc-windows-msvc",
};

/**
 * The bundled Codex CLI: the native binary from its platform package (`@openai/codex-<platform>-<arch>`, resolved
 * from `@openai/codex` itself), else `@openai/codex`'s JS launcher run with this Node. Null when neither is there.
 */
export function bundledCodex(o: BundledOptions = {}): BundledCli | null {
  const r = o.resolve ?? nodeResolve;
  const platform = o.platform ?? process.platform;
  const arch = o.arch ?? process.arch;
  const target = CODEX_TARGETS[`${platform}-${arch}`];
  if (target === undefined) return null; // its launcher refuses an unsupported platform too
  const pkgJson = tryResolve(r, "@openai/codex/package.json", HERE);
  if (pkgJson === null) return null;
  const nativeJson = tryResolve(r, `@openai/codex-${platform}-${arch}/package.json`, pkgJson);
  if (nativeJson !== null) {
    const dir = dirname(nativeJson);
    const file = contained(dir, join(dir, "vendor", target, "bin", platform === "win32" ? "codex.exe" : "codex"));
    if (file !== null) return { file, args: [] };
  }
  const entry = binEntry(pkgJson, "codex");
  return entry === null ? null : { file: process.execPath, args: [entry] };
}

/**
 * The bundled Gemini CLI: `@google/gemini-cli`'s `bin.gemini` (its single-file bundle) run with this Node. The
 * adapter sets GEMINI_CLI_NO_RELAUNCH so the bundle does not relaunch itself as a child our signals never reach.
 */
export function bundledGemini(o: BundledOptions = {}): BundledCli | null {
  const r = o.resolve ?? nodeResolve;
  const pkgJson = tryResolve(r, "@google/gemini-cli/package.json", HERE);
  if (pkgJson === null) return null;
  const entry = binEntry(pkgJson, "gemini");
  return entry === null ? null : { file: process.execPath, args: [entry] };
}

/** Whether this Linux uses musl rather than glibc (as the Agent SDK decides which binary to prefer). */
function isMusl(): boolean {
  try {
    const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined;
    return report?.header?.glibcVersionRuntime === undefined;
  } catch {
    return false;
  }
}

/**
 * The Claude Code binary shipped in the Agent SDK's platform package (`@anthropic-ai/claude-agent-sdk-<platform>-
 * <arch>[-musl]`, resolved from the SDK itself), used for subscription mode. Null when it is not installed.
 */
export function bundledClaude(o: BundledOptions = {}): string | null {
  const r = o.resolve ?? nodeResolve;
  const platform = o.platform ?? process.platform;
  const arch = o.arch ?? process.arch;
  // The SDK's exports do not include its package.json; its entry point sits at the package root.
  const sdk = tryResolve(r, "@anthropic-ai/claude-agent-sdk", HERE);
  if (sdk === null) return null;
  const base = `@anthropic-ai/claude-agent-sdk-${platform}-${arch}`;
  const names = platform === "linux" ? (isMusl() ? [`${base}-musl`, base] : [base, `${base}-musl`]) : [base];
  for (const name of names) {
    const pkgJson = tryResolve(r, `${name}/package.json`, sdk);
    if (pkgJson === null) continue;
    const dir = dirname(pkgJson);
    const file = contained(dir, join(dir, platform === "win32" ? "claude.exe" : "claude"));
    if (file !== null) return file;
  }
  return null;
}
