import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitOutputTooLargeError, GitTimeoutError, WorktreeManager } from "../../src/agents/worktrees.js";
import { ConflictError } from "../../src/connections/service.js";
import {
  BundleGitLimitError, BundleInvalidError, MAX_BUNDLE_BYTES, exportRepoBundle, importRepoBundle, importSnapshot, snapshotBundle,
} from "../../src/link/bundles.js";

const run = promisify(execFile);
// Git on Windows CI is slow: every runGit call makes several hardening calls first.
const T = 120_000;

let scratch: string;
let emptyConfig: string;
let dataA: string;
let dataB: string;
let a: WorktreeManager;
let b: WorktreeManager;

/** Plain git for setting up and inspecting fixtures: no inherited GIT_*, an empty global config, no system config. */
const git = async (cwd: string, ...args: string[]): Promise<string> => {
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_/i.test(k)));
  Object.assign(env, {
    GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  });
  return (await run("git", args, { cwd, env, windowsHide: true })).stdout.trim();
};

const refsOf = async (repo: string): Promise<string> => git(repo, "for-each-ref", "--format=%(refname) %(objectname)");

/** Project p1 on machine A with two commits on a branch named `trunk`. */
async function sourceRepo(): Promise<string> {
  const repo = await a.ensureProjectRepo("p1");
  await git(repo, "branch", "-m", "trunk");
  writeFileSync(join(repo, "README.md"), "hello\n");
  await git(repo, "add", "README.md");
  await git(repo, "commit", "-q", "-m", "second");
  return repo;
}

beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "bundles-")));
  emptyConfig = join(scratch, "empty-gitconfig");
  writeFileSync(emptyConfig, "");
  dataA = realpathSync(mkdtempSync(join(tmpdir(), "bundles-a-")));
  dataB = realpathSync(mkdtempSync(join(tmpdir(), "bundles-b-")));
  a = new WorktreeManager(dataA);
  b = new WorktreeManager(dataB);
});
afterEach(() => {
  for (const d of [scratch, dataA, dataB]) rmSync(d, { recursive: true, force: true });
});

