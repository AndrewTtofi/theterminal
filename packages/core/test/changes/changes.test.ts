import { execFile } from "node:child_process";
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_CHANGED_FILES, MAX_FILE_BYTES, type AgentRun } from "@theterminal/shared";
import type { AgentAdapter } from "../../src/agents/adapter.js";
import { ApprovalBroker } from "../../src/agents/approvals.js";
import { FakeAdapter } from "../../src/agents/fake-adapter.js";
import { AgentRunner } from "../../src/agents/runner.js";
import { GitOutputTooLargeError, GitTimeoutError, WorktreeManager, type GitRunner } from "../../src/agents/worktrees.js";
import { BoardService, NotFoundError } from "../../src/board/board-service.js";
import {
  NoBaseError, RunActiveError, WorktreeMissingError, fileDiff, isGitSegment, listChanges, listDir, readFile, runWorktree, type ChangesDeps,
} from "../../src/changes/changes.js";
import { openDatabase, type Db } from "../../src/db.js";
import { commitEvent } from "../../src/events/commit.js";
import { getRun, listPendingActions } from "../../src/events/projections.js";
import { Ledger } from "../../src/ledger/ledger.js";
import { plainGit, plantSubmoduleTrap } from "../fixtures/submodule-trap.js";

const owner = { kind: "human", id: "owner" } as const;
const KEY = "zq-TESTKEY-e2e-opaque-0000000000";
const exec = promisify(execFile);
const testEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_/i.test(k)));

// Every git call here runs through runGit's hardening, five or six git processes each: a run start is about fifty, a
// view of the changes about forty. Seconds on Windows CI, where a process start is slow and the suite shares two cores;
// the default 5 s cut these tests off mid-git.
const GIT_TEST_TIMEOUT_MS = process.platform === "win32" ? 40_000 : 15_000;
vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT_MS, hookTimeout: GIT_TEST_TIMEOUT_MS });

let dataDir: string;
let outside: string;
let db: Db;
let worktrees: WorktreeManager;
let runner: AgentRunner;
let deps: ChangesDeps;
let run: AgentRun;
let wt: string;

beforeEach(async () => {
  dataDir = realpathSync(mkdtempSync(join(tmpdir(), "changes-data-")));
  outside = realpathSync(mkdtempSync(join(tmpdir(), "changes-out-")));
  db = openDatabase(":memory:");
  const ledger = new Ledger(db);
  worktrees = new WorktreeManager(dataDir);
  const projectId = new BoardService(db, ledger).createProject(owner, { name: "Demo" }).id;
  runner = new AgentRunner({
    db, ledger, worktrees, broker: new ApprovalBroker(), adapters: { fake: new FakeAdapter([]) },
    extraSecrets: () => [KEY], dataDir, username: "someuser",
  });
  run = await startRun(projectId);
  deps = { db, dataDir, worktrees, clean: (id, s, max) => runner.cleanFor(id)(s, max), settling: (id) => runner.settling(id) };
  wt = join(dataDir, run.worktree);
});
afterEach(async () => {
  await runner.shutdown();
  // Retried: on Windows a git or agent process that was just killed can still hold its working directory (EBUSY).
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  rmSync(outside, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** Starts a run with the fake adapter (which does nothing) and waits for it to finish. */
const startRun = async (projectId: string) => {
  const r = await runner.start(owner, { projectId, adapter: "fake", prompt: "go" });
  await vi.waitFor(() => expect(getRun(db, r.id)!.status).not.toBe("running"), { timeout: 5000 });
  return r;
};
const write = (rel: string, content: string | Buffer) => writeFileSync(join(wt, rel), content);
/** Commits `files` to the project repository, then starts a fresh run from that commit, so they are part of its fork point. */
const startWithBase = async (files: Record<string, string>) => {
  const repo = worktrees.repoPath(run.projectId);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, rel)), { recursive: true });
    writeFileSync(join(repo, rel), content);
  }
  await worktrees.runGit(repo, ["add", "-A"]);
  await worktrees.runGit(repo, ["commit", "--no-verify", "-m", "base"]);
  run = await startRun(run.projectId);
  wt = join(dataDir, run.worktree);
};
/** The project repository's checked-out branch, as the agent could name it to `update-ref`. */
const mainBranch = async () => (await worktrees.runGit(worktrees.repoPath(run.projectId), ["symbolic-ref", "HEAD"])).trim();
const commitAll = async () => {
  await worktrees.runGit(wt, ["add", "-A"]);
  await worktrees.runGit(wt, ["commit", "--no-verify", "-m", "agent work"]);
};

