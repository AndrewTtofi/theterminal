import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IMPORT_LIMITS, OWNER_ID, type LedgerEntry } from "@theterminal/shared";
import { openDatabase, type Db } from "../../src/db.js";
import { Ledger } from "../../src/ledger/ledger.js";
import { BoardService } from "../../src/board/board-service.js";
import { WorktreeManager } from "../../src/agents/worktrees.js";
import { redact } from "../../src/agents/redact.js";
import { getProjectSource, rebuildAllProjections } from "../../src/events/projections.js";
import { ImportLimitError, PathRefusedError, PossibleSecretsError } from "../../src/sources/staging.js";
import { FolderRefusedError } from "../../src/sources/folder.js";
import { SourceService, UploadBusyError, UploadNotFoundError, type SourceGitHub } from "../../src/sources/service.js";
import { tgz, type FixtureEntry } from "./tar-fixture.js";
import { plainGit } from "../fixtures/submodule-trap.js";

const GIT_TEST_TIMEOUT_MS = process.platform === "win32" ? 40_000 : 15_000;
vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT_MS, hookTimeout: GIT_TEST_TIMEOUT_MS });

const owner = { kind: "human", id: OWNER_ID } as const;
const maintainer = { kind: "human", id: "m1" } as const;
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const ROOT = "octo-site-0123456/";

let base: string;
let dataDir: string;
let folder: string;
let db: Db;
let ledger: Ledger;
let board: BoardService;
let wt: WorktreeManager;
let clock: Date;

function makeService(github: SourceGitHub = fakeGitHub([])): SourceService {
  return new SourceService({ db, ledger, worktrees: wt, board, github, dataDir, redact: (s) => redact(s), now: () => clock });
}

function fakeGitHub(entries: FixtureEntry[]): SourceGitHub & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async head(repo) {
      calls.push(`head ${repo}`);
      return { branch: "main", commit: COMMIT };
    },
    async tarball(repo, commit) {
      calls.push(`tarball ${repo} ${commit}`);
      return Readable.from([tgz(entries)]);
    },
  };
}

const write = (rel: string, content: string | Buffer) => {
  const p = join(folder, ...rel.split("/"));
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
};

