import { execFile as nodeExecFile, spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, sep } from "node:path";
import { OVERRIDE_PROGRAM, visibleControls, type Actor, type AgentRun, type OverrideEventType } from "@theterminal/shared";
import { z } from "zod";
import { NotFoundError } from "../board/board-service.js";
import { baseChildEnv } from "../agents/child-env.js";
import { truncate } from "../agents/redact.js";
import { which as whichOnPath } from "../agents/which.js";
import { RunActiveError, isGitSegment, runWorktree, verifiedGit, type ChangesDeps } from "../changes/changes.js";
import { commitEvent } from "../events/commit.js";
import { getRun } from "../events/projections.js";
import type { RecordedText } from "../intake/recorded-text.js";
import { HumanRequiredError, SecretInTextError } from "../intake/service.js";
import type { Ledger } from "../ledger/ledger.js";

/**
 * The emergency override: the Owner acting directly on a stopped run's working copy, outside the agent gate. A
 * `command` runs one program the Owner names, as the Owner, started directly (never through a shell) with the
 * allowlisted environment (no connection keys); a `discard` drops the working copy's uncommitted changes and keeps
 * the agent's commits. Each is refused while the run is live or another override runs for it, records its request
 * before it starts and `override.completed` after it ends, and records nothing when it is refused.
 */

export { RunActiveError };

/** RunActiveError's message for an override. */
export const OVERRIDE_RUN_ACTIVE = "an agent is still working in this run";

export class OverrideBusyError extends Error {
  constructor() {
    super("an override is already running for this run");
    this.name = "OverrideBusyError";
  }
}

export class ProgramNotFoundError extends Error {
  constructor() {
    super("program not found on PATH");
    this.name = "ProgramNotFoundError";
  }
}

export class ProgramNotAllowedError extends Error {
  constructor() {
    super("program cannot be run as an override");
    this.name = "ProgramNotAllowedError";
  }
}

/** The workspace is shutting down: no new override starts. */
export class OverridesShuttingDownError extends Error {
  constructor() {
    super("workspace is shutting down");
    this.name = "OverridesShuttingDownError";
  }
}

export const OVERRIDE_TIMEOUT_MS = 600_000;
export const OVERRIDE_OUTPUT_CHARS = 16_000;
export const OVERRIDE_BUFFER = 1_048_576;
/** How long shutdown waits for killed overrides to end before recording them itself. */
const SHUTDOWN_WAIT_MS = 5_000;
const SIGNAL = /^SIG[A-Z0-9]+$/;
const RESTARTED = "workspace restarted";
const RECOVERY: Actor = { kind: "system", id: "override" };

const commandInput = z
  .object({
    program: z.string().min(1).max(260),
    args: z.array(z.string().max(1000)).max(64).default([]),
    cwd: z.string().max(500).optional(),
    reason: z.string(),
  })
  .strict();

export type OverrideDeps = ChangesDeps & {
  ledger: Ledger;
  /** How the Owner's text is checked for secrets and scrubbed of local paths before it is recorded. */
  recorded: RecordedText;
  /** PATH lookup for a bare program name. Default: this process's PATH. */
  which?: (cmd: string) => string | null;
  /** Starts the program (never through a shell). Default node's spawn. */
  spawn?: typeof nodeSpawn;
  /** Runs `taskkill` on Windows. Default node's execFile. */
  execFile?: typeof nodeExecFile;
  timeoutMs?: number;
  newId?: () => string;
  now?: () => Date;
  /** Test-only. Default process.platform. */
  platform?: NodeJS.Platform;
};

type Completion = { ok: boolean; exitCode: number | null; signal: string | null; timedOut: boolean; output: string };

type Active = {
  overrideId: string;
  runId: string;
  projectId: string;
  actor: Actor;
  started: number;
  child?: ChildProcess;
  /** Set once override.completed is recorded, so it is recorded exactly once. */
  recorded: boolean;
  killedAtShutdown: boolean;
  done: Promise<void>;
  settle: () => void;
};

