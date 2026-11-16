import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OWNER_ID, type LedgerEntry } from "@theterminal/shared";
import { openDatabase, type Db } from "../../src/db.js";
import { Ledger } from "../../src/ledger/ledger.js";
import { BoardService } from "../../src/board/board-service.js";
import { WorktreeManager, type GitRunner } from "../../src/agents/worktrees.js";
import { redact } from "../../src/agents/redact.js";
import { commitEvent } from "../../src/events/commit.js";
import { getRun } from "../../src/events/projections.js";
import { RunActiveError } from "../../src/changes/changes.js";
import { FolderUnavailableError } from "../../src/sources/staging.js";
import { SourceService, type SourceGitHub } from "../../src/sources/service.js";
import {
  AlreadyAcceptedError, MergeConflictError, NoSourceError, NothingToWriteError, WritebackService, WritebackStaleError,
  gitBlobId, type WritebackGitHub,
} from "../../src/sources/writeback.js";
import { tgz, type FixtureEntry } from "./tar-fixture.js";

const GIT_TEST_TIMEOUT_MS = process.platform === "win32" ? 60_000 : 20_000;
vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT_MS, hookTimeout: GIT_TEST_TIMEOUT_MS });

const owner = { kind: "human", id: OWNER_ID } as const;
const REMOTE = "0123456789abcdef0123456789abcdef01234567";
const ROOT = "octo-site-0123456/";

let base: string;
let dataDir: string;
let folder: string;
let db: Db;
let ledger: Ledger;
let board: BoardService;
let wt: WorktreeManager;

type PublishCall = { repo: string; i: Parameters<WritebackGitHub["publish"]>[1] };

function fakePublisher(): WritebackGitHub & { calls: PublishCall[] } {
  const calls: PublishCall[] = [];
  return {
    calls,
    async publish(repo, i) {
      calls.push({ repo, i });
      return { branch: i.branch, pullUrl: "https://github.com/octo/site/pull/7" };
    },
  };
}

function fakeSourceGitHub(entries: FixtureEntry[]): SourceGitHub {
  return {
    async head() {
      return { branch: "main", commit: REMOTE };
    },
    async tarball() {
      return Readable.from([tgz(entries)]);
    },
  };
}

function sources(github: SourceGitHub = fakeSourceGitHub([])): SourceService {
  return new SourceService({ db, ledger, worktrees: wt, board, github, dataDir, redact: (s) => redact(s) });
}

function writeback(github: WritebackGitHub = fakePublisher()): WritebackService {
  return new WritebackService({ db, ledger, worktrees: wt, github, dataDir });
}

const put = (root: string, rel: string, content: string | Buffer): void => {
  const p = join(root, ...rel.split("/"));
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
};

const git = (projectId: string, args: string[]) => wt.runGit(wt.repoPath(projectId), args);
const head = async (projectId: string) => (await git(projectId, ["rev-parse", "HEAD"])).trim();
const headTree = async (projectId: string) =>
  (await git(projectId, ["ls-tree", "-r", "--name-only", "-z", "HEAD"])).split("\0").filter(Boolean).sort();
const entriesOf = (type: string): LedgerEntry[] => ledger.list({ afterSeq: 0, limit: 1000 }).filter((e) => e.type === type);

/** A run whose working copy gets `files` (null deletes), finished unless `running`. */
async function run(projectId: string, runId: string, files: Record<string, string | Buffer | null>, running = false): Promise<void> {
  const w = await wt.createRunWorktree(projectId, runId);
  commitEvent(db, ledger, () => ({
    event: {
      projectId, actor: owner, type: "agent.started",
      payload: { runId, adapter: "fake", authMode: "none", prompt: "change things", cardId: null, worktree: w.relPath, base: w.base },
    },
    result: () => undefined,
  }));
  for (const [rel, content] of Object.entries(files)) {
    if (content === null) unlinkSync(join(w.absPath, ...rel.split("/")));
    else put(w.absPath, rel, content);
  }
  if (running) return;
  commitEvent(db, ledger, () => ({
    event: { projectId, actor: owner, type: "agent.finished", payload: { runId, status: "completed", costUsd: null, error: null } },
    result: () => undefined,
  }));
}

