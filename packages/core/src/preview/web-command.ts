import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { join, posix, win32 } from "node:path";
import { visibleControls } from "@theterminal/shared";
import { REDACTED } from "../agents/redact.js";
import { which as defaultWhich } from "../agents/which.js";
import { canonicalJson } from "../ledger/canonical.js";

/**
 * Website preview commands (spec "Decisions after review" 2, 3 and 9; plan Rulings 9-12). The command comes out of
 * the agent's own `[[preview: …]]` line, so it is untrusted: it is held to a strict grammar, its script must exist
 * in package.json, and it is run as an argument array with Node and the package manager's own JavaScript entry (or
 * a native executable), never through a shell and never as a `.cmd`, `.bat` or `.ps1` file.
 */

export type PreviewKind = "web" | "ios" | "android";
export type Manager = "npm" | "pnpm" | "yarn";
export type PackageManager = Manager | "npx";

export type PreviewRefusal = "redacted" | "truncated" | "controls" | "program" | "script_missing" | "no_package_json";

export class PreviewRefusedError extends Error {
  constructor(readonly reason: PreviewRefusal) {
    super(`preview command refused: ${reason}`);
    this.name = "PreviewRefusedError";
  }
}

export class PackageManagerNotFoundError extends Error {
  constructor(readonly manager: Manager) {
    super(`package manager not found: ${manager}`);
    this.name = "PackageManagerNotFoundError";
  }
}

export type WebCommand = { manager: Manager; runner: "run" | "npx"; name: string; args: string[] };

/** A script or npx tool name (Ruling 9). */
const NAME = /^[A-Za-z0-9@][A-Za-z0-9@:._/-]{0,99}$/;
/** One plain argument (Ruling 9): no quotes, no spaces, no shell operators. */
const ARG = /^[A-Za-z0-9@%+=:,._/-]{1,200}$/;
const MAX_ARGS = 16;
/** The length the runner truncates a recorded offer's command to. */
const RECORDED_COMMAND_MAX = 500;
const TRUNCATED_TAIL = /…(\[truncated\])?$/;
const MANAGERS: readonly Manager[] = ["npm", "pnpm", "yarn"];
const isManager = (s: string | undefined): s is Manager => MANAGERS.includes(s as Manager);

/**
 * The command as `{ manager, runner, name, args }`, or a PreviewRefusedError: `redacted` for a redaction marker,
 * `truncated` for a recorded truncation, `controls` for any hidden or control character, `program` for anything
 * that is not `npm|pnpm|yarn run <script> [args]` or `npx <tool> [args]` split on single spaces.
 */
export function parseWebCommand(command: string): WebCommand {
  if (command.includes(REDACTED)) throw new PreviewRefusedError("redacted");
  if (command.length >= RECORDED_COMMAND_MAX && TRUNCATED_TAIL.test(command)) throw new PreviewRefusedError("truncated");
  if (visibleControls(command) !== command) throw new PreviewRefusedError("controls");
  const parsed = parseArgv(command.split(" "));
  if (parsed === null) throw new PreviewRefusedError("program");
  return parsed;
}

/** The grammar over an already split command; null for anything outside it. */
function parseArgv(parts: readonly string[]): WebCommand | null {
  let head: Omit<WebCommand, "args">;
  let rest: readonly string[];
  if (parts[0] === "npx") {
    head = { manager: "npm", runner: "npx", name: parts[1] ?? "" };
    rest = parts.slice(2);
  } else if (isManager(parts[0]) && parts[1] === "run") {
    head = { manager: parts[0], runner: "run", name: parts[2] ?? "" };
    rest = parts.slice(3);
  } else {
    return null;
  }
  if (!NAME.test(head.name)) return null;
  if (rest.length > MAX_ARGS || !rest.every((a) => ARG.test(a))) return null;
  return { ...head, args: [...rest] };
}

export type ResolveOptions = {
  /** The child environment, whose PATH is searched. */
  env: NodeJS.ProcessEnv;
  execPath?: string;
  platform?: NodeJS.Platform;
  which?: typeof defaultWhich;
  realpath?: (p: string) => string;
  isFile?: (p: string) => boolean;
  /** The first bytes of a file, to tell a native executable or a Node script from a shell script. */
  readHead?: (p: string) => Buffer;
};

