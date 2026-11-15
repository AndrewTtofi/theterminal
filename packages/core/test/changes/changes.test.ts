import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_CHANGED_FILES, MAX_FILE_BYTES, type AgentRun } from "@theterminal/shared";
import { ApprovalBroker } from "../../src/agents/approvals.js";
import { FakeAdapter } from "../../src/agents/fake-adapter.js";
import { AgentRunner } from "../../src/agents/runner.js";
import { WorktreeManager } from "../../src/agents/worktrees.js";
import { BoardService, NotFoundError } from "../../src/board/board-service.js";
import {
  NoBaseError, WorktreeMissingError, fileDiff, listChanges, listDir, readFile, runWorktree, type ChangesDeps,
} from "../../src/changes/changes.js";
import { openDatabase, type Db } from "../../src/db.js";
import { getRun } from "../../src/events/projections.js";
import { Ledger } from "../../src/ledger/ledger.js";

const owner = { kind: "human", id: "owner" } as const;
const KEY = "zq-TESTKEY-e2e-opaque-0000000000";
const exec = promisify(execFile);
const testEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_/i.test(k)));

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
  run = await runner.start(owner, { projectId, adapter: "fake", prompt: "go" });
  await vi.waitFor(() => expect(getRun(db, run.id)!.status).not.toBe("running"), { timeout: 5000 });
  deps = { db, dataDir, worktrees, clean: (id, s, max) => runner.cleanFor(id)(s, max) };
  wt = join(dataDir, run.worktree);
});
afterEach(async () => {
  await runner.shutdown();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

const write = (rel: string, content: string | Buffer) => writeFileSync(join(wt, rel), content);
/** Commits `files` to the project repository and moves the run's branch onto it, so they are part of the fork point. */
const advanceBase = async (files: Record<string, string>) => {
  const repo = worktrees.repoPath(run.projectId);
  for (const [rel, content] of Object.entries(files)) writeFileSync(join(repo, rel), content);
  await worktrees.runGit(repo, ["add", "-A"]);
  await worktrees.runGit(repo, ["commit", "--no-verify", "-m", "base"]);
  await worktrees.runGit(wt, ["reset", "--hard", (await worktrees.runGit(repo, ["rev-parse", "HEAD"])).trim()]);
};
const commitAll = async () => {
  await worktrees.runGit(wt, ["add", "-A"]);
  await worktrees.runGit(wt, ["commit", "--no-verify", "-m", "agent work"]);
};

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
    await advanceBase({ "a.txt": "one\ntwo\n", "gone.txt": "bye\n" });
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

  it("fails closed with NoBaseError when the fork point cannot be found", async () => {
    rmSync(join(worktrees.repoPath(run.projectId), ".git", "refs", "heads"), { recursive: true, force: true });
    rmSync(join(worktrees.repoPath(run.projectId), ".git", "packed-refs"), { force: true });
    writeFileSync(join(worktrees.repoPath(run.projectId), ".git", "HEAD"), "ref: refs/heads/nowhere\n");
    await expect(listChanges(deps, run.id)).rejects.toBeInstanceOf(NoBaseError);
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
    await advanceBase({ "same.txt": "same\n" });
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
    const l = listDir(deps, run.id, "");
    expect(l).toMatchObject({ runId: run.id, path: "", truncated: false });
    expect(l.entries).toEqual([
      { name: "src", kind: "dir", size: null },
      { name: "notes.txt", kind: "file", size: 3 },
    ]);
    expect(listDir(deps, run.id, "src").entries).toEqual([]);
    expect(() => listDir(deps, run.id, "notes.txt")).toThrow(NotFoundError);
  });

  it("reads a file, cleaning secrets and the worktree's absolute path", () => {
    write("notes.txt", `key=${KEY}\nat ${join(wt, "x")}\n`);
    const f = readFile(deps, run.id, "notes.txt");
    expect(f).toMatchObject({ runId: run.id, path: "notes.txt", binary: false, tooLarge: false });
    expect(f.text).toContain("key=[REDACTED]");
    expect(f.text).not.toContain(wt);
    expect(f.text).toMatch(/at \.[\\/]x/);
    expect(() => readFile(deps, run.id, "")).toThrow(NotFoundError);
  });

  it("a 2 MiB file is tooLarge; the cap counts bytes (Review Focus 4)", () => {
    write("big.txt", Buffer.alloc(2 * 1024 * 1024, 0x61));
    expect(readFile(deps, run.id, "big.txt")).toMatchObject({ size: 2 * 1024 * 1024, tooLarge: true, binary: false, text: null });
    write("wide.txt", "\u00e9".repeat(MAX_FILE_BYTES / 2 + 1)); // fewer characters than the cap, more bytes
    expect(readFile(deps, run.id, "wide.txt")).toMatchObject({ tooLarge: true, text: null });
    write("fits.txt", "\u00e9".repeat(MAX_FILE_BYTES / 2)); // exactly the cap in bytes
    const fits = readFile(deps, run.id, "fits.txt");
    expect(fits).toMatchObject({ size: MAX_FILE_BYTES, tooLarge: false });
    expect(fits.text).toHaveLength(MAX_FILE_BYTES / 2);
  });

  it("a NUL byte in the first 8 KiB makes a file binary with no text", () => {
    write("blob.bin", Buffer.from([0x41, 0, 0x42]));
    expect(readFile(deps, run.id, "blob.bin")).toMatchObject({ size: 3, binary: true, tooLarge: false, text: null });
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
    for (const p of ["../token", "../../../../etc/hosts", "/etc/hosts", join(outside, "x"), ".git", ".git/config", "sub/.git/config"]) {
      await rejectsAll(p);
    }
    if (process.platform === "win32") await rejectsAll("C:\\Windows\\win.ini");
  });

  describe.skipIf(process.platform === "win32")("symlinks", () => {
    it("refuses a symlink to a file outside and a dangling symlink", async () => {
      writeFileSync(join(outside, "secret"), "s");
      symlinkSync(join(outside, "secret"), join(wt, "flink"));
      symlinkSync(outside, join(wt, "dlink"));
      symlinkSync(join(outside, "planted"), join(wt, "dangling"));
      for (const p of ["flink", "dlink", "dlink/secret", "dangling"]) await rejectsAll(p);
      const names = listDir(deps, run.id, "").entries;
      expect(names).toEqual(expect.arrayContaining([{ name: "flink", kind: "other", size: null }]));
    });
  });

  it("a deleted worktree is WorktreeMissingError for every view", async () => {
    rmSync(wt, { recursive: true, force: true });
    await expect(listChanges(deps, run.id)).rejects.toBeInstanceOf(WorktreeMissingError);
    await expect(fileDiff(deps, run.id, "a.txt")).rejects.toBeInstanceOf(WorktreeMissingError);
    expect(() => listDir(deps, run.id, "")).toThrow(WorktreeMissingError);
    expect(() => readFile(deps, run.id, "a.txt")).toThrow(WorktreeMissingError);
  });
});

