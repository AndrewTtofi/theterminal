import { randomUUID } from "node:crypto";
import { constants, lstatSync, mkdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { checkImportPath } from "@theterminal/shared";
import type { WorktreeManager } from "../agents/worktrees.js";
import { FolderRefusedError, FolderUnavailableError, type ImportStaging } from "./staging.js";

export { FolderRefusedError, FolderUnavailableError } from "./staging.js";

/** Where the scratch git directories for folder listings live, inside the data folder. */
export const SCAN_DIR = ".theterminal-scan";
const LIST_MAX_BUFFER = 32 * 1024 * 1024;

const isWindows = process.platform === "win32";
const fold = (p: string): string => (isWindows ? p.toLowerCase() : p);
const errCode = (e: unknown): string | undefined => (e as NodeJS.ErrnoException).code;

/** Whether `inner` is `outer` or inside it; both already canonical. */
function within(outer: string, inner: string): boolean {
  const rel = relative(outer, inner);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** The real path of an existing directory, folded on Windows; FolderUnavailableError when it is missing or not one. */
function realDirectory(p: string): string {
  let real: string;
  try {
    real = realpathSync.native(p);
    if (!statSync(real).isDirectory()) throw new FolderUnavailableError();
  } catch {
    throw new FolderUnavailableError();
  }
  return real;
}

/**
 * The files of a person's folder that git would consider (honouring its `.gitignore` files), without running git in
 * the folder's own repository: the listing uses a scratch, empty `--git-dir` (`<data>/.theterminal-scan/<uuid>`, made
 * by `git init --bare` and removed afterwards) with `--work-tree` set to the folder, so the folder's `.git`, its
 * configuration (an fsmonitor, hooks, filters), its index and its exclude file are never read. Nested repositories
 * (entries ending in `/`) come back in `nested`, without the slash.
 *
 * Refuses (FolderRefusedError) a relative path, the data folder, a folder inside it or one containing it, compared
 * after resolving symlinks and with case folded on Windows. A missing path, or one that is not a directory, is
 * FolderUnavailableError.
 */
export async function listFolder(wt: WorktreeManager, dataDir: string, folder: string): Promise<{ files: string[]; nested: string[] }> {
  if (typeof folder !== "string" || folder.includes("\0") || !isAbsolute(folder)) throw new FolderRefusedError();
  const real = realDirectory(folder);
  let data: string;
  try {
    data = realpathSync.native(dataDir);
  } catch {
    throw new FolderRefusedError();
  }
  if (within(fold(data), fold(real)) || within(fold(real), fold(data))) throw new FolderRefusedError();

  const scanRoot = join(dataDir, SCAN_DIR);
  mkdirSync(scanRoot, { recursive: true });
  const scratch = join(scanRoot, randomUUID());
  mkdirSync(scratch);
  try {
    await wt.runGit(scratch, ["init", "--bare", "-q"]);
    const out = await wt.runGit(scratch, ["ls-files", "--others", "--exclude-standard", "-z"], {
      gitDir: scratch,
      workTree: real,
      maxBuffer: LIST_MAX_BUFFER,
    });
    const files: string[] = [];
    const nested: string[] = [];
    for (const entry of out.split("\0")) {
      if (entry === "") continue;
      if (entry.endsWith("/")) nested.push(entry.slice(0, -1));
      else files.push(entry);
    }
    return { files, nested };
  } finally {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

/** Whether two stats are of the same file: the same device and inode (file index on Windows). */
export function sameIdentity(a: { dev: bigint; ino: bigint }, b: { dev: bigint; ino: bigint }): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

type Identity = { dev: bigint; ino: bigint };

/**
 * Whether every segment of `rel` under `root` is a real directory or, for the last, a regular file, checked with
 * `lstat` so no symlink (or junction) anywhere on the way is followed. "missing" when a segment is gone. For a file,
 * its identity (device and inode), which the opened handle must still have.
 */
function regularFileKind(root: string, segments: string[]): { kind: "file"; id: Identity } | { kind: "link" | "missing" } {
  let at = root;
  for (const [i, s] of segments.entries()) {
    at = join(at, s);
    let st;
    try {
      st = lstatSync(at, { bigint: true });
    } catch (e) {
      return { kind: errCode(e) === "ENOENT" || errCode(e) === "ENOTDIR" ? "missing" : "link" };
    }
    const last = i === segments.length - 1;
    if (last ? !st.isFile() : !st.isDirectory()) return { kind: "link" };
    if (last) return { kind: "file", id: { dev: st.dev, ino: st.ino } };
  }
  return { kind: "link" };
}

/**
 * Stages the listed files of `folder`. Each path is checked first; then every segment is `lstat`ed, and a symlink or
 * anything but a regular file is skipped as `"link"`. Each regular file is opened without following a link (where
 * the platform supports it: Windows has no O_NOFOLLOW), and the open handle must be a regular file with the same
 * device and inode the `lstat` saw, on every platform, so a file or folder swapped for a link in between is skipped as
 * `"link"`; then it is streamed into staging, which enforces the limits while it reads. A file gone since the listing
 * is skipped as `"missing"`. `openFile` is for tests.
 */
export async function stageFolder(staging: ImportStaging, folder: string, files: string[], openFile: typeof open = open): Promise<void> {
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
  for (const f of files) {
    const checked = checkImportPath(f);
    if (!checked.ok) {
      staging.skip(f, checked.reason);
      continue;
    }
    const segments = checked.path.split("/");
    const found = regularFileKind(folder, segments);
    if (found.kind !== "file") {
      staging.skip(f, found.kind);
      continue;
    }
    let handle;
    try {
      handle = await openFile(join(folder, ...segments), flags);
    } catch (e) {
      staging.skip(f, errCode(e) === "ENOENT" ? "missing" : "link");
      continue;
    }
    try {
      const st = await handle.stat({ bigint: true });
      if (!st.isFile() || !sameIdentity(st, found.id)) {
        staging.skip(f, "link");
        continue;
      }
      await staging.add(checked.path, handle.createReadStream({ autoClose: false }));
    } finally {
      await handle.close().catch(() => undefined);
    }
  }
}
