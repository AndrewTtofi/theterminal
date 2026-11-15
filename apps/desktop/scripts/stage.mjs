// Completes the staged tree after `pnpm deploy` wrote core to stage/core: prunes it, adds the pinned and
// checksum-verified Node runtime and the built UI, then checks the result.
//   node scripts/stage.mjs [--arch <arch>]   stage for this host (the arch must be the host's)
//   node scripts/stage.mjs --clean           remove stage/ before a fresh deploy
import { execFile } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { BUNDLE_CLAUDE } from "../electron-builder.mjs";
import { PRUNE, assertLayout, isExcludedPackage, nodeArchive, verifySha256 } from "./stage-lib.mjs";

const run = promisify(execFile);
const APP = join(dirname(fileURLToPath(import.meta.url)), "..");
const STAGE = join(APP, "stage");
const CACHE = join(APP, ".cache");
const CORE = join(STAGE, "core");

const { values } = parseArgs({ options: { arch: { type: "string" }, clean: { type: "boolean" } } });

if (values.clean) {
  rmSync(STAGE, { recursive: true, force: true });
  process.exit(0);
}

const platform = process.platform;
const arch = values.arch ?? process.arch;
if (arch !== process.arch) throw new Error(`Build on a ${arch} runner: platform packages are installed for the host only`);
if (!existsSync(join(CORE, "package.json"))) throw new Error("stage/core is missing: run deploy:core first");

// 1. Prune core, and leave out the packages that are not redistributed.
for (const entry of PRUNE) rmSync(join(CORE, ...entry.split("/")), { recursive: true, force: true });
const nm = join(CORE, "node_modules");
for (const scope of readdirSync(nm).filter((n) => n.startsWith("@"))) {
  for (const name of readdirSync(join(nm, scope))) {
    if (isExcludedPackage(`${scope}/${name}`, BUNDLE_CLAUDE)) rmSync(join(nm, scope, name), { recursive: true, force: true });
  }
}

// 2. The pinned Node runtime: downloaded once into .cache, verified on every use, before anything is extracted.
const manifest = JSON.parse(readFileSync(join(APP, "node-runtime.json"), "utf8"));
const node = nodeArchive(manifest, platform, arch);
mkdirSync(CACHE, { recursive: true });
const archive = join(CACHE, node.file);
if (!existsSync(archive)) {
  const res = await fetch(node.url);
  if (!res.ok) throw new Error(`Download failed (${res.status}): ${node.url}`);
  const partial = `${archive}.partial`;
  writeFileSync(partial, Buffer.from(await res.arrayBuffer()));
  try {
    verifySha256(partial, node.sha256);
  } catch (e) {
    rmSync(partial, { force: true });
    throw e;
  }
  renameSync(partial, archive);
}
verifySha256(archive, node.sha256);

// bsdtar reads both .tar.gz and .zip. On Windows, name the system's own tar.exe: a Git for Windows GNU tar on PATH
// reads no zip and takes `C:` for a remote host.
const tar = platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
const root = node.member.split("/")[0];
const tmp = mkdtempSync(join(CACHE, "extract-"));
try {
  await run(tar, ["-xf", archive, "-C", tmp, node.member, `${root}/LICENSE`]);
  const nodeDir = join(STAGE, "node");
  rmSync(nodeDir, { recursive: true, force: true });
  mkdirSync(nodeDir, { recursive: true });
  const exe = join(nodeDir, platform === "win32" ? "node.exe" : "node");
  renameSync(join(tmp, ...node.member.split("/")), exe);
  renameSync(join(tmp, root, "LICENSE"), join(nodeDir, "LICENSE"));
  if (platform !== "win32") chmodSync(exe, 0o755);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// 3. The built UI.
const uiDist = join(APP, "..", "ui", "dist");
if (!existsSync(join(uiDist, "index.html"))) throw new Error("apps/ui/dist is missing: run pnpm build first");
rmSync(join(STAGE, "ui"), { recursive: true, force: true });
cpSync(uiDist, join(STAGE, "ui"), { recursive: true });

// 4. The staged tree must match the packaged layout exactly.
const problems = assertLayout(STAGE, platform, arch, { bundleClaude: BUNDLE_CLAUDE });
if (problems.length > 0) throw new Error(`Staged layout is incomplete: ${problems.join(", ")}`);
console.log(`Staged core, Node ${manifest.version} and the UI for ${platform}-${arch}${BUNDLE_CLAUDE ? "" : " (Claude Code not bundled)"}`);