describe.skipIf(process.platform === "win32")("agent-planted git configuration never runs (R2)", () => {
  it("ignores a planted filter driver, textconv, external diff and hooks", async () => {
    const marker = join(outside, "ran");
    const evil = join(outside, "evil.sh");
    writeFileSync(evil, `#!/bin/sh\necho "$0 $*" >> "${marker}"\nif [ -n "$1" ] && [ -f "$1" ]; then cat "$1"; else cat; fi\n`);
    chmodSync(evil, 0o755);
    write("a.txt", "one\n");
    await commitAll();

    const repo = worktrees.repoPath(run.projectId);
    const plant = (...args: string[]) => exec("git", ["config", ...args], { cwd: repo, env: testEnv() });
    await plant("filter.evil.clean", evil);
    await plant("filter.evil.smudge", evil);
    await plant("filter.evil.required", "true");
    await plant("diff.evil.textconv", evil);
    await plant("diff.external", evil);
    for (const hook of ["post-index-change", "reference-transaction", "pre-commit", "post-checkout"]) {
      writeFileSync(join(repo, ".git", "hooks", hook), `#!/bin/sh\necho hook >> "${marker}"\n`);
      chmodSync(join(repo, ".git", "hooks", hook), 0o755);
    }
    write(".gitattributes", "* filter=evil diff=evil\n");
    write("a.txt", "one\ntwo\n");
    write("b.txt", "new\n");

    const c = await listChanges(deps, run.id);
    expect(c.files.map((f) => f.path)).toEqual([".gitattributes", "a.txt", "b.txt"]);
    expect((await fileDiff(deps, run.id, "a.txt")).text).toContain("+two");
    await fileDiff(deps, run.id, "b.txt");
    readFile(deps, run.id, "a.txt");
    listDir(deps, run.id, "");
    await worktrees.runGit(wt, ["commit", "--allow-empty", "-m", "x"]);
    expect(existsSync(marker)).toBe(false);

    // Control: the same repository, read by plain git, does run the planted program.
    await exec("git", ["diff", "HEAD"], { cwd: wt, env: testEnv() });
    expect(existsSync(marker)).toBe(true);
  });
});
