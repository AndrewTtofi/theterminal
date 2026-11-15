import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  GitEnvRefusedError, HooksDirModifiedError, SharedGitconfigModifiedError, UnsafeGitConfigError, type WorktreeManager,
} from "../agents/worktrees.js";
import { WorktreeMissingError } from "../changes/changes.js";

/** The largest repository or snapshot bundle a machine accepts from another: 256 MiB. */
export const MAX_BUNDLE_BYTES = 268_435_456;

/** A bundle that is not a git bundle, fails `git bundle verify`, is too large, or holds refs it may not hold. */
export class BundleInvalidError extends Error {
  constructor() {
    super("the repository bundle is not valid");
    this.name = "BundleInvalidError";
  }
}

/** Bundle work reads or writes up to MAX_BUNDLE_BYTES of objects; slow disks and Windows get the time for it. */
const BUNDLE_TIMEOUT_MS = 300_000;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/**
 * The only branch a repository bundle may carry: the project's checked-out branch. Never a run's own branch
 * (`run/<id>`), which the receiving machine creates itself, and only conservative ref characters.
 */
const PROJECT_BRANCH = /^refs\/heads\/(?!run\/)[A-Za-z0-9_-][A-Za-z0-9._/-]{0,199}$/;
const SNAPSHOT_IDENTITY = {
  GIT_AUTHOR_NAME: "The Terminal", GIT_AUTHOR_EMAIL: "theterminal@localhost",
  GIT_COMMITTER_NAME: "The Terminal", GIT_COMMITTER_EMAIL: "theterminal@localhost",
} as const;

const isWindows = process.platform === "win32";
const fold = (p: string): string => (isWindows ? p.toLowerCase() : p);
const snapshotRef = (runId: string): string => `refs/theterminal/snapshot/${runId}`;

/** A refusal of runGit's own safeguards is passed on as it is, never reported as a bad bundle. */
const isRefusal = (e: unknown): boolean =>
  e instanceof UnsafeGitConfigError || e instanceof HooksDirModifiedError || e instanceof SharedGitconfigModifiedError ||
  e instanceof GitEnvRefusedError;

function assertId(kind: string, id: string): void {
  if (typeof id !== "string" || !ID_PATTERN.test(id)) throw new Error(`invalid ${kind}`);
}

function assertBundlePath(file: string): void {
  if (typeof file !== "string" || !isAbsolute(file) || file.includes("\0")) throw new Error("the bundle path must be absolute");
}

/** A ref name with nothing git or a later step could misread: conservative characters, no `..`, `//`, `.lock` or `/.`. */
function isProjectBranch(ref: string): boolean {
  return PROJECT_BRANCH.test(ref) && !/\.\.|\/\/|\/\.|\.lock(?:\/|$)|[/.]$/.test(ref);
}

/** The data folder a manager works in, from the one path it names for a project. */
const dataDirOf = (wt: WorktreeManager, projectId: string): string => dirname(dirname(dirname(wt.repoPath(projectId))));

/** Runs a git step over an untrusted bundle: any failure but a safeguard's refusal is BundleInvalidError. */
async function overBundle(step: Promise<string>): Promise<string> {
  try {
    return await step;
  } catch (e) {
    if (isRefusal(e)) throw e;
    throw new BundleInvalidError();
  }
}

/**
 * Checks a received bundle before git reads it: a regular file (no symlink) of at most MAX_BUNDLE_BYTES, then
 * `git bundle verify` in `repo`. Returns the bundle's refs from `git bundle list-heads`, each a well-formed object id
 * and name. Anything else is BundleInvalidError.
 */
async function verifiedHeads(wt: WorktreeManager, repo: string, file: string): Promise<{ id: string; ref: string }[]> {
  let st;
  try {
    st = lstatSync(file);
  } catch {
    throw new BundleInvalidError();
  }
  if (!st.isFile() || st.size === 0 || st.size > MAX_BUNDLE_BYTES) throw new BundleInvalidError();
  await overBundle(wt.runGit(repo, ["bundle", "verify", file], { timeoutMs: BUNDLE_TIMEOUT_MS }));
  const out = await overBundle(wt.runGit(repo, ["bundle", "list-heads", file], { timeoutMs: BUNDLE_TIMEOUT_MS }));
  const heads = out.split(/\r?\n/).filter((l) => l !== "").map((l) => {
    const m = /^([0-9a-f]+) (\S+)$/.exec(l);
    if (m === null || !OBJECT_ID.test(m[1]!)) throw new BundleInvalidError();
    return { id: m[1]!, ref: m[2]! };
  });
  return heads;
}

/**
 * Fetches exactly `ref` from the verified bundle into the same ref of `repo`: objects checked as they arrive
 * (`transfer.fsckObjects`), no tags, no submodules, no FETCH_HEAD, no automatic gc. `--update-head-ok` because the
 * project repository may have that branch checked out already.
 */
