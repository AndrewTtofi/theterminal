import { execFile } from "node:child_process";
import { chmodSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { devNull } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Plain git as an agent would run it: nothing of the server's GIT_* environment, no global or system config. */
const plainGit = async (cwd: string, ...args: string[]): Promise<string> => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_/i.test(k)));
  const { stdout } = await run("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], {
    cwd, env: { ...env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1" },
  });
  return stdout.trim();
};

export type SubmoduleTrap = {
  /** The file the planted filter driver writes when it runs. */
  marker: string;
  /** Whether the driver ran since the last `reset`. */
  ran: () => boolean;
  /** Forgets a run of the driver. */
  reset: () => void;
  /** Deletes a file inside the submodule again, so a recursing reset or checkout has something to restore through the driver. */
  disturb: () => void;
  /** The deleted file inside the submodule. */
  inner: string;
};

/**
 * Plants, inside `worktree`, what an agent could through ordinary gated actions: a nested repository `sub/` whose own
 * configuration names a filter driver (a shell script that writes `marker` and passes its input through) and whose
 * `info/attributes` applies it to every file; `sub` committed as a submodule with a `.gitmodules`; `submodule.sub.url`
 * and `submodule.recurse=true` in the shared repository configuration; and one file deleted inside `sub`, so a reset
 * or checkout that recursed would restore it through the driver. The nested repository's configuration is never seen
 * by the worktree manager's scans, which read the top repository only. POSIX only: the driver is a shell script.
 */
export async function plantSubmoduleTrap(worktree: string, outside: string): Promise<SubmoduleTrap> {
  const marker = join(outside, "submodule-filter.ran");
  const driver = join(outside, "submodule-filter.sh");
  writeFileSync(driver, `#!/bin/sh\ntouch "${marker}"\ncat\n`);
  chmodSync(driver, 0o755);

  const sub = join(worktree, "sub");
  await plainGit(worktree, "init", "-q", "sub");
  const inner = join(sub, "inner.txt");
  writeFileSync(inner, "inside the submodule\n");
  await plainGit(sub, "add", "inner.txt");
  await plainGit(sub, "commit", "-q", "-m", "submodule content");
  await plainGit(sub, "config", "filter.evil.smudge", driver);
  await plainGit(sub, "config", "filter.evil.clean", driver);
  writeFileSync(join(sub, ".git", "info", "attributes"), "* filter=evil\n");

  writeFileSync(join(worktree, ".gitmodules"), '[submodule "sub"]\n\tpath = sub\n\turl = ./sub\n');
  await plainGit(worktree, "add", ".gitmodules", "sub");
  await plainGit(worktree, "commit", "-q", "-m", "add submodule");
  await plainGit(worktree, "config", "submodule.sub.url", "./sub");
  await plainGit(worktree, "config", "submodule.recurse", "true");

  const disturb = () => rmSync(inner, { force: true });
  disturb();
  return { marker, inner, disturb, ran: () => existsSync(marker), reset: () => rmSync(marker, { force: true }) };
}

export { plainGit };
