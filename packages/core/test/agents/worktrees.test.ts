import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorktreeManager } from "../../src/agents/worktrees.js";

const run = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await run("git", args, { cwd })).stdout.trim();

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
  });
});