const fold = (p: string, platform: NodeJS.Platform): string => (platform === "win32" || platform === "darwin" ? p.toLowerCase() : p);

/** Whether `p` is `dir` or lies inside it (both real paths). Case is ignored where file systems usually do. */
function within(p: string, dir: string, platform: NodeJS.Platform): boolean {
  const rel = relative(fold(dir, platform), fold(p, platform));
  return rel === "" || !(rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel));
}

const real = (p: string): string | null => {
  try {
    return realpathSync.native(p);
  } catch {
    return null;
  }
};

const isWindowsAbsolute = (p: string): boolean => /^[A-Za-z]:[\\/]/.test(p) || /^\\\\/.test(p);

/** A fixed sentence for a program that could not be started, with the error code when it is one. */
function notStarted(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  return `the program could not be started${typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code) ? ` (${code})` : ""}`;
}

/** Counts the entries of `git status --porcelain=v1 -z`: a rename or copy carries its source as an extra field. */
function countStatus(out: string): number {
  const fields = out.split("\0");
  let n = 0;
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i]!;
    if (f.length < 4) continue;
    n++;
    if (f[0] === "R" || f[0] === "C") i++;
  }
  return n;
}

export class OverrideService {
  private readonly active_ = new Map<string, Active>();
  private shuttingDown = false;
  private readonly exec: typeof nodeExecFile;
  private readonly spawn: typeof nodeSpawn;
  private readonly platform: NodeJS.Platform;
  private readonly newId: () => string;
  private readonly now: () => Date;

  constructor(private readonly deps: OverrideDeps) {
    this.exec = deps.execFile ?? nodeExecFile;
    this.spawn = deps.spawn ?? nodeSpawn;
    this.platform = deps.platform ?? process.platform;
    this.newId = deps.newId ?? (() => randomUUID());
    this.now = deps.now ?? (() => new Date());
  }

  active(runId: string): boolean {
    return this.active_.has(runId);
  }

