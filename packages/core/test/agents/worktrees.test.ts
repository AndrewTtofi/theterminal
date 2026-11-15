import { execFile } from "node:child_process";
import {
  appendFileSync, chmodSync, closeSync, existsSync, linkSync, statSync, mkdtempSync, mkdirSync, openSync, readFileSync, rmSync, symlinkSync,
  utimesSync, writeFileSync, writeSync, realpathSync,
} from "node:fs";
import { devNull, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildChildEnv } from "../../src/agents/child-env.js";
import { plainGit, plantSubmoduleTrap } from "../fixtures/submodule-trap.js";
import {
  EMPTY_GITCONFIG, GIT_COMMON_ARGS, GIT_INCLUDES_REFUSED, GitOutputTooLargeError, GitScope, GitTimeoutError,
  SharedGitconfigModifiedError, UnsafeGitConfigError,
  WorktreeManager,
  ensureEmptyGitconfig, gitEnv,
  type GitRunner,
} from "../../src/agents/worktrees.js";

const run = promisify(execFile);
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_/i.test(k)));
const git = async (cwd: string, ...args: string[]) =>
  (await run("git", args, { cwd, env: cleanEnv() })).stdout.trim();

let dataDir: string;
let outside: string;
let mgr: WorktreeManager;

// Every runGit call is five or six git processes (its hardening checks, then the call) and a repository or worktree
// is set up with eight or nine of them: seconds on Windows CI, where a process start is slow and the suite shares two
// cores; the default 5 s cut these tests off mid-git.
const GIT_TEST_TIMEOUT_MS = process.platform === "win32" ? 40_000 : 15_000;
vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT_MS, hookTimeout: GIT_TEST_TIMEOUT_MS });