const git = (projectId: string, args: string[]) => wt.runGit(wt.repoPath(projectId), args);
const headTree = async (projectId: string) => (await git(projectId, ["ls-tree", "-r", "--name-only", "-z", "HEAD"])).split("\0").filter(Boolean).sort();
const entriesOf = (type: string): LedgerEntry[] => ledger.list({ afterSeq: 0, limit: 1000 }).filter((e) => e.type === type);
/** Every staging directory still on disk, anywhere under the data folder. */
function stagingDirs(): string[] {
  const out: string[] = [];
  const top = join(dataDir, "staging");
  if (existsSync(top)) out.push(...readdirSync(top).map((d) => join(top, d)));
  const projects = join(dataDir, "projects");
  if (existsSync(projects)) {
    for (const p of readdirSync(projects)) {
      const s = join(projects, p, "staging");
      if (existsSync(s)) out.push(...readdirSync(s).map((d) => join(s, d)));
    }
  }
  return out;
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "sources-")));
  dataDir = join(base, "data");
  folder = join(base, "my-folder");
  mkdirSync(dataDir);
  mkdirSync(folder);
  db = openDatabase(":memory:");
  ledger = new Ledger(db);
  board = new BoardService(db, ledger);
  wt = new WorktreeManager(dataDir);
  clock = new Date("2026-11-15T10:00:00.000Z");
});
afterEach(() => {
  db.close();
  rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("createFromFolder", () => {
  beforeEach(() => {
    write("a.txt", "alpha\n");
    write("src/b.ts", "export const b = 1;\n");
    write(".env", "TOKEN=TESTKEY\n");
  });

  it("refuses possible secrets unless included: no project, no staging left", async () => {
    const s = makeService();
    const err = await s.createFromFolder(owner, { path: folder }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PossibleSecretsError);
    expect((err as PossibleSecretsError).names).toEqual([".env"]);
    expect(board.listProjects()).toEqual([]);
    expect(ledger.list({ afterSeq: 0, limit: 10 })).toEqual([]);
    expect(stagingDirs()).toEqual([]);
  });

  it("with secrets included, creates the project, commits every file and records the source and the import", async () => {
    const s = makeService();
    const { project, result } = await s.createFromFolder(owner, { path: folder, includeSecrets: true });
    expect(project.name).toBe("my-folder");
    expect(await headTree(project.id)).toEqual([".env", "a.txt", "src/b.ts"]);
    const head = (await git(project.id, ["rev-parse", "HEAD"])).trim();
    expect((await git(project.id, ["log", "-1", "--format=%s"])).trim()).toBe("Imported from a folder");
    const bytes = "alpha\n".length + "export const b = 1;\n".length + "TOKEN=TESTKEY\n".length;
    expect(result).toEqual({ commit: head, files: 3, bytes, skipped: [], skippedCount: 0 });

    const [set] = entriesOf("project.source_set");
    expect(set!.projectId).toBe(project.id);
    expect(set!.actor).toEqual(owner);
    expect(set!.payload).toEqual({ projectId: project.id, kind: "folder", path: folder, syncedCommit: head });
    const [imported] = entriesOf("project.files_imported");
    expect(imported!.payload).toEqual({
      projectId: project.id, from: "folder", commit: head, files: 3, bytes, skipped: 0, secretsIncluded: true,
    });
    expect(getProjectSource(db, project.id)).toEqual({
      projectId: project.id, kind: "folder", repo: null, branch: null, remoteCommit: null, path: folder, syncedCommit: head,
    });
    expect(stagingDirs()).toEqual([]);
  });

  it("uses a given name, records secretsIncluded false without secret names, and skips links and nested repos", async () => {
    rmSync(join(folder, ".env"));
    const outside = join(base, "outside.txt");
    writeFileSync(outside, "outside");
    let linked = true;
    try {
      symlinkSync(outside, join(folder, "link.txt"));
    } catch {
      linked = false; // Windows without the symlink privilege
    }
    write("nested/x.txt", "x");
    await plainGit(join(folder, "nested"), "init", "-q");
    const s = makeService();
    const { project, result } = await s.createFromFolder(owner, { path: folder, name: "Club site" });
    expect(project.name).toBe("Club site");
    expect(await headTree(project.id)).toEqual(["a.txt", "src/b.ts"]);
    const reasons = Object.fromEntries(result.skipped.map((x) => [x.path, x.reason]));
    if (linked) expect(reasons["link.txt"]).toBe("link");
    expect(reasons.nested).toBe("nested");
    expect(entriesOf("project.files_imported")[0]!.payload).toMatchObject({ secretsIncluded: false, files: 2 });
  });

  it("refuses the data folder before creating anything", async () => {
    const s = makeService();
    await expect(s.createFromFolder(owner, { path: dataDir })).rejects.toBeInstanceOf(FolderRefusedError);
    expect(board.listProjects()).toEqual([]);
  });

  it("rebuilds getProjectSource exactly from the ledger", async () => {
    const s = makeService();
    const { project } = await s.createFromFolder(owner, { path: folder, includeSecrets: true });
    const before = getProjectSource(db, project.id);
    const dump = () => ["project_sources", "project_imports"].map((t) => db.prepare(`SELECT * FROM ${t} ORDER BY 1`).all());
    const live = dump();
    rebuildAllProjections(db, ledger);
    expect(getProjectSource(db, project.id)).toEqual(before);
    expect(dump()).toEqual(live);
  });
});

describe("createFromGitHub", () => {
  it("imports the archive, records repo, branch and remoteCommit, and skips a symlink entry", async () => {
    const gh = fakeGitHub([
      { name: ROOT, type: "5", mode: 0o755 },
      { name: `${ROOT}README.md`, body: "# Site\n" },
      { name: `${ROOT}src/`, type: "5", mode: 0o755 },
      { name: `${ROOT}src/index.ts`, body: "console.log(1);\n" },
      { name: `${ROOT}evil`, type: "2", linkname: "/etc/passwd" },
    ]);
    const s = makeService(gh);
    const { project, result } = await s.createFromGitHub(maintainer, { repo: "octo/site" });
    expect(gh.calls).toEqual(["head octo/site", `tarball octo/site ${COMMIT}`]);
    expect(project.name).toBe("site");
    expect(await headTree(project.id)).toEqual(["README.md", "src/index.ts"]);
    expect((await git(project.id, ["log", "-1", "--format=%s"])).trim()).toBe("Imported from GitHub: octo/site");
    expect(result.files).toBe(2);
    expect(result.skippedCount).toBe(1);
    expect(result.skipped).toEqual([{ path: "evil", reason: "link" }]);
    const head = (await git(project.id, ["rev-parse", "HEAD"])).trim();
    expect(entriesOf("project.source_set")[0]!.payload).toEqual({
      projectId: project.id, kind: "github", repo: "octo/site", branch: "main", remoteCommit: COMMIT, syncedCommit: head,
    });
    expect(entriesOf("project.files_imported")[0]!.payload).toMatchObject({ from: "github", files: 2, skipped: 1, secretsIncluded: false });
    expect(stagingDirs()).toEqual([]);
  });

  it("maps an archive over the file size limit to ImportLimitError and creates nothing", async () => {
    const gh = fakeGitHub([{ name: `${ROOT}big.bin`, body: Buffer.alloc(16), size: IMPORT_LIMITS.fileBytes + 1 }]);
    const s = makeService(gh);
    const err = await s.createFromGitHub(maintainer, { repo: "octo/site" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ImportLimitError);
    expect((err as ImportLimitError).limit).toBe("file_bytes");
    expect(board.listProjects()).toEqual([]);
    expect(stagingDirs()).toEqual([]);
  });
});

describe("uploads", () => {
  let projectId: string;
  beforeEach(() => {
    projectId = board.createProject(owner, { name: "Club" }).id;
  });
  const body = (s: string | Buffer) => Readable.from([Buffer.isBuffer(s) ? s : Buffer.from(s)]);

  it("open, put two files, commit: one commit `Added 2 files` and project.files_imported from files", async () => {
    const s = makeService();
    const { uploadId } = s.openUpload(maintainer, projectId, { files: 2, bytes: 6, includeSecrets: false });
    await s.putUploadFile(maintainer, uploadId, "a.txt", body("abc"));
    await s.putUploadFile(maintainer, uploadId, "docs\\b.md", body("def"));
    const result = await s.commitUpload(maintainer, uploadId);
    const head = (await git(projectId, ["rev-parse", "HEAD"])).trim();
    expect(result).toEqual({ commit: head, files: 2, bytes: 6, skipped: [], skippedCount: 0 });
    expect((await git(projectId, ["log", "-1", "--format=%s"])).trim()).toBe("Added 2 files");
    expect(await headTree(projectId)).toEqual(["a.txt", "docs/b.md"]);
    expect(entriesOf("project.files_imported").map((e) => [e.actor, e.payload])).toEqual([[
      maintainer, { projectId, from: "files", commit: head, files: 2, bytes: 6, skipped: 0, secretsIncluded: false },
    ]]);
    expect(stagingDirs()).toEqual([]);
    // A put after the commit finds nothing.
    await expect(s.putUploadFile(maintainer, uploadId, "c.txt", body("x"))).rejects.toBeInstanceOf(UploadNotFoundError);
  });

  it("another person's put, an unknown upload, and a cancelled one give UploadNotFoundError", async () => {
    const s = makeService();
    const { uploadId } = s.openUpload(maintainer, projectId, { files: 1, bytes: 1, includeSecrets: false });
    await expect(s.putUploadFile(owner, uploadId, "a.txt", body("a"))).rejects.toBeInstanceOf(UploadNotFoundError);
    await expect(s.commitUpload(owner, uploadId)).rejects.toBeInstanceOf(UploadNotFoundError);
    expect(() => s.cancelUpload(owner, uploadId)).toThrow(UploadNotFoundError);
    await expect(s.putUploadFile(maintainer, "nope", "a.txt", body("a"))).rejects.toBeInstanceOf(UploadNotFoundError);
    s.cancelUpload(maintainer, uploadId);
    expect(stagingDirs()).toEqual([]);
    await expect(s.putUploadFile(maintainer, uploadId, "a.txt", body("a"))).rejects.toBeInstanceOf(UploadNotFoundError);
  });

  it("refuses a bad path at its put without reading the body", async () => {
    const s = makeService();
    const { uploadId } = s.openUpload(maintainer, projectId, { files: 1, bytes: 1, includeSecrets: false });
    const b = body("never read");
    const err = await s.putUploadFile(maintainer, uploadId, "../x", b).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PathRefusedError);
    expect((err as PathRefusedError).reason).toBe("dot_dot");
    expect(b.readableFlowing).toBeNull();
    await s.putUploadFile(maintainer, uploadId, "A.txt", body("a"));
    await expect(s.putUploadFile(maintainer, uploadId, "a.txt", body("a"))).rejects.toMatchObject({ reason: "duplicate" });
  });

  it("checks the declared totals and refuses a fifth open upload", () => {
    const s = makeService();
    expect(() => s.openUpload(maintainer, projectId, { files: IMPORT_LIMITS.files + 1, bytes: 1, includeSecrets: false }))
      .toThrow(expect.objectContaining({ limit: "files" }));
    expect(() => s.openUpload(maintainer, projectId, { files: 1, bytes: IMPORT_LIMITS.bytes + 1, includeSecrets: false }))
      .toThrow(expect.objectContaining({ limit: "bytes" }));
    for (let i = 0; i < 4; i++) s.openUpload(maintainer, projectId, { files: 1, bytes: 1, includeSecrets: false });
    expect(() => s.openUpload(maintainer, projectId, { files: 1, bytes: 1, includeSecrets: false })).toThrow(UploadBusyError);
  });

  it("counts streamed bytes, not content-length", async () => {
    const s = makeService();
    // Declared as one byte; the stream sends more than the per-file limit.
    const { uploadId } = s.openUpload(maintainer, projectId, { files: 1, bytes: 1, includeSecrets: false });
    const chunk = Buffer.alloc(1024 * 1024);
    let sent = 0;
    const flood = new Readable({
      read() {
        if (sent > IMPORT_LIMITS.fileBytes) return void this.push(null);
        sent += chunk.length;
        this.push(chunk);
      },
    });
    const err = await s.putUploadFile(maintainer, uploadId, "big.bin", flood).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ImportLimitError);
    expect((err as ImportLimitError).limit).toBe("file_bytes");
    // A broken limit refuses the whole upload: nothing left to commit, and its staging folder is gone.
    expect(stagingDirs()).toEqual([]);
    await expect(s.commitUpload(maintainer, uploadId)).rejects.toBeInstanceOf(UploadNotFoundError);
    expect(entriesOf("project.files_imported")).toEqual([]);
  });

  it("refuses a commit holding possible secrets unless they were included", async () => {
    const s = makeService();
    const a = s.openUpload(maintainer, projectId, { files: 1, bytes: 1, includeSecrets: false });
    await s.putUploadFile(maintainer, a.uploadId, ".env", body("K=TESTKEY"));
    await expect(s.commitUpload(maintainer, a.uploadId)).rejects.toEqual(new PossibleSecretsError([".env"]));
    expect(entriesOf("project.files_imported")).toEqual([]);
    const b = s.openUpload(maintainer, projectId, { files: 1, bytes: 1, includeSecrets: true });
    await s.putUploadFile(maintainer, b.uploadId, ".env", body("K=TESTKEY"));
    await s.commitUpload(maintainer, b.uploadId);
    expect(entriesOf("project.files_imported")[0]!.payload).toMatchObject({ files: 1, secretsIncluded: true });
  });

  it("sweeps expired uploads", async () => {
    const s = makeService();
    const { uploadId } = s.openUpload(maintainer, projectId, { files: 1, bytes: 1, includeSecrets: false });
    await s.putUploadFile(maintainer, uploadId, "a.txt", body("a"));
    expect(stagingDirs()).toHaveLength(1);
    s.sweep(new Date(clock.getTime() + 59 * 60_000));
    expect(stagingDirs()).toHaveLength(1);
    s.sweep(new Date(clock.getTime() + 61 * 60_000));
    expect(stagingDirs()).toEqual([]);
    await expect(s.commitUpload(maintainer, uploadId)).rejects.toBeInstanceOf(UploadNotFoundError);
  });

  it("sweep removes staging folders left behind by an earlier server", () => {
    const left = join(dataDir, "projects", projectId, "staging", "00000000-0000-4000-8000-000000000000");
    mkdirSync(left, { recursive: true });
    writeFileSync(join(left, "a.txt"), "a");
    makeService().sweep(clock);
    expect(stagingDirs()).toEqual([]);
  });
});

describe("projectFiles", () => {
  it("lists the top level of HEAD, directories first, with the folder path only for the Owner", async () => {
    write("b.txt", "bb");
    write("a.txt", "a");
    write("src/x.ts", "x");
    write("docs/y.md", "y");
    const s = makeService();
    const { project } = await s.createFromFolder(owner, { path: folder });
    const head = (await git(project.id, ["rev-parse", "HEAD"])).trim();
    const forOwner = await s.projectFiles(project.id, { personId: OWNER_ID });
    expect(forOwner).toEqual({
      source: { kind: "folder", path: folder },
      added: true,
      head,
      entries: [
        { name: "docs", kind: "dir", size: null },
        { name: "src", kind: "dir", size: null },
        { name: "a.txt", kind: "file", size: 1 },
        { name: "b.txt", kind: "file", size: 2 },
      ],
      truncated: false,
    });
    for (const who of [{ personId: "r1" }, null]) {
      const f = await s.projectFiles(project.id, who);
      expect(f.source).toEqual({ kind: "folder" });
      expect(JSON.stringify(f)).not.toContain(folder);
    }
  });

  it("a project with no source and no imports says so", async () => {
    const projectId = board.createProject(owner, { name: "Empty" }).id;
    const f = await makeService().projectFiles(projectId, { personId: OWNER_ID });
    expect(f).toMatchObject({ source: null, added: false, entries: [], truncated: false });
    expect(f.head).toMatch(/^[0-9a-f]{40}$/);
  });
});