async function fetchRef(wt: WorktreeManager, repo: string, file: string, ref: string): Promise<void> {
  await overBundle(
    wt.runGit(
      repo,
      [
        "-c", "transfer.fsckObjects=true", "fetch", "--update-head-ok", "--no-tags", "--no-recurse-submodules",
        "--no-write-fetch-head", "--no-auto-gc", "--quiet", file, `+${ref}:${ref}`,
      ],
      { timeoutMs: BUNDLE_TIMEOUT_MS },
    ),
  );
}

/**
 * Writes the project repository to `file` (an absolute path) as a bundle of its checked-out branch and HEAD only:
 * none of the run branches (`run/*`), snapshot refs or tags that earlier runs and imports left in it, and nothing of
 * the data folder around it (the repository is `projects/<projectId>/repo`). A failed export leaves no file.
 */
export async function exportRepoBundle(wt: WorktreeManager, projectId: string, file: string): Promise<void> {
  assertBundlePath(file);
  const repo = await wt.ensureProjectRepo(projectId);
  const branch = (await wt.runGit(repo, ["symbolic-ref", "-q", "HEAD"])).trim();
  if (!isProjectBranch(branch)) throw new Error("the project repository has no branch checked out that can be sent");
  mkdirSync(dirname(file), { recursive: true });
  rmSync(file, { force: true });
  try {
    await wt.runGit(repo, ["bundle", "create", file, "HEAD", branch], { timeoutMs: BUNDLE_TIMEOUT_MS });
  } catch (e) {
    rmSync(file, { force: true });
    throw e;
  }
}

/**
 * Imports a repository bundle another machine sent into the project's repository (created if missing), and checks
 * out its branch. The bundle must pass `git bundle verify` and hold exactly HEAD and one branch (not a run branch)
 * at the same commit, the commit HEAD names; any other ref, or any failure reading it, is BundleInvalidError with the
 * repository untouched. Only that branch is fetched (`+refs/heads/<b>:refs/heads/<b>`); HEAD is then pointed at it
 * and the working tree reset to it. Every git call goes through runGit, so no hook, filter or fsmonitor of either
 * side runs. The bundle file is deleted afterwards in every case.
 */
export async function importRepoBundle(wt: WorktreeManager, projectId: string, file: string): Promise<void> {
  assertBundlePath(file);
  try {
    const repo = await wt.ensureProjectRepo(projectId);
    const heads = await verifiedHeads(wt, repo, file);
    const head = heads.filter((h) => h.ref === "HEAD");
    const branches = heads.filter((h) => h.ref !== "HEAD");
    if (heads.length !== 2 || head.length !== 1 || branches.length !== 1) throw new BundleInvalidError();
    const [{ ref: branch, id }] = branches as [{ ref: string; id: string }];
    if (!isProjectBranch(branch) || id !== head[0]!.id) throw new BundleInvalidError();
    await fetchRef(wt, repo, file, branch);
    await wt.runGit(repo, ["symbolic-ref", "HEAD", branch]);
    await wt.runGit(repo, ["reset", "--hard", "--quiet", id], { timeoutMs: BUNDLE_TIMEOUT_MS });
    const now = (await wt.runGit(repo, ["rev-parse", "--verify", "HEAD^{commit}"])).trim();
    if (now !== id) throw new BundleInvalidError();
  } finally {
    rmSync(file, { force: true });
  }
}

/**
 * The run worktree at `worktreeAbs`, checked as `verifiedGit` checks one: it must be
 * `<dataDir>/projects/<projectId>/worktrees/<runId>` of this manager's data folder, git's top level there must be
 * that directory, its git directory the project repository's entry for it and its common directory the project
 * repository's `.git`. Anything else is WorktreeMissingError. Returns the paths later calls pin with
 * `--git-dir`/`--work-tree`.
 */
async function runWorktreeGit(wt: WorktreeManager, worktreeAbs: string, runId: string): Promise<{ abs: string; gitDir: string; dataDir: string }> {
  const abs = resolve(worktreeAbs);
  const projectDir = dirname(dirname(abs));
  const projectId = basename(projectDir);
  if (basename(abs) !== runId || basename(dirname(abs)) !== "worktrees" || !ID_PATTERN.test(projectId)) throw new WorktreeMissingError();
  const repo = wt.repoPath(projectId);
  if (fold(resolve(repo)) !== fold(join(projectDir, "repo"))) throw new WorktreeMissingError();
  let gitDir: string;
  try {
    const out = (await wt.runGit(abs, ["rev-parse", "--show-toplevel", "--absolute-git-dir", "--git-common-dir"]))
      .split(/\r?\n/)
      .map((l) => l.trim());
    if (out.length < 3 || !out[0] || !out[1] || !out[2]) throw new WorktreeMissingError();
    const top = realpathSync.native(out[0]);
    gitDir = realpathSync.native(out[1]);
    const common = realpathSync.native(resolve(abs, out[2]));
    const repoGit = realpathSync.native(join(repo, ".git"));
    const entry = realpathSync.native(join(repoGit, "worktrees", basename(abs)));
    if (fold(top) !== fold(realpathSync.native(abs)) || fold(gitDir) !== fold(entry) || fold(common) !== fold(repoGit)) {
      throw new WorktreeMissingError();
    }
  } catch (e) {
    if (isRefusal(e)) throw e;
    throw new WorktreeMissingError();
  }
  return { abs, gitDir, dataDir: dirname(dirname(projectDir)) };
}