async function folderProject(files: Record<string, string>): Promise<string> {
  for (const [rel, content] of Object.entries(files)) put(folder, rel, content);
  const { project } = await sources().createFromFolder(owner, { path: folder });
  return project.id;
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "writeback-")));
  dataDir = join(base, "data");
  folder = join(base, "my-folder");
  mkdirSync(dataDir);
  mkdirSync(folder);
  db = openDatabase(":memory:");
  ledger = new Ledger(db);
  board = new BoardService(db, ledger);
  wt = new WorktreeManager(dataDir);
});

afterEach(() => {
  db.close();
  rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("accept", () => {
  it("merges a run that wrote a.txt, records run.accepted, and refuses a second accept", async () => {
    const projectId = await folderProject({ "keep.txt": "keep\n" });
    await run(projectId, "run-aaaa1111", { "a.txt": "from the run\n" });
    const w = writeback();
    const { commit } = await w.accept(owner, "run-aaaa1111");
    expect(await head(projectId)).toBe(commit);
    expect(await headTree(projectId)).toEqual(["a.txt", "keep.txt"]);
    expect((await git(projectId, ["log", "-1", "--format=%s"])).trim()).toBe("Accept run run-aaaa");
    expect((await git(projectId, ["rev-list", "--parents", "-n", "1", "HEAD"])).trim().split(" ")).toHaveLength(3);
    expect(getRun(db, "run-aaaa1111")!.acceptedCommit).toBe(commit);
    expect(entriesOf("run.accepted")[0]!.payload).toEqual({ runId: "run-aaaa1111", commit, files: 1 });
    await expect(w.accept(owner, "run-aaaa1111")).rejects.toBeInstanceOf(AlreadyAcceptedError);
  });

  it("two runs editing the same line: the second accept is a MergeConflictError and nothing changes", async () => {
    const projectId = await folderProject({ "a.txt": "one\n" });
    await run(projectId, "run-first111", { "a.txt": "first\n" });
    await run(projectId, "run-second22", { "a.txt": "second\n" });
    const w = writeback();
    await w.accept(owner, "run-first111");
    const before = await head(projectId);
    await expect(w.accept(owner, "run-second22")).rejects.toBeInstanceOf(MergeConflictError);
    expect(await head(projectId)).toBe(before);
    expect((await git(projectId, ["status", "--porcelain"])).trim()).toBe("");
    expect(readFileSync(join(wt.repoPath(projectId), "a.txt"), "utf8")).toBe("first\n");
    expect(getRun(db, "run-second22")!.acceptedCommit ?? null).toBeNull();
    expect(entriesOf("run.accepted")).toHaveLength(1);
  });

  it("refuses a running run with RunActiveError", async () => {
    const projectId = await folderProject({ "a.txt": "one\n" });
    await run(projectId, "run-live1111", { "b.txt": "x\n" }, true);
    await expect(writeback().accept(owner, "run-live1111")).rejects.toBeInstanceOf(RunActiveError);
  });

  it("an accept overlapping a commit of added files waits for it in the project's queue, and both land", async () => {
    const projectId = await folderProject({ "keep.txt": "keep\n" });
    await run(projectId, "run-cccc3333", { "a.txt": "from the run\n" });
    // Holds the accept just before its merge, and the commit of added files once it has staged them (its index dirty).
    const holder = wt as unknown as { git: GitRunner };
    const real = holder.git;
    let atMerge!: () => void;
    const mergeReached = new Promise<void>((r) => (atMerge = r));
    let releaseMerge!: () => void;
    const mergeGate = new Promise<void>((r) => (releaseMerge = r));
    let releaseCommit!: () => void;
    const commitGate = new Promise<void>((r) => (releaseCommit = r));
    let staged = false;
    holder.git = async (args, cwd, opts) => {
      if (args.includes("merge") && args.includes("--no-ff")) {
        atMerge();
        await mergeGate;
      }
      if (args.includes("diff") && args.includes("--cached")) {
        staged = true;
        await commitGate;
      }
      return real(args, cwd, opts);
    };
    const accepting = writeback().accept(owner, "run-cccc3333");
    await mergeReached;
    const stagingDir = join(base, "staged");
    put(stagingDir, "added.txt", "added\n");
    const committing = wt.commitFiles(projectId, stagingDir, ["added.txt"], "Added 1 file");
    // Without the project lock, the commit stages its file now, while the merge is about to run.
    const until = Date.now() + 2000;
    while (!staged && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
    releaseMerge();
    const accepted = await accepting.then((v) => v, (e: unknown) => e);
    releaseCommit();
    await committing;
    expect(accepted).not.toBeInstanceOf(Error);
    expect(getRun(db, "run-cccc3333")!.acceptedCommit).toBe((accepted as { commit: string }).commit);
    expect(await headTree(projectId)).toEqual(["a.txt", "added.txt", "keep.txt"]);
    expect((await git(projectId, ["status", "--porcelain"])).trim()).toBe("");
  });
});

describe("apply", () => {
  it("writes the accepted files with exact bytes, skips files changed since the import, and deletes only unchanged files", async () => {
    const projectId = await folderProject({ "keep.txt": "keep\n", "old.txt": "old\n", "edited.txt": "v1\n", "gone.txt": "g\n" });
    const binary = Buffer.from([0, 1, 2, 0x0d, 0x0a, 255, 0, 10]);
    await run(projectId, "run-apply111", { "a.txt": binary, "edited.txt": "from the run\n", "old.txt": null, "gone.txt": null });
    const w = writeback();
    await w.accept(owner, "run-apply111");
    // The person edits one file in their folder after the import, and adds one of their own.
    put(folder, "edited.txt", "my own edit\n");
    put(folder, "mine.txt", "untouched\n");

    const preview = await w.preview(projectId);
    expect(preview.kind).toBe("folder");
    expect(preview.head).toBe(await head(projectId));
    expect([...preview.files].sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: "a.txt", change: "add" },
      { path: "edited.txt", change: "modify" },
      { path: "gone.txt", change: "delete" },
      { path: "old.txt", change: "delete" },
    ]);
    const result = await w.apply(owner, projectId, preview.head);
    expect(result).toEqual({ written: 1, deleted: 2, skipped: ["edited.txt"] });
    expect(readFileSync(join(folder, "a.txt")).equals(binary)).toBe(true);
    expect(readFileSync(join(folder, "edited.txt"), "utf8")).toBe("my own edit\n");
    expect(existsSync(join(folder, "old.txt"))).toBe(false);
    expect(existsSync(join(folder, "gone.txt"))).toBe(false);
    expect(readFileSync(join(folder, "keep.txt"), "utf8")).toBe("keep\n");
    expect(readFileSync(join(folder, "mine.txt"), "utf8")).toBe("untouched\n");
    const applied = entriesOf("project.folder_applied");
    expect(applied).toHaveLength(1);
    expect(applied[0]!.payload).toMatchObject({ projectId, to: preview.head, written: 1, deleted: 2, skipped: 1 });

    await expect(w.preview(projectId)).rejects.toBeInstanceOf(NothingToWriteError);
  });

  it("skips a file that is new to the folder since the import, and a delete of a changed file", async () => {
    const projectId = await folderProject({ "old.txt": "old\n" });
    await run(projectId, "run-clash111", { "new.txt": "run's\n", "old.txt": null });
    const w = writeback();
    await w.accept(owner, "run-clash111");
    put(folder, "new.txt", "person's\n");
    put(folder, "old.txt", "changed\n");
    const preview = await w.preview(projectId);
    const result = await w.apply(owner, projectId, preview.head);
    expect(result.written).toBe(0);
    expect(result.deleted).toBe(0);
    expect([...result.skipped].sort()).toEqual(["new.txt", "old.txt"]);
    expect(readFileSync(join(folder, "new.txt"), "utf8")).toBe("person's\n");
    expect(readFileSync(join(folder, "old.txt"), "utf8")).toBe("changed\n");
  });

  it("refuses a stale head, and a second apply of the same preview", async () => {
    const projectId = await folderProject({ "keep.txt": "keep\n" });
    await run(projectId, "run-stale111", { "a.txt": "a\n" });
    const w = writeback();
    await w.accept(owner, "run-stale111");
    const preview = await w.preview(projectId);
    await expect(w.apply(owner, projectId, "f".repeat(40))).rejects.toBeInstanceOf(WritebackStaleError);
    expect(existsSync(join(folder, "a.txt"))).toBe(false);
    await w.apply(owner, projectId, preview.head);
    await expect(w.apply(owner, projectId, preview.head)).rejects.toBeInstanceOf(WritebackStaleError);
    expect(entriesOf("project.folder_applied")).toHaveLength(1);
  });

  it("refuses a head the preview did not show, after more work was accepted", async () => {
    const projectId = await folderProject({ "keep.txt": "keep\n" });
    await run(projectId, "run-more1111", { "a.txt": "a\n" });
    await run(projectId, "run-more2222", { "b.txt": "b\n" });
    const w = writeback();
    await w.accept(owner, "run-more1111");
    const preview = await w.preview(projectId);
    await w.accept(owner, "run-more2222");
    await expect(w.apply(owner, projectId, preview.head)).rejects.toBeInstanceOf(WritebackStaleError);
    expect(existsSync(join(folder, "a.txt"))).toBe(false);
  });

  it("writes only what the preview showed, even when files are added between the freshness check and the diff", async () => {
    const projectId = await folderProject({ "keep.txt": "keep\n" });
    await run(projectId, "run-pin11111", { "a.txt": "a\n" });
    const w = writeback();
    await w.accept(owner, "run-pin11111");
    const preview = await w.preview(projectId);
    // Right after apply has checked HEAD, an upload commits another file.
    const holder = wt as unknown as { git: GitRunner };
    const real = holder.git;
    let fired = false;
    holder.git = async (args, cwd, opts) => {
      const out = await real(args, cwd, opts);
      if (!fired && args.includes("rev-parse") && args.includes("HEAD^{commit}")) {
        fired = true;
        const stagingDir = join(base, "staged-late");
        put(stagingDir, "late.txt", "late\n");
        await wt.commitFiles(projectId, stagingDir, ["late.txt"], "Added 1 file");
      }
      return out;
    };
    const result = await w.apply(owner, projectId, preview.head);
    holder.git = real;
    expect(fired).toBe(true);
    expect(result).toEqual({ written: 1, deleted: 0, skipped: [] });
    expect(existsSync(join(folder, "late.txt"))).toBe(false);
    expect(entriesOf("project.folder_applied")[0]!.payload).toMatchObject({ to: preview.head });
  });

  it("publishes only what the preview showed, even when files are added between the freshness check and the diff", async () => {
    const { project } = await sources(
      fakeSourceGitHub([
        { name: ROOT, type: "5", mode: 0o755 },
        { name: `${ROOT}README.md`, body: "# Site\n" },
      ]),
    ).createFromGitHub(owner, { repo: "octo/site" });
    await run(project.id, "run-pin22222", { "README.md": "# Site, better\n" });
    const gh = fakePublisher();
    const w = writeback(gh);
    await w.accept(owner, "run-pin22222");
    const preview = await w.preview(project.id);
    const holder = wt as unknown as { git: GitRunner };
    const real = holder.git;
    let fired = false;
    holder.git = async (args, cwd, opts) => {
      const out = await real(args, cwd, opts);
      if (!fired && args.includes("rev-parse") && args.includes("HEAD^{commit}")) {
        fired = true;
        const stagingDir = join(base, "staged-late");
        put(stagingDir, "late.txt", "late\n");
        await wt.commitFiles(project.id, stagingDir, ["late.txt"], "Added 1 file");
      }
      return out;
    };
    await w.publish(owner, project.id, preview.head);
    holder.git = real;
    expect(fired).toBe(true);
    expect(gh.calls[0]!.i.files.map((f) => f.path)).toEqual(["README.md"]);
  });

  it("a folder renamed away is FolderUnavailableError, and nothing is written", async () => {
    const projectId = await folderProject({ "keep.txt": "keep\n" });
    await run(projectId, "run-gone1111", { "a.txt": "a\n" });
    const w = writeback();
    await w.accept(owner, "run-gone1111");
    const preview = await w.preview(projectId);
    const moved = join(base, "moved-away");
    renameSync(folder, moved);
    await expect(w.apply(owner, projectId, preview.head)).rejects.toBeInstanceOf(FolderUnavailableError);
    expect(existsSync(folder)).toBe(false);
    expect(existsSync(join(moved, "a.txt"))).toBe(false);
    expect(entriesOf("project.folder_applied")).toHaveLength(0);
  });

  it.skipIf(process.platform === "win32")("never follows a symlink in the folder", async () => {
    const outside = join(base, "outside");
    mkdirSync(outside);
    const projectId = await folderProject({ "keep.txt": "keep\n" });
    await run(projectId, "run-link1111", { "sub/x.txt": "x\n", "keep.txt": "changed by the run\n" });
    const w = writeback();
    await w.accept(owner, "run-link1111");
    // After the import the person's folder gets a directory symlink where the run wrote a directory, and keep.txt
    // becomes a symlink to a file outside.
    symlinkSync(outside, join(folder, "sub"));
    put(outside, "target.txt", "outside\n");
    unlinkSync(join(folder, "keep.txt"));
    symlinkSync(join(outside, "target.txt"), join(folder, "keep.txt"));
    const preview = await w.preview(projectId);
    const result = await w.apply(owner, projectId, preview.head);
    expect([...result.skipped].sort()).toEqual(["keep.txt", "sub/x.txt"]);
    expect(existsSync(join(outside, "x.txt"))).toBe(false);
    expect(readFileSync(join(outside, "target.txt"), "utf8")).toBe("outside\n");
  });
});

describe("publish", () => {
  it("publishes the accepted change on a new branch from remoteCommit, and records project.published", async () => {
    const { project } = await sources(
      fakeSourceGitHub([
        { name: ROOT, type: "5", mode: 0o755 },
        { name: `${ROOT}README.md`, body: "# Site\n" },
        { name: `${ROOT}old.txt`, body: "old\n" },
      ]),
    ).createFromGitHub(owner, { repo: "octo/site" });
    await run(project.id, "run-pub11111", { "README.md": "# Site, better\n", "old.txt": null });
    const gh = fakePublisher();
    const w = writeback(gh);
    await w.accept(owner, "run-pub11111");
    const preview = await w.preview(project.id);
    expect(preview.kind).toBe("github");
    const out = await w.publish(owner, project.id, preview.head);
    expect(out.pullUrl).toBe("https://github.com/octo/site/pull/7");
    expect(out.branch).toMatch(/^the-terminal\/[0-9a-f]{8}$/);
    expect(gh.calls).toHaveLength(1);
    const call = gh.calls[0]!;
    expect(call.repo).toBe("octo/site");
    expect(call.i.base).toBe(REMOTE);
    expect(call.i.into).toBe("main");
    expect(call.i.branch).toBe(out.branch);
    expect(call.i.branch).not.toBe("main");
    expect(call.i.title).toBe("Changes from The Terminal");
    expect(call.i.body).toMatch(/1 accepted run/);
    const files = [...call.i.files].sort((a, b) => (a.path < b.path ? -1 : 1));
    expect(files.map((f) => [f.path, f.mode, f.content === null ? null : f.content.toString("utf8")])).toEqual([
      ["README.md", "100644", "# Site, better\n"],
      ["old.txt", "100644", null],
    ]);
    const published = entriesOf("project.published");
    expect(published).toHaveLength(1);
    expect(published[0]!.payload).toMatchObject({ projectId: project.id, branch: out.branch, pullUrl: out.pullUrl, to: preview.head, files: 2 });
  });

  it("a project without a source is NoSourceError", async () => {
    const project = board.createProject(owner, { name: "Plain" });
    await wt.ensureProjectRepo(project.id);
    const w = writeback();
    await expect(w.preview(project.id)).rejects.toBeInstanceOf(NoSourceError);
    await expect(w.publish(owner, project.id, "f".repeat(40))).rejects.toBeInstanceOf(NoSourceError);
    await expect(w.apply(owner, project.id, "f".repeat(40))).rejects.toBeInstanceOf(NoSourceError);
  });
});

describe("gitBlobId", () => {
  it("is git's blob id of the file", async () => {
    const f = join(base, "hello.txt");
    writeFileSync(f, "hello\n");
    expect(await gitBlobId(f)).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
  });
});
