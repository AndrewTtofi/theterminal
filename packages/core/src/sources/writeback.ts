import { createHash, randomUUID } from "node:crypto";
import { chmodSync, constants, copyFileSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { IMPORT_LIMITS, type Actor, type ApplyResult, type WritebackPreview } from "@theterminal/shared";
import type { Db } from "../db.js";
import type { Ledger } from "../ledger/ledger.js";
import {
  GitScope, HooksDirModifiedError, SharedGitconfigModifiedError, UnsafeGitConfigError, type WorktreeManager,
} from "../agents/worktrees.js";
import { NotFoundError } from "../board/board-service.js";
import { RunActiveError } from "../changes/changes.js";
import { commitEvent } from "../events/commit.js";
import { getProjectSource, getRun, type ProjectSource } from "../events/projections.js";
import type { GitHubRepos } from "../github/repos.js";
import { FolderUnavailableError, ImportLimitError } from "./staging.js";

/** Merging the run's work into the project repo conflicted; the merge was aborted and nothing changed. */
export class MergeConflictError extends Error {
  constructor() {
    super("the run's changes conflict with the project's files");
    this.name = "MergeConflictError";
  }
}

/** The run's changes were accepted already. */
export class AlreadyAcceptedError extends Error {
  constructor() {
    super("the run's changes were already accepted");
    this.name = "AlreadyAcceptedError";
  }
}

/** The run cannot be accepted: it has no recorded fork point, so what it changed is unknown. */
export class NotAcceptableError extends Error {
  constructor() {
    super("this run's changes cannot be accepted");
    this.name = "NotAcceptableError";
  }
}

/** Nothing was accepted or added since the last sync with the source. */
export class NothingToWriteError extends Error {
  constructor() {
    super("there is nothing to write back");
    this.name = "NothingToWriteError";
  }
}

/** The project has no source of the kind asked for (a folder for Apply, GitHub for Publish, either for a preview). */
export class NoSourceError extends Error {
  constructor() {
    super("the project has no source to write back to");
    this.name = "NoSourceError";
  }
}

/** The preview the person confirmed no longer matches the project: HEAD or the last synced commit moved since. */
export class WritebackStaleError extends Error {
  constructor() {
    super("the project changed since the preview");
    this.name = "WritebackStaleError";
  }
}

/** What the service needs of the GitHub client. */
export type WritebackGitHub = Pick<GitHubRepos, "publish">;

export type WritebackServiceDeps = {
  db: Db;
  ledger: Ledger;
  worktrees: WorktreeManager;
  github: WritebackGitHub;
  dataDir: string;
  newId?: () => string;
  /** Whether a stopped run's agent may still be writing (runner.settling); such a run is not accepted yet. */
  settling?: (runId: string) => boolean;
};

type Change = { path: string; change: "add" | "modify" | "delete" };
type TreeEntry = { mode: string; type: string; id: string; size: number | null };

const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const GIT_LIST_MAX_BUFFER = 32 * 1024 * 1024;
const GIT_LONG_TIMEOUT_MS = 5 * 60_000;
const REGULAR_MODES = new Set(["100644", "100755"]);
const PUBLISH_TITLE = "Changes from The Terminal";
const APPLY_DIR = "apply";
const isWindows = process.platform === "win32";
const fold = (p: string): string => (isWindows ? p.toLowerCase() : p);
const errCode = (e: unknown): string | undefined => (e as NodeJS.ErrnoException).code;
/** Never follows a symlink, never blocks on a FIFO or device. */
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** Errors that mean runGit refused to run git at all: never reported as a merge conflict. */
const isRefusal = (e: unknown): boolean =>
  e instanceof UnsafeGitConfigError || e instanceof HooksDirModifiedError || e instanceof SharedGitconfigModifiedError;

/**
 * The git blob id of a file (`sha1("blob <size>\0" + bytes)`, or sha256 for a sha256 repository), hashed in-process
 * while streaming, so no git runs in the person's folder. The file is opened without following a symlink; anything
 * but a regular file, or a file whose size changes while it is read, throws.
 */
export async function gitBlobId(file: string, algorithm: "sha1" | "sha256" = "sha1"): Promise<string> {
  const handle = await open(file, OPEN_FLAGS);
  try {
    const st = await handle.stat();
    if (!st.isFile()) throw new Error("not a regular file");
    const hash = createHash(algorithm).update(`blob ${st.size}\0`);
    let total = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false, start: 0 })) {
      total += (chunk as Buffer).length;
      hash.update(chunk as Buffer);
    }
    if (total !== st.size) throw new Error("the file changed while it was read");
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

