// The pure parts of staging: which Node archive to fetch, how to check it, what to remove from deployed core, and
// what a complete staged tree (or a packed app's Resources) must and must not contain.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
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
  "vitest.config.ts",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "node_modules/.pnpm",
  "node_modules/.bin",
  "node_modules/.modules.yaml",
  "node_modules/.pnpm-workspace-state-v1.json",
]);

/** Removed from every staged workspace package (`core/node_modules/@theterminal/*`): its sources, tests and configs. */
export const WORKSPACE_PRUNE = Object.freeze(["src", "test", "tsconfig.json", "vitest.config.ts"]);

/** The dependency maps a manifest may carry, besides devDependencies (which staging drops). */
const DEP_FIELDS = ["dependencies", "optionalDependencies", "peerDependencies"];

/** A spec that points at the build machine (`pnpm deploy` writes `file:///<absolute path>` for workspace packages). */
const LOCAL_SPEC = /(?:^|@)(?:file|link|workspace):/;

/**
 * A staged manifest without build-machine traces: no scripts or devDependencies, and every `file:`, `link:` or
 * `workspace:` spec replaced by the staged package's version.
 * @param {Record<string, unknown>} pkg
 * @param {(name: string) => string | undefined} versionOf the version of a package staged next to it
 * @returns {Record<string, unknown>}
 */
export function sanitizeManifest(pkg, versionOf) {
  const { scripts: _scripts, devDependencies: _dev, ...rest } = pkg;
  for (const field of DEP_FIELDS) {
    const deps = rest[field];
    if (typeof deps !== "object" || deps === null) continue;
    rest[field] = Object.fromEntries(
      Object.entries(deps).map(([name, spec]) => {
        if (typeof spec !== "string" || !LOCAL_SPEC.test(spec)) return [name, spec];
        const version = versionOf(name);
        if (version === undefined) throw new Error(`No staged version of ${name}`);
        return [name, version];
      }),
    );
  }
  return rest;
}

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

/** A licence file as packages name it: LICENSE, LICENCE or COPYING, optionally .md or .txt. */
const LICENSE_FILE = /^(?:licen[cs]e|copying)(?:\.(?:md|txt))?$/i;
/** A notice file: NOTICE, optionally .md or .txt. */
const NOTICE_FILE = /^notice(?:\.(?:md|txt))?$/i;

/** Where staging puts each program's licence and notice files (`licenses/<id>/`), and the list of them all. */
export const LICENSES_DIR = "licenses";
export const NOTICES_FILE = "THIRD_PARTY_NOTICES.txt";

/**
 * @typedef {{ id: string; name: string; dir: string; package?: string; fallback?: string; version?: string; license?: string }} ThirdPartyProgram
 *   `dir`: where it is staged ("/"-separated, relative to the stage); `fallback`: a folder (relative to apps/desktop)
 *   with copies of the upstream licence and notice files, for a package published without them
 */

/**
 * The third-party programs the app ships, whose licence files staging must find. Codex's npm package ships no
 * LICENSE or NOTICE, so a copy of the upstream files (openai/codex at the bundled release's tag) is kept in
 * third-party/openai-codex. Claude Code's native binary is listed only when it is bundled.
 * @param {string} platform
 * @param {string} arch
 * @param {boolean} bundleClaude
 * @param {string} [nodeVersion]
 * @returns {ThirdPartyProgram[]}
 */
export function thirdPartyPrograms(platform, arch, bundleClaude, nodeVersion) {
  const pa = `${platform}-${arch}`;
  return [
    { id: "nodejs", name: "Node.js", dir: "node", license: "MIT", ...(nodeVersion !== undefined && { version: nodeVersion }) },
    { id: "openai-codex", name: "Codex CLI", package: "@openai/codex", dir: "core/node_modules/@openai/codex", fallback: "third-party/openai-codex" },
    { id: "google-gemini-cli", name: "Gemini CLI", package: "@google/gemini-cli", dir: "core/node_modules/@google/gemini-cli" },
    {
      id: "anthropic-claude-agent-sdk", name: "Claude Agent SDK", package: "@anthropic-ai/claude-agent-sdk",
      dir: "core/node_modules/@anthropic-ai/claude-agent-sdk",
    },
    ...(bundleClaude
      ? [{ id: "anthropic-claude-code", name: "Claude Code", package: `@anthropic-ai/claude-agent-sdk-${pa}`, dir: `core/node_modules/@anthropic-ai/claude-agent-sdk-${pa}` }]
      : []),
  ];
}

/** The files in `dir` whose names match `pattern`, sorted, as `{ name, from }`. */
function matching(dir, pattern) {
  return readdirSafe(dir)
    .filter((n) => pattern.test(n) && statSafe(join(dir, n))?.isFile())
    .map((name) => ({ name, from: join(dir, name) }));
}

