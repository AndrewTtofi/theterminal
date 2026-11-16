import { open } from "node:fs/promises";
import { chmodSync, lstatSync, renameSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorktreeManager } from "../../src/agents/worktrees.js";
import { FolderRefusedError, FolderUnavailableError, listFolder, sameIdentity, stageFolder } from "../../src/sources/folder.js";
import { ImportStaging } from "../../src/sources/staging.js";
import { plainGit } from "../fixtures/submodule-trap.js";

const GIT_TEST_TIMEOUT_MS = process.platform === "win32" ? 40_000 : 15_000;
vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT_MS, hookTimeout: GIT_TEST_TIMEOUT_MS });

let base: string;
let dataDir: string;
let folder: string;
let outside: string;
let wt: WorktreeManager;

const write = (rel: string, content: string | Buffer) => {
  const p = join(folder, ...rel.split("/"));
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
};

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "folder-")));
  dataDir = join(base, "data");
  folder = join(base, "mine");
  outside = join(base, "outside");
  for (const d of [dataDir, folder, outside]) mkdirSync(d);
  wt = new WorktreeManager(dataDir);
});
afterEach(() => rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

describe("listFolder", () => {
  it("lists the folder's files, leaving out what .gitignore excludes", async () => {
    write("a.txt", "a");
    write("src/b.ts", "b");
    write("dist/a.js", "built");
    write(".gitignore", "dist/\n");
    const r = await listFolder(wt, dataDir, folder);
    expect(r.files.sort()).toEqual([".gitignore", "a.txt", "src/b.ts"]);
    expect(r.nested).toEqual([]);
    // The scratch git directory is removed afterwards and nothing was written into the folder.
    expect(existsSync(join(dataDir, ".theterminal-scan")) ? readdirSync(join(dataDir, ".theterminal-scan")) : []).toEqual([]);
    expect(readdirSync(folder).sort()).toEqual([".gitignore", "a.txt", "dist", "src"]);
  });

  it("never reads the folder's own .git: a planted core.fsmonitor never runs", async (ctx) => {
    write("a.txt", "a");
    await plainGit(folder, "init", "-q");
    await plainGit(folder, "add", "a.txt");
    await plainGit(folder, "commit", "-q", "-m", "mine");
    write("new.txt", "new");
    write("hidden.txt", "listed although the folder's own exclude names it");
    writeFileSync(join(folder, ".git", "info", "exclude"), "hidden.txt\n");
    const marker = join(outside, "fsmonitor.ran");
    const monitor = join(outside, "fsmonitor.sh");
    writeFileSync(monitor, `#!/bin/sh\ntouch "${marker}"\nexit 1\n`);
    chmodSync(monitor, 0o755);
    await plainGit(folder, "config", "core.fsmonitor", monitor);
    await plainGit(folder, "config", "core.hooksPath", outside);

    const r = await listFolder(wt, dataDir, folder);
    // The folder's own index (a.txt committed) and exclude file were not used: every file is listed, .git never.
    expect(r.files.sort()).toEqual(["a.txt", "hidden.txt", "new.txt"]);
    expect(existsSync(marker)).toBe(false);

    if (process.platform === "win32") return ctx.skip(); // the planted monitor is a shell script
    // The trap is live: plain git in the folder runs it.
    await plainGit(folder, "status", "--porcelain");
    expect(existsSync(marker)).toBe(true);
  });

  it("lists a nested repository in nested, not in files", async () => {
    write("a.txt", "a");
    write("vendor/lib/x.txt", "x");
    await plainGit(join(folder, "vendor", "lib"), "init", "-q");
    const r = await listFolder(wt, dataDir, folder);
    expect(r.files).toEqual(["a.txt"]);
    expect(r.nested).toEqual(["vendor/lib"]);
  });

  it("refuses the data folder, a folder inside it, and one containing it", async () => {
    mkdirSync(join(dataDir, "projects"), { recursive: true });
    await expect(listFolder(wt, dataDir, dataDir)).rejects.toBeInstanceOf(FolderRefusedError);
    await expect(listFolder(wt, dataDir, join(dataDir, "projects"))).rejects.toBeInstanceOf(FolderRefusedError);
    await expect(listFolder(wt, dataDir, base)).rejects.toBeInstanceOf(FolderRefusedError);
    if (process.platform === "win32") {
      await expect(listFolder(wt, dataDir, dataDir.toUpperCase())).rejects.toBeInstanceOf(FolderRefusedError);
    }
  });

  it("refuses the data folder reached through a symlink", async (ctx) => {
    const link = join(base, "data-link");
    try {
      symlinkSync(dataDir, link, "dir");
    } catch {
      return ctx.skip(); // no symlink privilege (Windows without developer mode)
    }
    await expect(listFolder(wt, dataDir, link)).rejects.toBeInstanceOf(FolderRefusedError);
  });

  it("refuses a relative path", async () => {
    await expect(listFolder(wt, dataDir, relative(process.cwd(), folder))).rejects.toBeInstanceOf(FolderRefusedError);
    await expect(listFolder(wt, dataDir, "mine")).rejects.toBeInstanceOf(FolderRefusedError);
  });

  it("gives FolderUnavailableError for a missing path or a file", async () => {
    await expect(listFolder(wt, dataDir, join(base, "gone"))).rejects.toBeInstanceOf(FolderUnavailableError);
    write("f.txt", "x");
    await expect(listFolder(wt, dataDir, join(folder, "f.txt"))).rejects.toBeInstanceOf(FolderUnavailableError);
  });
});

describe("stageFolder", () => {
  it("stages regular files and skips a symlink to a file outside as link", async (ctx) => {
    write("a.txt", "a");
    write("bin/data.bin", Buffer.from([0, 1, 2, 0, 255]));
    writeFileSync(join(outside, "secret.txt"), "outside the folder");
    try {
      symlinkSync(join(outside, "secret.txt"), join(folder, "link.txt"), "file");
    } catch {
      return ctx.skip(); // no symlink privilege (Windows without developer mode)
    }
    const { files } = await listFolder(wt, dataDir, folder);
    expect(files.sort()).toEqual(["a.txt", "bin/data.bin", "link.txt"].sort());

    const stagingDir = join(dataDir, "staging", "s1");
    const staging = new ImportStaging(stagingDir, { includeSecrets: false, redact: (s) => s });
    await stageFolder(staging, folder, files);
    const r = staging.finish();
    expect(r.files.sort()).toEqual(["a.txt", "bin/data.bin"].sort());
    expect(r.skipped).toEqual([{ path: "link.txt", reason: "link" }]);
    expect(existsSync(join(stagingDir, "link.txt"))).toBe(false);
    expect(readFileSync(join(stagingDir, "bin", "data.bin"))).toEqual(Buffer.from([0, 1, 2, 0, 255]));
  });

  it("skips a file under a symlinked directory as link", async (ctx) => {
    mkdirSync(join(outside, "dir"));
    writeFileSync(join(outside, "dir", "x.txt"), "outside");
    try {
      symlinkSync(join(outside, "dir"), join(folder, "d"), "dir");
    } catch {
      return ctx.skip();
    }
    const staging = new ImportStaging(join(dataDir, "staging", "s2"), { includeSecrets: false, redact: (s) => s });
    await stageFolder(staging, folder, ["d/x.txt"]);
    expect(staging.finish().skipped).toEqual([{ path: "d/x.txt", reason: "link" }]);
  });

  it.skipIf(process.platform === "win32")("skips a file whose folder was swapped for a link between the check and the open", async () => {
    write("d/x.txt", "mine");
    mkdirSync(join(outside, "dir"));
    writeFileSync(join(outside, "dir", "x.txt"), "outside");
    const stagingDir = join(dataDir, "staging", "swap");
    const staging = new ImportStaging(stagingDir, { includeSecrets: false, redact: (t) => t });
    const swapping: typeof open = async (path, flags) => {
      renameSync(join(folder, "d"), join(folder, "d-moved"));
      symlinkSync(join(outside, "dir"), join(folder, "d"), "dir");
      return open(path, flags);
    };
    await stageFolder(staging, folder, ["d/x.txt"], swapping);
    const r = staging.finish();
    expect(r.files).toEqual([]);
    expect(r.skipped).toEqual([{ path: "d/x.txt", reason: "link" }]);
    expect(existsSync(join(stagingDir, "d", "x.txt"))).toBe(false);
  });
});

describe("sameIdentity", () => {
  it("is true only for the same device and inode", () => {
    write("a.txt", "a");
    write("b.txt", "b");
    const a = lstatSync(join(folder, "a.txt"), { bigint: true });
    const b = lstatSync(join(folder, "b.txt"), { bigint: true });
    expect(sameIdentity(a, lstatSync(join(folder, "a.txt"), { bigint: true }))).toBe(true);
    expect(sameIdentity(a, b)).toBe(false);
    expect(sameIdentity({ dev: 1n, ino: 2n }, { dev: 1n, ino: 2n })).toBe(true);
    expect(sameIdentity({ dev: 1n, ino: 2n }, { dev: 3n, ino: 2n })).toBe(false);
    expect(sameIdentity({ dev: 1n, ino: 2n }, { dev: 1n, ino: 3n })).toBe(false);
  });
});