describe("a live run", () => {
  it("refuses every view with RunActiveError without starting git, and serves the run once it is stopped", async () => {
    const live = new AgentRunner({
      db, ledger: new Ledger(db), worktrees, broker: new ApprovalBroker(), dataDir, extraSecrets: () => [KEY], username: "someuser",
      adapters: {
        fake: new FakeAdapter([
          { propose: { tool: "Write", kind: "file_write", summary: "write notes", input: { path: "notes.md" }, paths: ["notes.md"] } },
        ]),
      },
    });
    try {
      const r = await live.start(owner, { projectId: run.projectId, adapter: "fake", prompt: "wait" });
      await vi.waitFor(() => expect(listPendingActions(db, run.projectId)).toHaveLength(1), { timeout: 5000 });
      expect(getRun(db, r.id)!.status).toBe("running");
      let gitCalls = 0;
      const counting: GitRunner = async (args, cwd, opts) => {
        gitCalls++;
        return (await exec("git", args, { cwd, env: opts?.env, maxBuffer: opts?.maxBuffer, timeout: opts?.timeoutMs })).stdout;
      };
      const d: ChangesDeps = {
        ...deps, worktrees: new WorktreeManager(dataDir, counting), clean: (id, s, max) => live.cleanFor(id)(s, max), settling: (id) => live.settling(id),
      };
      writeFileSync(join(dataDir, r.worktree, "notes.txt"), "x\n");
      const message = "Changes show when the run is stopped or finished.";
      await expect(listChanges(d, r.id)).rejects.toThrow(new RunActiveError());
      await expect(listChanges(d, r.id)).rejects.toThrow(message);
      await expect(fileDiff(d, r.id, "notes.txt")).rejects.toBeInstanceOf(RunActiveError);
      await expect(listDir(d, r.id, "")).rejects.toThrow(RunActiveError);
      await expect(readFile(d, r.id, "notes.txt")).rejects.toThrow(RunActiveError);
      expect(gitCalls).toBe(0);

      live.stop(owner, r.id);
      await vi.waitFor(() => expect(getRun(db, r.id)!.status).toBe("stopped"), { timeout: 5000 });
      await vi.waitFor(() => expect(live.settling(r.id)).toBe(false), { timeout: 5000 });
      expect((await listChanges(d, r.id)).files.map((f) => f.path)).toEqual(["notes.txt"]);
      expect((await readFile(d, r.id, "notes.txt")).text).toBe("x\n");
      expect(gitCalls).toBeGreaterThan(0);
    } finally {
      await live.shutdown();
    }
  });

  it("refuses every view while a stopped run's agent may still be writing (settling) past the wait, without starting git", async () => {
    let release!: () => void;
    const returned = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow: AgentAdapter = {
      id: "fake",
      start: async () => {
        await returned; // ignores the abort until released
        return { status: "completed" };
      },
    };
    const live = new AgentRunner({
      db, ledger: new Ledger(db), worktrees, broker: new ApprovalBroker(), dataDir, extraSecrets: () => [KEY], username: "someuser", adapters: { fake: slow },
    });
    try {
      const r = await live.start(owner, { projectId: run.projectId, adapter: "fake", prompt: "slow" });
      live.stop(owner, r.id);
      expect(getRun(db, r.id)!.status).toBe("stopped");
      expect(live.settling(r.id)).toBe(true);
      let gitCalls = 0;
      const counting: GitRunner = async (args, cwd, opts) => {
        gitCalls++;
        return (await exec("git", args, { cwd, env: opts?.env, maxBuffer: opts?.maxBuffer, timeout: opts?.timeoutMs })).stdout;
      };
      const d: ChangesDeps = {
        ...deps, worktrees: new WorktreeManager(dataDir, counting), clean: (id, s, max) => live.cleanFor(id)(s, max), settling: (id) => live.settling(id),
        settleWaitMs: 300,
      };
      writeFileSync(join(dataDir, r.worktree, "notes.txt"), "x\n");
      const started = Date.now();
      await expect(listChanges(d, r.id)).rejects.toBeInstanceOf(RunActiveError);
      expect(Date.now() - started).toBeGreaterThanOrEqual(250);
      await expect(fileDiff(d, r.id, "notes.txt")).rejects.toBeInstanceOf(RunActiveError);
      await expect(listDir(d, r.id, "")).rejects.toThrow(RunActiveError);
      await expect(readFile(d, r.id, "notes.txt")).rejects.toThrow(RunActiveError);
      expect(gitCalls).toBe(0);
      release();
      await vi.waitFor(() => expect(live.settling(r.id)).toBe(false));
      expect((await listChanges(d, r.id)).files.map((f) => f.path)).toEqual(["notes.txt"]);
    } finally {
      release();
      await live.shutdown();
    }
  });

  it("a view asked for on Stop waits for the agent to return and then answers, with no git before (final re-review, Important 2)", async () => {
    let release!: () => void;
    const returned = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow: AgentAdapter = {
      id: "fake",
      start: async () => {
        await returned; // like an adapter waiting out its kill grace after SIGTERM
        return { status: "completed" };
      },
    };
    const live = new AgentRunner({
      db, ledger: new Ledger(db), worktrees, broker: new ApprovalBroker(), dataDir, extraSecrets: () => [KEY], username: "someuser", adapters: { fake: slow },
    });
    try {
      const r = await live.start(owner, { projectId: run.projectId, adapter: "fake", prompt: "slow" });
      live.stop(owner, r.id); // agent.finished is recorded now; the UI asks on that entry
      expect(live.settling(r.id)).toBe(true);
      let gitCalls = 0;
      const counting: GitRunner = async (args, cwd, opts) => {
        gitCalls++;
        return (await exec("git", args, { cwd, env: opts?.env, maxBuffer: opts?.maxBuffer, timeout: opts?.timeoutMs })).stdout;
      };
      const d: ChangesDeps = {
        ...deps, worktrees: new WorktreeManager(dataDir, counting), clean: (id, s, max) => live.cleanFor(id)(s, max), settling: (id) => live.settling(id),
      };
      writeFileSync(join(dataDir, r.worktree, "notes.txt"), "x\n");
      const asked = Promise.all([listChanges(d, r.id), fileDiff(d, r.id, "notes.txt"), listDir(d, r.id, ""), readFile(d, r.id, "notes.txt")]);
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(gitCalls).toBe(0);
      expect(live.settling(r.id)).toBe(true);
      release();
      const [changes, diff, dir, file] = await asked;
      expect(changes.files.map((f) => f.path)).toEqual(["notes.txt"]);
      expect(diff.text).toContain("+x");
      expect(dir.entries.map((e) => e.name)).toEqual(["notes.txt"]);
      expect(file.text).toBe("x\n");
      expect(live.settling(r.id)).toBe(false);
    } finally {
      release();
      await live.shutdown();
    }
  });
});