beforeEach(() => {
  dataDir = realpathSync(mkdtempSync(join(tmpdir(), "wt-data-")));
  outside = realpathSync(mkdtempSync(join(tmpdir(), "wt-out-")));
  mgr = new WorktreeManager(dataDir);
});
afterEach(() => {
  // Retried: on Windows a git process that was just killed can still hold its working directory (EBUSY).
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  rmSync(outside, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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
    chmodSync(cfg, 0o644);
    writeFileSync(cfg, "[user]\n\temail = someone@example.com\n"); // tampered: never silently emptied, git is not run
    await expect(mgr.ensureProjectRepo("proj1")).rejects.toThrow(SharedGitconfigModifiedError);
    expect(existsSync(join(dataDir, "projects", "proj1", "repo", ".git"))).toBe(false);
  });

  it("creates the shared git config empty and read-only on construction", () => {
    const cfg = join(dataDir, EMPTY_GITCONFIG);
    expect(readFileSync(cfg, "utf8")).toBe("");
    if (process.platform !== "win32") expect(statSync(cfg).mode & 0o777).toBe(0o444);
    expect(ensureEmptyGitconfig(dataDir)).toBe(cfg); // idempotent on a read-only file
  });

  it("repair empties a modified shared git config and makes it read-only again", () => {
    const cfg = join(dataDir, EMPTY_GITCONFIG);
    chmodSync(cfg, 0o644);
    writeFileSync(cfg, "[user]\n\tname = x\n");
    ensureEmptyGitconfig(dataDir); // without repair, never rewritten
    expect(readFileSync(cfg, "utf8")).not.toBe("");
    expect(ensureEmptyGitconfig(dataDir, { repair: true })).toBe(cfg);
    expect(readFileSync(cfg, "utf8")).toBe("");
    if (process.platform !== "win32") expect(statSync(cfg).mode & 0o777).toBe(0o444);
  });

  it.skipIf(process.platform === "win32")("refuses a symlink in place of the shared git config, never chmod-ing through it", () => {
    const cfg = join(dataDir, EMPTY_GITCONFIG);
    rmSync(cfg);
    const target = join(outside, "target");
    writeFileSync(target, "");
    chmodSync(target, 0o644);
    symlinkSync(target, cfg);
    expect(() => ensureEmptyGitconfig(dataDir)).toThrow(SharedGitconfigModifiedError);
    expect(() => ensureEmptyGitconfig(dataDir, { repair: true })).toThrow(SharedGitconfigModifiedError);
    expect(statSync(target).mode & 0o777).toBe(0o644);
    expect(() => new WorktreeManager(dataDir)).not.toThrow(); // the per-run check fails the run instead
  });

  it("refuses a shared git config with another hard link, never writing or chmod-ing the linked file", () => {
    const cfg = join(dataDir, EMPTY_GITCONFIG);
    rmSync(cfg);
    const other = join(outside, "other-config");
    writeFileSync(other, "[user]\n\tname = x\n");
    chmodSync(other, 0o644);
    linkSync(other, cfg);
    for (const opts of [{}, { repair: true }]) {
      expect(() => ensureEmptyGitconfig(dataDir, opts)).toThrow(expect.objectContaining({ name: "SharedGitconfigModifiedError", reason: "linked" }));
    }
    expect(readFileSync(other, "utf8")).toBe("[user]\n\tname = x\n");
    if (process.platform !== "win32") expect(statSync(other).mode & 0o777).toBe(0o644);
  });

  it.skipIf(process.platform === "win32")("tells a symlink apart from a shared git config that cannot be checked", () => {
    const cfg = join(dataDir, EMPTY_GITCONFIG);
    rmSync(cfg);
    symlinkSync(join(outside, "target"), cfg);
    expect(() => ensureEmptyGitconfig(dataDir)).toThrow(expect.objectContaining({ reason: "not_file" }));
    if (process.getuid?.() === 0) return; // root can search a directory without the permission
    chmodSync(dataDir, 0o600); // no search permission: lstat fails with EACCES
    try {
      expect(() => ensureEmptyGitconfig(dataDir)).toThrow(expect.objectContaining({ reason: "unchecked" }));
    } finally {
      chmodSync(dataDir, 0o700);
    }
  });

  it("a shared git config with a byte in it fails buildChildEnv before any CLI starts", () => {
    const cfg = join(dataDir, EMPTY_GITCONFIG);
    expect(() => buildChildEnv("claude", "api_key", { apiKey: "k", dataDir })).not.toThrow();
    chmodSync(cfg, 0o644);
    writeFileSync(cfg, "x");
    expect(() => buildChildEnv("claude", "api_key", { apiKey: "k", dataDir })).toThrow(SharedGitconfigModifiedError);
    expect(() => buildChildEnv("codex", "chatgpt", { dataDir })).toThrow("shared git config was modified");
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
      expect(mgr.resolveInside(wt, "src/a.ts")).toBe(join(realpathSync.native(wt), "src", "a.ts"));
      expect(mgr.resolveInside(wt, "src/new/deep/b.ts")).toBe(join(realpathSync.native(wt), "src", "new", "deep", "b.ts"));
      expect(mgr.resolveInside(wt, join(wt, "src", "a.ts"))).toBe(join(realpathSync.native(wt), "src", "a.ts"));
      expect(mgr.resolveInside(wt, ".")).toBe(realpathSync.native(wt));
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

  describe("runGit and repoPath", () => {
    it("prepends GIT_COMMON_ARGS and an empty hooks directory, with the timeout, buffer and an allowlisted env", async () => {
      const calls: { args: string[]; cwd: string; opts: Parameters<GitRunner>[2] }[] = [];
      const fake: GitRunner = async (args, cwd, opts) => {
        calls.push({ args, cwd, opts });
        return "";
      };
      const m = new WorktreeManager(dataDir, fake);
      process.env.TT_TEST_PLANTED_VAR = "planted-value";
      try {
        await m.runGit(outside, ["status", "--short"]);
      } finally {
        delete process.env.TT_TEST_PLANTED_VAR;
      }
      const last = calls.at(-1)!;
      expect(last.cwd).toBe(outside);
      expect(last.args.slice(0, GIT_COMMON_ARGS.length)).toEqual([...GIT_COMMON_ARGS]);
      expect(last.args.slice(-2)).toEqual(["status", "--short"]);
      expect(last.args).toContain(`core.hooksPath=${join(dataDir, ".theterminal-empty-hooks")}`);
      expect(last.opts).toMatchObject({ timeoutMs: 30000, maxBuffer: 2 * 1024 * 1024 });
      expect(last.opts!.env!.TT_TEST_PLANTED_VAR).toBeUndefined();
      expect(last.opts!.env!.GIT_CONFIG_GLOBAL).toBe(join(dataDir, EMPTY_GITCONFIG));
      expect(last.opts!.env!.GIT_CONFIG_NOSYSTEM).toBe("1");
      expect(last.opts!.env!.GIT_INDEX_FILE).toBeUndefined();
    });

    it("names a scratch index with GIT_INDEX_FILE only when asked, and pins the index features that hide changes off", async () => {
      const calls: { args: string[]; opts: Parameters<GitRunner>[2] }[] = [];
      const fake: GitRunner = async (args, _cwd, opts) => {
        calls.push({ args, opts });
        return "";
      };
      const m = new WorktreeManager(dataDir, fake);
      const indexFile = join(outside, "scratch", "index");
      await m.runGit(outside, ["status"], { indexFile });
      expect(calls.at(-1)!.opts!.env!.GIT_INDEX_FILE).toBe(indexFile);
      const pairs = calls.at(-1)!.args.filter((a, i, all) => all[i - 1] === "-c");
      expect(pairs).toEqual(
        expect.arrayContaining([
          "core.sparseCheckout=false", "index.sparse=false", "core.splitIndex=false", "core.untrackedCache=false", "core.ignoreStat=false",
        ]),
      );
    });

    it("neutralises every filter driver the repository configures", async () => {
      const calls: string[][] = [];
      const fake: GitRunner = async (args) => {
        calls.push(args);
        return args.includes("--get-regexp") ? "filter.lfs.clean\0filter.lfs.smudge\0filter.a.b.process\0" : "";
      };
      const m = new WorktreeManager(dataDir, fake);
      await m.runGit(outside, ["diff"]);
      const last = calls.at(-1)!;
      for (const name of ["lfs", "a.b"]) {
        for (const kv of [`filter.${name}.clean=`, `filter.${name}.smudge=`, `filter.${name}.process=`, `filter.${name}.required=false`]) {
          expect(last).toContain(kv);
        }
      }
    });

    it("the default runner maps a maxBuffer overflow to GitOutputTooLargeError", async () => {
      const repo = await mgr.ensureProjectRepo("proj1");
      await expect(mgr.runGit(repo, ["log"], { maxBuffer: 4 })).rejects.toBeInstanceOf(GitOutputTooLargeError);
      expect((await mgr.runGit(repo, ["rev-parse", "--verify", "HEAD"])).trim()).toMatch(/^[0-9a-f]{40,64}$/);
    });

    it("repoPath is the project repository, and refuses a bad id", () => {
      expect(mgr.repoPath("proj1")).toBe(join(dataDir, "projects", "proj1", "repo"));
      expect(() => mgr.repoPath("../x")).toThrow();
    });

    it.skipIf(process.platform === "win32")("never runs a hook the repository plants", async () => {
      const repo = await mgr.ensureProjectRepo("proj1");
      const marker = join(outside, "hook-ran");
      writeFileSync(join(repo, ".git", "hooks", "pre-commit"), `#!/bin/sh\ntouch "${marker}"\n`);
      chmodSync(join(repo, ".git", "hooks", "pre-commit"), 0o755);
      await mgr.runGit(repo, ["commit", "--allow-empty", "-m", "x"]);
      expect(existsSync(marker)).toBe(false);
    });
  });

  describe("repository setup runs through the same hardening (R2)", () => {
    it("ensureProjectRepo and createRunWorktree call git with the common args, no hooks, no signing, an allowlisted env and bounds", async () => {
      const calls: { args: string[]; opts: Parameters<GitRunner>[2] }[] = [];
      const fake: GitRunner = async (args, cwd, opts) => {
        calls.push({ args, opts });
        const inWorktree = basename(dirname(cwd)) === "worktrees"; // the new worktree, which this fake never creates
        if (args.includes("--absolute-git-dir")) return join(inWorktree ? cwd : realpathSync.native(cwd), ".git");
        if (args.includes("--verify")) {
          if (inWorktree) return `${"a".repeat(40)}\n`; // the new worktree's HEAD: the run's fork commit
          throw new Error("no HEAD yet");
        }
        return "";
      };
      const m = new WorktreeManager(dataDir, fake);
      process.env.TT_TEST_PLANTED_VAR = "planted-value";
      try {
        await m.createRunWorktree("proj1", "run-a");
      } finally {
        delete process.env.TT_TEST_PLANTED_VAR;
      }
      const subcommands = calls.map((c) => c.args.find((a, i) => i > 0 && c.args[i - 1] !== "-c" && !a.startsWith("-")));
      expect(subcommands).toEqual(expect.arrayContaining(["init", "commit", "worktree"]));
      for (const c of calls) {
        expect(c.args.slice(0, GIT_COMMON_ARGS.length)).toEqual([...GIT_COMMON_ARGS]);
        expect(c.args).toContain(`core.hooksPath=${join(dataDir, ".theterminal-empty-hooks")}`);
        expect(c.args).toContain("commit.gpgsign=false");
        // Listing HEAD's tree for .gitattributes files has its own larger, still bounded, buffer.
        const maxBuffer = c.args.includes("ls-tree") ? 32 * 1024 * 1024 : c.args.includes("cat-file") ? 256 * 1024 : 2 * 1024 * 1024;
        expect(c.opts).toMatchObject({ timeoutMs: 30000, maxBuffer });
        expect(c.opts!.env!.TT_TEST_PLANTED_VAR).toBeUndefined();
      }
    });

    it.skipIf(process.platform === "win32")("never runs a planted post-commit, post-checkout hook or smudge filter; plain git does", async () => {
      const evil = (name: string) => {
        const f = join(outside, `${name}.sh`);
        writeFileSync(f, `#!/bin/sh\necho ran >> "${join(outside, `${name}.ran`)}"\ncat\n`);
        chmodSync(f, 0o755);
        return f;
      };
      const ran = (name: string) => existsSync(join(outside, `${name}.ran`));
      const hook = (repo: string, name: string) => {
        writeFileSync(join(repo, ".git", "hooks", name), `#!/bin/sh\necho ran >> "${join(outside, `${name}.ran`)}"\n`);
        chmodSync(join(repo, ".git", "hooks", name), 0o755);
      };

      // A repository planted before the initial commit: its post-commit hook must not run on that commit.
      const repo = join(dataDir, "projects", "proj1", "repo");
      mkdirSync(repo, { recursive: true });
      await git(repo, "init");
      hook(repo, "post-commit");
      await mgr.ensureProjectRepo("proj1");
      expect(ran("post-commit")).toBe(false);

      // A smudge filter and a post-checkout hook in the shared .git must not run when a worktree is checked out.
      writeFileSync(join(repo, ".gitattributes"), "*.txt filter=evil\n");
      writeFileSync(join(repo, "a.txt"), "hello\n");
      await mgr.runGit(repo, ["add", "-A"]);
      await mgr.runGit(repo, ["commit", "-m", "files"]);
      await git(repo, "config", "filter.evil.smudge", evil("smudge"));
      await git(repo, "config", "filter.evil.clean", evil("clean"));
      hook(repo, "post-checkout");
      const wt = await mgr.createRunWorktree("proj1", "run-a");
      expect(readFileSync(join(wt.absPath, "a.txt"), "utf8")).toBe("hello\n");
      expect([ran("post-commit"), ran("post-checkout"), ran("smudge")]).toEqual([false, false, false]);

      // Controls: plain git runs each of them.
      await git(repo, "commit", "--allow-empty", "-m", "control");
      expect(ran("post-commit")).toBe(true);
      await git(repo, "worktree", "add", join(outside, "control-wt"));
      expect(ran("post-checkout")).toBe(true);
      expect(ran("smudge")).toBe(true);
    });
  });

  describe("included configuration and attributes (R2, re-review)", () => {
    const smudge = () => {
      const f = join(outside, "smudge.sh");
      writeFileSync(f, `#!/bin/sh\necho ran >> "${join(outside, "smudge.ran")}"\ncat\n`);
      chmodSync(f, 0o755);
      const cfg = join(outside, "evil.cfg");
      writeFileSync(cfg, `[filter "hid"]\n\tsmudge = ${f}\n\tclean = cat\n`);
      return cfg;
    };
    /** A project repository whose HEAD holds a nested .gitattributes that uses the `hid` filter. */
    const withNestedAttributes = async () => {
      const repo = await mgr.ensureProjectRepo("proj1");
      mkdirSync(join(repo, "sub"));
      writeFileSync(join(repo, "sub", ".gitattributes"), "*.txt filter=hid\n");
      writeFileSync(join(repo, "sub", "a.txt"), "hello\n");
      await mgr.runGit(repo, ["add", "-A"]);
      await mgr.runGit(repo, ["commit", "-m", "nested attributes"]);
      return repo;
    };

    for (const condition of ["gitdir:**/.git/worktrees/**", "onbranch:run/**"]) {
      it.skipIf(process.platform === "win32")(`refuses a conditional include (${condition}) and never runs its filter; plain git does`, async () => {
        const repo = await withNestedAttributes();
        await git(repo, "config", `includeIf.${condition}.path`, smudge());
        await expect(mgr.createRunWorktree("proj1", "run-a")).rejects.toThrow(
          "This repository's git configuration includes other files, which The Terminal does not allow",
        );
        expect(existsSync(join(outside, "smudge.ran"))).toBe(false);
        // Control: plain git applies the included filter on checkout.
        await git(repo, "worktree", "add", "-b", "run/control", join(outside, "control-wt"));
        expect(existsSync(join(outside, "smudge.ran"))).toBe(true);
      });
    }

    it("refuses a plain include.path too, and an include in the worktree's own configuration", async () => {
      const repo = await mgr.ensureProjectRepo("proj1");
      const wt = await mgr.createRunWorktree("proj1", "run-a");
      await git(repo, "config", "extensions.worktreeConfig", "true");
      await git(wt.absPath, "config", "--worktree", "include.path", join(outside, "x.cfg"));
      await expect(mgr.runGit(wt.absPath, ["status"])).rejects.toBeInstanceOf(UnsafeGitConfigError);
      await git(wt.absPath, "config", "--worktree", "--unset", "include.path");
      await mgr.runGit(wt.absPath, ["status"]);
      await git(repo, "config", "include.path", join(outside, "x.cfg"));
      await expect(mgr.runGit(repo, ["status"])).rejects.toBeInstanceOf(UnsafeGitConfigError);
    });

    it("refuses a repository with a non-empty info/attributes", async () => {
      const repo = await mgr.ensureProjectRepo("proj1");
      mkdirSync(join(repo, ".git", "info"), { recursive: true });
      writeFileSync(join(repo, ".git", "info", "attributes"), "* filter=x\n");
      await expect(mgr.runGit(repo, ["status"])).rejects.toBeInstanceOf(UnsafeGitConfigError);
    });

    /** A fake git whose repository (under `outside`) has the given object format, and whose version is `version`. */
    const fakeGit = (version: () => string, format = "sha1") => {
      const calls: string[][] = [];
      const fake: GitRunner = async (args) => {
        calls.push(args);
        if (args.at(-1) === "version") return version();
        if (args.includes("--show-object-format")) return `${join(outside, ".git")}\n${join(outside, ".git")}\n${format}\n`;
        return "";
      };
      return { calls, m: new WorktreeManager(dataDir, fake) };
    };

    it("neutralises attribute files: core.attributesFile, and --attr-source when git supports it", async () => {
      const argsFor = async (version: string) => {
        const { calls, m } = fakeGit(() => version);
        await m.runGit(outside, ["status"]);
        await m.runGit(outside, ["status"]);
        expect(calls.filter((a) => a.at(-1) === "version")).toHaveLength(1); // detected once
        return calls.at(-1)!;
      };
      const modern = await argsFor("git version 2.45.1\n");
      expect(modern).toContain(`core.attributesFile=${join(dataDir, ".theterminal-empty-attributes")}`);
      expect(modern).toContain("--attr-source=4b825dc642cb6eb9a060e54bf8d69288fbee4904");
      const old = await argsFor("git version 2.39.3 (Apple Git-146)\n");
      expect(old).toContain(`core.attributesFile=${join(dataDir, ".theterminal-empty-attributes")}`);
      expect(old.some((a) => a.startsWith("--attr-source"))).toBe(false);
    });

    it("uses the empty tree of the repository's object format, and refuses an unknown one", async () => {
      const sha256 = fakeGit(() => "git version 2.45.1\n", "sha256");
      await sha256.m.runGit(outside, ["status"]);
      expect(sha256.calls.at(-1)).toContain("--attr-source=6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321");
      const odd = fakeGit(() => "git version 2.45.1\n", "sha512");
      await expect(odd.m.runGit(outside, ["status"])).rejects.toBeInstanceOf(UnsafeGitConfigError);
    });

    it.skipIf(process.platform === "win32")("works in a real sha256 repository", async () => {
      const repo = join(outside, "r256");
      mkdirSync(repo);
      await git(repo, "init", "--object-format=sha256");
      writeFileSync(join(repo, "a.txt"), "x\n");
      await mgr.runGit(repo, ["add", "a.txt"]);
      await mgr.runGit(repo, ["-c", "user.name=t", "-c", "user.email=t@t.invalid", "commit", "-m", "x"]);
      expect((await mgr.runGit(repo, ["diff", "HEAD"])).trim()).toBe("");
    });

    it("never caches a failed git version check", async () => {
      let n = 0;
      const { calls, m } = fakeGit(() => {
        n++;
        if (n === 1) throw new Error("git not ready");
        return "git version 2.45.1\n";
      });
      await expect(m.runGit(outside, ["status"])).rejects.toThrow();
      await m.runGit(outside, ["status"]);
      expect(calls.at(-1)).toContain("--attr-source=4b825dc642cb6eb9a060e54bf8d69288fbee4904");
      expect(calls.filter((a) => a.at(-1) === "version")).toHaveLength(2);
    });

    it("treats any failure of the attribute scan as a refusal", async () => {
      const refusedWith = async (fail: (args: string[]) => Error | string | null) => {
        const fake: GitRunner = async (args) => {
          const r = fail(args);
          if (r instanceof Error) throw r;
          if (typeof r === "string") return r;
          if (args.at(-1) === "version") return "git version 2.45.1\n";
          if (args.includes("--show-object-format")) return `${join(outside, ".git")}\n${join(outside, ".git")}\nsha1\n`;
          return "";
        };
        return new WorktreeManager(dataDir, fake).runGit(outside, ["status"]);
      };
      const tree = (args: string[]) => (args.includes("ls-tree") ? "sub/.gitattributes\0" : null);
      await expect(refusedWith((a) => (a.includes("cat-file") ? new Error("bad object") : tree(a)))).rejects.toBeInstanceOf(UnsafeGitConfigError);
      await expect(refusedWith((a) => (a.includes("cat-file") ? new GitOutputTooLargeError() : tree(a)))).rejects.toBeInstanceOf(UnsafeGitConfigError);
      await expect(refusedWith((a) => (a.includes("ls-tree") ? new GitTimeoutError() : null))).rejects.toBeInstanceOf(UnsafeGitConfigError);
      // ls-tree failing while HEAD exists is a refusal; without a HEAD there is simply no tree to scan.
      const lsTreeFails = (head: boolean) => (a: string[]) =>
        a.includes("ls-tree") ? new Error("fatal") : a.includes("--verify") ? (head ? "abc\n" : new Error("no HEAD")) : null;
      await expect(refusedWith(lsTreeFails(true))).rejects.toBeInstanceOf(UnsafeGitConfigError);
      await expect(refusedWith(lsTreeFails(false))).resolves.toBe("");
      const configFails = (a: string[]) => (a.includes("--get-regexp") ? Object.assign(new Error("bad config"), { code: 128 }) : null);
      await expect(refusedWith(configFails)).rejects.toBeInstanceOf(UnsafeGitConfigError);
      writeFileSync(join(outside, ".gitattributes"), `${"#".repeat(300 * 1024)}\n* filter=late\n`);
      await expect(refusedWith(() => null)).rejects.toBeInstanceOf(UnsafeGitConfigError);
    });

    it("neutralises filters named by any .gitattributes in HEAD's tree", async () => {
      const calls: string[][] = [];
      const fake: GitRunner = async (args) => {
        calls.push(args);
        if (args.includes("ls-tree")) return "README\0sub/deep/.gitattributes\0.gitattributes\0";
        if (args.includes("cat-file")) return args.at(-1)!.endsWith("sub/deep/.gitattributes") ? "*.bin filter=deep\n" : "* filter=top\n";
        return "";
      };
      await new WorktreeManager(dataDir, fake).runGit(outside, ["status"]);
      const last = calls.at(-1)!;
      for (const n of ["deep", "top"]) expect(last).toContain(`filter.${n}.smudge=`);
    });
  });

  describe("submodules, replace objects and the big-file threshold (final review)", () => {
    it("every call disables submodule recursion and summaries, replace objects, and pins core.bigFileThreshold", () => {
      const args = [...GIT_COMMON_ARGS];
      const pairs = args.flatMap((a, i) => (a === "-c" ? [args[i + 1]] : []));
      expect(pairs).toEqual(expect.arrayContaining(["submodule.recurse=false", "status.submoduleSummary=false", "core.bigFileThreshold=512m"]));
      expect(args).toContain("--no-replace-objects");
      // Global options only, before the subcommand: nothing here names a subcommand or takes an operand.
      for (const a of args) expect(a === "-c" || a.startsWith("--") || a.includes("=")).toBe(true);
    });

    it.skipIf(process.platform === "win32")("never recurses into a planted submodule on reset, checkout or status, so its filter driver never runs; plain git does", async () => {
      const wt = await mgr.createRunWorktree("proj1", "run-a");
      const trap = await plantSubmoduleTrap(wt.absPath, outside);
      await mgr.runGit(wt.absPath, ["reset", "--hard", "HEAD"]);
      expect(trap.ran()).toBe(false);
      expect(existsSync(trap.inner)).toBe(false); // nothing was restored inside the submodule
      await mgr.runGit(wt.absPath, ["checkout", "--", "."]);
      await mgr.runGit(wt.absPath, ["status", "--porcelain=v1", "-z"]);
      await mgr.runGit(wt.absPath, ["diff", "--numstat", "HEAD~1"]);
      expect(trap.ran()).toBe(false);
      // Control: plain git with the same repository recurses and runs the driver.
      await plainGit(wt.absPath, "reset", "--hard", "HEAD");
      expect(trap.ran()).toBe(true);
      expect(existsSync(trap.inner)).toBe(true);
    });
  });

  describe("one scan per operation (GitScope)", () => {
    /** A manager over real git that records every process it starts. */
    const recording = () => {
      const calls: string[][] = [];
      const runner: GitRunner = async (args, cwd, opts) => {
        calls.push(args);
        return (await run("git", args, { cwd, env: opts?.env, maxBuffer: opts?.maxBuffer, timeout: opts?.timeoutMs })).stdout;
      };
      return { calls, m: new WorktreeManager(dataDir, runner) };
    };
    /** The processes started since `from`, by subcommand. */
    const since = (calls: string[][], from: number) =>
      calls.slice(from).map((a) => a.find((x, i) => !x.startsWith("-") && a[i - 1] !== "-c" && a[i - 1] !== "--file"));

    it("scans a repository once per scope, scans again when its configuration changes, and never shares a scan across scopes", async () => {
      const repo = await mgr.ensureProjectRepo("proj1");
      const { calls, m } = recording();
      const scope = new GitScope();
      await m.runGit(repo, ["status"], { scope });
      // `git version` once per manager; the probe, the include listing, the filter scan and the tree scan; the call.
      expect(since(calls, 0)).toEqual(["version", "rev-parse", "config", "config", "ls-tree", "status"]);
      let n = calls.length;
      await m.runGit(repo, ["status", "--short"], { scope });
      expect(since(calls, n)).toEqual(["status"]);

      // The agent (another run's, through the shared common dir) configures a filter driver mid-operation: the next
      // call scans again and neutralises it.
      n = calls.length;
      await git(repo, "config", "filter.evil.smudge", "cat");
      await m.runGit(repo, ["status"], { scope });
      expect(since(calls, n)).toEqual(["rev-parse", "config", "config", "ls-tree", "status"]);
      expect(calls.at(-1)).toContain("filter.evil.smudge=");
      n = calls.length;
      await m.runGit(repo, ["status"], { scope });
      expect(since(calls, n)).toEqual(["status"]);
      expect(calls.at(-1)).toContain("filter.evil.smudge=");

      // An include planted mid-operation is refused by the next call.
      await git(repo, "config", "include.path", join(outside, "x.cfg"));
      await expect(m.runGit(repo, ["status"], { scope })).rejects.toThrow(GIT_INCLUDES_REFUSED);
      await git(repo, "config", "--unset", "include.path");

      // Another scope, and a call without one, each scan for themselves.
      n = calls.length;
      await m.runGit(repo, ["status"], { scope: new GitScope() });
      expect(since(calls, n)).toEqual(["rev-parse", "config", "config", "ls-tree", "status"]);
      n = calls.length;
      await m.runGit(repo, ["status"]);
      await m.runGit(repo, ["status"]);
      expect(since(calls, n)).toEqual(["rev-parse", "config", "config", "ls-tree", "status", "rev-parse", "config", "config", "ls-tree", "status"]);
    });

    it("a scan pinned to a worktree's verified git directory reuses the scan that found it, and a scan of another worktree does not", async () => {
      const a = await mgr.createRunWorktree("proj1", "run-a");
      const b = await mgr.createRunWorktree("proj1", "run-b");
      const { calls, m } = recording();
      const scope = new GitScope();
      const gitDir = (await m.runGit(a.absPath, ["rev-parse", "--absolute-git-dir"], { scope })).trim();
      let n = calls.length;
      await m.runGit(a.absPath, ["status"], { scope, gitDir, workTree: a.absPath });
      expect(since(calls, n)).toEqual(["status"]);
      n = calls.length;
      await m.runGit(b.absPath, ["status"], { scope });
      expect(since(calls, n)).toEqual(["rev-parse", "config", "config", "ls-tree", "status"]);
    });

    it("a repository that appears during the operation (git init) is scanned: nothing is kept about an empty directory", async () => {
      const { calls, m } = recording();
      const repo = await m.ensureProjectRepo("proj1");
      const init = calls.findIndex((a) => a.includes("init"));
      expect(init).toBeGreaterThan(0);
      // After `init`: a scan of the new repository before anything else runs in it.
      expect(since(calls, init + 1).slice(0, 4)).toEqual(["rev-parse", "config", "config", "ls-tree"]);
      expect(await git(repo, "rev-list", "--count", "HEAD")).toBe("1");
    });

    it("a configuration that changes under a write of ours is caught by the listing that follows the write", async () => {
      // The agent of another run plants an include at the moment the start writes the identity: the start is refused.
      const runner: GitRunner = async (args, cwd, opts) => {
        const out = (await run("git", args, { cwd, env: opts?.env, maxBuffer: opts?.maxBuffer, timeout: opts?.timeoutMs })).stdout;
        if (args.includes("config") && args.includes("user.name")) await git(cwd, "config", "include.path", join(outside, "x.cfg"));
        return out;
      };
      const m = new WorktreeManager(dataDir, runner);
      await expect(m.ensureProjectRepo("proj1")).rejects.toThrow(GIT_INCLUDES_REFUSED);
    });

    /** A bare repository, outside dataDir, whose configuration names a filter driver. */
    const evilCommonDir = async () => {
      const evil = join(outside, "evil.git");
      await git(outside, "init", "--bare", "-q", evil);
      await git(outside, `--git-dir=${evil}`, "config", "filter.evil.smudge", "cat");
      return evil;
    };

    it("a commondir planted mid-operation under the worktree's pinned git directory makes the next call scan again and neutralise what it reaches", async () => {
      const wt = await mgr.createRunWorktree("proj1", "run-a");
      const { calls, m } = recording();
      const scope = new GitScope();
      const gitDir = (await m.runGit(wt.absPath, ["rev-parse", "--absolute-git-dir"], { scope })).trim();
      await m.runGit(wt.absPath, ["status"], { scope, gitDir, workTree: wt.absPath });
      const n = calls.length;
      // The agent redirects the worktree's common directory: every pinned call would read the planted repository's config.
      writeFileSync(join(gitDir, "commondir"), `${await evilCommonDir()}\n`);
      await m.runGit(wt.absPath, ["status"], { scope, gitDir, workTree: wt.absPath });
      // A scan of what the call now reaches (the planted repository has no HEAD, so the tree scan checks for one).
      expect(since(calls, n)).toEqual(["rev-parse", "config", "config", "ls-tree", "rev-parse", "status"]);
      expect(calls.at(-1)).toContain("filter.evil.smudge=");
    });

    it("a commondir planted mid-operation in the main repository's git directory is noticed too", async () => {
      const repo = await mgr.ensureProjectRepo("proj1");
      const { calls, m } = recording();
      const scope = new GitScope();
      await m.runGit(repo, ["status"], { scope });
      const n = calls.length;
      writeFileSync(join(repo, ".git", "commondir"), `${await evilCommonDir()}\n`);
      await m.runGit(repo, ["status"], { scope });
      expect(since(calls, n)).toEqual(["rev-parse", "config", "config", "ls-tree", "rev-parse", "status"]);
      expect(calls.at(-1)).toContain("filter.evil.smudge=");
    });

    it("a fingerprinted file whose content changes with its size, times and inode unchanged still scans again; one over the hash bound is never trusted", async () => {
      const repo = await mgr.ensureProjectRepo("proj1");
      const { calls, m } = recording();
      const scope = new GitScope();
      await m.runGit(repo, ["status"], { scope });
      const cfg = join(repo, ".git", "config");
      const before = statSync(cfg);
      // Same length, written in place (same inode), times put back: only the content differs.
      const text = readFileSync(cfg, "utf8");
      const fd = openSync(cfg, "r+");
      writeSync(fd, text.replace("bare = false", "bare = FALSE"), 0, "utf8");
      closeSync(fd);
      utimesSync(cfg, before.atime, before.mtime);
      let n = calls.length;
      await m.runGit(repo, ["status"], { scope });
      expect(since(calls, n)).toEqual(["rev-parse", "config", "config", "ls-tree", "status"]);
      // Over the bound, the file is read by git alone: every call scans.
      appendFileSync(cfg, `# ${"x".repeat(1024 * 1024)}\n`);
      n = calls.length;
      await m.runGit(repo, ["status"], { scope });
      await m.runGit(repo, ["status"], { scope });
      expect(since(calls, n)).toEqual(["rev-parse", "config", "config", "ls-tree", "status", "rev-parse", "config", "config", "ls-tree", "status"]);
    });

    it("sets the identity keys only when they are not already set, and resets one the agent changed", async () => {
      const repo = await mgr.ensureProjectRepo("proj1");
      const { calls, m } = recording();
      await m.ensureProjectRepo("proj1");
      expect(calls.some((a) => a.includes("config") && a.includes("user.name"))).toBe(false);
      await git(repo, "config", "user.email", "someone@example.com");
      await m.ensureProjectRepo("proj1");
      const writes = calls.filter((a) => a.includes("config") && !a.includes("--file") && !a.includes("--get-regexp"));
      expect(writes.map((a) => a.slice(-2))).toEqual([["user.email", "agent@theterminal.localhost"]]);
      expect(await git(repo, "config", "user.email")).toBe("agent@theterminal.localhost");
    });
  });
});