  /**
   * Runs a program in the run's working copy. Resolves once the process has started and `override.command` is
   * committed; `override.completed` follows when it exits, is killed after the timeout, or at shutdown. Everything up
   * to the spawn is synchronous, so no other override or check can interleave.
   */
  async command(actor: Actor, runId: string, input: { program: string; args?: string[]; cwd?: string; reason: string }): Promise<{ overrideId: string }> {
    if (actor.kind !== "human") throw new HumanRequiredError();
    const body = commandInput.parse(input);
    const { recorded } = this.deps;
    const reason = recorded.text("reason", body.reason, { min: 10, max: 500 });
    for (const text of [...body.args, body.program, body.cwd ?? ""]) {
      if (!recorded.passes(text)) throw new SecretInTextError();
    }
    const { run, abs } = this.stoppedRun(runId);
    const cwdRel = (body.cwd ?? ".").split(/[\\/]/).filter((s) => s !== "" && s !== ".").join("/");
    const cwd = this.resolveCwd(abs, body.cwd ?? ".");
    const program = this.resolveProgram(body.program, abs);
    const env = { ...baseChildEnv(this.deps.dataDir), GIT_CEILING_DIRECTORIES: dirname(abs) };

    const entry = this.begin(actor, run, "override.command", (overrideId) => ({
      overrideId,
      runId,
      program: truncate(recorded.scrub(body.program), 260),
      args: body.args.map((a) => truncate(recorded.scrub(a), 1000)),
      cwd: truncate(recorded.scrub(cwdRel === "" ? "." : cwdRel), 500),
      reason,
    }));

    let timedOut = false;
    let overflow = false;
    let startError: string | null = null;
    let timer: NodeJS.Timeout | undefined;
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const sizes = { out: 0, err: 0 };
    const complete = (code: number | null, sig: NodeJS.Signals | null) => {
      clearTimeout(timer);
      if (entry.recorded) return;
      const killed = timedOut || overflow || entry.killedAtShutdown;
      const exitCode = killed || startError !== null ? null : code;
      const signal = killed ? "SIGKILL" : typeof sig === "string" && SIGNAL.test(sig) ? sig : null;
      const stdout = Buffer.concat(out).toString("utf8");
      const stderr = Buffer.concat(err).toString("utf8");
      let raw = stdout + (stderr ? `\n[stderr]\n${stderr}` : "");
      if (startError !== null) raw = `${raw}${raw ? "\n" : ""}${startError}`;
      this.finish(entry, { ok: exitCode === 0 && !killed, exitCode, signal, timedOut, output: this.cleanOutput(runId, raw) });
    };
    let child: ChildProcess;
    try {
      child = this.spawn(program, body.args, {
        cwd, env, windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"],
        // POSIX: its own process group, so a timeout or shutdown kills everything it started.
        detached: this.platform !== "win32",
      });
    } catch (e) {
      startError = notStarted(e);
      complete(null, null);
      return { overrideId: entry.overrideId };
    }
    entry.child = child;
    const collect = (into: Buffer[], key: "out" | "err") => (chunk: Buffer) => {
      if (overflow) return;
      sizes[key] += chunk.length;
      if (sizes[key] > OVERRIDE_BUFFER) {
        overflow = true; // as execFile's maxBuffer: what was read is kept, the process tree is killed
        into.push(chunk.subarray(0, chunk.length - (sizes[key] - OVERRIDE_BUFFER)));
        this.killTree(child);
        return;
      }
      into.push(chunk);
    };
    child.stdout?.on("data", collect(out, "out"));
    child.stderr?.on("data", collect(err, "err"));
    child.stdin?.on("error", () => undefined); // a program that exits at once closes its stdin first
    child.stdin?.end(); // nothing is ever typed into an override
    child.on("error", (e) => {
      startError = notStarted(e);
      if (child.pid === undefined) complete(null, null); // never started: no close follows for sure
    });
    child.on("close", (code, sig) => complete(code, sig));
    timer = setTimeout(() => {
      timedOut = true;
      this.killTree(child);
    }, this.deps.timeoutMs ?? OVERRIDE_TIMEOUT_MS);
    return { overrideId: entry.overrideId };
  }