describe("runWorktree", () => {
  it("finds the run's working copy; an unknown run is NotFoundError, a deleted one WorktreeMissingError", () => {
    expect(runWorktree(deps, run.id)).toEqual({ run: expect.objectContaining({ id: run.id }), abs: wt });
    expect(() => runWorktree(deps, "no-such-run")).toThrow(NotFoundError);
    rmSync(wt, { recursive: true, force: true });
    expect(() => runWorktree(deps, run.id)).toThrow(WorktreeMissingError);
  });
});

describe("listChanges", () => {
  it("lists an untracked file", async () => {
    write("notes.txt", `key=${KEY}\n`);
    const c = await listChanges(deps, run.id);
    expect(c).toMatchObject({ runId: run.id, truncated: false });
    expect(c.base).toMatch(/^[0-9a-f]{40,64}$/);
    expect(c.head).toBe(c.base);
    expect(c.files).toEqual([{ path: "notes.txt", status: "untracked", added: null, deleted: null, binary: false }]);
  });

  it("compares with the fork point: committed and uncommitted edits, deletions and binary files", async () => {
    await startWithBase({ "a.txt": "one\ntwo\n", "gone.txt": "bye\n" });
    write("img.bin", Buffer.from([1, 0, 2, 0]));
    await commitAll();
    write("a.txt", "one\nTWO\n");
    unlinkSync(join(wt, "gone.txt"));
    write("raw.dat", Buffer.from([0, 1, 2]));
    const c = await listChanges(deps, run.id);
    expect(c.head).not.toBe(c.base);
    expect(c.files).toEqual([
      { path: "a.txt", status: "modified", added: 1, deleted: 1, binary: false },
      { path: "gone.txt", status: "deleted", added: 0, deleted: 1, binary: false },
      { path: "img.bin", status: "added", added: null, deleted: null, binary: true },
      { path: "raw.dat", status: "untracked", added: null, deleted: null, binary: true },
    ]);
  });

  it(`cuts the list at ${MAX_CHANGED_FILES} files and says so (Review Focus 4)`, async () => {
    for (let i = 0; i < 600; i++) write(`f${String(i).padStart(3, "0")}.txt`, "x\n");
    const c = await listChanges(deps, run.id);
    expect(c.files).toHaveLength(MAX_CHANGED_FILES);
    expect(c.truncated).toBe(true);
    expect(c.files[0]!.path).toBe("f000.txt");
  });

  it("does not depend on the project repository's HEAD: a broken HEAD still lists against the recorded fork commit", async () => {
    write("notes.txt", "x\n");
    writeFileSync(join(worktrees.repoPath(run.projectId), ".git", "HEAD"), "ref: refs/heads/nowhere\n");
    const c = await listChanges(deps, run.id);
    expect(c.base).toBe(run.base);
    expect(c.files.map((f) => f.path)).toEqual(["notes.txt"]);
  });
});

