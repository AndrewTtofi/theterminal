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

/** The message for a repository whose configuration includes other files. */
export const GIT_INCLUDES_REFUSED = "This repository's git configuration includes other files, which The Terminal does not allow";

/**
 * The repository is set up in a way git could be made to run a program through, so nothing is run in it: its
 * configuration includes other files, it has repository-wide attributes, or it names a filter driver that cannot
 * be neutralised on the command line.
 */
export class UnsafeGitConfigError extends Error {
  constructor(message = "the repository configures a filter driver that cannot be disabled") {
    super(message);
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

/**
 * Given to every runGit call, before the subcommand: no pager; no fsmonitor program; paths printed as they are; no
 * recursion into submodules (a nested repository's own configuration is never scanned, so a reset or checkout that
 * entered it could run its filter driver) and no submodule summaries; replace objects ignored (`git replace` in the
 * shared repository would otherwise substitute what every diff and rev-parse sees); `core.bigFileThreshold`
 * pinned to git's default, so a planted `core.bigFileThreshold=1` cannot make every text file read as binary; and
 * the index features that can make git call a changed file unchanged or skip a directory switched off: no sparse
 * checkout (a planted `core.sparseCheckout=true` with patterns would mark files skip-worktree on the next checkout
 * or reset), no sparse index, no split index (a scratch index written by the views would otherwise leave a
 * `sharedindex` file in the agent's git directory), no untracked cache, and no `core.ignoreStat` (which sets
 * assume-unchanged on files git writes).
 */
export const GIT_COMMON_ARGS = [
  "--no-pager", "--no-replace-objects",
  "-c", "core.fsmonitor=false", "-c", "core.quotePath=false",
  "-c", "submodule.recurse=false", "-c", "status.submoduleSummary=false",
  "-c", "core.bigFileThreshold=512m",
  "-c", "core.sparseCheckout=false", "-c", "index.sparse=false", "-c", "core.splitIndex=false",
  "-c", "core.untrackedCache=false", "-c", "core.ignoreStat=false",
] as const;
export const GIT_TIMEOUT_MS = 30_000;
export const GIT_MAX_BUFFER = 2 * 1024 * 1024;
/** An always-empty directory inside dataDir that runGit names as `core.hooksPath`, so no hook ever runs. */
export const EMPTY_HOOKS_DIR = ".theterminal-empty-hooks";
/** An always-empty file inside dataDir that runGit names as `core.attributesFile`. */
export const EMPTY_ATTRIBUTES = ".theterminal-empty-attributes";
/**
 * The empty tree of each object format: with `--attr-source` (git 2.40+) pointing at it, no `.gitattributes` in the
 * tree is read at all.
 */
const EMPTY_TREE: Record<string, string> = {
  sha1: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
  sha256: "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321",
};
const CHECK_FAILED = "The Terminal could not check this repository's git configuration, so it did not run git in it";
/** At most this many `.gitattributes` files in HEAD's tree are read for filter names; more is refused. */
const MAX_ATTRIBUTE_FILES = 500;
/** Buffer for listing HEAD's tree when looking for `.gitattributes` files. */
const TREE_LIST_BUFFER = 32 * 1024 * 1024;
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

/**
 * A worktree's top-level .gitattributes, for filter names. Missing, or anything but a regular file (git does not
 * follow an in-tree .gitattributes symlink), is "". Over `max` bytes, or unreadable, throws UnsafeGitConfigError:
 * a file that cannot be checked whole is refused, never skipped.
 */
function readAttributesFile(file: string, max: number): string {
  let st;
  try {
    st = lstatSync(file);
  } catch (e) {
    if (errCode(e) === "ENOENT" || errCode(e) === "ENOTDIR") return "";
    throw new UnsafeGitConfigError(CHECK_FAILED);
  }
  if (!st.isFile()) return "";
  if (st.size > max) throw new UnsafeGitConfigError(CHECK_FAILED);
  try {
    const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const buf = Buffer.alloc(max + 1);
      const n = readSync(fd, buf, 0, max + 1, 0);
      if (n > max) throw new UnsafeGitConfigError(CHECK_FAILED);
      return buf.subarray(0, n).toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    throw new UnsafeGitConfigError(CHECK_FAILED);
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
  private readonly emptyAttributes: string;
  private readonly git: GitRunner;
  /** Whether the installed git supports `--attr-source`; null until a version check has succeeded (a failed one is not kept). */
  private attrSourceSupported: boolean | null = null;

  constructor(
    private readonly dataDir: string,
    git?: GitRunner,
  ) {
    this.emptyGlobalConfig = join(dataDir, EMPTY_GITCONFIG);
    this.emptyHooks = join(dataDir, EMPTY_HOOKS_DIR);
    this.emptyAttributes = join(dataDir, EMPTY_ATTRIBUTES);
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
   * Runs git in `cwd`, which may be a tree or repository an agent controlled, so nothing in it may make git run a
   * program: GIT_COMMON_ARGS (no pager, no fsmonitor, no submodule recursion, no replace objects, the default
   * big-file threshold), `core.hooksPath` set to an always-empty directory,
   * `commit.gpgsign=false` (no signing program), `core.attributesFile` set to an always-empty file, `--attr-source`
   * set to the empty tree when git supports it (2.40+), and every filter driver named in the repository's
   * configuration or in any `.gitattributes` (the top level of `cwd`, and every one in HEAD's tree) set to empty
   * commands and not required. A repository whose configuration (shared or the worktree's own) has any `include.*`
   * or `includeIf.*` key, or whose info/attributes is not empty, is refused with UnsafeGitConfigError before
   * anything else runs in it. The environment is the allowlisted one
   * (safeGitEnv), never the server's. Diff callers add `--no-ext-diff --no-textconv`. `gitDir` and `workTree`, when
   * given, are passed as `--git-dir`/`--work-tree`, so a planted `core.worktree` or `.git` file cannot redirect the
   * call. `indexFile`, when given, is passed as `GIT_INDEX_FILE`, so the call reads and writes that index instead of
   * the repository's own. Every call this manager makes goes through here, repository setup included. Bounded by
   * `timeoutMs` (default 30 s, GitTimeoutError) and `maxBuffer` (default 2 MiB, GitOutputTooLargeError).
   */
  async runGit(
    cwd: string,
    args: string[],
    opts: { timeoutMs?: number; maxBuffer?: number; gitDir?: string; workTree?: string; indexFile?: string } = {},
  ): Promise<string> {
    assertEmptyGitconfig(this.dataDir);
    this.assertEmptyHooks();
    this.assertEmptyAttributes();
    const run: GitRunOptions = {
      timeoutMs: opts.timeoutMs ?? GIT_TIMEOUT_MS,
      maxBuffer: opts.maxBuffer ?? GIT_MAX_BUFFER,
      env: { ...safeGitEnv(cwd, this.emptyGlobalConfig), ...(opts.indexFile !== undefined && { GIT_INDEX_FILE: opts.indexFile }) },
    };
    // The checks before the call have their own fixed bounds; the caller's bounds apply to its call only.
    const check: GitRunOptions = { ...run, timeoutMs: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER };
    const base = [
      ...GIT_COMMON_ARGS, "-c", `core.hooksPath=${this.emptyHooks}`, "-c", "commit.gpgsign=false",
      "-c", `core.attributesFile=${this.emptyAttributes}`,
    ];
    if (this.attrSourceSupported === null) {
      // A failure here fails this call and is not remembered, so the next call checks again.
      const out = await this.git([...base, "version"], this.dataDir, { ...check, env: safeGitEnv(this.dataDir, this.emptyGlobalConfig) });
      const m = /git version (\d+)\.(\d+)/.exec(out);
      this.attrSourceSupported = m !== null && (Number(m[1]) > 2 || (Number(m[1]) === 2 && Number(m[2]) >= 40));
    }
    const location = [
      ...(opts.gitDir !== undefined ? [`--git-dir=${opts.gitDir}`] : []),
      ...(opts.workTree !== undefined ? [`--work-tree=${opts.workTree}`] : []),
    ];
    const repo = await this.probeRepository([...base, ...location], cwd, check);
    let attrSource: string[] = [];
    if (repo !== null && this.attrSourceSupported) {
      const tree = EMPTY_TREE[repo.format];
      if (tree === undefined) throw new UnsafeGitConfigError(CHECK_FAILED);
      attrSource = [`--attr-source=${tree}`];
    }
    const hardened = [...base, ...attrSource];
    if (repo !== null) this.assertSafeRepository(repo);
    await this.assertNoIncludes(repo, [...hardened, ...location], cwd, check);
    const names = await this.filterDrivers(opts.workTree ?? cwd, [...hardened, ...location], cwd, check);
    const filters = names.flatMap((n) =>
      [`filter.${n}.clean=`, `filter.${n}.smudge=`, `filter.${n}.process=`, `filter.${n}.required=false`].flatMap((kv) => ["-c", kv]),
    );
    return this.git([...hardened, ...filters, ...location, ...args], cwd, run);
  }

  /**
   * The repository `cwd` (or the given location) is in: its git directory, common directory and object format.
   * Null only when git says there is no repository there (before `git init`); any other failure is a refusal.
   */
  private async probeRepository(
    hardened: string[],
    cwd: string,
    run: GitRunOptions,
  ): Promise<{ gitDir: string; common: string; format: string } | null> {
    let out: string;
    try {
      out = await this.git([...hardened, "rev-parse", "--absolute-git-dir", "--git-common-dir", "--show-object-format"], cwd, run);
    } catch (e) {
      if (/not a git repository/i.test(String((e as { stderr?: unknown }).stderr ?? ""))) return null;
      throw new UnsafeGitConfigError(CHECK_FAILED);
    }
    const [gitDir, common, format] = out.split(/\r?\n/).map((l) => l.trim());
    if (!gitDir || !common || !format) return null;
    return { gitDir: resolve(cwd, gitDir), common: resolve(cwd, common), format };
  }

  /** Refuses (UnsafeGitConfigError) a repository whose info/attributes is anything but missing or empty. */
  private assertSafeRepository(repo: { common: string }): void {
    let st;
    try {
      st = lstatSync(join(repo.common, "info", "attributes"));
    } catch (e) {
      if (errCode(e) === "ENOENT" || errCode(e) === "ENOTDIR") return;
      throw new UnsafeGitConfigError(CHECK_FAILED);
    }
    if (!st.isFile() || st.size > 0) throw new UnsafeGitConfigError("This repository has repository-wide git attributes, which The Terminal does not allow");
  }

  /**
   * Refuses (UnsafeGitConfigError) a repository whose shared configuration or worktree configuration has any
   * `include.*` or `includeIf.*` key: an included file, possibly conditional on the branch or git directory, could
   * define a filter this manager never sees. The files are listed with `--file`, which does not follow includes.
   */
  private async assertNoIncludes(
    repo: { gitDir: string; common: string } | null,
    hardened: string[],
    cwd: string,
    run: GitRunOptions,
  ): Promise<void> {
    if (repo === null) return;
    for (const file of [join(repo.common, "config"), join(repo.gitDir, "config.worktree")]) {
      try {
        lstatSync(file);
      } catch (e) {
        if (errCode(e) === "ENOENT" || errCode(e) === "ENOTDIR") continue;
        throw new UnsafeGitConfigError(CHECK_FAILED);
      }
      const keys = await this.git([...hardened, "config", "--file", file, "--null", "--name-only", "--list"], cwd, run).catch(() => {
        throw new UnsafeGitConfigError(CHECK_FAILED);
      });
      if (keys.split("\0").some((k) => /^include(if)?\./i.test(k.trim()))) throw new UnsafeGitConfigError(GIT_INCLUDES_REFUSED);
    }
  }

  /**
   * Every filter driver name the repository could apply: its configuration's `filter.<name>.*` keys, and
   * `filter=<name>` in the top-level .gitattributes of `top` and in every .gitattributes in HEAD's tree. A name
   * that `-c name=value` could not carry unambiguously is refused (UnsafeGitConfigError), never skipped.
   */
  private async filterDrivers(top: string, hardened: string[], cwd: string, run: GitRunOptions): Promise<string[]> {
    const names = new Set<string>();
    const keys = await this.git([...hardened, "config", "--null", "--name-only", "--get-regexp", "^filter\\."], cwd, run).catch(
      (e: unknown) => {
        if ((e as { code?: unknown }).code === 1) return ""; // no such key
        throw new UnsafeGitConfigError(CHECK_FAILED);
      },
    );
    for (const key of keys.split("\0")) {
      const k = key.trim();
      const dot = k.lastIndexOf(".");
      if (k.toLowerCase().startsWith("filter.") && dot > "filter.".length) names.add(k.slice("filter.".length, dot));
    }
    // Every failure below is a refusal, never "no filters": a scan that could not finish proves nothing.
    const texts = [readAttributesFile(join(top, ".gitattributes"), MAX_ATTRIBUTES_BYTES)];
    let tree: string;
    try {
      tree = await this.git([...hardened, "ls-tree", "-r", "-z", "--name-only", "HEAD"], cwd, { ...run, maxBuffer: TREE_LIST_BUFFER });
    } catch (e) {
      if (e instanceof GitOutputTooLargeError || e instanceof GitTimeoutError) throw new UnsafeGitConfigError(CHECK_FAILED);
      // Only a repository without a HEAD (or no repository yet) has no tree to scan.
      const hasHead = await this.git([...hardened, "rev-parse", "--verify", "--quiet", "HEAD^{tree}"], cwd, run).then(
        () => true,
        () => false,
      );
      if (hasHead) throw new UnsafeGitConfigError(CHECK_FAILED);
      tree = "";
    }
    const attrPaths = tree.split("\0").filter((p) => p === ".gitattributes" || p.endsWith("/.gitattributes"));
    if (attrPaths.length > MAX_ATTRIBUTE_FILES) throw new UnsafeGitConfigError("This repository has too many .gitattributes files to check");
    for (const p of attrPaths) {
      texts.push(
        await this.git([...hardened, "cat-file", "blob", `HEAD:${p}`], cwd, { ...run, maxBuffer: MAX_ATTRIBUTES_BYTES }).catch(() => {
          throw new UnsafeGitConfigError(CHECK_FAILED);
        }),
      );
    }
    for (const text of texts) {
      for (const m of text.matchAll(ATTR_FILTER)) names.add(m[1]!);
    }
    for (const n of names) {
      if (n === "" || /[=\0\r\n]/.test(n)) throw new UnsafeGitConfigError();
    }
    return [...names].sort();
  }

  /** Creates the empty attributes file if it is missing; refuses it once anything was written to it or linked. */
  private assertEmptyAttributes(): void {
    try {
      writeFileSync(this.emptyAttributes, "", { flag: "wx", mode: 0o444 });
    } catch (e) {
      if (errCode(e) !== "EEXIST") throw e;
    }
    const st = lstatSync(this.emptyAttributes);
    if (!st.isFile() || st.size > 0 || st.nlink > 1) throw new UnsafeGitConfigError("the empty attributes file was modified");
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
    await this.runGit(repo, ["init"]); // idempotent; also repairs an empty .git
    const gitDir = (await this.runGit(repo, ["rev-parse", "--absolute-git-dir"])).trim();
    if (fold(normalize(gitDir)) !== fold(join(realpathSync.native(repo), ".git"))) {
      throw new Error("project repo is not its own git repository");
    }
    for (const [key, value] of REPO_CONFIG) await this.runGit(repo, ["config", key, value]);
    const hasHead = await this.runGit(repo, ["rev-parse", "--verify", "HEAD"]).then(
      () => true,
      () => false,
    );
    if (!hasHead) {
      await this.runGit(repo, ["commit", "--allow-empty", "--no-verify", "-m", "Initial commit"]);
    }
    return repo;
  }

  /**
   * Creates the run's worktree on a new branch `run/<runId>` from the project repository's HEAD and returns its path
   * and `base`, the commit it was created at, read from the new worktree itself: the fork point for every later view
   * of what the run changed, recorded with the run so nothing the agent can move (a branch, a replace ref) changes it.
   */
  async createRunWorktree(projectId: string, runId: string): Promise<{ absPath: string; relPath: string; base: string }> {
    assertId("projectId", projectId);
    assertId("runId", runId);
    return this.serialize(projectId, async () => {
      const repo = await this.initRepo(projectId);
      const absPath = join(this.dataDir, "projects", projectId, "worktrees", runId);
      mkdirSync(dirname(absPath), { recursive: true });
      await this.runGit(repo, ["worktree", "add", "-b", `run/${runId}`, absPath]);
      const base = (await this.runGit(absPath, ["rev-parse", "--verify", "HEAD"])).trim();
      if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(base)) throw new Error("the new worktree has no commit to fork from");
      const relPath = relative(this.dataDir, absPath).split(sep).join("/");
      return { absPath, relPath, base };
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