describe("repository bundles", () => {
  it("export then import reproduces HEAD and the checked-out branch, and deletes the bundle", { timeout: T }, async () => {
    const src = await sourceRepo();
    const file = join(scratch, "repo.bundle");
    await exportRepoBundle(a, "p1", file);
    expect(existsSync(file)).toBe(true);
    await importRepoBundle(b, "p1", file);
    const dst = b.repoPath("p1");
    expect(await git(dst, "rev-parse", "HEAD")).toBe(await git(src, "rev-parse", "HEAD"));
    expect(await git(dst, "symbolic-ref", "--short", "HEAD")).toBe("trunk");
    expect(readFileSync(join(dst, "README.md"), "utf8")).toBe("hello\n");
    expect(await git(dst, "status", "--porcelain")).toBe("");
    expect(existsSync(file)).toBe(false);
  });

  it("imports again over an existing repository whose branch is checked out", { timeout: T }, async () => {
    const src = await sourceRepo();
    const first = join(scratch, "first.bundle");
    await exportRepoBundle(a, "p1", first);
    await importRepoBundle(b, "p1", first);
    writeFileSync(join(src, "README.md"), "hello again\n");
    await git(src, "commit", "-q", "-am", "third");
    const second = join(scratch, "second.bundle");
    await exportRepoBundle(a, "p1", second);
    await importRepoBundle(b, "p1", second);
    const dst = b.repoPath("p1");
    expect(await git(dst, "rev-parse", "HEAD")).toBe(await git(src, "rev-parse", "HEAD"));
    expect(await git(dst, "symbolic-ref", "--short", "HEAD")).toBe("trunk");
    expect(readFileSync(join(dst, "README.md"), "utf8")).toBe("hello again\n");
  });

  it("ships only the checked-out branch: no run branches, snapshot refs or tags, and nothing of the data folder", { timeout: T }, async () => {
    const src = await sourceRepo();
    writeFileSync(join(dataA, "token"), "TESTKEY-token\n");
    writeFileSync(join(dataA, "ledger.db"), "TESTKEY-ledger\n");
    await a.createRunWorktree("p1", "run-old");
    await git(src, "update-ref", "refs/theterminal/snapshot/run-old", "HEAD");
    await git(src, "tag", "v1");
    const file = join(scratch, "repo.bundle");
    await exportRepoBundle(a, "p1", file);
    const heads = (await git(src, "bundle", "list-heads", file)).split("\n").map((l) => l.split(" ")[1]);
    expect(heads.sort()).toEqual(["HEAD", "refs/heads/trunk"]);
    const clone = join(scratch, "clone");
    await git(scratch, "clone", "-q", file, clone);
    const files = (await git(clone, "log", "--all", "--name-only", "--format=")).split("\n").filter(Boolean);
    expect(files).not.toContain("token");
    expect(files).not.toContain("ledger.db");
    expect(readdirSync(clone).sort()).toEqual([".git", "README.md"]);
  });

  it("refuses a file that is not a bundle, leaves the repository untouched and deletes the file", { timeout: T }, async () => {
    const dst = await b.ensureProjectRepo("p1");
    const before = await refsOf(dst);
    const file = join(scratch, "bad.bundle");
    writeFileSync(file, "not a bundle");
    await expect(importRepoBundle(b, "p1", file)).rejects.toBeInstanceOf(BundleInvalidError);
    expect(await refsOf(dst)).toBe(before);
    expect(existsSync(file)).toBe(false);
  });

  it("refuses a bundle over the size limit without running git on it", { timeout: T }, async () => {
    const dst = await b.ensureProjectRepo("p1");
    const before = await refsOf(dst);
    const file = join(scratch, "big.bundle");
    writeFileSync(file, "");
    truncateSync(file, MAX_BUNDLE_BYTES + 1); // sparse: no real 256 MiB written
    await expect(importRepoBundle(b, "p1", file)).rejects.toBeInstanceOf(BundleInvalidError);
    expect(await refsOf(dst)).toBe(before);
    expect(existsSync(file)).toBe(false);
  });

  it("refuses a bundle with refs outside the project's branches, or with no branch for HEAD", { timeout: T }, async () => {
    const other = join(scratch, "other");
    await git(scratch, "init", "-q", "-b", "main", other);
    writeFileSync(join(other, "f"), "x\n");
    await git(other, "add", "f");
    await git(other, "commit", "-q", "-m", "one");
    await git(other, "branch", "run/x");
    await git(other, "tag", "t");
    await git(other, "update-ref", "refs/theterminal/snapshot/x", "HEAD");
    const dst = await b.ensureProjectRepo("p1");
    const before = await refsOf(dst);
    const cases: string[][] = [
      ["HEAD", "refs/heads/main", "refs/tags/t"],
      ["HEAD", "refs/heads/main", "refs/heads/run/x"],
      ["HEAD", "refs/heads/main", "refs/theterminal/snapshot/x"],
      ["refs/heads/main"], // no HEAD
      ["HEAD"], // no branch
    ];
    for (const [i, revs] of cases.entries()) {
      const file = join(scratch, `case-${i}.bundle`);
      await git(other, "bundle", "create", "-q", file, ...revs);
      await expect(importRepoBundle(b, "p1", file), revs.join(" ")).rejects.toBeInstanceOf(BundleInvalidError);
      expect(existsSync(file)).toBe(false);
    }
    // A branch literally named HEAD, beside HEAD itself (added last: it makes `HEAD` ambiguous for the cases above).
    await git(other, "update-ref", "refs/heads/HEAD", "refs/heads/main");
    const file = join(scratch, "head-branch.bundle");
    await git(other, "bundle", "create", "-q", file, "refs/heads/HEAD");
    // git will not write HEAD beside it (the name is ambiguous), so the header gets a HEAD line at the same commit.
    const raw = readFileSync(file);
    const end = raw.indexOf("\n\n");
    const id = raw.subarray(0, end).toString("latin1").split("\n")[1]!.split(" ")[0]!;
    writeFileSync(file, Buffer.concat([raw.subarray(0, end), Buffer.from(`\n${id} HEAD`), raw.subarray(end)]));
    const heads = (await git(other, "bundle", "list-heads", file)).split("\n").map((l) => l.split(" ")[1]).sort();
    expect(heads).toEqual(["HEAD", "refs/heads/HEAD"]);
    await expect(importRepoBundle(b, "p1", file)).rejects.toBeInstanceOf(BundleInvalidError);
    expect(await refsOf(dst)).toBe(before);
  });

  it("reports git running past its time or output limit as BundleGitLimitError, not as an invalid bundle", { timeout: T }, async () => {
    await sourceRepo();
    for (const limit of [() => new GitTimeoutError(), () => new GitOutputTooLargeError()]) {
      const file = join(scratch, "repo.bundle");
      await exportRepoBundle(a, "p1", file);
      // The same manager, with `git bundle verify` running past a limit.
      const slow = Object.create(b) as WorktreeManager;
      slow.runGit = (cwd, args, opts) => (args[0] === "bundle" ? Promise.reject(limit()) : b.runGit(cwd, args, opts));
      const err = await importRepoBundle(slow, "p1", file).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BundleGitLimitError);
      expect(err).not.toBeInstanceOf(BundleInvalidError);
      expect(existsSync(file)).toBe(false);
    }
  });

  it("runs no hook of the importing repository", { timeout: T }, async (ctx) => {
    if (process.platform === "win32") return ctx.skip();
    await sourceRepo();
    const dst = await b.ensureProjectRepo("p1");
    const marker = join(scratch, "hook-ran");
    for (const hook of ["reference-transaction", "post-checkout", "post-merge"]) {
      const p = join(dst, ".git", "hooks", hook);
      writeFileSync(p, `#!/bin/sh\necho ran > "${marker}"\n`);
      chmodSync(p, 0o755);
    }
    const file = join(scratch, "repo.bundle");
    await exportRepoBundle(a, "p1", file);
    await importRepoBundle(b, "p1", file);
    expect(existsSync(marker)).toBe(false);
  });
});