describe("the fork point is the commit recorded when the run started (final review, Important 2)", () => {
  /** The agent's own git, as a gated shell action would run it, in the run's worktree. */
  const agentGit = (...args: string[]) => plainGit(wt, ...args);

  it("records the project repository's HEAD at the start as the run's base and diffs against it", async () => {
    const repoHead = (await worktrees.runGit(worktrees.repoPath(run.projectId), ["rev-parse", "HEAD"])).trim();
    expect(run.base).toBe(repoHead);
    expect(getRun(db, run.id)!.base).toBe(repoHead);
    write("notes.txt", "x\n");
    const c = await listChanges(deps, run.id);
    expect(c.base).toBe(repoHead);
    expect(c.head).toBe(repoHead);
  });

  it("still shows committed work after the agent moves the project branch onto its own commit (update-ref)", async () => {
    await startWithBase({ "a.txt": "one\n" });
    write("a.txt", "one\ntwo\n");
    write("new.txt", "new\n");
    await commitAll();
    await agentGit("update-ref", await mainBranch(), "HEAD");
    const c = await listChanges(deps, run.id);
    expect(c.base).toBe(run.base);
    expect(c.files.map((f) => [f.path, f.status])).toEqual([["a.txt", "modified"], ["new.txt", "added"]]);
    expect((await fileDiff(deps, run.id, "a.txt")).text).toContain("+two");
  });

  it("ignores replace objects the agent plants for the fork commit (git replace)", async () => {
    await startWithBase({ "a.txt": "one\n" });
    write("a.txt", "one\ntwo\n");
    await commitAll();
    await agentGit("replace", run.base!, "HEAD");
    const c = await listChanges(deps, run.id);
    expect(c.files).toEqual([{ path: "a.txt", status: "modified", added: 1, deleted: 0, binary: false }]);
    expect((await fileDiff(deps, run.id, "a.txt")).text).toContain("+two");
  });

  it("keeps text files readable as text when the agent sets core.bigFileThreshold=1 in the shared configuration", async () => {
    await startWithBase({ "a.txt": "one\n" });
    write("a.txt", "one\ntwo\n");
    write("b.txt", "b\n");
    await commitAll();
    await agentGit("config", "core.bigFileThreshold", "1");
    const c = await listChanges(deps, run.id);
    expect(c.files).toEqual([
      { path: "a.txt", status: "modified", added: 1, deleted: 0, binary: false },
      { path: "b.txt", status: "added", added: 1, deleted: 0, binary: false },
    ]);
    const d = await fileDiff(deps, run.id, "a.txt");
    expect(d).toMatchObject({ binary: false, added: 1, deleted: 0 });
    expect(d.text).toContain("+two");
  });

  it("a run recorded before the fork commit was kept fails closed with NoBaseError; its files are still browsable", async () => {
    const legacy = await worktrees.createRunWorktree(run.projectId, "legacy-run");
    const ledger = new Ledger(db);
    commitEvent(db, ledger, () => ({
      event: {
        projectId: run.projectId, actor: owner, type: "agent.started",
        payload: { runId: "legacy-run", adapter: "fake", authMode: "none", prompt: "old", cardId: null, worktree: legacy.relPath },
      },
      result: () => undefined,
    }));
    commitEvent(db, ledger, () => ({
      event: { projectId: run.projectId, actor: owner, type: "agent.finished", payload: { runId: "legacy-run", status: "completed", costUsd: null, error: null } },
      result: () => undefined,
    }));
    expect(getRun(db, "legacy-run")!.base).toBeNull();
    writeFileSync(join(legacy.absPath, "notes.txt"), "x\n");
    await expect(listChanges(deps, "legacy-run")).rejects.toBeInstanceOf(NoBaseError);
    await expect(fileDiff(deps, "legacy-run", "notes.txt")).rejects.toBeInstanceOf(NoBaseError);
    expect((await listDir(deps, "legacy-run", "")).entries.map((e) => e.name)).toEqual(["notes.txt"]);
    expect((await readFile(deps, "legacy-run", "notes.txt")).text).toBe("x\n");
  });

  it("fails closed with NoBaseError when the recorded fork commit is no longer in the repository", async () => {
    const objects = join(worktrees.repoPath(run.projectId), ".git", "objects");
    rmSync(join(objects, run.base!.slice(0, 2), run.base!.slice(2)), { force: true });
    await expect(listChanges(deps, run.id)).rejects.toBeInstanceOf(NoBaseError);
  });

  it.skipIf(process.platform === "win32")("never recurses into a planted submodule, so its filter driver never runs", async () => {
    const trap = await plantSubmoduleTrap(wt, outside);
    write("notes.txt", "x\n");
    const c = await listChanges(deps, run.id);
    expect(c.files.map((f) => f.path)).toEqual(expect.arrayContaining([".gitmodules", "notes.txt"]));
    await fileDiff(deps, run.id, ".gitmodules");
    expect(trap.ran()).toBe(false);
    expect(existsSync(trap.inner)).toBe(false);
  });
});

