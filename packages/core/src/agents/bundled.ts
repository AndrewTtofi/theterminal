import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The agent programs shipped inside The Terminal as dependencies of this package: Codex and Gemini CLI, and the
 * Claude Code binary that comes with the Agent SDK. Their versions are pinned to the ones the adapters' protocol
 * handling was verified against.
 *
 * No shell, PATH, NODE_PATH or ancestor search is involved. A dependency is looked for only where the package
 * manager links it for this package: `<core>/node_modules/<name>`, or the `node_modules` core itself is installed
 * in (for a platform package: next to the package that depends on it). Its real `package.json` must then lie
 * inside a `node_modules` reachable from core's own directory, and the file it provides must stay, symlinks
 * followed, inside the real directory of that package.
 */

/** A program to spawn: a native binary with no arguments, or this Node with a JS entry point. */
export type BundledCli = { file: string; args: string[] };

export type BundledOptions = {
  /** The directory of the `@theterminal/core` package. Injectable for tests. */
  coreDir?: string;
  platform?: NodeJS.Platform;
  arch?: string;
};

const HERE = dirname(fileURLToPath(import.meta.url));

/** This package's directory: the nearest ancestor whose package.json is `@theterminal/core`. */
function findCoreDir(): string | null {
  for (let d = HERE; ; d = dirname(d)) {
    try {
      if ((JSON.parse(readFileSync(join(d, "package.json"), "utf8")) as { name?: unknown }).name === "@theterminal/core") return d;
    } catch {
      // No (readable) package.json here.
    }
    if (dirname(d) === d) return null;
  }
}

/** Whether `p` lies strictly inside `dir` (both already real paths). */
function isInside(dir: string, p: string): boolean {
  const rel = relative(dir, p);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** The real path of `file` when it is a regular file inside `dir` (both with symlinks followed), else null. */
function contained(dir: string, file: string): string | null {
  try {
    const real = realpathSync(file);
    return isInside(realpathSync(dir), real) && statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}

/** The nearest ancestor of `dir` named node_modules, or null. */
function enclosingNodeModules(dir: string): string | null {
  for (let d = dirname(dir); dirname(d) !== d; d = dirname(d)) {
    if (basename(d) === "node_modules") return d;
  }
  return null;
}

/** Where the package manager links the dependencies of the package in `dir`. */
const linkRoots = (dir: string): string[] => [join(dir, "node_modules"), ...[enclosingNodeModules(dir) ?? []].flat()];

/** The real paths of the node_modules directories reachable from core's directory, nearest first. */
function reachableNodeModules(coreDir: string): string[] {
  const out: string[] = [];
  let d: string;
  try {
    d = realpathSync(coreDir);
  } catch {
    return out;
  }
  for (;;) {
    const nm = basename(d) === "node_modules" ? d : join(d, "node_modules");
    try {
      if (existsSync(nm)) out.push(realpathSync(nm));
    } catch {
      // Unreadable: not a place we accept packages from.
    }
    if (dirname(d) === d) return out;
    d = dirname(d);
  }
}

/** One lookup context: core's directory and the node_modules directories packages may really live in. */
type Install = { coreDir: string; allowed: string[] };

function install(coreDir: string | null): Install | null {
  return coreDir === null ? null : { coreDir, allowed: reachableNodeModules(coreDir) };
}

/** The real path of package `name`'s package.json linked for the package in `dir`, or null. */
function findPackage(inst: Install, dir: string, name: string): string | null {
  for (const root of linkRoots(dir)) {
    const candidate = join(root, name, "package.json");
    let real: string;
    try {
      real = realpathSync(candidate);
    } catch {
      continue;
    }
    if (inst.allowed.some((nm) => isInside(nm, real))) return real;
  }
  return null;
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

/** Computes a lookup once for the default options; injected options always compute afresh. */
function memoized<T>(compute: (o: BundledOptions) => T): (o?: BundledOptions) => T {
  let cached: { value: T } | undefined;
  return (o) => {
    if (o !== undefined) return compute(o);
    cached ??= { value: compute({}) };
    return cached.value;
  };
}

/**
 * The bundled Codex CLI: the native binary from its platform package (`@openai/codex-<platform>-<arch>`, linked
 * next to `@openai/codex`). Null without it: the package's JS launcher needs that same binary, so the caller falls
 * back to PATH instead.
 */
export const bundledCodex = memoized((o): BundledCli | null => {
  const platform = o.platform ?? process.platform;
  const arch = o.arch ?? process.arch;
  const target = CODEX_TARGETS[`${platform}-${arch}`];
  if (target === undefined) return null;
  const inst = install(o.coreDir ?? findCoreDir());
  if (inst === null) return null;
  const pkgJson = findPackage(inst, inst.coreDir, "@openai/codex");
  if (pkgJson === null) return null;
  const nativeJson = findPackage(inst, dirname(pkgJson), `@openai/codex-${platform}-${arch}`);
  if (nativeJson === null) return null;
  const dir = dirname(nativeJson);
  const file = contained(dir, join(dir, "vendor", target, "bin", platform === "win32" ? "codex.exe" : "codex"));
  return file === null ? null : { file, args: [] };
});

/**
 * The bundled Gemini CLI: `@google/gemini-cli`'s `bin.gemini` (its single-file bundle) run with this Node. The
 * adapter sets GEMINI_CLI_NO_RELAUNCH so the bundle does not relaunch itself as a child our signals never reach.
 */
export const bundledGemini = memoized((o): BundledCli | null => {
  const inst = install(o.coreDir ?? findCoreDir());
  if (inst === null) return null;
  const pkgJson = findPackage(inst, inst.coreDir, "@google/gemini-cli");
  if (pkgJson === null) return null;
  const entry = binEntry(pkgJson, "gemini");
  return entry === null ? null : { file: process.execPath, args: [entry] };
});

let musl: boolean | undefined;
/** Whether this Linux uses musl rather than glibc (as the Agent SDK decides which binary to prefer). Asked once. */
function isMusl(): boolean {
  if (musl === undefined) {
    try {
      const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined;
      musl = report?.header?.glibcVersionRuntime === undefined;
    } catch {
      musl = false;
    }
  }
  return musl;
}

/**
 * The Claude Code binary shipped in the Agent SDK's platform package (`@anthropic-ai/claude-agent-sdk-<platform>-
 * <arch>[-musl]`, linked next to the SDK), used for subscription mode. Null when it is not installed.
 */
export const bundledClaude = memoized((o): string | null => {
  const platform = o.platform ?? process.platform;
  const arch = o.arch ?? process.arch;
  const inst = install(o.coreDir ?? findCoreDir());
  if (inst === null) return null;
  const sdk = findPackage(inst, inst.coreDir, "@anthropic-ai/claude-agent-sdk");
  if (sdk === null) return null;
  const base = `@anthropic-ai/claude-agent-sdk-${platform}-${arch}`;
  const names = platform === "linux" ? (isMusl() ? [`${base}-musl`, base] : [base, `${base}-musl`]) : [base];
  for (const name of names) {
    const pkgJson = findPackage(inst, dirname(sdk), name);
    if (pkgJson === null) continue;
    const dir = dirname(pkgJson);
    const file = contained(dir, join(dir, platform === "win32" ? "claude.exe" : "claude"));
    if (file !== null) return file;
  }
  return null;
});
