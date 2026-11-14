import { accessSync, constants, statSync } from "node:fs";
import { posix, win32 } from "node:path";

export type WhichOptions = {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Whether `p` is an executable file. Injectable for tests. */
  isExecutable?: (p: string) => boolean;
};

function isExecutableFile(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The first executable `cmd` on PATH, or null. Only absolute PATH entries are searched, so nothing is found
 * relative to the current directory. On Windows `cmd.exe` and then `cmd.cmd` are tried in each entry.
 */
export function which(cmd: string, o: WhichOptions = {}): string | null {
  const env = o.env ?? process.env;
  const platform = o.platform ?? process.platform;
  const isExecutable = o.isExecutable ?? isExecutableFile;
  const windows = platform === "win32";
  const path = windows ? win32 : posix;
  const key = windows ? Object.keys(env).find((k) => k.toUpperCase() === "PATH") : "PATH";
  const dirs = (key === undefined ? "" : (env[key] ?? "")).split(path.delimiter).filter((d) => d !== "" && path.isAbsolute(d));
  const names = windows ? [`${cmd}.exe`, `${cmd}.cmd`] : [cmd];
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}