function statSafe(p) {
  try {
    return statSync(p);
  } catch {
    return undefined;
  }
}

/**
 * Each program's licence files (required) and notice files (whichever exist): the staged package's own, else the
 * kept upstream copies. Version and licence come from the staged package.json unless the program names them.
 * @param {string} stageDir
 * @param {string} appDir apps/desktop
 * @param {ThirdPartyProgram[]} programs
 * @returns {{ entries: { id: string; name: string; package?: string; version: string; license: string; files: { name: string; from: string }[] }[]; problems: string[] }}
 */
export function collectNotices(stageDir, appDir, programs) {
  const entries = [];
  const problems = [];
  for (const p of programs) {
    const dir = join(stageDir, ...p.dir.split("/"));
    const fallback = p.fallback === undefined ? undefined : join(appDir, ...p.fallback.split("/"));
    const pick = (/** @type {RegExp} */ pattern) => {
      const own = matching(dir, pattern);
      return own.length > 0 || fallback === undefined ? own : matching(fallback, pattern);
    };
    const licenses = pick(LICENSE_FILE);
    if (licenses.length === 0) {
      problems.push(`no licence file for ${p.name} (${p.dir})`);
      continue;
    }
    let manifest = {};
    try {
      manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    } catch {
      manifest = {};
    }
    entries.push({
      id: p.id,
      name: p.name,
      ...(p.package !== undefined && { package: p.package }),
      version: p.version ?? (typeof manifest.version === "string" ? manifest.version : "unknown"),
      license: p.license ?? (typeof manifest.license === "string" ? manifest.license : "see the licence file"),
      files: [...licenses, ...pick(NOTICE_FILE)],
    });
  }
  return { entries, problems };
}

/**
 * The text of THIRD_PARTY_NOTICES.txt for `entries` (from collectNotices).
 * @param {{ id: string; name: string; package?: string; version: string; license: string; files: { name: string }[] }[]} entries
 */