describe("index flags the agent sets never hide a change (final re-review, Important 1)", () => {
  const agentGit = (...args: string[]) => plainGit(wt, ...args);
  const gitDir = () => join(worktrees.repoPath(run.projectId), ".git", "worktrees", run.worktree.split(/[\\/]/).at(-1)!);
  const modifiedPaths = async () => (await listChanges(deps, run.id)).files.filter((f) => f.status === "modified").map((f) => f.path);

  it("lists and diffs files marked skip-worktree or assume-unchanged, which plain git hides", async () => {
    await startWithBase({ "a.txt": "one\n", "b.txt": "two\n" });
    write("a.txt", "one\nmore\n");
    write("b.txt", "two\nmore\n");
    await agentGit("update-index", "--skip-worktree", "a.txt");
    await agentGit("update-index", "--assume-unchanged", "b.txt");
    // Control: the agent's index hides both from plain git.
    expect((await plainGit(wt, "diff", "--numstat", run.base!)).trim()).toBe("");
    expect(await modifiedPaths()).toEqual(["a.txt", "b.txt"]);
    const d = await fileDiff(deps, run.id, "a.txt");
    expect(d).toMatchObject({ status: "modified", added: 1, deleted: 0 });
    expect(d.text).toContain("+more");
    // The agent's own index is left as it was: the view never writes into it.
    expect((await plainGit(wt, "ls-files", "-v")).split(/\r?\n/).sort()).toEqual(["S a.txt", "h b.txt"]);
  });

  it("shows a file a sparse checkout removed from the working copy as deleted, and an untracked cache or split index changes nothing", async () => {
    await startWithBase({ "sub/in.txt": "in\n", "other/out.txt": "out\n" });
    await agentGit("sparse-checkout", "set", "sub"); // cone mode: root files stay, other/ is removed
    expect(existsSync(join(wt, "other", "out.txt"))).toBe(false);
    expect((await plainGit(wt, "diff", "--name-status", run.base!)).trim()).toBe("");
    const sparse = await listChanges(deps, run.id);
    expect(sparse.files).toEqual([{ path: "other/out.txt", status: "deleted", added: 0, deleted: 1, binary: false }]);
    await agentGit("sparse-checkout", "disable");

    await agentGit("update-index", "--untracked-cache");
    await agentGit("update-index", "--split-index");
    await agentGit("config", "core.splitIndex", "true");
    await agentGit("status", "--porcelain"); // warms both caches
    write("sub/in.txt", "in\nmore\n");
    write("new.txt", "x\n");
    const before = { names: readdirSync(gitDir()).sort(), index: readFileSync(join(gitDir(), "index")) };
    const c = await listChanges(deps, run.id);
    expect(c.files.map((f) => [f.path, f.status])).toEqual([["new.txt", "untracked"], ["sub/in.txt", "modified"]]);
    expect((await fileDiff(deps, run.id, "sub/in.txt")).text).toContain("+more");
    // The scratch index the views use is gone, and nothing was written into the agent's git directory or its index.
    expect(readdirSync(dataDir).filter((n) => n.includes("index"))).toEqual([]);
    expect(readdirSync(gitDir()).sort()).toEqual(before.names);
    expect(readFileSync(join(gitDir(), "index")).equals(before.index)).toBe(true);
  });

  it("a staged file is shown as the working copy has it: new and untracked, or unchanged after rm --cached", async () => {
    await startWithBase({ "a.txt": "one\n" });
    write("staged.txt", "s\n");
    await agentGit("add", "staged.txt");
    await agentGit("rm", "--cached", "a.txt");
    const c = await listChanges(deps, run.id);
    expect(c.files).toEqual([{ path: "staged.txt", status: "untracked", added: null, deleted: null, binary: false }]);
    expect((await fileDiff(deps, run.id, "a.txt")).status).toBe("unchanged");
    expect((await fileDiff(deps, run.id, "staged.txt")).text).toContain("+s");
  });
});

describe("fileDiff", () => {
  it("synthesises an untracked file's diff and redacts it (Review Focus 2)", async () => {
    write("notes.txt", `key=${KEY}\nsecond\n`);
    const d = await fileDiff(deps, run.id, "notes.txt");
    expect(d).toMatchObject({ runId: run.id, path: "notes.txt", status: "untracked", binary: false, tooLarge: false, added: 2, deleted: 0 });
    expect(d.text).toBe("--- /dev/null\n+++ b/notes.txt\n@@ -0,0 +1,2 @@\n+key=[REDACTED]\n+second\n");
    expect(d.text).not.toContain(KEY);
  });

  it("diffs a tracked file against the fork point, and an unchanged one is empty", async () => {
    await startWithBase({ "same.txt": "same\n" });
    write("a.txt", "one\ntwo\n");
    await commitAll();
    write("a.txt", `one\nkey=${KEY}\n`);
    const d = await fileDiff(deps, run.id, "a.txt");
    expect(d).toMatchObject({ status: "added", added: 2, deleted: 0, tooLarge: false, binary: false });
    expect(d.text).toContain("+key=[REDACTED]");
    expect(d.text).not.toContain(KEY);
    expect(await fileDiff(deps, run.id, "same.txt")).toEqual({
      runId: run.id, path: "same.txt", status: "unchanged", binary: false, tooLarge: false, added: 0, deleted: 0, text: "",
    });
  });

  it("a 10,000-line change is tooLarge with its counts and no text (Review Focus 4)", async () => {
    write("big.txt", Array.from({ length: 10000 }, (_, i) => `line ${i}`).join("\n") + "\n");
    await commitAll();
    const d = await fileDiff(deps, run.id, "big.txt");
    expect(d).toMatchObject({ status: "added", tooLarge: true, text: null, added: 10000, deleted: 0 });
  });

  it("measures the diff cap in UTF-8 bytes, not characters", async () => {
    // 4,500 lines of 116 two-byte characters: the file is under MAX_FILE_BYTES and its diff has about half as
    // many characters as bytes, but the synthesised diff is over MAX_DIFF_BYTES in bytes.
    write("wide.txt", `${"\u00e9".repeat(116)}\n`.repeat(4500));
    const d = await fileDiff(deps, run.id, "wide.txt");
    expect(d).toMatchObject({ status: "untracked", tooLarge: true, text: null, added: 4500 });
  });

  it("an untracked file over MAX_FILE_BYTES is tooLarge without being read, and a binary one has no text", async () => {
    write("huge.txt", "x".repeat(MAX_FILE_BYTES + 1));
    write("blob.bin", Buffer.from([0x41, 0, 0x42]));
    expect(await fileDiff(deps, run.id, "huge.txt")).toMatchObject({ status: "untracked", tooLarge: true, text: null });
    expect(await fileDiff(deps, run.id, "blob.bin")).toMatchObject({ status: "untracked", binary: true, tooLarge: false, text: null });
  });
});