  /**
   * Drops the working copy's uncommitted changes (`git reset --hard HEAD`, then `git clean -fd`) and keeps the
   * agent's commits. `files` counts the uncommitted entries git reported before. Resolves after override.completed.
   */
  async discard(actor: Actor, runId: string, reason: string): Promise<{ overrideId: string; files: number }> {
    if (actor.kind !== "human") throw new HumanRequiredError();
    const why = this.deps.recorded.text("reason", reason, { min: 10, max: 500 });
    const { run, abs } = this.stoppedRun(runId);
    // Held from here (synchronously after the checks), so nothing else starts while git counts the files.
    const hold = this.hold(actor, run);
    let files: number;
    let git: Awaited<ReturnType<typeof verifiedGit>>;
    try {
      git = await verifiedGit(this.deps, run, abs);
      files = countStatus(await git(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=all"]));
      if (this.shuttingDown) throw new OverridesShuttingDownError();
      this.record(hold, "override.discard", { overrideId: hold.overrideId, runId, reason: why, files });
    } catch (e) {
      this.release(hold);
      throw e;
    }
    let completion: Completion;
    try {
      const reset = await git(["reset", "--hard", "HEAD"]);
      const clean = await git(["clean", "-fd"]);
      completion = { ok: true, exitCode: 0, signal: null, timedOut: false, output: this.cleanOutput(runId, reset + clean) };
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e);
      completion = { ok: false, exitCode: null, signal: null, timedOut: false, output: this.cleanOutput(runId, text) };
    }
    this.finish(hold, completion);
    return { overrideId: hold.overrideId, files };
  }

  /**
   * At start, before any request: every override.command or override.discard without an override.completed for the
   * same override ended with the previous process, so it is recorded as failed ("workspace restarted").
   */
  recoverOnStartup(): void {
    const { db, ledger } = this.deps;
    if (ledger.readOnly) return;
    const dangling = db
      .prepare(
        `SELECT r.project_id AS projectId, json_extract(r.payload, '$.overrideId') AS overrideId,
                json_extract(r.payload, '$.runId') AS runId
         FROM ledger r
         WHERE r.type IN ('override.command', 'override.discard') AND json_valid(r.payload)
           AND NOT EXISTS (
             SELECT 1 FROM ledger c
             WHERE c.type = 'override.completed' AND json_valid(c.payload)
               AND json_extract(c.payload, '$.overrideId') = json_extract(r.payload, '$.overrideId'))
         ORDER BY r.seq`,
      )
      .all() as { projectId: string | null; overrideId: unknown; runId: unknown }[];
    for (const d of dangling) {
      if (typeof d.overrideId !== "string" || typeof d.runId !== "string") continue;
      if ([...this.active_.values()].some((a) => a.overrideId === d.overrideId)) continue;
      commitEvent(db, ledger, () => ({
        event: {
          projectId: d.projectId, actor: RECOVERY, type: "override.completed",
          payload: {
            overrideId: d.overrideId, runId: d.runId, ok: false, exitCode: null, signal: null, timedOut: false, durationMs: 0,
            output: RESTARTED,
          },
        },
        result: () => undefined,
      }));
    }
  }

  /**
   * Kills every running override's process tree, waits up to 5 s for them to end, and records any that has not
   * ended itself as completed { ok: false, signal: "SIGKILL" }. No override starts afterwards.
   */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const all = [...this.active_.values()];
    for (const a of all) {
      if (a.child === undefined) continue;
      a.killedAtShutdown = true;
      this.killTree(a.child);
    }
    let timer: NodeJS.Timeout | undefined;
    const waited = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, SHUTDOWN_WAIT_MS);
    });
    await Promise.race([Promise.all(all.map((a) => a.done)), waited]);
    clearTimeout(timer);
    for (const a of all) {
      if (!a.recorded) {
        this.finish(a, {
          ok: false, exitCode: null, signal: a.child === undefined ? null : "SIGKILL", timedOut: false, output: RESTARTED,
        });
      }
    }
  }

  /** The run's worktree, refused while the run is live or another override runs for it. */
  private stoppedRun(runId: string): { run: AgentRun; abs: string } {
    if (this.shuttingDown) throw new OverridesShuttingDownError();
    const found = runWorktree(this.deps, runId);
    if (found.run.status === "running") throw new RunActiveError(OVERRIDE_RUN_ACTIVE);
    if (this.active(runId)) throw new OverrideBusyError();
    return found;
  }

  /** The working directory inside the worktree: a directory resolveInside accepts, never `.git`; else NotFoundError. */
  private resolveCwd(abs: string, cwd: string): string {
    const notFound = new NotFoundError("path", "(given)");
    if (isAbsolute(cwd) || isWindowsAbsolute(cwd) || cwd.startsWith("\\")) throw notFound;
    if (cwd.split(/[\\/]/).some((s) => isGitSegment(s))) throw notFound;
    const resolved = this.deps.worktrees.resolveInside(abs, cwd);
    if (resolved === null) throw notFound;
    try {
      if (!statSync(resolved).isDirectory()) throw notFound;
    } catch {
      throw notFound;
    }
    return resolved;
  }

  /**
   * The program to start: an absolute path as given, or a bare name found on PATH only. Never a relative path, a
   * program inside the worktree or the data folder (by its real path), or a Windows batch file.
   */
  private resolveProgram(program: string, worktreeAbs: string): string {
    let found: string | null;
    if (isAbsolute(program) || isWindowsAbsolute(program)) {
      found = program;
    } else if (/[\\/]/.test(program)) {
      throw new ProgramNotAllowedError();
    } else {
      if (!OVERRIDE_PROGRAM.test(program)) throw new ProgramNotFoundError();
      found = (this.deps.which ?? ((cmd: string) => whichOnPath(cmd)))(program);
    }
    if (found === null) throw new ProgramNotFoundError();
    const resolved = real(found);
    if (resolved === null) throw new ProgramNotFoundError();
    try {
      if (!statSync(resolved).isFile()) throw new ProgramNotFoundError();
    } catch {
      throw new ProgramNotFoundError();
    }
    if ([found, resolved].some((p) => /\.(?:cmd|bat)$/i.test(p))) throw new ProgramNotAllowedError();
    const roots = [worktreeAbs, this.deps.dataDir].map((d) => real(d) ?? d);
    if (roots.some((root) => [found, resolved].some((p) => within(p, root, this.platform)))) throw new ProgramNotAllowedError();
    return resolved;
  }

  /** Holds the run for a new override (not yet recorded). */
  private hold(actor: Actor, run: AgentRun): Active {
    let settle!: () => void;
    const done = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const a: Active = {
      overrideId: this.newId(), runId: run.id, projectId: run.projectId, actor, started: this.now().getTime(),
      recorded: false, killedAtShutdown: false, done, settle,
    };
    this.active_.set(run.id, a);
    return a;
  }

  private release(a: Active): void {
    if (this.active_.get(a.runId) === a) this.active_.delete(a.runId);
    a.settle();
  }

  /** Commits the request entry, checking again inside the transaction that the run is not live. */
  private record(a: Active, type: Exclude<OverrideEventType, "override.completed">, payload: Record<string, unknown>): void {
    const { db, ledger } = this.deps;
    commitEvent(db, ledger, () => {
      if (getRun(db, a.runId)?.status === "running") throw new RunActiveError(OVERRIDE_RUN_ACTIVE);
      return { event: { projectId: a.projectId, actor: a.actor, type, payload }, result: () => undefined };
    });
  }

  /** Holds the run and commits the request; nothing is held when the commit fails. */
  private begin(
    actor: Actor,
    run: AgentRun,
    type: Exclude<OverrideEventType, "override.completed">,
    payload: (overrideId: string) => Record<string, unknown>,
  ): Active {
    const a = this.hold(actor, run);
    try {
      this.record(a, type, payload(a.overrideId));
    } catch (e) {
      this.release(a);
      throw e;
    }
    return a;
  }

  /** Records override.completed once and frees the run. */
  private finish(a: Active, c: Completion): void {
    if (a.recorded) return;
    a.recorded = true;
    try {
      const { db, ledger } = this.deps;
      commitEvent(db, ledger, () => ({
        event: {
          projectId: a.projectId, actor: a.actor, type: "override.completed",
          payload: {
            overrideId: a.overrideId, runId: a.runId, ...c, durationMs: Math.max(0, Math.round(this.now().getTime() - a.started)),
          },
        },
        result: () => undefined,
      }));
    } catch {
      // The ledger could not take it (read-only, closed): recoverOnStartup records it at the next start.
      console.error("The Terminal: an override's completion could not be recorded");
    } finally {
      this.release(a);
    }
  }

  /** Redact (the run's and every minted secret), scrub, redact, then show controls, and only then cut. */
  private cleanOutput(runId: string, raw: string): string {
    return truncate(visibleControls(this.deps.clean(runId, raw, Infinity)), OVERRIDE_OUTPUT_CHARS);
  }

  /** The whole process tree: its process group on POSIX, `taskkill /T /F` on Windows. */
  private killTree(child: ChildProcess): void {
    const pid = child.pid;
    if (pid === undefined) return;
    if (this.platform === "win32") {
      this.exec("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, shell: false, timeout: 10_000 }, (err) => {
        if (err && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      });
      return;
    }
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }
}