const isRegularFile = (p: string): boolean => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

const fileHead = (p: string): Buffer => {
  const fd = openSync(p, "r");
  try {
    const buf = Buffer.alloc(256);
    return buf.subarray(0, readSync(fd, buf, 0, buf.length, 0));
  } finally {
    closeSync(fd);
  }
};

const NEVER_RUN = /\.(cmd|bat|ps1)$/i;
const JS_ENTRY = /\.(js|cjs|mjs)$/i;
/** ELF, Mach-O (32/64-bit, either byte order) and fat Mach-O. */
const NATIVE_MAGIC = [
  [0x7f, 0x45, 0x4c, 0x46],
  [0xfe, 0xed, 0xfa, 0xce],
  [0xfe, 0xed, 0xfa, 0xcf],
  [0xce, 0xfa, 0xed, 0xfe],
  [0xcf, 0xfa, 0xed, 0xfe],
  [0xca, 0xfe, 0xba, 0xbe],
];
/** A `#!` line whose interpreter is Node (`#!/usr/bin/env node`, `#!/usr/local/bin/node`). */
const NODE_SHEBANG = /^#![^\n]*\bnode(\s|$)/;

/** The entry of `pm` inside an npm-style `node_modules` folder (Ruling 10). */
const ENTRIES: Record<PackageManager, readonly string[]> = {
  npm: ["npm/bin/npm-cli.js"],
  npx: ["npm/bin/npx-cli.js"],
  pnpm: ["pnpm/bin/pnpm.cjs", "pnpm/bin/pnpm.js"],
  yarn: ["yarn/bin/yarn.cjs", "yarn/bin/yarn.js"],
};

/**
 * How to run `pm` without a shell (Ruling 10), tried in order: npm's own entry beside this Node; the PATH hit when
 * its real path is a JavaScript file (run with this Node) or a native executable (run directly); for a `.cmd` shim,
 * the package's own JavaScript entry beside it. A `.cmd`, `.bat` or `.ps1` file is never returned, and neither is a
 * shell script. Nothing found: PackageManagerNotFoundError.
 */
export function resolvePackageManager(pm: PackageManager, o: ResolveOptions): { file: string; args: string[] } {
  const execPath = o.execPath ?? process.execPath;
  const platform = o.platform ?? process.platform;
  const windows = platform === "win32";
  const path = windows ? win32 : posix;
  const whichFn = o.which ?? defaultWhich;
  const isFile = o.isFile ?? isRegularFile;
  const readHead = o.readHead ?? fileHead;
  const realpath = (p: string): string | null => {
    try {
      return (o.realpath ?? realpathSync.native)(p);
    } catch {
      return null;
    }
  };
  const viaNode = (entry: string) => ({ file: execPath, args: [entry] });
  const entryIn = (nodeModules: string): string | null => {
    for (const rel of ENTRIES[pm]) {
      const candidate = path.join(nodeModules, ...rel.split("/"));
      if (!isFile(candidate)) continue;
      const real = realpath(candidate);
      if (real !== null && JS_ENTRY.test(real) && isFile(real)) return real;
    }
    return null;
  };

  if (pm === "npm" || pm === "npx") {
    const binDir = path.dirname(execPath);
    const own = entryIn(windows ? path.join(binDir, "node_modules") : path.join(binDir, "..", "lib", "node_modules"));
    if (own !== null) return viaNode(own);
  }

  const hit = whichFn(pm, { env: o.env, platform });
  if (hit !== null) {
    const real = realpath(hit);
    if (real !== null && isFile(real)) {
      if (JS_ENTRY.test(real)) return viaNode(real);
      if (!NEVER_RUN.test(real)) {
        const kind = windows ? (/\.exe$/i.test(real) ? "native" : null) : headKind(real, readHead);
        if (kind === "native") return { file: real, args: [] };
        if (kind === "node") return viaNode(real);
      }
    }
    // A `.cmd` shim (npm's, pnpm's or yarn's) sits beside the package's own node_modules.
    if (/\.cmd$/i.test(hit)) {
      const entry = entryIn(path.join(path.dirname(hit), "node_modules"));
      if (entry !== null) return viaNode(entry);
    }
  }
  throw new PackageManagerNotFoundError(pm === "npx" ? "npm" : pm);
}

