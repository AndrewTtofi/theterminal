import { randomBytes } from "node:crypto";
import { linkSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** Thrown when another live server holds the data folder's lock. The message is fixed: it holds no path or pid. */
export class DataDirInUseError extends Error {
  constructor() {
    super("Another The Terminal server is already using this data folder.");
    this.name = "DataDirInUseError";
  }
}

const LOCK_FILE = "server.lock";
/** An empty or unparsable lock younger than this may belong to a writer that has not finished: it counts as live. */
const YOUNG_LOCK_MS = 2000;

/** Whether a process with this pid exists: EPERM means it exists but belongs to someone else. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The file's text, or null when it cannot be read. */
function readText(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** The pid a lock's text names, or null when it holds no positive integer. */
function parsePid(text: string | null): number | null {
  const m = text === null ? null : /^\s*(\d+)\s*$/.exec(text);
  if (!m) return null;
  const pid = Number(m[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

/** Whether the file was modified within the young-lock grace period (false when it cannot be read). */
function isYoung(file: string): boolean {
  try {
    return Date.now() - statSync(file).mtimeMs < YOUNG_LOCK_MS;
  } catch {
    return false;
  }
}

/**
 * The data folders this process holds the lock for, by real path. A lock naming our own pid that is not in here was
 * left by an earlier process that had the same pid: in a container the server is PID 1 on every start, so after
 * docker kill or an OOM kill the lock names 1 and `process.kill(1, 0)` succeeds. A lock cannot be held by the
 * process that is only now starting, so that lock is stale.
 */
const heldHere = new Set<string>();

function folderKey(dataDir: string): string {
  try {
    return realpathSync.native(dataDir);
  } catch {
    return resolve(dataDir);
  }
}

const uniqueName = (dataDir: string, kind: string) => join(dataDir, `${LOCK_FILE}.${kind}-${randomBytes(8).toString("hex")}`);

/**
 * Takes `<dataDir>/server.lock` for `pid`, so that only one server (the CLI or the desktop app) opens a data folder
 * at a time. The pid is written to a unique temp file and published with a hard link, so the lock never exists
 * half-written. A held lock throws DataDirInUseError: one whose pid is alive, or one that is empty or unparsable and
 * still young. A lock naming this process's own pid is held only while this process took it (see `heldHere`).
 * Any other lock is stale and taken over: it is renamed away, confirmed unchanged, removed, and the publish is tried
 * once more. release() removes the file only while it still names our pid.
 */
export function acquireDataDirLock(
  dataDir: string,
  pid: number = process.pid,
  isAlive: (pid: number) => boolean = processAlive,
): { release(): void } {
  const file = join(dataDir, LOCK_FILE);
  const key = folderKey(dataDir);
  const live = (holder: number): boolean => (holder === process.pid ? heldHere.has(key) : isAlive(holder));
  const temp = uniqueName(dataDir, "tmp");
  writeFileSync(temp, `${pid}\n`, { flag: "wx", mode: 0o600 });
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        linkSync(temp, file);
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        if (attempt > 0) throw new DataDirInUseError();
      }
      takeOverIfStale(dataDir, file, live);
    }
  } finally {
    rmSync(temp, { force: true });
  }
  if (pid === process.pid) heldHere.add(key);
  return { release: () => releaseDataDirLock(dataDir, pid) };
}

/**
 * Removes `<dataDir>/server.lock` only while it names `pid`. Never throws: a host whose server hangs on close calls
 * it as a best effort before exiting.
 */
export function releaseDataDirLock(dataDir: string, pid: number = process.pid): void {
  const file = join(dataDir, LOCK_FILE);
  if (pid === process.pid) heldHere.delete(folderKey(dataDir));
  try {
    if (parsePid(readText(file)) === pid) rmSync(file, { force: true });
  } catch {
    // Best effort: a lock left behind names a dead pid and is taken over by the next start.
  }
}

/** Removes a stale lock, or throws DataDirInUseError when it is held (or changes while it is being judged). */
function takeOverIfStale(dataDir: string, file: string, isAlive: (pid: number) => boolean): void {
  const text = readText(file);
  if (text === null) return; // gone already: publish again
  const holder = parsePid(text);
  if (holder === null ? isYoung(file) : isAlive(holder)) throw new DataDirInUseError();
  const stale = uniqueName(dataDir, "stale");
  try {
    renameSync(file, stale);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return; // another process removed it: publish again
    throw e;
  }
  if (readText(stale) === text) {
    rmSync(stale, { force: true });
    return;
  }
  // Another process published its own lock between our read and our rename: put it back, never delete it.
  try {
    linkSync(stale, file);
  } catch {
    // A newer lock is already in place; either way the folder is in use.
  }
  rmSync(stale, { force: true });
  throw new DataDirInUseError();
}