describe("run snapshots", () => {
  /** Machine B imports A's project and runs `run-1` there, changing one tracked file and adding one untracked file. */
  async function workerRun(): Promise<string> {
    await sourceRepo();
    const file = join(scratch, "repo.bundle");
    await exportRepoBundle(a, "p1", file);
    await importRepoBundle(b, "p1", file);
    const { absPath } = await b.createRunWorktree("p1", "run-1");
    writeFileSync(join(absPath, "README.md"), "changed by the agent\n");
    writeFileSync(join(absPath, "new.txt"), "a new file\n");
    return absPath;
  }

  it("snapshots the worktree into a bundle that importSnapshot turns into the run's worktree", { timeout: T }, async () => {
    const wt = await workerRun();
    const out = join(scratch, "snap.bundle");
    const commit = await snapshotBundle(b, wt, "run-1", out);
    expect(commit).toMatch(/^[0-9a-f]{40,64}$/);
    // The temporary index lived under the data folder, outside the worktree, and is gone.
    const tmp = join(dataB, "link", "tmp");
    expect(existsSync(tmp) ? readdirSync(tmp) : []).toEqual([]);
    expect(readdirSync(wt).sort()).toEqual([".git", "README.md", "new.txt"]);
    expect((await git(wt, "ls-tree", "-r", "--name-only", commit)).split("\n").sort()).toEqual(["README.md", "new.txt"]);
    expect(await git(wt, "log", "-1", "--format=%an <%ae>|%cn <%ce>", commit)).toBe(
      "The Terminal <theterminal@localhost>|The Terminal <theterminal@localhost>",
    );
    expect(await git(wt, "log", "-1", "--format=%s", commit)).toBe("The Terminal snapshot of run run-1");
    expect(await git(wt, "rev-parse", `${commit}^`)).toBe(await git(wt, "rev-parse", "HEAD"));
    // The agent's own index was not touched: the changes are still unstaged there.
    expect(await git(wt, "diff", "--cached", "--name-only")).toBe("");
    expect(await git(wt, "diff", "--name-only")).toBe("README.md");
    expect(await git(wt, "ls-files", "--others", "--exclude-standard")).toBe("new.txt");

    const res = await importSnapshot(a, "p1", "run-1", out);
    expect(res.commit).toBe(commit);
    expect(res.absPath).toBe(join(dataA, "projects", "p1", "worktrees", "run-1"));
    expect(res.relPath).toBe("projects/p1/worktrees/run-1");
    expect(await git(res.absPath, "status", "--porcelain")).toBe("");
    expect(await git(res.absPath, "symbolic-ref", "--short", "HEAD")).toBe("run/run-1");
    expect(readFileSync(join(res.absPath, "README.md"), "utf8")).toBe("changed by the agent\n");
    expect(readFileSync(join(res.absPath, "new.txt"), "utf8")).toBe("a new file\n");
    expect(await git(res.absPath, "log", "-1", "--format=%an")).toBe("The Terminal");
    expect(existsSync(out)).toBe(false);
  });

  it("keeps a tracked file that .gitignore matches in the snapshot", { timeout: T }, async () => {
    const src = await sourceRepo();
    writeFileSync(join(src, "kept.log"), "tracked\n");
    await git(src, "add", "kept.log");
    await git(src, "commit", "-q", "-m", "log");
    const file = join(scratch, "repo.bundle");
    await exportRepoBundle(a, "p1", file);
    await importRepoBundle(b, "p1", file);
    const { absPath } = await b.createRunWorktree("p1", "run-2");
    writeFileSync(join(absPath, ".gitignore"), "*.log\n");
    const commit = await snapshotBundle(b, absPath, "run-2", join(scratch, "snap.bundle"));
    expect((await git(absPath, "ls-tree", "-r", "--name-only", commit)).split("\n").sort()).toEqual([".gitignore", "README.md", "kept.log"]);
  });

  it("refuses a directory that is not a run worktree of a project", { timeout: T }, async () => {
    const other = join(scratch, "other");
    await git(scratch, "init", "-q", "-b", "main", other);
    await git(other, "commit", "-q", "--allow-empty", "-m", "one");
    await expect(snapshotBundle(b, other, "run-1", join(scratch, "x.bundle"))).rejects.toThrow();
    expect(existsSync(join(scratch, "x.bundle"))).toBe(false);
  });

  it("refuses a run id that is not an id", { timeout: T }, async () => {
    const wt = await workerRun();
    await expect(snapshotBundle(b, wt, "../x", join(scratch, "x.bundle"))).rejects.toThrow();
    const file = join(scratch, "y.bundle");
    writeFileSync(file, "");
    await expect(importSnapshot(a, "p1", "../x", file)).rejects.toThrow();
  });

  it("importSnapshot refuses a run branch at another commit with ConflictError, before the snapshot ref is touched", { timeout: T }, async () => {
    const wt = await workerRun();
    const out = join(scratch, "snap.bundle");
    await snapshotBundle(b, wt, "run-1", out);
    const repo = await a.ensureProjectRepo("p1");
    await git(repo, "branch", "run/run-1", "HEAD");
    await expect(importSnapshot(a, "p1", "run-1", out)).rejects.toBeInstanceOf(ConflictError);
    expect(await git(repo, "for-each-ref", "refs/theterminal/")).toBe("");
    expect(existsSync(join(dataA, "projects", "p1", "worktrees", "run-1"))).toBe(false);
    expect(existsSync(out)).toBe(false);
  });

  it("importSnapshot refuses a run whose worktree folder already exists with ConflictError", { timeout: T }, async () => {
    const wt = await workerRun();
    const out = join(scratch, "snap.bundle");
    await snapshotBundle(b, wt, "run-1", out);
    const repo = await a.ensureProjectRepo("p1");
    mkdirSync(join(dataA, "projects", "p1", "worktrees", "run-1"), { recursive: true });
    await expect(importSnapshot(a, "p1", "run-1", out)).rejects.toBeInstanceOf(ConflictError);
    expect(await git(repo, "branch", "--list", "run/*")).toBe("");
    expect(await git(repo, "for-each-ref", "refs/theterminal/")).toBe("");
  });

  it("importSnapshot refuses a bundle that is not that run's snapshot", { timeout: T }, async () => {
    const wt = await workerRun();
    const out = join(scratch, "snap.bundle");
    await snapshotBundle(b, wt, "run-1", out);
    await expect(importSnapshot(a, "p1", "run-other", out)).rejects.toBeInstanceOf(BundleInvalidError);
    expect(existsSync(out)).toBe(false);
    const repoBundle = join(scratch, "repo.bundle");
    await exportRepoBundle(a, "p1", repoBundle);
    await expect(importSnapshot(a, "p1", "run-1", repoBundle)).rejects.toBeInstanceOf(BundleInvalidError);
    expect(existsSync(join(dataA, "projects", "p1", "worktrees", "run-1"))).toBe(false);
    expect(await git(a.repoPath("p1"), "for-each-ref", "refs/theterminal/")).toBe("");
  });
});
