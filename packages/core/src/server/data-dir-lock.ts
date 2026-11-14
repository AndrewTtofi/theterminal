import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Thrown when another live server holds the data folder's lock. The message is fixed: it holds no path or pid. */
export class DataDirInUseError extends Error {
  constructor() {
    super("Another The Terminal server is already using this data folder.");
    this.name = "DataDirInUseError";
  }
}

const LOCK_FILE = "server.lock";

/** Whether a process with this pid exists: EPERM means it exists but belongs to someone else. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The pid a lock file names, or null when it cannot be read or holds no positive integer. */
function readPid(file: string): number | null {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const m = /^\s*(\d+)\s*$/.exec(text);
  if (!m) return null;
  const pid = Number(m[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

/**
 * Takes `<dataDir>/server.lock` for `pid`, so that only one server (the CLI or the desktop app) opens a data folder
 * at a time. A lock whose process is gone, or that cannot be read, is taken over; a live one throws
 * DataDirInUseError. release() removes the file only while it still names our pid.
 */
export function acquireDataDirLock(
  dataDir: string,
  pid: number = process.pid,
  isAlive: (pid: number) => boolean = processAlive,
): { release(): void } {
  const file = join(dataDir, LOCK_FILE);
  const content = `${pid}\n`;
  for (let attempt = 0; ; attempt++) {
    try {
      writeFileSync(file, content, { flag: "wx", mode: 0o600 });
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST" || attempt > 0) throw e;
    }
    const holder = readPid(file);
    if (holder !== null && isAlive(holder)) throw new DataDirInUseError();
    rmSync(file, { force: true });
  }
  return {
    release() {
      if (readPid(file) === pid) rmSync(file, { force: true });
    },
  };
}
