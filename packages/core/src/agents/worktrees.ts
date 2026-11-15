import { execFile } from "node:child_process";
import { chmodSync, closeSync, constants, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { allowlistedEnv } from "./env-allowlist.js";

const execFileAsync = promisify(execFile);

/** How one git call is bounded; `env` replaces the default environment (gitEnv). */
export type GitRunOptions = { timeoutMs?: number; maxBuffer?: number; env?: NodeJS.ProcessEnv };
export type GitRunner = (args: string[], cwd: string, opts?: GitRunOptions) => Promise<string>;

/** A git call printed more than its buffer allows. */
export class GitOutputTooLargeError extends Error {
  constructor() {
    super("git output too large");
    this.name = "GitOutputTooLargeError";
  }
}

/** A git call ran past its timeout and was killed. */
export class GitTimeoutError extends Error {
  constructor() {
    super("git timed out");
    this.name = "GitTimeoutError";
  }
}

/** The repository configures a filter driver whose name cannot be neutralised on the command line. */
export class UnsafeGitConfigError extends Error {
  constructor() {
    super("the repository configures a filter driver that cannot be disabled");
    this.name = "UnsafeGitConfigError";
  }
}

/** The empty hooks directory has something in it. */
export class HooksDirModifiedError extends Error {
  constructor() {
    super("the empty hooks directory was modified");
    this.name = "HooksDirModifiedError";
  }
}

/** Given to every runGit call: no pager, no fsmonitor program, paths printed as they are. */
export const GIT_COMMON_ARGS = ["--no-pager", "-c", "core.fsmonitor=false", "-c", "core.quotePath=false"] as const;
export const GIT_TIMEOUT_MS = 30_000;
export const GIT_MAX_BUFFER = 2 * 1024 * 1024;
/** An always-empty directory inside dataDir that runGit names as `core.hooksPath`, so no hook ever runs. */
export const EMPTY_HOOKS_DIR = ".theterminal-empty-hooks";
/** Attribute files read for filter driver names, beside the configuration's own `filter.*` sections. */
const MAX_ATTRIBUTES_BYTES = 256 * 1024;
/** `filter=<name>` in a gitattributes line. */
const ATTR_FILTER = /(?:^|\s)filter=(\S+)/g;

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

/**
 * The environment for git over a tree an agent controls: only the allowlisted variables (no provider keys, no
 * GIT_*), pinned to the empty global config, no system config, no prompts, and no repository above `cwd`.
 */
export function safeGitEnv(cwd: string, emptyGlobalConfig: string): NodeJS.ProcessEnv {
  return {
    ...allowlistedEnv(process.env, process.platform),
    GIT_CEILING_DIRECTORIES: dirname(resolve(cwd)),
    GIT_CONFIG_GLOBAL: emptyGlobalConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
}

const gitRunner =
  (emptyGlobalConfig: string): GitRunner =>
  async (args, cwd, opts = {}) => {
    try {
      const { stdout } = await execFileAsync("git", args, {
        cwd,
        env: opts.env ?? gitEnv(cwd, emptyGlobalConfig),
        windowsHide: true,
        ...(opts.timeoutMs !== undefined && { timeout: opts.timeoutMs, killSignal: "SIGKILL" as const }),
        ...(opts.maxBuffer !== undefined && { maxBuffer: opts.maxBuffer }),
      });
      return stdout;
    } catch (e) {
      const err = e as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null };
      if (err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" || err.code === "ENOBUFS") throw new GitOutputTooLargeError();
      if (err.killed && opts.timeoutMs !== undefined) throw new GitTimeoutError();
      throw e;
    }
  };

/** Reads at most `max` bytes of a regular file, never through a symlink; "" when it is missing or anything else. */
function readSmallRegularFile(file: string, max: number): string {
  try {
    if (!lstatSync(file).isFile()) return "";
    const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const buf = Buffer.alloc(max);
      const n = readSync(fd, buf, 0, max, 0);
      return buf.subarray(0, n).toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return "";
  }
}


function assertId(kind: string, id: string): void {
  if (!ID_PATTERN.test(id)) throw new Error(`invalid ${kind}`);
}

const isWindows = process.platform === "win32";
const fold = (p: string): string => (isWindows ? p.toLowerCase() : p);

export class WorktreeManager {
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly emptyGlobalConfig: string;
  private readonly emptyHooks: string;
  private readonly git: GitRunner;

  constructor(
    private readonly dataDir: string,
    git?: GitRunner,
  ) {
    this.emptyGlobalConfig = join(dataDir, EMPTY_GITCONFIG);
    this.emptyHooks = join(dataDir, EMPTY_HOOKS_DIR);
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

  /** The project's own repository: `<dataDir>/projects/<projectId>/repo`. */
  repoPath(projectId: string): string {
    assertId("projectId", projectId);
    return join(this.dataDir, "projects", projectId, "repo");
  }

  /**
   * Runs git in `cwd`, which may be a tree an agent controlled, so nothing in it may make git run a program:
   * GIT_COMMON_ARGS (no pager, no fsmonitor), `core.hooksPath` set to an always-empty directory, and every filter
   * driver named in the repository's configuration or its attribute files set to empty commands and not required.
   * The environment is the allowlisted one (safeGitEnv), never the server's. Diff callers add `--no-ext-diff
   * --no-textconv`. Bounded by `timeoutMs` (default 30 s, GitTimeoutError) and `maxBuffer` (default 2 MiB,
   * GitOutputTooLargeError).
   */
  async runGit(cwd: string, args: string[], opts: { timeoutMs?: number; maxBuffer?: number } = {}): Promise<string> {
    assertEmptyGitconfig(this.dataDir);
    this.assertEmptyHooks();
    const run: GitRunOptions = {
      timeoutMs: opts.timeoutMs ?? GIT_TIMEOUT_MS,
      maxBuffer: opts.maxBuffer ?? GIT_MAX_BUFFER,
      env: safeGitEnv(cwd, this.emptyGlobalConfig),
    };
    const hardened = [...GIT_COMMON_ARGS, "-c", `core.hooksPath=${this.emptyHooks}`];
    const names = await this.filterDrivers(cwd, hardened, run);
    const filters = names.flatMap((n) =>
      [`filter.${n}.clean=`, `filter.${n}.smudge=`, `filter.${n}.process=`, `filter.${n}.required=false`].flatMap((kv) => ["-c", kv]),
    );
    return this.git([...hardened, ...filters, ...args], cwd, run);
  }

  /**
   * Every filter driver name the repository could apply: its configuration's `filter.<name>.*` keys (includes
   * followed), and `filter=<name>` in the worktree's top-level .gitattributes and the repository's info/attributes.
   * A name that `-c name=value` could not carry unambiguously is refused (UnsafeGitConfigError), never skipped.
   */
  private async filterDrivers(cwd: string, hardened: string[], run: GitRunOptions): Promise<string[]> {
    const names = new Set<string>();
    const keys = await this.git([...hardened, "config", "--null", "--name-only", "--get-regexp", "^filter\\."], cwd, run).catch(
      (e: unknown) => {
        if ((e as { code?: unknown }).code === 1) return ""; // no such key
        throw e;
      },
    );
    for (const key of keys.split("\0")) {
      const k = key.trim();
      const dot = k.lastIndexOf(".");
      if (k.toLowerCase().startsWith("filter.") && dot > "filter.".length) names.add(k.slice("filter.".length, dot));
    }
    const attrFiles = [join(cwd, ".gitattributes")];
    const common = await this.git([...hardened, "rev-parse", "--git-common-dir"], cwd, run).then(
      (out) => resolve(cwd, out.trim()),
      () => null,
    );
    if (common !== null) attrFiles.push(join(common, "info", "attributes"));
    for (const file of attrFiles) {
      for (const m of readSmallRegularFile(file, MAX_ATTRIBUTES_BYTES).matchAll(ATTR_FILTER)) names.add(m[1]!);
    }
    for (const n of names) {
      if (n === "" || /[=\0\r\n]/.test(n)) throw new UnsafeGitConfigError();
    }
    return [...names].sort();
  }

  /** Creates the empty hooks directory if it is missing; throws HooksDirModifiedError if anything is in it. */
  private assertEmptyHooks(): void {
    mkdirSync(this.emptyHooks, { recursive: true });
    const st = lstatSync(this.emptyHooks);
    if (!st.isDirectory() || readdirSync(this.emptyHooks).length > 0) throw new HooksDirModifiedError();
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