describe("listDir and readFile", () => {
  it("lists directories first, then files, never .git", async () => {
    write("notes.txt", "hi\n");
    mkdirSync(join(wt, "src"));
    const l = await listDir(deps, run.id, "");
    expect(l).toMatchObject({ runId: run.id, path: "", truncated: false });
    expect(l.entries).toEqual([
      { name: "src", kind: "dir", size: null },
      { name: "notes.txt", kind: "file", size: 3 },
    ]);
    expect((await listDir(deps, run.id, "src")).entries).toEqual([]);
    await expect(listDir(deps, run.id, "notes.txt")).rejects.toThrow(NotFoundError);
  });

  it("reads a file, cleaning secrets and the worktree's absolute path", async () => {
    write("notes.txt", `key=${KEY}\nat ${join(wt, "x")}\n`);
    const f = await readFile(deps, run.id, "notes.txt");
    expect(f).toMatchObject({ runId: run.id, path: "notes.txt", binary: false, tooLarge: false });
    expect(f.text).toContain("key=[REDACTED]");
    expect(f.text).not.toContain(wt);
    expect(f.text).toMatch(/at \.[\\/]x/);
    await expect(readFile(deps, run.id, "")).rejects.toThrow(NotFoundError);
  });

  it("a 2 MiB file is tooLarge; the cap counts bytes (Review Focus 4)", async () => {
    write("big.txt", Buffer.alloc(2 * 1024 * 1024, 0x61));
    expect(await readFile(deps, run.id, "big.txt")).toMatchObject({ size: 2 * 1024 * 1024, tooLarge: true, binary: false, text: null });
    write("wide.txt", "\u00e9".repeat(MAX_FILE_BYTES / 2 + 1)); // fewer characters than the cap, more bytes
    expect(await readFile(deps, run.id, "wide.txt")).toMatchObject({ tooLarge: true, text: null });
    write("fits.txt", "\u00e9".repeat(MAX_FILE_BYTES / 2)); // exactly the cap in bytes
    const fits = await readFile(deps, run.id, "fits.txt");
    expect(fits).toMatchObject({ size: MAX_FILE_BYTES, tooLarge: false });
    expect(fits.text).toHaveLength(MAX_FILE_BYTES / 2);
  });

  it("refuses a file whose path resolves differently once it is open", async () => {
    write("notes.txt", "hello\n");
    write("other.txt", "other\n");
    const real = worktrees.resolveInside.bind(worktrees);
    const spy = vi.spyOn(worktrees, "resolveInside");
    spy.mockImplementationOnce(real).mockImplementationOnce((root) => join(root, "other.txt"));
    await expect(readFile(deps, run.id, "notes.txt")).rejects.toThrow(NotFoundError);
    spy.mockRestore();
    expect((await readFile(deps, run.id, "notes.txt")).text).toBe("hello\n");
  });

  it("a NUL byte in the first 8 KiB makes a file binary with no text", async () => {
    write("blob.bin", Buffer.from([0x41, 0, 0x42]));
    expect(await readFile(deps, run.id, "blob.bin")).toMatchObject({ size: 3, binary: true, tooLarge: false, text: null });
  });
});

