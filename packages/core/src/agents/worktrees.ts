import { execFile } from "node:child_process";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type GitRunner = (args: string[], cwd: string) => Promise<string>;

const ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;
const COMMIT_IDENTITY = ["-c", "user.name=The Terminal", "-c", "user.email=agent@theterminal.localhost", "-c", "commit.gpgsign=false"];

const defaultGit: GitRunner = async (args, cwd) => {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return stdout;
};

function assertId(kind: string, id: string): void {
  if (!ID_PATTERN.test(id)) throw new Error(`invalid ${kind}`);
}

const isWindows = process.platform === "win32";
const fold = (p: string): string => (isWindows ? p.toLowerCase() : p);

export class WorktreeManager {
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly dataDir: string,
    private readonly git: GitRunner = defaultGit,
  ) {}

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
    if (existsSync(join(repo, ".git"))) return repo;
    mkdirSync(repo, { recursive: true });
    await this.git(["init"], repo);
    await this.git([...COMMIT_IDENTITY, "commit", "--allow-empty", "-m", "Initial commit"], repo);
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

  /** Returns the realpath-resolved absolute path if `p` is inside the worktree, else null. */
  resolveInside(worktreeAbs: string, p: string): string | null {
    if (p.includes("\0") || worktreeAbs.includes("\0")) return null;
    let root: string;
    try {
      root = realpathSync(worktreeAbs);
    } catch {
      return null;
    }
    const target = resolve(root, p);

    // Realpath the longest existing ancestor, then re-append the missing remainder.
    let existing = target;
    const remainder: string[] = [];
    for (;;) {
      try {
        existing = realpathSync(existing);
        break;
      } catch {
        const parent = dirname(existing);
        if (parent === existing) return null;
        remainder.unshift(existing.slice(parent.length).replace(/^[\\/]+/, ""));
        existing = parent;
      }
    }
    if (remainder.some((seg) => seg === ".." || seg.split(/[\\/]/).includes(".."))) return null;
    const real = normalize(join(existing, ...remainder));

    const rel = relative(fold(root), fold(real));
    if (rel === "") return real;
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
    return real;
  }
}