/** Whether `inner` is `outer` or inside it; both already canonical. */
function within(outer: string, inner: string): boolean {
  const rel = relative(outer, inner);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * Accepting a run's work into the project repo, and sending accepted work back to where the project's files came
 * from: "Apply to my folder" for a folder source, "Publish to GitHub" (a new branch and a pull request, never the
 * default branch) for a GitHub source. What is sent is the difference between the source's `syncedCommit` and HEAD,
 * shown in full by `preview` first; Apply and Publish refuse once HEAD or `syncedCommit` moved since that preview.
 * Every change of state is one ledger entry through `commitEvent`.
 */
export class WritebackService {
  private readonly newId: () => string;
  private readonly locks = new Map<string, Promise<unknown>>();
  /** The last preview of each project: the HEAD it showed and the synced commit it was computed from. */
  private readonly previews = new Map<string, { head: string; synced: string }>();

  constructor(private readonly deps: WritebackServiceDeps) {
    this.newId = deps.newId ?? randomUUID;
  }

  /**
   * Merges a finished run's work into the project repo's checked-out branch (`--no-ff`, `Accept run <id8>`): for a
   * run on this computer, a snapshot of its working copy (`snapshotRun`); for a run on a linked machine, the imported
   * `run/<id>` tip. A conflict aborts the merge and throws MergeConflictError with nothing changed. If recording
   * `run.accepted` fails, the repo is reset to where it was.
   */
  async accept(actor: Actor, runId: string): Promise<{ commit: string }> {
    const first = this.acceptable(runId);
    return this.locked(first.projectId, async () => {
      const run = this.acceptable(runId); // again inside the lock: a second accept waits, then sees the first
      const wt = this.deps.worktrees;
      const repo = await wt.ensureProjectRepo(run.projectId);
      const scope = new GitScope();
      const snapshot =
        run.machineId === null
          ? await wt.snapshotRun(run.projectId, runId)
          : (await wt.runGit(repo, ["rev-parse", "--verify", `refs/heads/run/${runId}^{commit}`], { scope })).trim();
      if (!COMMIT.test(snapshot)) throw new NotAcceptableError();
      const changed = await wt.runGit(
        repo, ["diff", "--name-only", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", run.base!, snapshot],
        { scope, maxBuffer: GIT_LIST_MAX_BUFFER },
      );
      const files = changed.split("\0").filter(Boolean).length;
      const previous = await this.head(repo, scope);
      try {
        await wt.runGit(repo, ["merge", "--no-ff", "--no-edit", "-m", `Accept run ${runId.slice(0, 8)}`, snapshot], {
          scope, timeoutMs: GIT_LONG_TIMEOUT_MS,
        });
      } catch (e) {
        if (isRefusal(e)) throw e;
        await wt.runGit(repo, ["merge", "--abort"], { scope }).catch(() => undefined);
        await this.resetTo(repo, previous, scope);
        throw new MergeConflictError();
      }
      const commit = await this.head(repo, scope);
      try {
        commitEvent(this.deps.db, this.deps.ledger, () => ({
          event: { projectId: run.projectId, actor, type: "run.accepted", payload: { runId, commit, files } },
          result: () => undefined,
        }));
      } catch (e) {
        await this.resetTo(repo, previous, scope);
        throw e;
      }
      return { commit };
    });
  }

  /**
   * What write-back would send: every path changed between the source's `syncedCommit` and HEAD. Remembers the HEAD
   * and synced commit it showed, which Apply and Publish check. NothingToWriteError when nothing changed;
   * ImportLimitError when the change is over IMPORT_LIMITS.
   */
  async preview(projectId: string): Promise<WritebackPreview> {
    return this.locked(projectId, async () => {
      const source = this.source(projectId, null);
      const { head, files } = await this.changes(projectId, source, new GitScope());
      this.previews.set(projectId, { head, synced: source.syncedCommit });
      return { kind: source.kind, head, files };
    });
  }

  /**
   * Writes the previewed change into the person's folder. Only the listed paths are touched. A path is skipped (and
   * reported) when the folder's file differs from the file as it was copied in (compared by git blob id, hashed
   * here), when a file was added to the folder at a path the change adds, or when the target or any folder on its way
   * is a symlink or not where the path says. Files are written through a temporary file and a rename. Then
   * `project.folder_applied` moves the synced commit to HEAD.
   */
  async apply(actor: Actor, projectId: string, head: string): Promise<ApplyResult> {
    return this.locked(projectId, async () => {
      const source = this.source(projectId, "folder");
      const scope = new GitScope();
      await this.assertFresh(projectId, source, head, scope);
      const root = this.folderRoot(source.path);
      const { files } = await this.changes(projectId, source, scope);
      const repo = this.deps.worktrees.repoPath(projectId);
      const algorithm = source.syncedCommit.length === 64 ? "sha256" : "sha1";
      const synced = await this.tree(repo, source.syncedCommit, scope);
      const now = await this.tree(repo, head, scope);
      const writes = files.filter((f) => f.change !== "delete").map((f) => f.path);
      const dir = join(this.deps.dataDir, "projects", projectId, APPLY_DIR, this.newId());
      mkdirSync(dir, { recursive: true });
      let written = 0;
      let deleted = 0;
      const skipped: string[] = [];
      try {
        await this.deps.worktrees.materialise(projectId, head, writes, dir);
        for (const f of files) {
          const target = this.target(root, f.path);
          const before = synced.get(f.path);
          if (target === null || !(await this.unchanged(target, before, algorithm))) {
            skipped.push(f.path);
            continue;
          }
          if (f.change === "delete") {
            if (target.exists) {
              unlinkSync(target.abs);
              deleted += 1;
            }
            continue;
          }
          const staged = join(dir, ...f.path.split("/"));
          const entry = now.get(f.path);
          const st = lstatSync(staged, { throwIfNoEntry: false });
          if (entry === undefined || !REGULAR_MODES.has(entry.mode) || st === undefined || !st.isFile()) {
            skipped.push(f.path);
            continue;
          }
          if (!this.write(root, target.abs, f.path, staged, entry.mode === "100755")) {
            skipped.push(f.path);
            continue;
          }
          written += 1;
        }
      } finally {
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      }
      commitEvent(this.deps.db, this.deps.ledger, () => ({
        event: {
          projectId, actor, type: "project.folder_applied",
          payload: { projectId, from: source.syncedCommit, to: head, written, deleted, skipped: skipped.length },
        },
        result: () => undefined,
      }));
      this.previews.delete(projectId);
      return { written, deleted, skipped };
    });
  }

  /**
   * Publishes the previewed change as one commit on a new branch `the-terminal/<8 hex>` whose parent is the imported
   * `remoteCommit`, and a pull request against the recorded branch. Never writes to an existing branch. The synced
   * commit stays where it is (the pull request is not merged); `project.published` records the pull request.
   */
  async publish(actor: Actor, projectId: string, head: string): Promise<{ branch: string; pullUrl: string }> {
    return this.locked(projectId, async () => {
      const source = this.source(projectId, "github");
      const scope = new GitScope();
      await this.assertFresh(projectId, source, head, scope);
      if (source.repo === null || source.branch === null || source.remoteCommit === null) throw new NoSourceError();
      const { files } = await this.changes(projectId, source, scope);
      const repo = this.deps.worktrees.repoPath(projectId);
      const now = await this.tree(repo, head, scope);
      const sent: { path: string; mode: "100644" | "100755"; content: Buffer | null }[] = [];
      const writes = files.filter((f) => f.change !== "delete" && REGULAR_MODES.has(now.get(f.path)?.mode ?? "")).map((f) => f.path);
      const dir = join(this.deps.dataDir, "projects", projectId, APPLY_DIR, this.newId());
      mkdirSync(dir, { recursive: true });
      try {
        await this.deps.worktrees.materialise(projectId, head, writes, dir);
        for (const f of files) {
          if (f.change === "delete") {
            sent.push({ path: f.path, mode: "100644", content: null });
            continue;
          }
          const entry = now.get(f.path);
          if (entry === undefined || !REGULAR_MODES.has(entry.mode)) continue; // a symlink or submodule is not sent
          const staged = join(dir, ...f.path.split("/"));
          const st = lstatSync(staged, { throwIfNoEntry: false });
          if (st === undefined || !st.isFile()) continue;
          sent.push({ path: f.path, mode: entry.mode as "100644" | "100755", content: readFileSync(staged) });
        }
      } finally {
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      }
      if (sent.length === 0) throw new NothingToWriteError();
      const branch = `the-terminal/${this.shortId()}`;
      if (branch === source.branch) throw new Error("refusing to publish to the recorded branch");
      const runs = await this.acceptedRuns(projectId, repo, source.syncedCommit, head, scope);
      const body =
        `This pull request has the changes of ${plural(runs, "accepted run", "accepted runs")} ` +
        `(${plural(sent.length, "file", "files")}), sent from The Terminal.`;
      const out = await this.deps.github.publish(source.repo, {
        base: source.remoteCommit, into: source.branch, branch, files: sent, title: PUBLISH_TITLE, body,
      });
      commitEvent(this.deps.db, this.deps.ledger, () => ({
        event: {
          projectId, actor, type: "project.published",
          payload: { projectId, branch: out.branch, pullUrl: out.pullUrl, from: source.syncedCommit, to: head, files: sent.length },
        },
        result: () => undefined,
      }));
      this.previews.delete(projectId);
      return { branch: out.branch, pullUrl: out.pullUrl };
    });
  }

  /** The run, if it can be accepted: finished and settled, not accepted yet, with a fork point. */
  private acceptable(runId: string): { projectId: string; machineId: string | null; base: string | null } {
    const run = getRun(this.deps.db, runId);
    if (!run) throw new NotFoundError("run", runId);
    if (run.status === "running" || this.deps.settling?.(runId) === true) throw new RunActiveError();
    if (run.acceptedCommit) throw new AlreadyAcceptedError();
    if (run.base === null || !COMMIT.test(run.base)) throw new NotAcceptableError();
    return run;
  }

  /** The project's source, of `kind` when one is given; NoSourceError otherwise. */
  private source(projectId: string, kind: "folder" | "github" | null): ProjectSource {
    const s = getProjectSource(this.deps.db, projectId);
    if (s === null || (kind !== null && s.kind !== kind)) throw new NoSourceError();
    return s;
  }

  /** HEAD must be the head the last preview showed, and the synced commit the one it was computed from. */
  private async assertFresh(projectId: string, source: ProjectSource, head: string, scope: GitScope): Promise<void> {
    const shown = this.previews.get(projectId);
    if (typeof head !== "string" || !COMMIT.test(head) || shown === undefined) throw new WritebackStaleError();
    if (shown.head !== head || shown.synced !== source.syncedCommit) throw new WritebackStaleError();
    if ((await this.head(this.deps.worktrees.repoPath(projectId), scope)) !== head) throw new WritebackStaleError();
  }

  /** The change from the synced commit to HEAD, checked against IMPORT_LIMITS. */
  private async changes(projectId: string, source: ProjectSource, scope: GitScope): Promise<{ head: string; files: Change[] }> {
    const repo = this.deps.worktrees.repoPath(projectId);
    const head = await this.head(repo, scope);
    const out = await this.deps.worktrees.runGit(
      repo,
      ["diff", "--name-status", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", "--ignore-submodules=none", source.syncedCommit, head],
      { scope, maxBuffer: GIT_LIST_MAX_BUFFER },
    );
    const parts = out.split("\0");
    const files: Change[] = [];
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const status = parts[i]!.charAt(0);
      const path = parts[i + 1]!;
      if (path === "") continue;
      files.push({ path, change: status === "A" ? "add" : status === "D" ? "delete" : "modify" });
    }
    if (files.length === 0) throw new NothingToWriteError();
    if (files.length > IMPORT_LIMITS.files) throw new ImportLimitError("files");
    const tree = await this.tree(repo, head, scope);
    let bytes = 0;
    for (const f of files) {
      if (f.change === "delete") continue;
      const size = tree.get(f.path)?.size ?? 0;
      if (size > IMPORT_LIMITS.fileBytes) throw new ImportLimitError("file_bytes");
      bytes += size;
    }
    if (bytes > IMPORT_LIMITS.bytes) throw new ImportLimitError("bytes");
    return { head, files };
  }

  /** Every entry of `commit`'s tree, recursively: path to mode, type, object id and size. */
  private async tree(repo: string, commit: string, scope: GitScope): Promise<Map<string, TreeEntry>> {
    const out = await this.deps.worktrees.runGit(repo, ["ls-tree", "-r", "-l", "-z", commit], { scope, maxBuffer: GIT_LIST_MAX_BUFFER });
    const map = new Map<string, TreeEntry>();
    for (const line of out.split("\0")) {
      const tab = line.indexOf("\t");
      if (tab < 0) continue;
      const [mode, type, id, size] = line.slice(0, tab).split(/ +/);
      map.set(line.slice(tab + 1), { mode: mode!, type: type!, id: id!, size: size === undefined || size === "-" ? null : Number(size) });
    }
    return map;
  }

  private async head(repo: string, scope: GitScope): Promise<string> {
    const h = (await this.deps.worktrees.runGit(repo, ["rev-parse", "--verify", "HEAD^{commit}"], { scope })).trim();
    if (!COMMIT.test(h)) throw new Error("the project repo has no HEAD");
    return h;
  }

  private async resetTo(repo: string, commit: string, scope: GitScope): Promise<void> {
    if ((await this.head(repo, scope).catch(() => null)) === commit) return;
    await this.deps.worktrees.runGit(repo, ["reset", "--hard", "-q", commit], { scope, timeoutMs: GIT_LONG_TIMEOUT_MS });
  }

  /** The folder's real path, which must be an existing directory; FolderUnavailableError otherwise. */
  private folderRoot(path: string | null): string {
    if (path === null || !isAbsolute(path)) throw new FolderUnavailableError();
    try {
      const real = realpathSync.native(path);
      if (!lstatSync(real).isDirectory()) throw new FolderUnavailableError();
      return real;
    } catch {
      throw new FolderUnavailableError();
    }
  }

  /**
   * Where `path` is in the folder, never through a symlink: every existing folder on the way must be a real
   * directory (not a symlink or junction) and still inside the root, and the target itself, when it exists, must be
   * a regular file. Null otherwise.
   */
  private target(root: string, path: string): { abs: string; exists: boolean } | null {
    const segments = path.split("/");
    if (segments.some((s) => s === "" || s === "." || s === ".." || s.includes("\\") || s.includes("\0"))) return null;
    let at = root;
    for (const [i, s] of segments.entries()) {
      at = join(at, s);
      let st;
      try {
        st = lstatSync(at);
      } catch (e) {
        if (errCode(e) === "ENOENT") return { abs: join(root, ...segments), exists: false };
        return null;
      }
      const last = i === segments.length - 1;
      if (st.isSymbolicLink()) return null;
      if (last) return st.isFile() ? { abs: at, exists: true } : null;
      if (!st.isDirectory()) return null;
      try {
        if (!within(fold(root), fold(realpathSync.native(at)))) return null;
      } catch {
        return null;
      }
    }
    return null;
  }

  /**
   * Whether the folder's file is as it was copied in: its blob id equals the synced tree's, or both are absent. A file
   * the synced tree lacks that is now present, a file it has that is now gone, or one that cannot be hashed is changed.
   */
  private async unchanged(target: { abs: string; exists: boolean }, before: TreeEntry | undefined, algorithm: "sha1" | "sha256"): Promise<boolean> {
    if (before === undefined) return !target.exists;
    if (!target.exists || before.type !== "blob" || !REGULAR_MODES.has(before.mode)) return false;
    try {
      return (await gitBlobId(target.abs, algorithm)) === before.id;
    } catch {
      return false;
    }
  }

  /**
   * Writes the staged file at `abs` through a temporary file beside it and a rename. Missing folders on the way are
   * made one at a time, each checked again (no symlink, still inside the root) after it exists. False when the
   * target cannot be written safely.
   */
  private write(root: string, abs: string, path: string, staged: string, executable: boolean): boolean {
    const segments = path.split("/");
    let at = root;
    for (const s of segments.slice(0, -1)) {
      at = join(at, s);
      try {
        mkdirSync(at);
      } catch (e) {
        if (errCode(e) !== "EEXIST") return false;
      }
      try {
        const st = lstatSync(at);
        if (st.isSymbolicLink() || !st.isDirectory() || !within(fold(root), fold(realpathSync.native(at)))) return false;
      } catch {
        return false;
      }
    }
    const tmp = join(at, `.${segments[segments.length - 1]}.theterminal-${this.newId()}.tmp`);
    try {
      copyFileSync(staged, tmp, constants.COPYFILE_EXCL);
      if (!isWindows) chmodSync(tmp, executable ? 0o755 : 0o644);
      const st = lstatSync(abs, { throwIfNoEntry: false });
      if (st !== undefined && !st.isFile()) throw new Error("the target is no longer a regular file");
      renameSync(tmp, abs);
      return true;
    } catch {
      rmSync(tmp, { force: true });
      return false;
    }
  }

  /** How many of the project's accepted runs are in the change (their accept commit is between synced and HEAD). */
  private async acceptedRuns(projectId: string, repo: string, synced: string, head: string, scope: GitScope): Promise<number> {
    const out = await this.deps.worktrees.runGit(repo, ["rev-list", `${synced}..${head}`], { scope, maxBuffer: GIT_LIST_MAX_BUFFER });
    const commits = new Set(out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
    const rows = this.deps.db
      .prepare("SELECT accepted_commit FROM agent_runs WHERE project_id = ? AND accepted_commit IS NOT NULL")
      .all(projectId) as { accepted_commit: string }[];
    return rows.filter((r) => commits.has(r.accepted_commit)).length;
  }

  /** Eight lowercase hex characters from newId (a UUID by default), or random ones when it gives fewer. */
  private shortId(): string {
    const hex = this.newId().toLowerCase().replace(/[^0-9a-f]/g, "");
    return hex.length >= 8 ? hex.slice(0, 8) : randomUUID().replace(/-/g, "").slice(0, 8);
  }

  /** Runs `fn` after all earlier write-back work for the same project has settled. */
  private locked<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(projectId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => undefined);
    this.locks.set(projectId, tail);
    void tail.then(() => {
      if (this.locks.get(projectId) === tail) this.locks.delete(projectId);
    });
    return next;
  }
}