describe("paths that leave the worktree (Review Focus 1)", () => {
  const every = (p: string) => [
    () => readFile(deps, run.id, p),
    () => listDir(deps, run.id, p),
    () => fileDiff(deps, run.id, p),
  ];
  const rejectsAll = async (p: string) => {
    for (const call of every(p)) {
      await expect((async () => call())()).rejects.toBeInstanceOf(NotFoundError);
    }
  };

  it("refuses .., absolute paths and .git", async () => {
    writeFileSync(join(dataDir, "projects", run.projectId, "worktrees", "token"), "secret");
    const winGitNames = [".git./config", ".git /config", "sub/.git. ./x", ".git::$INDEX_ALLOCATION/config", "GIT~1/config"];
    const gitNames = [".git", ".git/config", "sub/.git/config", ".GIT/config", ...(process.platform === "win32" ? winGitNames : [])];
    for (const p of ["../token", "../../../../etc/hosts", "/etc/hosts", join(outside, "x"), ...gitNames]) {
      await rejectsAll(p);
    }
    if (process.platform === "win32") await rejectsAll("C:\\Windows\\win.ini");
  });

  it("knows the git directory's other names on Windows, at any depth", () => {
    for (const n of [".git", ".GIT", ".git.", ".git ", ".git. .", ".git::$INDEX_ALLOCATION", "GIT~1", "git~12"]) {
      expect(isGitSegment(n, "win32"), n).toBe(true);
    }
    for (const n of [".gitignore", ".github", "git", ".git.x", "git~"]) expect(isGitSegment(n, "win32"), n).toBe(false);
    expect(isGitSegment(".GIT", "darwin")).toBe(true);
    expect(isGitSegment(".git.", "darwin")).toBe(false);
  });

  describe.skipIf(process.platform === "win32")("symlinks", () => {
    it("refuses a symlink to a file outside and a dangling symlink", async () => {
      writeFileSync(join(outside, "secret"), "s");
      symlinkSync(join(outside, "secret"), join(wt, "flink"));
      symlinkSync(outside, join(wt, "dlink"));
      symlinkSync(join(outside, "planted"), join(wt, "dangling"));
      for (const p of ["flink", "dlink", "dlink/secret", "dangling"]) await rejectsAll(p);
      const names = (await listDir(deps, run.id, "")).entries;
      expect(names).toEqual(expect.arrayContaining([{ name: "flink", kind: "other", size: null }]));
    });
  });

  it("a deleted worktree is WorktreeMissingError for every view", async () => {
    rmSync(wt, { recursive: true, force: true });
    await expect(listChanges(deps, run.id)).rejects.toBeInstanceOf(WorktreeMissingError);
    await expect(fileDiff(deps, run.id, "a.txt")).rejects.toBeInstanceOf(WorktreeMissingError);
    await expect(listDir(deps, run.id, "")).rejects.toThrow(WorktreeMissingError);
    await expect(readFile(deps, run.id, "a.txt")).rejects.toThrow(WorktreeMissingError);
  });
});

describe.skipIf(process.platform === "win32")("agent-planted git configuration never runs (R2)", { timeout: 20000 }, () => {
  it("ignores a planted filter driver, textconv, external diff, fsmonitor and hooks; plain git runs each", async () => {
    const evil = (name: string, passThrough = true) => {
      const f = join(outside, `${name}.sh`);
      const tail = passThrough ? `if [ -n "$1" ] && [ -f "$1" ]; then cat "$1"; else cat; fi\n` : "";
      writeFileSync(f, `#!/bin/sh\necho ran >> "${join(outside, `${name}.ran`)}"\n${tail}`);
      chmodSync(f, 0o755);
      return f;
    };
    const ran = (name: string) => existsSync(join(outside, `${name}.ran`));
    write("a.txt", "one\n");
    await commitAll();

    const repo = worktrees.repoPath(run.projectId);
    const plant = (...args: string[]) => exec("git", ["config", ...args], { cwd: repo, env: testEnv() });
    await plant("filter.evil.clean", evil("clean"));
    await plant("filter.evil.smudge", evil("smudge"));
    await plant("filter.evil.required", "true");
    await plant("diff.evil.textconv", evil("textconv"));
    await plant("diff.external", evil("external"));
    await plant("core.fsmonitor", evil("fsmonitor", false));
    const hooks = ["post-index-change", "reference-transaction", "pre-commit", "post-commit", "post-checkout"];
    for (const hook of hooks) {
      writeFileSync(join(repo, ".git", "hooks", hook), `#!/bin/sh\necho ran >> "${join(outside, "hook.ran")}"\n`);
      chmodSync(join(repo, ".git", "hooks", hook), 0o755);
    }
    write(".gitattributes", "* filter=evil diff=evil\n");
    write("a.txt", "one\ntwo\n");
    write("b.txt", "new\n");

    const c = await listChanges(deps, run.id);
    expect(c.files.map((f) => f.path)).toEqual([".gitattributes", "a.txt", "b.txt"]);
    expect((await fileDiff(deps, run.id, "a.txt")).text).toContain("+two");
    await fileDiff(deps, run.id, "b.txt");
    await readFile(deps, run.id, "a.txt");
    await listDir(deps, run.id, "");
    await worktrees.runGit(wt, ["commit", "--allow-empty", "-m", "x"]);
    for (const name of ["clean", "smudge", "textconv", "external", "fsmonitor", "hook"]) expect(ran(name), name).toBe(false);

    // Controls: the same repository, used by plain git, runs each planted program.
    const plain = (...args: string[]) => exec("git", args, { cwd: wt, env: testEnv() });
    await plain("status");
    expect(ran("fsmonitor")).toBe(true);
    await plain("diff", "HEAD");
    expect(ran("external")).toBe(true);
    await plain("diff", "--no-ext-diff", "HEAD");
    expect(ran("textconv")).toBe(true);
    await plain("add", "a.txt");
    expect(ran("clean")).toBe(true);
    await plain("commit", "--allow-empty", "-m", "control");
    expect(ran("hook")).toBe(true);
  });

  it("refuses a worktree whose git configuration points its work tree elsewhere, never serving outside content", async () => {
    writeFileSync(join(outside, "stolen.txt"), "outside content\n");
    const repo = worktrees.repoPath(run.projectId);
    await exec("git", ["config", "extensions.worktreeConfig", "true"], { cwd: repo, env: testEnv() });
    await exec("git", ["config", "--worktree", "core.worktree", outside], { cwd: wt, env: testEnv() });
    // Control: plain git now treats the outside folder as this worktree.
    expect((await exec("git", ["rev-parse", "--show-toplevel"], { cwd: wt, env: testEnv() })).stdout.trim()).toBe(outside);
    await expect(listChanges(deps, run.id)).rejects.toBeInstanceOf(WorktreeMissingError);
    await expect(fileDiff(deps, run.id, "stolen.txt")).rejects.toBeInstanceOf(WorktreeMissingError);
  });

  it("refuses a worktree whose .git file points at another repository", async () => {
    const other = join(outside, "other");
    mkdirSync(other);
    await exec("git", ["init"], { cwd: other, env: testEnv() });
    writeFileSync(join(wt, ".git"), `gitdir: ${join(other, ".git")}\n`);
    await expect(listChanges(deps, run.id)).rejects.toBeInstanceOf(WorktreeMissingError);
  });

  it("refuses a .git file pointing at another run's entry, and an entry whose commondir points outside", async () => {
    const second = await runner.start(owner, { projectId: run.projectId, adapter: "fake", prompt: "again" });
    await vi.waitFor(() => expect(getRun(db, second.id)!.status).not.toBe("running"), { timeout: 5000 });
    const repoGit = join(worktrees.repoPath(run.projectId), ".git");
    const original = readFileSync(join(wt, ".git"), "utf8");
    writeFileSync(join(wt, ".git"), `gitdir: ${join(repoGit, "worktrees", second.id)}\n`);
    await expect(listChanges(deps, run.id)).rejects.toBeInstanceOf(WorktreeMissingError);
    writeFileSync(join(wt, ".git"), original);
    await listChanges(deps, run.id);

    const other = join(outside, "other");
    mkdirSync(other);
    await exec("git", ["init"], { cwd: other, env: testEnv() });
    writeFileSync(join(repoGit, "worktrees", run.id, "commondir"), `${join(other, ".git")}\n`);
    await expect(listChanges(deps, run.id)).rejects.toBeInstanceOf(WorktreeMissingError);
  });

  it("never blocks on a FIFO: refused as a file, not a regular file in a diff", async () => {
    await exec("mkfifo", [join(wt, "pipe")]);
    await expect(readFile(deps, run.id, "pipe")).rejects.toThrow(NotFoundError);
    await listChanges(deps, run.id);
    const d = await fileDiff(deps, run.id, "pipe");
    expect(d.text === null || d.text === "").toBe(true);
    expect((await listDir(deps, run.id, "")).entries).toEqual(expect.arrayContaining([{ name: "pipe", kind: "other", size: null }]));
  });
});