function headKind(file: string, readHead: (p: string) => Buffer): "native" | "node" | null {
  let head: Buffer;
  try {
    head = readHead(file);
  } catch {
    return null;
  }
  if (NATIVE_MAGIC.some((m) => m.every((b, i) => head[i] === b))) return "native";
  if (NODE_SHEBANG.test(head.toString("latin1"))) return "node";
  return null;
}

type Flavor = "vite" | "next" | null;

/** Which framework a script's text or an npx tool (with its arguments) starts, from its words. */
function flavorOf(text: string | null): Flavor {
  if (text === null) return null;
  // Words of the script, split on spaces and the shell's own separators; a path keeps its last part.
  const words = text.split(/[\s;&|()<>]+/).map((w) => w.slice(w.lastIndexOf("/") + 1).replace(/(.)@.*$/, "$1"));
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const next = words[i + 1];
    if (w === "vite") return "vite";
    if ((w === "astro" || w === "nuxt" || w === "nuxi") && next === "dev") return "vite";
    if (w === "next" && next === "dev") return "next";
  }
  return null;
}

function flagsFor(flavor: Flavor, port: string): string[] {
  if (flavor === "vite") return ["--port", port, "--host", "127.0.0.1"];
  if (flavor === "next") return ["--port", port, "--hostname", "127.0.0.1"];
  return [];
}

/**
 * The flags that pin a known dev server to the chosen port on loopback (Ruling 11): `--port <p> --host 127.0.0.1`
 * for Vite, `astro dev` and `nuxt dev`/`nuxi dev`, `--port <p> --hostname 127.0.0.1` for `next dev`, else none.
 * `tool` is the npx tool, optionally followed by its arguments (`next dev`).
 */
export function frameworkFlags(scriptText: string | null, tool: string | null, port: number): string[] {
  return flagsFor(flavorOf(scriptText) ?? flavorOf(tool), String(port));
}

const LOCKFILES: readonly { file: string; manager: Manager; install: string[] }[] = [
  { file: "package-lock.json", manager: "npm", install: ["npm", "ci"] },
  { file: "pnpm-lock.yaml", manager: "pnpm", install: ["pnpm", "install", "--frozen-lockfile"] },
  { file: "yarn.lock", manager: "yarn", install: ["yarn", "install", "--frozen-lockfile"] },
];

function chosenLock(worktree: string, manager: Manager) {
  const present = LOCKFILES.filter((l) => existsSync(join(worktree, l.file)));
  return present.find((l) => l.manager === manager) ?? present[0] ?? null;
}

/**
 * The install that comes first (spec decision 9): null when `node_modules` exists; else chosen by the lockfile (the
 * manager's own first), else `<manager> install`.
 */
export function installCommand(worktree: string, manager: Manager): string[] | null {
  if (existsSync(join(worktree, "node_modules"))) return null;
  const lock = chosenLock(worktree, manager);
  return lock === null ? [manager, "install"] : [...lock.install];
}

function readScripts(worktree: string): Record<string, unknown> {
  let pkg: unknown;
  try {
    pkg = JSON.parse(readFileSync(join(worktree, "package.json"), "utf8"));
  } catch {
    throw new PreviewRefusedError("no_package_json");
  }
  if (typeof pkg !== "object" || pkg === null || Array.isArray(pkg)) throw new PreviewRefusedError("no_package_json");
  const scripts = (pkg as { scripts?: unknown }).scripts;
  return typeof scripts === "object" && scripts !== null && !Array.isArray(scripts) ? (scripts as Record<string, unknown>) : {};
}

const INSTALL_SHAPES: readonly string[] = [
  "npm ci",
  "pnpm install --frozen-lockfile",
  "yarn install --frozen-lockfile",
  "npm install",
  "pnpm install",
  "yarn install",
];

