import { execFile } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type GitRunner = (args: string[], cwd: string) => Promise<string>;

const ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;
/** Repo-local config: every commit in the project repo and its worktrees (ours or the agent's) uses it. */
const REPO_CONFIG: [key: string, value: string][] = [
  ["user.name", "The Terminal"],
  ["user.email", "agent@theterminal.localhost"],
  ["commit.gpgsign", "false"],
];
/**
 * An always-empty file inside dataDir that stands in for the global git config. The null device does not
 * work here: git on Windows cannot open `\\.\nul` as a config file.
 */
export const EMPTY_GITCONFIG = ".theterminal-empty-gitconfig";

const errCode = (e: unknown): string | undefined => (e as NodeJS.ErrnoException).code;

/**
 * Why the shared git config is refused: `modified` (content in it), `not_file` (a symlink or anything but a regular
 * file), `linked` (a regular file with another hard link) or `unchecked` (it could not be inspected).
 */
export type SharedGitconfigProblem = "modified" | "not_file" | "linked" | "unchecked";

export class SharedGitconfigModifiedError extends Error {
  constructor(readonly reason: SharedGitconfigProblem = "modified") {
    super("shared git config was modified");
    this.name = "SharedGitconfigModifiedError";
  }
}

/**
 * Creates the shared empty git config if it is missing and makes it read-only (best effort on Windows, where
 * chmod only sets the read-only attribute), so `git config --global` in a run fails instead of writing to it.
 * An existing file is rewritten only with `repair` (at server start); otherwise content in it is caught by
 * `assertEmptyGitconfig` before every run. A symlink or anything but a regular file in its place, or a file with
 * another hard link (repairing it would empty the linked file), is refused with SharedGitconfigModifiedError before
 * any write or chmod, never followed. Returns its path.
 */
export function ensureEmptyGitconfig(dataDir: string, opts: { repair?: boolean } = {}): string {
  const file = join(dataDir, EMPTY_GITCONFIG);
  mkdirSync(dataDir, { recursive: true });
  let st;
  try {
    st = lstatSync(file);
  } catch (e) {
    if (errCode(e) !== "ENOENT") throw new SharedGitconfigModifiedError("unchecked");
  }
  if (st === undefined) {
    try {
      writeFileSync(file, "", { flag: "wx", mode: 0o444 });
    } catch (e) {
      if (errCode(e) !== "EEXIST") throw e;
      return ensureEmptyGitconfig(dataDir, opts); // created meanwhile: judge what is there now
    }
  } else if (!st.isFile()) {
    throw new SharedGitconfigModifiedError("not_file");
  } else if (st.nlink > 1) {
    throw new SharedGitconfigModifiedError("linked");
  } else if (opts.repair && st.size > 0) {
    chmodSync(file, 0o644); // our own file: make it writable, empty it, then read-only again below
    writeFileSync(file, "");
  }
  try {
    chmodSync(file, 0o444);
  } catch {
    // Best effort: the check before every run still fails closed.
  }
  return file;
}

/**
 * Throws SharedGitconfigModifiedError unless the shared git config is missing (git then reads no global config)
 * or an empty regular file. A symlink or directory in its place counts as modified.
 */
export function assertEmptyGitconfig(dataDir: string): void {
  let st;
  try {
    st = lstatSync(join(dataDir, EMPTY_GITCONFIG));
  } catch (e) {
    if (errCode(e) === "ENOENT") return;
    throw new SharedGitconfigModifiedError();
  }
  if (!st.isFile() || st.size > 0) throw new SharedGitconfigModifiedError();
}

/** Drops every inherited GIT_* variable and ignores global/system git config. */
export function gitEnv(cwd: string, emptyGlobalConfig: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!/^GIT_/i.test(k)) env[k] = v;
  }
  // Never let git discover a repository above the directory it runs in.
  return {
    ...env,
    GIT_CEILING_DIRECTORIES: dirname(resolve(cwd)),
    GIT_CONFIG_GLOBAL: emptyGlobalConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
}

const gitRunner =
  (emptyGlobalConfig: string): GitRunner =>
  async (args, cwd) => {
    const { stdout } = await execFileAsync("git", args, { cwd, env: gitEnv(cwd, emptyGlobalConfig) });
    return stdout;
  };