/**
 * Commits the run's worktree as it is, without touching the agent's own index, and writes that commit to `file` as a
 * bundle of `refs/theterminal/snapshot/<runId>`. A temporary index under `<dataDir>/link/tmp`, outside the worktree
 * (so it is never itself part of the snapshot), starts from HEAD's tree (`read-tree`, so a tracked file .gitignore
 * matches stays) and takes the working tree with `add -A -- .`; `write-tree` and `commit-tree` on HEAD, as "The
 * Terminal" <theterminal@localhost>, make the snapshot commit, which `update-ref` names. The temporary index is
 * removed in every case, and a failed snapshot leaves no bundle. Returns the commit id.
 */
export async function snapshotBundle(wt: WorktreeManager, worktreeAbs: string, runId: string, file: string): Promise<string> {
  assertId("runId", runId);
  assertBundlePath(file);
  const { abs, gitDir, dataDir } = await runWorktreeGit(wt, worktreeAbs, runId);
  const git = (args: string[], opts: Parameters<WorktreeManager["runGit"]>[2] = {}): Promise<string> =>
    wt.runGit(abs, args, { gitDir, workTree: abs, ...opts });
  const head = (await git(["rev-parse", "--verify", "HEAD^{commit}"])).trim();
  if (!OBJECT_ID.test(head)) throw new WorktreeMissingError();
  const tmpRoot = join(dataDir, "link", "tmp");
  mkdirSync(tmpRoot, { recursive: true });
  const dir = mkdtempSync(join(tmpRoot, `${runId}-`));
  try {
    const env = { GIT_INDEX_FILE: join(dir, "index") };
    await git(["read-tree", head], { env, timeoutMs: BUNDLE_TIMEOUT_MS });
    await git(["add", "-A", "--", "."], { env, timeoutMs: BUNDLE_TIMEOUT_MS });
    const tree = (await git(["write-tree"], { env, timeoutMs: BUNDLE_TIMEOUT_MS })).trim();
    if (!OBJECT_ID.test(tree)) throw new Error("git wrote no tree for the snapshot");
    const commit = (
      await git(["commit-tree", tree, "-p", head, "-m", `The Terminal snapshot of run ${runId}`], { env: { ...env, ...SNAPSHOT_IDENTITY } })
    ).trim();
    if (!OBJECT_ID.test(commit)) throw new Error("git wrote no snapshot commit");
    await git(["update-ref", snapshotRef(runId), commit]);
    mkdirSync(dirname(file), { recursive: true });
    rmSync(file, { force: true });
    try {
      await git(["bundle", "create", file, snapshotRef(runId)], { timeoutMs: BUNDLE_TIMEOUT_MS });
    } catch (e) {
      rmSync(file, { force: true });
      throw e;
    }
    return commit;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Imports a run's snapshot bundle from the machine that ran it into the project's repository, and checks it out as
 * the run's worktree at the path createRunWorktree would have used (`projects/<projectId>/worktrees/<runId>`). The
 * bundle must pass `git bundle verify` and hold exactly `refs/theterminal/snapshot/<runId>`, else BundleInvalidError
 * with nothing fetched. The run's branch `run/<runId>` is created at the snapshot commit, or reused when it is
 * already there. The bundle file is deleted afterwards in every case.
 */
export async function importSnapshot(
  wt: WorktreeManager,
  projectId: string,
  runId: string,
  file: string,
): Promise<{ commit: string; absPath: string; relPath: string }> {
  assertId("projectId", projectId);
  assertId("runId", runId);
  assertBundlePath(file);
  try {
    const repo = await wt.ensureProjectRepo(projectId);
    const ref = snapshotRef(runId);
    const heads = await verifiedHeads(wt, repo, file);
    if (heads.length !== 1 || heads[0]!.ref !== ref) throw new BundleInvalidError();
    await fetchRef(wt, repo, file, ref);
    const commit = (await wt.runGit(repo, ["rev-parse", "--verify", `${ref}^{commit}`])).trim();
    if (commit !== heads[0]!.id) throw new BundleInvalidError();
    const branch = `run/${runId}`;
    const existing = await wt.runGit(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`]).then(
      (out) => out.trim(),
      () => null,
    );
    if (existing === null) await wt.runGit(repo, ["branch", branch, commit]);
    else if (existing !== commit) throw new Error("the run's branch already exists at another commit");
    const dataDir = dataDirOf(wt, projectId);
    const absPath = join(dataDir, "projects", projectId, "worktrees", runId);
    mkdirSync(dirname(absPath), { recursive: true });
    await wt.runGit(repo, ["worktree", "add", "--quiet", absPath, branch], { timeoutMs: BUNDLE_TIMEOUT_MS });
    const relPath = relative(dataDir, absPath).split(sep).join("/");
    return { commit, absPath, relPath };
  } finally {
    rmSync(file, { force: true });
  }
}