/**
 * The full logical argument array as it runs: for `npm run`, `--` goes straight after the script, so no argument
 * is ever read by npm itself as its own configuration (`--script-shell=…`); the framework flags come last.
 * PreviewRefusedError("program") for anything outside the grammar or the install commands.
 */
function logicalArgv(cmd: readonly string[], scriptText: string | null, port: string): string[] {
  if (INSTALL_SHAPES.includes(cmd.join(" ")) && cmd.every((c) => c !== "")) return [...cmd];
  const parsed = parseArgv(cmd);
  if (parsed === null) throw new PreviewRefusedError("program");
  const flags = flagsFor(
    parsed.runner === "npx" ? flavorOf([parsed.name, ...parsed.args].join(" ")) : flavorOf(scriptText),
    port,
  );
  const tail = [...parsed.args, ...flags];
  if (parsed.runner === "npx") return ["npx", parsed.name, ...tail];
  if (parsed.manager === "npm" && tail.length > 0) return ["npm", "run", parsed.name, "--", ...tail];
  return [parsed.manager, "run", parsed.name, ...tail];
}

export type WebPlan = {
  /** Logical commands (`["npm","run","dev"]`), unresolved and without port flags: what the key covers. */
  commands: string[][];
  /** Each command as it will run, with `<port>` in place of the port: what the person confirms. */
  display: string[];
  /** Relative paths whose bytes the key covers. */
  files: string[];
  install: boolean;
  /** The script's text from package.json (null for npx). */
  script: string | null;
};

/**
 * The plan for a website command: the install when `node_modules` is missing, then the command. Refuses with
 * PreviewRefusedError (`no_package_json`, `script_missing`, or the grammar's reasons).
 */
export function webPlan(worktree: string, command: string, _o: Record<string, never> = {}): WebPlan {
  const parsed = parseWebCommand(command);
  const scripts = readScripts(worktree);
  let script: string | null = null;
  if (parsed.runner === "run") {
    const text = Object.hasOwn(scripts, parsed.name) ? scripts[parsed.name] : undefined;
    if (typeof text !== "string") throw new PreviewRefusedError("script_missing");
    script = text;
  }
  const run = parsed.runner === "npx" ? ["npx", parsed.name, ...parsed.args] : [parsed.manager, "run", parsed.name, ...parsed.args];
  const install = installCommand(worktree, parsed.manager);
  const commands = install === null ? [run] : [install, run];
  const files = ["package.json"];
  if (install !== null) {
    const lock = chosenLock(worktree, parsed.manager);
    if (lock !== null) files.push(lock.file);
  }
  return {
    commands,
    display: commands.map((c) => logicalArgv(c, script, "<port>").join(" ")),
    files,
    install: install !== null,
    script,
  };
}

const sha256 = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");

/**
 * The confirmation key (Ruling 12): `sha256(canonicalJson({ kind, commands, files }))`, `files` mapping each
 * relative path to the sha256 of its bytes, or null when it is missing or not a regular file.
 */
export function contentKey(worktree: string, kind: PreviewKind, commands: string[][], files: string[]): string {
  const hashed: Record<string, string | null> = {};
  for (const rel of files) {
    const abs = join(worktree, ...rel.split("/"));
    let digest: string | null = null;
    try {
      if (statSync(abs).isFile()) digest = sha256(readFileSync(abs));
    } catch {
      digest = null;
    }
    hashed[rel] = digest;
  }
  return sha256(canonicalJson({ kind, commands, files: hashed }));
}

/**
 * One logical command as a program and its arguments: the resolved package manager, the logical arguments, then
 * `--` (npm run only) and the framework flags for `port`.
 */
export function resolveWebArgv(
  cmd: string[],
  port: number,
  o: ResolveOptions & { scriptText?: string | null },
): { file: string; args: string[] } {
  const argv = logicalArgv(cmd, o.scriptText ?? null, String(port));
  const pm = argv[0] as PackageManager;
  const entry = resolvePackageManager(pm, o);
  return { file: entry.file, args: [...entry.args, ...argv.slice(1)] };
}