function assertId(kind: string, id: string): void {
  if (!ID_PATTERN.test(id)) throw new Error(`invalid ${kind}`);
}

const isWindows = process.platform === "win32";
const fold = (p: string): string => (isWindows ? p.toLowerCase() : p);

export class WorktreeManager {
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly emptyGlobalConfig: string;
  private readonly git: GitRunner;

  constructor(
    private readonly dataDir: string,
    git?: GitRunner,
  ) {
    this.emptyGlobalConfig = join(dataDir, EMPTY_GITCONFIG);
    try {
      ensureEmptyGitconfig(dataDir);
    } catch (e) {
      if (!(e instanceof SharedGitconfigModifiedError)) throw e; // the check before every git call and run fails closed
    }
    this.git = git ?? gitRunner(this.emptyGlobalConfig);
  }

  /** Runs `fn` after all earlier work for the same project has settled. */
  private serialize<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(projectId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => undefined);
    this.queues.set(projectId, tail);
    void tail.then(() => {
      if (this.queues.get(projectId) === tail) this.queues.delete(projectId);
    });
    return next;
  }

  async ensureProjectRepo(projectId: string): Promise<string> {
    assertId("projectId", projectId);
    return this.serialize(projectId, () => this.initRepo(projectId));
  }

  private async initRepo(projectId: string): Promise<string> {
    const repo = join(this.dataDir, "projects", projectId, "repo");
    mkdirSync(repo, { recursive: true });
    // Before any git call: recreated if it was deleted, and never used once something was written to it.
    ensureEmptyGitconfig(this.dataDir);
    assertEmptyGitconfig(this.dataDir);
    await this.git(["init"], repo); // idempotent; also repairs an empty .git
    const gitDir = (await this.git(["rev-parse", "--absolute-git-dir"], repo)).trim();
    if (fold(normalize(gitDir)) !== fold(join(realpathSync.native(repo), ".git"))) {
      throw new Error("project repo is not its own git repository");
    }
    for (const [key, value] of REPO_CONFIG) await this.git(["config", key, value], repo);
    const hasHead = await this.git(["rev-parse", "--verify", "HEAD"], repo).then(
      () => true,
      () => false,
    );
    if (!hasHead) {
      await this.git(["commit", "--allow-empty", "--no-verify", "-m", "Initial commit"], repo);
    }
    return repo;
  }

  async createRunWorktree(projectId: string, runId: string): Promise<{ absPath: string; relPath: string }> {
    assertId("projectId", projectId);
    assertId("runId", runId);
    return this.serialize(projectId, async () => {
      const repo = await this.initRepo(projectId);
      const absPath = join(this.dataDir, "projects", projectId, "worktrees", runId);
      mkdirSync(dirname(absPath), { recursive: true });
      await this.git(["worktree", "add", "-b", `run/${runId}`, absPath], repo);
      const relPath = relative(this.dataDir, absPath).split(sep).join("/");
      return { absPath, relPath };
    });
  }

  /**
   * Returns the realpath-resolved absolute path if `p` is inside the worktree, else null.
   * Fails closed: `..` segments, `.git`, dangling symlinks and any unexpected fs error yield null.
   */
  resolveInside(worktreeAbs: string, p: string): string | null {
    if (p.includes("\0") || worktreeAbs.includes("\0")) return null;
    if (p.split(/[\\/]/).includes("..")) return null;
    let root: string;
    try {
      root = realpathSync.native(worktreeAbs);
    } catch {
      return null;
    }

    // Realpath the longest existing ancestor, then re-append the missing remainder.
    let existing = resolve(root, p);
    const remainder: string[] = [];
    for (;;) {
      try {
        existing = realpathSync.native(existing);
        break;
      } catch (e) {
        if (errCode(e) !== "ENOENT") return null;
        try {
          lstatSync(existing); // exists but realpath failed: dangling symlink
          return null;
        } catch (e2) {
          if (errCode(e2) !== "ENOENT") return null;
        }
        const parent = dirname(existing);
        if (parent === existing) return null;
        remainder.unshift(existing.slice(parent.length).replace(/^[\\/]+/, ""));
        existing = parent;
      }
    }
    const real = normalize(join(existing, ...remainder));

    const rel = relative(fold(root), fold(real));
    if (rel === "") return real;
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
    if (rel.split(sep)[0] === ".git") return null;
    return real;
  }
}
