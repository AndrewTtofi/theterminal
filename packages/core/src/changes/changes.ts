import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import {
  MAX_CHANGED_FILES, MAX_DIFF_BYTES, MAX_DIFF_LINES, MAX_DIR_ENTRIES, MAX_FILE_BYTES,
  type AgentRun, type ChangeStatus, type ChangedFile, type DirEntry, type DirListing, type FileContent, type FileDiff,
  type RunChanges,
} from "@theterminal/shared";
import { NotFoundError } from "../board/board-service.js";
import type { Db } from "../db.js";
import { getRun } from "../events/projections.js";
import {
  GitOutputTooLargeError, GitTimeoutError, HooksDirModifiedError, SharedGitconfigModifiedError, UnsafeGitConfigError,
  type WorktreeManager,
} from "../agents/worktrees.js";

/**
 * Read-only views of a run's working copy: what it changed compared with its fork point, one file's diff, a
 * directory listing and a file's text. Every path goes through `resolveInside`, `.git` is never listed or served,
 * every git call goes through `runGit` (no hooks, filters, textconv or external diff), and every string served
 * passes the run's cleaning before any limit is applied. Limits are in bytes of UTF-8 where they say bytes.
 */

/** The run's working copy no longer exists on disk. */
export class WorktreeMissingError extends Error {
  constructor() {
    super("the run's working copy no longer exists");
    this.name = "WorktreeMissingError";
  }
}

/** The fork point of the run's branch from the project repository's HEAD could not be found. */
export class NoBaseError extends Error {
  constructor() {
    super("could not determine what this run changed");
    this.name = "NoBaseError";
  }
}

/** The message shown while a run is live. */
export const RUN_ACTIVE_MESSAGE = "Changes show when the run is stopped or finished.";

/**
 * The run is live (`running`, which includes waiting on a decision): its working copy is still changing, so none of
 * its views is served and no git process is started on it.
 */
export class RunActiveError extends Error {
  constructor(message = RUN_ACTIVE_MESSAGE) {
    super(message);
    this.name = "RunActiveError";
  }
}

export type ChangesDeps = {
  db: Db;
  dataDir: string;
  worktrees: WorktreeManager;
  /** The run's cleaning: redact, scrub paths, redact, then truncate to `max` characters. */
  clean: (runId: string, s: string, max: number) => string;
};

