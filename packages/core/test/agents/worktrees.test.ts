import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, realpathSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EMPTY_GITCONFIG, WorktreeManager, gitEnv } from "../../src/agents/worktrees.js";

const run = promisify(execFile);
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_/i.test(k)));
const git = async (cwd: string, ...args: string[]) =>
  (await run("git", args, { cwd, env: cleanEnv() })).stdout.trim();

let dataDir: string;
let outside: string;
let mgr: WorktreeManager;

beforeEach(() => {
  dataDir = realpathSync(mkdtempSync(join(tmpdir(), "wt-data-")));
  outside = realpathSync(mkdtempSync(join(tmpdir(), "wt-out-")));
  mgr = new WorktreeManager(dataDir);
});
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("WorktreeManager", () => {
  it("ensureProjectRepo is idempotent", async () => {
    const a = await mgr.ensureProjectRepo("proj1");
    const head = await git(a, "rev-parse", "HEAD");
    const b = await mgr.ensureProjectRepo("proj1");
    expect(b).toBe(a);
    expect(await git(b, "rev-parse", "HEAD")).toBe(head);
    expect(await git(b, "rev-list", "--count", "HEAD")).toBe("1");
  });

  it("serializes concurrent ensureProjectRepo/createRunWorktree for one project", async () => {
    const [a, b] = await Promise.all([
      mgr.createRunWorktree("proj1", "run-a"),
      mgr.createRunWorktree("proj1", "run-b"),
    ]);
    expect(a.absPath).not.toBe(b.absPath);
  });

  it("initial commit uses the fixed local identity", async () => {
    const repo = await mgr.ensureProjectRepo("proj1");
    expect(await git(repo, "log", "-1", "--format=%ae")).toBe("agent@theterminal.localhost");
    expect(await git(repo, "log", "-1", "--format=%an")).toBe("The Terminal");
  });

  it("ignores identity and hooks from the environment and global config", async (ctx) => {
    if (process.platform === "win32") return ctx.skip();
    const home = realpathSync(mkdtempSync(join(tmpdir(), "wt-home-")));
    const hooks = join(home, "hooks");
    mkdirSync(hooks);
    const marker = join(home, "hook-ran");
    writeFileSync(join(hooks, "pre-commit"), `#!/bin/sh\ntouch "${marker}"\n`);
    chmodSync(join(hooks, "pre-commit"), 0o755);
    writeFileSync(join(home, ".gitconfig"), `[core]\n\thooksPath = ${hooks}\n`);
    const keys = ["HOME", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "GIT_DIR"];
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    try {
      process.env.HOME = home;
      process.env.GIT_AUTHOR_NAME = "Someone";
      process.env.GIT_AUTHOR_EMAIL = "someone@example.com";
      process.env.GIT_COMMITTER_NAME = "Someone";
      process.env.GIT_COMMITTER_EMAIL = "someone@example.com";
      process.env.GIT_DIR = join(home, "nowhere");
      const repo = await mgr.ensureProjectRepo("proj1");
      expect(await git(repo, "log", "-1", "--format=%an|%ae|%cn|%ce")).toBe(
        "The Terminal|agent@theterminal.localhost|The Terminal|agent@theterminal.localhost",
      );
      expect(existsSync(marker)).toBe(false);
    } finally {
      for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("points GIT_CONFIG_GLOBAL at an empty file inside dataDir, never the null device", async () => {
    const cfg = join(dataDir, EMPTY_GITCONFIG);
    const env = gitEnv(dataDir, cfg);
    expect(env.GIT_CONFIG_GLOBAL).toBe(cfg);
    expect(env.GIT_CONFIG_GLOBAL).not.toBe(devNull);
    expect(env.GIT_CONFIG_NOSYSTEM).toBe("1");
    writeFileSync(cfg, "[user]\n\temail = someone@example.com\n"); // tampered: emptied again
    await mgr.ensureProjectRepo("proj1");
    expect(readFileSync(cfg, "utf8")).toBe("");
  });

  it("a plain git commit in a worktree uses the neutral identity, not the user's global one", async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "wt-home-")));
    try {
      writeFileSync(
        join(home, ".gitconfig"),
        "[user]\n\tname = Someone\n\temail = someone@example.com\n[commit]\n\tgpgsign = true\n",
      );
      const { absPath } = await mgr.createRunWorktree("proj1", "run-a");
      const env = { ...cleanEnv(), HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config") };
      await run("git", ["commit", "--allow-empty", "-m", "agent work"], { cwd: absPath, env });
      const { stdout } = await run("git", ["log", "-1", "--format=%an|%ae|%cn|%ce"], { cwd: absPath, env });
      expect(stdout.trim()).toBe("The Terminal|agent@theterminal.localhost|The Terminal|agent@theterminal.localhost");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("recovers a repo whose initial commit never happened", async () => {
    const repo = join(dataDir, "projects", "proj1", "repo");
    mkdirSync(repo, { recursive: true });
    await git(repo, "init");
    await mgr.ensureProjectRepo("proj1");
    expect(await git(repo, "rev-list", "--count", "HEAD")).toBe("1");
    const wt = await mgr.createRunWorktree("proj1", "run-a");
    expect(await git(wt.absPath, "rev-parse", "--abbrev-ref", "HEAD")).toBe("run/run-a");
  });

  it("recovers an empty repo/.git directory", async () => {
    mkdirSync(join(dataDir, "projects", "proj1", "repo", ".git"), { recursive: true });
    await mgr.ensureProjectRepo("proj1");
    const wt = await mgr.createRunWorktree("proj1", "run-a");
    expect(await git(wt.absPath, "rev-parse", "--abbrev-ref", "HEAD")).toBe("run/run-a");
  });

  it("never touches an outer repository when repo/.git is empty", async () => {
    const outer = realpathSync(mkdtempSync(join(tmpdir(), "wt-outer-")));
    try {
      await git(outer, "init");
      await git(outer, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--allow-empty", "-m", "outer");
      const nested = join(outer, "data");
      mkdirSync(join(nested, "projects", "proj1", "repo", ".git"), { recursive: true });
      const branches = await git(outer, "branch");
      const trees = await git(outer, "worktree", "list");
      const m = new WorktreeManager(nested);
      await m.ensureProjectRepo("proj1");
      const wt = await m.createRunWorktree("proj1", "run-a");
      expect(await git(wt.absPath, "rev-parse", "--abbrev-ref", "HEAD")).toBe("run/run-a");
      expect(await git(outer, "branch")).toBe(branches);
      expect(await git(outer, "worktree", "list")).toBe(trees);
    } finally {
      rmSync(outer, { recursive: true, force: true });
    }
  });

  it("gives two runs separate worktrees on separate branches", async () => {
    const a = await mgr.createRunWorktree("proj1", "run-a");
    const b = await mgr.createRunWorktree("proj1", "run-b");
    expect(a.absPath).not.toBe(b.absPath);
    expect(await git(a.absPath, "rev-parse", "--abbrev-ref", "HEAD")).toBe("run/run-a");
    expect(await git(b.absPath, "rev-parse", "--abbrev-ref", "HEAD")).toBe("run/run-b");
  });

  it("relPath is relative to dataDir with / separators and no drive or leading slash", async () => {
    const { relPath } = await mgr.createRunWorktree("proj1", "run-a");
    expect(relPath).toBe("projects/proj1/worktrees/run-a");
    expect(relPath).not.toMatch(/^([A-Za-z]:|\/)/);
    expect(relPath).not.toContain("\\");
  });

  it("rejects ids that could traverse paths", async () => {
    await expect(mgr.ensureProjectRepo("../evil")).rejects.toThrow();
    await expect(mgr.createRunWorktree("proj1", "a/b")).rejects.toThrow();
    await expect(mgr.createRunWorktree("proj1", "")).rejects.toThrow();
  });

  describe("resolveInside", () => {
    let wt: string;
    beforeEach(async () => {
      wt = (await mgr.createRunWorktree("proj1", "run-a")).absPath;
      mkdirSync(join(wt, "src"));
      writeFileSync(join(wt, "src", "a.ts"), "x");
    });

    it("accepts existing and not-yet-existing files inside", () => {
      expect(mgr.resolveInside(wt, "src/a.ts")).toBe(join(realpathSync(wt), "src", "a.ts"));
      expect(mgr.resolveInside(wt, "src/new/deep/b.ts")).toBe(join(realpathSync(wt), "src", "new", "deep", "b.ts"));
      expect(mgr.resolveInside(wt, join(wt, "src", "a.ts"))).toBe(join(realpathSync(wt), "src", "a.ts"));
      expect(mgr.resolveInside(wt, ".")).toBe(realpathSync(wt));
    });

    it("rejects parent traversal", () => {
      expect(mgr.resolveInside(wt, "../x")).toBeNull();
      expect(mgr.resolveInside(wt, "src/../../x")).toBeNull();
      expect(mgr.resolveInside(wt, "nope/../../x")).toBeNull();
    });

    it("rejects any .. segment, even if it would stay inside", () => {
      expect(mgr.resolveInside(wt, "a/../b")).toBeNull();
      expect(mgr.resolveInside(wt, "a\\..\\b")).toBeNull();
      expect(mgr.resolveInside(wt, "sub/../.git")).toBeNull();
    });

    it("never treats .git as inside", () => {
      expect(mgr.resolveInside(wt, ".git")).toBeNull();
      expect(mgr.resolveInside(wt, "./.git")).toBeNull();
      expect(mgr.resolveInside(wt, ".GIT/config")).toBeNull();
      expect(mgr.resolveInside(wt, join(wt, ".git"))).toBeNull();
      expect(mgr.resolveInside(wt, ".gitignore")).not.toBeNull();
    });

    it("rejects absolute paths elsewhere and NUL bytes", () => {
      expect(mgr.resolveInside(wt, join(outside, "f"))).toBeNull();
      expect(mgr.resolveInside(wt, "src/a.ts\0.png")).toBeNull();
    });

    it("rejects a sibling directory sharing a name prefix", () => {
      expect(mgr.resolveInside(wt, wt + "-evil/f")).toBeNull();
    });

    it("rejects symlinks pointing outside", (ctx) => {
      try {
        symlinkSync(outside, join(wt, "link"), "dir");
        writeFileSync(join(outside, "secret"), "s");
        symlinkSync(join(outside, "secret"), join(wt, "flink"), "file");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EPERM") return ctx.skip();
        throw e;
      }
      expect(mgr.resolveInside(wt, "link")).toBeNull();
      expect(mgr.resolveInside(wt, "link/secret")).toBeNull();
      expect(mgr.resolveInside(wt, "link/newfile")).toBeNull();
      expect(mgr.resolveInside(wt, "flink")).toBeNull();
    });

    it("rejects dangling symlinks, link loops and dir links combined with ..", (ctx) => {
      try {
        symlinkSync(join(outside, "planted"), join(wt, "dangling"), "file");
        symlinkSync(join(wt, "loopb"), join(wt, "loopa"), "file");
        symlinkSync(join(wt, "loopa"), join(wt, "loopb"), "file");
        symlinkSync(outside, join(wt, "dlink"), "dir");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EPERM") return ctx.skip();
        throw e;
      }
      expect(mgr.resolveInside(wt, "dangling")).toBeNull();
      expect(mgr.resolveInside(wt, "loopa")).toBeNull();
      expect(mgr.resolveInside(wt, "loopa/x")).toBeNull();
      expect(mgr.resolveInside(wt, "dlink/../x")).toBeNull();
    });
  });
});