describe("too many changes", () => {
  const injected = (fail: (args: string[]) => Error | null): ChangesDeps => {
    const runner: GitRunner = async (args, cwd, opts) => {
      const err = fail(args);
      if (err) throw err;
      return (await exec("git", args, { cwd, env: opts?.env, maxBuffer: opts?.maxBuffer, timeout: opts?.timeoutMs })).stdout;
    };
    return { ...deps, worktrees: new WorktreeManager(dataDir, runner) };
  };

  it("an over-large or slow listing is the tooMany state, never an error", async () => {
    write("notes.txt", "x\n");
    const big = await listChanges(injected((a) => (a.includes("--numstat") ? new GitOutputTooLargeError() : null)), run.id);
    expect(big).toMatchObject({ runId: run.id, files: [], truncated: true, tooMany: true });
    const slow = await listChanges(injected((a) => (a.includes("ls-files") ? new GitTimeoutError() : null)), run.id);
    expect(slow).toMatchObject({ files: [], truncated: true, tooMany: true });
    expect(await listChanges(deps, run.id)).toMatchObject({ truncated: false, tooMany: false });
  });
});

describe("names changed by cleaning", () => {
  it("are flagged and never served as a path (sorted by their real names)", async () => {
    write(`${KEY}.txt`, "x\n");
    write("plain.txt", "y\n");
    const c = await listChanges(deps, run.id);
    expect(c.files).toEqual([
      { path: "plain.txt", status: "untracked", added: null, deleted: null, binary: false },
      { path: "[REDACTED].txt", status: "untracked", added: null, deleted: null, binary: false, cleaned: true },
    ]);
    expect((await listDir(deps, run.id, "")).entries).toEqual([
      { name: "plain.txt", kind: "file", size: 2 },
      { name: "[REDACTED].txt", kind: "file", size: 2, cleaned: true },
    ]);
    await expect(readFile(deps, run.id, `${KEY}.txt`)).rejects.toThrow(NotFoundError);
    await expect(fileDiff(deps, run.id, `${KEY}.txt`)).rejects.toBeInstanceOf(NotFoundError);
    await expect(readFile(deps, run.id, "[REDACTED].txt")).rejects.toThrow(NotFoundError);
  });
});