/** Bytes read to decide whether a file is binary (a NUL byte in them). */
const SNIFF_BYTES = 8192;
const NAME_MAX = 255;
const PATH_MAX = 4096;
const COMMIT_ID = /^[0-9a-f]{40,64}$/;
const DIFF_FLAGS = ["--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "--ignore-submodules=all"];
const STATUS: Record<string, ChangeStatus> = { A: "added", M: "modified", D: "deleted", T: "typechange" };

const notFound = (): NotFoundError => new NotFoundError("path", "(given)");
/** Never follows a symlink, never blocks on a FIFO or device. */
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
/** A pathspec git matches as written, never as a glob or with magic. */
const literal = (rel: string): string => `:(literal)${rel}`;
/**
 * Whether a path segment names the git directory. Case is ignored everywhere. On Windows a name is also the same as
 * `.git` after the trailing dots and spaces and any `:stream` suffix are dropped, and `GIT~<n>` may be its short
 * name, so those are refused too.
 */
export function isGitSegment(name: string, platform: NodeJS.Platform = process.platform): boolean {
  const n = name.toLowerCase();
  if (n === ".git") return true;
  if (platform !== "win32") return false;
  const base = n.split(":")[0]!.replace(/[. ]+$/, "");
  return base === ".git" || /^git~\d+$/.test(base);
}
const isGitName = (name: string): boolean => isGitSegment(name);

/** Errors that mean the workspace refused to run git at all; never reported as "no base". */
const isRefusal = (e: unknown): boolean =>
  e instanceof UnsafeGitConfigError || e instanceof HooksDirModifiedError || e instanceof SharedGitconfigModifiedError;

/**
 * The worktree of a run that is not live: NotFoundError for an unknown run, RunActiveError while it runs (checked
 * before anything touches its worktree), then runWorktree's checks.
 */
function stoppedRunWorktree(deps: ChangesDeps, runId: string): { run: AgentRun; abs: string } {
  const run = getRun(deps.db, runId);
  if (!run) throw new NotFoundError("run", runId);
  if (run.status === "running") throw new RunActiveError();
  return runWorktree(deps, runId);
}

export function runWorktree(deps: ChangesDeps, runId: string): { run: AgentRun; abs: string } {
  const run = getRun(deps.db, runId);
  if (!run) throw new NotFoundError("run", runId);
  const abs = join(deps.dataDir, run.worktree);
  let isDir = false;
  try {
    isDir = statSync(abs).isDirectory();
  } catch {
    // missing or unreadable: the same answer
  }
  if (!isDir) throw new WorktreeMissingError();
  return { run, abs };
}

/**
 * The resolved path for `path` inside the worktree, and the path as git names it (relative, `/`-separated).
 * Refuses (NotFoundError, with no detail) an absolute path, any `.git` segment, anything resolveInside refuses, and
 * a path that the run's cleaning would change.
 */
function confine(deps: ChangesDeps, runId: string, abs: string, path: string): { resolved: string; rel: string } {
  if (typeof path !== "string" || path.length > PATH_MAX) throw notFound();
  if (isAbsolute(path) || /^[A-Za-z]:/.test(path) || path.startsWith("\\")) throw notFound();
  if (path.split(/[\\/]/).some(isGitName)) throw notFound();
  const resolved = deps.worktrees.resolveInside(abs, path);
  if (resolved === null) throw notFound();
  const rel = path
    .split(sep === "\\" ? /[\\/]/ : "/")
    .filter((s) => s !== "" && s !== ".")
    .join("/");
  // A path that cleaning would change is never served: it holds a secret or a private path.
  if (deps.clean(runId, rel, PATH_MAX) !== rel) throw notFound();
  return { resolved, rel };
}

/**
 * Opens `resolved` (what resolveInside gave for `rel`) only if it is a regular file, never through a symlink and
 * never blocking, then checks that what was opened is still what the path names: the descriptor's device and inode
 * match an lstat of the path taken before and after opening, and resolveInside still gives the same path (so a
 * parent directory swapped for a symlink in between is caught). Null, with nothing left open, otherwise.
 *
 * A residual race remains in principle: a parent directory swapped for a symlink after the last check but while
 * the file is read. It needs something writing into the worktree during the request, and every view refuses a live
 * run (RunActiveError) before touching its worktree, so the only writer that could do it, the run's agent, has
 * stopped. (A human override, Task 3, is exclusive with the run and runs as the Owner.)
 */
function openChecked(deps: ChangesDeps, abs: string, rel: string, resolved: string): { fd: number; size: number } | null {
  let before;
  try {
    before = lstatSync(resolved);
  } catch {
    return null;
  }
  if (!before.isFile()) return null; // never open a FIFO, socket or device
  let fd: number;
  try {
    fd = openSync(resolved, OPEN_FLAGS);
  } catch {
    return null;
  }
  try {
    const st = fstatSync(fd);
    const after = lstatSync(resolved);
    const same = (a: { dev: number; ino: number }) => a.dev === st.dev && a.ino === st.ino;
    if (st.isFile() && same(before) && same(after) && deps.worktrees.resolveInside(abs, rel) === resolved) {
      return { fd, size: st.size };
    }
  } catch {
    // fall through: refused
  }
  closeSync(fd);
  return null;
}

/**
 * Reads a checked regular file (openChecked) only if it is at most `max` bytes, reading at most `max + 1` bytes so
 * a file that grows meanwhile is still caught. `buf` is null when it is over `max`; null overall when it is refused.
 */
function readCapped(deps: ChangesDeps, abs: string, rel: string, resolved: string, max: number): { size: number; buf: Buffer | null } | null {
  const opened = openChecked(deps, abs, rel, resolved);
  if (opened === null) return null;
  const { fd, size } = opened;
  try {
    if (size > max) return { size, buf: null };
    const buf = Buffer.alloc(max + 1);
    let n = 0;
    for (;;) {
      const got = readSync(fd, buf, n, buf.length - n, n);
      if (got === 0) break;
      n += got;
      if (n > max) return { size: Math.max(size, n), buf: null };
    }
    return { size: n, buf: buf.subarray(0, n) };
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

const hasNul = (buf: Buffer): boolean => buf.subarray(0, SNIFF_BYTES).includes(0);

/** Whether an untracked file looks binary, from its first 8 KiB; anything that is not a regular file inside is not. */
function sniffBinary(deps: ChangesDeps, abs: string, rel: string): boolean {
  const resolved = deps.worktrees.resolveInside(abs, rel);
  if (resolved === null) return false;
  const opened = openChecked(deps, abs, rel, resolved);
  if (opened === null) return false;
  try {
    const buf = Buffer.alloc(SNIFF_BYTES);
    return hasNul(buf.subarray(0, readSync(opened.fd, buf, 0, SNIFF_BYTES, 0)));
  } catch {
    return false;
  } finally {
    closeSync(opened.fd);
  }
}

/** Git in the run's worktree, pinned to its verified git directory and work tree. */
export type WorktreeGit = (args: string[]) => Promise<string>;

const isWindows = process.platform === "win32";
const fold = (p: string): string => (isWindows ? p.toLowerCase() : p);

/**
 * Checks that git sees the worktree as itself before anything is read through git: its top level is the worktree,
 * its git directory is exactly the project repository's entry for it (`<repo>/.git/worktrees/<name>`), and its
 * common directory is the project repository's own `.git`. A planted `core.worktree`, or a
 * `.git` file pointing anywhere else, fails with WorktreeMissingError. Every later call passes the verified
 * `--git-dir` and `--work-tree`, so neither can change in between.
 */
export async function verifiedGit(deps: ChangesDeps, run: AgentRun, abs: string): Promise<WorktreeGit> {
  let gitDir: string;
  try {
    const out = (await deps.worktrees.runGit(abs, ["rev-parse", "--show-toplevel", "--absolute-git-dir", "--git-common-dir"]))
      .split(/\r?\n/)
      .map((l) => l.trim());
    if (out.length < 3 || !out[0] || !out[1] || !out[2]) throw new WorktreeMissingError();
    const top = realpathSync.native(out[0]);
    gitDir = realpathSync.native(out[1]);
    const common = realpathSync.native(resolve(abs, out[2]));
    const repoGit = realpathSync.native(join(deps.worktrees.repoPath(run.projectId), ".git"));
    const entry = realpathSync.native(join(repoGit, "worktrees", basename(abs)));
    if (fold(top) !== fold(realpathSync.native(abs)) || fold(gitDir) !== fold(entry) || fold(common) !== fold(repoGit)) {
      throw new WorktreeMissingError();
    }
  } catch (e) {
    if (isRefusal(e)) throw e;
    throw new WorktreeMissingError();
  }
  return (args) => deps.worktrees.runGit(abs, args, { gitDir, workTree: abs });
}

/** The fork point (`merge-base HEAD <repo HEAD>`) and the run's HEAD; NoBaseError when either cannot be found. */
async function forkPoint(deps: ChangesDeps, run: AgentRun, git: WorktreeGit): Promise<{ base: string; head: string }> {
  try {
    const repoHead = (await deps.worktrees.runGit(deps.worktrees.repoPath(run.projectId), ["rev-parse", "--verify", "HEAD"])).trim();
    if (!COMMIT_ID.test(repoHead)) throw new NoBaseError();
    const base = (await git(["merge-base", "HEAD", repoHead])).trim();
    const head = (await git(["rev-parse", "--verify", "HEAD"])).trim();
    if (!COMMIT_ID.test(base) || !COMMIT_ID.test(head)) throw new NoBaseError();
    return { base, head };
  } catch (e) {
    if (isRefusal(e)) throw e;
    throw new NoBaseError();
  }
}

/** Tracked changes from `base` to the working tree, by path (optionally only those under one literal pathspec). */
async function trackedChanges(git: WorktreeGit, base: string, only?: string): Promise<Map<string, ChangedFile>> {
  const spec = ["--", ...(only === undefined ? [] : [literal(only)])];
  const [numstat, names] = await Promise.all([
    git(["diff", "--numstat", "-z", ...DIFF_FLAGS, base, ...spec]),
    git(["diff", "--name-status", "-z", ...DIFF_FLAGS, base, ...spec]),
  ]);
  const files = new Map<string, ChangedFile>();
  const tokens = names.split("\0");
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const code = tokens[i]!.charAt(0);
    const path = tokens[i + 1]!;
    if (path === "") continue;
    files.set(path, { path, status: STATUS[code] ?? "modified", added: null, deleted: null, binary: false });
  }
  for (const record of numstat.split("\0")) {
    const m = /^(-|\d+)\t(-|\d+)\t(.+)$/s.exec(record);
    if (!m) continue;
    const f = files.get(m[3]!);
    if (!f) continue;
    if (m[1] === "-" || m[2] === "-") f.binary = true;
    else {
      f.added = Number(m[1]);
      f.deleted = Number(m[2]);
    }
  }
  return files;
}

async function untrackedPaths(git: WorktreeGit, only?: string): Promise<string[]> {
  const out = await git([
    "ls-files", "--others", "--exclude-standard", "-z", ...(only === undefined ? [] : ["--", literal(only)]),
  ]);
  return out.split("\0").filter((p) => p !== "");
}

export async function listChanges(deps: ChangesDeps, runId: string): Promise<RunChanges> {
  const { run, abs } = stoppedRunWorktree(deps, runId);
  const git = await verifiedGit(deps, run, abs);
  const { base, head } = await forkPoint(deps, run, git);
  let tracked: Map<string, ChangedFile>;
  let untracked: string[];
  try {
    tracked = await trackedChanges(git, base);
    untracked = await untrackedPaths(git);
  } catch (e) {
    // The list itself is too large or too slow to read: say so instead of failing.
    if (e instanceof GitOutputTooLargeError || e instanceof GitTimeoutError) {
      return { runId, base, head, files: [], truncated: true, tooMany: true };
    }
    throw e;
  }
  const all: ChangedFile[] = [...tracked.values()];
  for (const path of untracked) {
    if (!tracked.has(path)) all.push({ path, status: "untracked", added: null, deleted: null, binary: false });
  }
  all.sort((a, b) => byName(a.path, b.path));
  const kept = all.slice(0, MAX_CHANGED_FILES);
  const files = kept.map((f): ChangedFile => {
    const path = deps.clean(runId, f.path, PATH_MAX);
    return {
      ...f,
      path,
      // A path that cleaning changed is never opened, so its contents are not even sniffed.
      ...(f.status === "untracked" && { binary: path === f.path && sniffBinary(deps, abs, f.path) }),
      ...(path !== f.path && { cleaned: true as const }),
    };
  });
  return { runId, base, head, files, truncated: all.length > MAX_CHANGED_FILES, tooMany: false };
}

export async function fileDiff(deps: ChangesDeps, runId: string, path: string): Promise<FileDiff> {
  const { run, abs } = stoppedRunWorktree(deps, runId);
  const { resolved, rel } = confine(deps, runId, abs, path);
  if (rel === "") throw notFound();
  const git = await verifiedGit(deps, run, abs);
  const { base } = await forkPoint(deps, run, git);
  const shown = deps.clean(runId, rel, PATH_MAX);
  const answer = (d: Omit<FileDiff, "runId" | "path">): FileDiff => ({ runId, path: shown, ...d });
  /** Cleans first, then applies the byte cap: over it the diff is tooLarge with no text, never cut. */
  const capped = (raw: string, d: Omit<FileDiff, "runId" | "path" | "text" | "tooLarge">): FileDiff => {
    const text = deps.clean(runId, raw, Infinity);
    const tooLarge = Buffer.byteLength(text, "utf8") > MAX_DIFF_BYTES;
    return answer({ ...d, tooLarge, text: tooLarge ? null : text });
  };

  const t = (await trackedChanges(git, base, rel)).get(rel);
  if (t) {
    const counts = { status: t.status, binary: t.binary, added: t.added, deleted: t.deleted };
    if (t.binary) return answer({ ...counts, tooLarge: false, text: null });
    if ((t.added ?? 0) + (t.deleted ?? 0) > MAX_DIFF_LINES) return answer({ ...counts, tooLarge: true, text: null });
    let raw: string;
    try {
      raw = await git(["diff", ...DIFF_FLAGS, "-U3", base, "--", literal(rel)]);
    } catch (e) {
      if (e instanceof GitOutputTooLargeError || e instanceof GitTimeoutError) return answer({ ...counts, tooLarge: true, text: null });
      throw e;
    }
    return capped(raw, counts);
  }

  if ((await untrackedPaths(git, rel)).includes(rel)) {
    const status = "untracked" as const;
    const file = readCapped(deps, abs, rel, resolved, MAX_FILE_BYTES);
    if (file === null) return answer({ status, binary: false, tooLarge: false, added: null, deleted: null, text: null });
    if (file.buf === null) return answer({ status, binary: false, tooLarge: true, added: null, deleted: null, text: null });
    if (hasNul(file.buf)) return answer({ status, binary: true, tooLarge: false, added: null, deleted: null, text: null });
    const lines = file.buf.toString("utf8").split("\n");
    if (lines.at(-1) === "") lines.pop();
    const counts = { status, binary: false, added: lines.length, deleted: 0 };
    if (lines.length > MAX_DIFF_LINES) return answer({ ...counts, tooLarge: true, text: null });
    const header = `--- /dev/null\n+++ b/${rel}\n`;
    const body = lines.length === 0 ? "" : `@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}\n`).join("")}`;
    return capped(header + body, counts);
  }

  return answer({ status: "unchanged", binary: false, tooLarge: false, added: 0, deleted: 0, text: "" });
}

export function listDir(deps: ChangesDeps, runId: string, path: string): DirListing {
  const { abs } = stoppedRunWorktree(deps, runId);
  const { resolved, rel } = confine(deps, runId, abs, path);
  let dirents;
  try {
    if (!statSync(resolved).isDirectory()) throw notFound();
    dirents = readdirSync(resolved, { withFileTypes: true });
  } catch {
    throw notFound();
  }
  const rank = { dir: 0, file: 1, other: 2 } as const;
  const all = dirents
    .filter((d) => !isGitName(d.name))
    .map((d) => ({ name: d.name, kind: d.isDirectory() ? ("dir" as const) : d.isFile() ? ("file" as const) : ("other" as const) }))
    .sort((a, b) => rank[a.kind] - rank[b.kind] || byName(a.name, b.name));
  const entries: DirEntry[] = all.slice(0, MAX_DIR_ENTRIES).map(({ name, kind }) => {
    let size: number | null = null;
    if (kind === "file") {
      try {
        size = lstatSync(join(resolved, name)).size;
      } catch {
        size = null;
      }
    }
    const shown = deps.clean(runId, name, NAME_MAX);
    return { name: shown, kind, size, ...(shown !== name && { cleaned: true as const }) };
  });
  return { runId, path: deps.clean(runId, rel, PATH_MAX), entries, truncated: all.length > MAX_DIR_ENTRIES };
}

export function readFile(deps: ChangesDeps, runId: string, path: string): FileContent {
  const { abs } = stoppedRunWorktree(deps, runId);
  const { resolved, rel } = confine(deps, runId, abs, path);
  const file = readCapped(deps, abs, rel, resolved, MAX_FILE_BYTES);
  if (file === null) throw notFound();
  const out = { runId, path: deps.clean(runId, rel, PATH_MAX), size: file.size };
  if (file.buf === null) return { ...out, binary: false, tooLarge: true, text: null };
  if (hasNul(file.buf)) return { ...out, binary: true, tooLarge: false, text: null };
  // Clean first, then the byte cap: over it the file is tooLarge with no text, never cut.
  const text = deps.clean(runId, file.buf.toString("utf8"), Infinity);
  if (Buffer.byteLength(text, "utf8") > MAX_FILE_BYTES) return { ...out, binary: false, tooLarge: true, text: null };
  return { ...out, binary: false, tooLarge: false, text };
}
