import { execFile } from "node:child_process";
import { chmodSync, existsSync, linkSync, statSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, realpathSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildChildEnv } from "../../src/agents/child-env.js";
import {
  EMPTY_GITCONFIG, GIT_COMMON_ARGS, GitOutputTooLargeError, SharedGitconfigModifiedError, UnsafeGitConfigError, WorktreeManager,
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
        if (args.includes("--absolute-git-dir")) return join(realpathSync.native(cwd), ".git");
        if (args.includes("--verify")) throw new Error("no HEAD yet");
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

    it("neutralises attribute files: core.attributesFile, and --attr-source when git supports it", async () => {
      const argsFor = async (version: string) => {
        const calls: string[][] = [];
        const fake: GitRunner = async (args) => {
          calls.push(args);
          return args.includes("version") ? version : "";
        };
        const m = new WorktreeManager(dataDir, fake);
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
});