export function noticesText(entries) {
  const lines = [
    "Third-party software in The Terminal",
    "",
    "The Terminal is licensed under the Apache License 2.0. It ships the programs below, each under its own licence.",
    `Their licence and notice files are in the ${LICENSES_DIR} folder next to this file.`,
  ];
  for (const e of entries) {
    lines.push(
      "",
      `${e.name} ${e.version}${e.package === undefined ? "" : ` (${e.package})`}`,
      `  Licence: ${e.license}`,
      `  Files: ${e.files.map((f) => `${LICENSES_DIR}/${e.id}/${f.name}`).join(", ")}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Replaces `<stage>/licenses` with each entry's files under `licenses/<id>/`, and writes THIRD_PARTY_NOTICES.txt.
 * @param {string} stageDir
 * @param {{ id: string; name: string; package?: string; version: string; license: string; files: { name: string; from: string }[] }[]} entries
 */
export function writeNotices(stageDir, entries) {
  const root = join(stageDir, LICENSES_DIR);
  rmSync(root, { recursive: true, force: true });
  for (const e of entries) {
    const dir = join(root, e.id);
    mkdirSync(dir, { recursive: true });
    for (const f of e.files) copyFileSync(f.from, join(dir, f.name));
  }
  writeFileSync(join(stageDir, NOTICES_FILE), noticesText(entries));
}

/** Whether `p` is a symlink to a directory. */
function isDirLink(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Every file under `dir` (symlinks not followed), as "/"-separated paths relative to `base`. `skip` names
 * directories (by name) not entered.
 * @param {string} dir
 * @param {string} rel
 * @param {(name: string) => boolean} [skip]
 * @returns {string[]}
 */
function filesUnder(dir, rel, skip = () => false) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!skip(e.name)) out.push(...filesUnder(join(dir, e.name), `${rel}${e.name}/`, skip));
    } else if (e.isFile()) {
      out.push(`${rel}${e.name}`);
    }
  }
  return out.sort();
}

/**
 * The strings that give away the build machine, lower-cased: its home folder and the repository root (as written,
 * JSON-escaped and with forward slashes) and its username as a path segment.
 * @param {{ home?: string; user?: string; repoRoot?: string }} paths
 * @returns {string[]}
 */
function buildPathNeedles(paths) {
  const out = new Set();
  for (const p of [paths.home, paths.repoRoot]) {
    if (!p) continue;
    for (const v of [p, p.replaceAll("\\", "\\\\"), p.replaceAll("\\", "/")]) out.add(v.toLowerCase());
  }
  if (paths.user) {
    const u = paths.user.toLowerCase();
    for (const v of [`/${u}/`, `\\${u}\\`, `\\\\${u}\\\\`]) out.add(v);
  }
  return [...out];
}

/**
 * This machine's home folder and username (as far as they can be read), and the repository root when given.
 * @param {string} [repoRoot]
 * @returns {{ home?: string; user?: string; repoRoot?: string }}
 */
export function buildMachinePaths(repoRoot) {
  let user;
  try {
    user = userInfo().username;
  } catch {
    user = undefined;
  }
  return { home: homedir(), user, ...(repoRoot !== undefined && { repoRoot }) };
}

/** The files scanned for build-machine paths: text files the app reads or ships as its own. */
const SCANNED = /\.(?:json|js|mjs|cjs|map|html|css)$/;

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
      if (!e.isDirectory() && !(e.name.startsWith("@") && isDirLink(join(dir, e.name)))) continue;
      const sub = join(dir, e.name);
      if (e.name.startsWith("@")) {
        for (const p of readdirSync(sub, { withFileTypes: true })) {
          // A symlink is a package too, wherever it points (even nowhere); its target is not walked.
          if (p.isSymbolicLink()) out.push(`${rel}${e.name}/${p.name}`);
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

/** The entries of `dir`, or none. */
function readdirSafe(dir) {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

/** Whether a manifest's dependency maps (devDependencies included) hold a `file:`, `link:` or `workspace:` spec. */
function hasLocalSpec(text) {
  let pkg;
  try {
    pkg = JSON.parse(text);
  } catch {
    return false;
  }
  if (typeof pkg !== "object" || pkg === null) return false;
  return [...DEP_FIELDS, "devDependencies"].some((field) => {
    const deps = pkg[field];
    return typeof deps === "object" && deps !== null && Object.values(deps).some((spec) => typeof spec === "string" && LOCAL_SPEC.test(spec));
  });
}

/**
 * What a staged tree (`<stage>` with `core`, `node` and `ui`, or a packed app's Resources) is missing or must not
 * contain, as "/"-separated paths relative to it. Empty when the tree is good.
 * @param {string} stageDir
 * @param {NodeJS.Platform} platform
 * @param {string} arch
 * @param {{ bundleClaude?: boolean; buildPaths?: { home?: string; user?: string; repoRoot?: string } }} [opts]
 *   `buildPaths`: what must not appear in a staged file (default: this machine's home folder and username)
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
  need(NOTICES_FILE);
  for (const p of thirdPartyPrograms(platform, arch, bundleClaude)) {
    const dir = join(stageDir, LICENSES_DIR, p.id);
    need(`${LICENSES_DIR}/${p.id}/LICENSE`, readdirSafe(dir).some((n) => LICENSE_FILE.test(n)));
  }

  for (const entry of PRUNE) {
    if (existsSync(join(stageDir, "core", ...entry.split("/")))) problems.push(`forbidden: core/${entry}`);
  }
  const workspace = readdirSafe(join(nm, "@theterminal")).map((n) => `core/node_modules/@theterminal/${n}`);
  for (const pkg of workspace) {
    for (const entry of WORKSPACE_PRUNE) {
      if (existsSync(join(stageDir, ...pkg.split("/"), entry))) problems.push(`forbidden: ${pkg}/${entry}`);
    }
  }
  for (const dist of ["core/dist", ...workspace.map((p) => `${p}/dist`)]) {
    for (const f of filesUnder(join(stageDir, ...dist.split("/")), `${dist}/`)) {
      if (f.endsWith(".js.map")) problems.push(`forbidden: ${f}`);
    }
  }
  for (const pkg of scopedPackages(nm)) {
    const name = pkg.split("/").slice(-2).join("/");
    if (isExcludedPackage(name, bundleClaude)) problems.push(`forbidden: core/node_modules/${pkg}`);
  }

  // No staged file may carry a path from the build machine, and no manifest a spec that points at one.
  const needles = buildPathNeedles(opts.buildPaths ?? buildMachinePaths());
  const scanned = new Set([
    ...filesUnder(join(stageDir, "core"), "core/", (n) => n === "node_modules").filter((f) => SCANNED.test(f)),
    ...workspace.flatMap((p) => filesUnder(join(stageDir, ...p.split("/")), `${p}/`).filter((f) => SCANNED.test(f))),
    ...filesUnder(nm, "core/node_modules/").filter((f) => f.endsWith("/package.json")),
    ...filesUnder(join(stageDir, "ui"), "ui/").filter((f) => SCANNED.test(f)),
  ]);
  for (const rel of [...scanned].sort()) {
    const text = readFileSync(join(stageDir, ...rel.split("/")), "utf8");
    const lower = text.toLowerCase();
    if (needles.some((n) => lower.includes(n))) problems.push(`build path: ${rel}`);
    if (rel.endsWith("package.json") && hasLocalSpec(text)) problems.push(`local spec: ${rel}`);
  }
  return problems;
}
