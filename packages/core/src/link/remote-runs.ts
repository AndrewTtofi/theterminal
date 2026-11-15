import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  agentPayloadSchemas, helloResponseSchema, LINK_PROTOCOL_VERSION, type Actor, type AdapterId, type AgentAction, type AgentRun,
} from "@theterminal/shared";
import type { Db } from "../db.js";
import type { Ledger } from "../ledger/ledger.js";
import { commitEvent } from "../events/commit.js";
import { getLinkRun, getMachine, getRun, listActions, listLinkRuns } from "../events/projections.js";
import { NotFoundError } from "../board/board-service.js";
import { HumanRequiredError } from "../intake/service.js";
import { redact } from "../agents/redact.js";
import type { WorktreeManager } from "../agents/worktrees.js";
import { ConflictError } from "../connections/service.js";
import { BundleGitLimitError, BundleInvalidError, MAX_BUNDLE_BYTES, exportRepoBundle, importSnapshot } from "./bundles.js";
import {
  DEFAULT_STREAM_IDLE_MS, LinkProtocolError, MachineKeyMismatchError, MachineUnreachableError, RemoteRefusedError,
  type LinkClient, type Peer,
} from "./client.js";
import { acceptMirroredLine, FATAL_REFUSALS } from "./mirrored.js";
import type { LinkService } from "./service.js";

/**
 * The requester's side of a remote run: this computer asks a paired machine (the worker) to run an agent on one of
 * its projects, follows the run through the worker's signed ledger entries, sends the Owner's decisions and stops to
 * the worker, and imports the worker's snapshot of the run's working copy when the run is over, for the Owner to
 * review like any run's changes (never merged by this code).
 *
 * Everything the worker sends is untrusted: each line of its stream is checked and committed on its own by
 * acceptMirroredLine (the pinned key, the run, the project, the cursor, duplicates, action ownership); a refusal that
 * a correct worker never causes ends the run there. A local runner never stops or decides a remote run: those go to
 * the worker, and nothing is recorded here until the worker's own entries arrive.
 */

/** What the link records as the system's own work on a remote run. */
const LINK_ACTOR = { kind: "system", id: "link" } as const;
/** The waits between reconnects (and between snapshot downloads), the last one repeated. */
const DEFAULT_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];
/**
 * A start, an upload or a download waits on git on the worker (importing the repository, creating the run's working
 * copy, writing the snapshot) before it answers; slow disks and Windows get the time for it.
 */
const SLOW_TIMEOUT_MS = 300_000;
/** A decision, a stop or a hello answers at once. */
const QUICK_TIMEOUT_MS = 10_000;
const MAX_PROMPT = 20_000;
const MAX_REASON = 500;
const OBJECT_ID = /^[0-9a-f]{40}$/;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;
/** Remote statuses that would read as something about this computer (its session, its own workspace) are not passed on. */
const NOT_PASSED_ON = new Set([401, 403, 407, 423]);

/**
 * The worker refused a remote-run request. `status` is the worker's status when it is a client error this computer
 * can pass on (else 502), `code` the worker's error code (a short `[a-z0-9_]` word, never its message), and `machine`
 * the name this computer recorded for it. Answered as `{ error: "remote_refused", code, machine }`.
 */
export class RemoteRunRefusedError extends Error {
  readonly status: number;
  constructor(status: number, readonly code: string, readonly machine: string) {
    super(`the linked machine refused: ${code}`);
    this.name = "RemoteRunRefusedError";
    this.status = status >= 400 && status < 500 && !NOT_PASSED_ON.has(status) ? status : 502;
  }
}

export type RemoteRunDeps = {
  db: Db;
  ledger: Ledger;
  link: LinkService;
  worktrees: WorktreeManager;
  dataDir: string;
  /** The client for one paired machine, given a timeout. Default: the link service's (this computer's identity). */
  client?: (timeoutMs: number) => LinkClient;
  /**
   * Cleans the prompt before it is recorded or sent (redaction with every known secret, paths): the same cleaning as
   * a local run's recorded prompt. Default: the built-in redaction.
   */
  clean?: (s: string) => string;
  /** The waits between reconnects, the last one repeated. Default 1 s, 2 s, 4 s, 8 s, 16 s, then every 30 s. */
  backoffMs?: number[];
  /** Silence on a stream past this is a cut machine (the worker's heartbeat comes every 30 s). Default 120 s. */
  streamIdleMs?: number;
};

type Following = { abort: AbortController; done: Promise<void> };

/** Ends the stream after a fatal refusal or a projection conflict: this run is not followed any further. */
class StopFollowing extends Error {}
/** Closes the stream after a transient refusal: reconnect and resume from the cursor. */
class Reconnect extends Error {}

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });

/** The worker's code for a refusal; anything a reply could not say is `unknown`. */
const codeOf = (err: unknown): string => (err instanceof RemoteRefusedError ? err.code : "unknown");

/** Whether a refusal may pass with time (the worker busy, settling, shutting down) rather than never. */
const transientRefusal = (err: RemoteRefusedError): boolean =>
  err.status >= 500 || err.status === 408 || err.status === 429 || err.code === "run_active";

export class RemoteRunService {
  private readonly deps: RemoteRunDeps;
  private readonly backoffMs: number[];
  private readonly streamIdleMs: number;
  private readonly clean: (s: string) => string;
  private readonly following = new Map<string, Following>();
  private closed = false;

  constructor(deps: RemoteRunDeps) {
    this.deps = deps;
    this.backoffMs = deps.backoffMs && deps.backoffMs.length > 0 ? deps.backoffMs : DEFAULT_BACKOFF_MS;
    this.streamIdleMs = deps.streamIdleMs ?? DEFAULT_STREAM_IDLE_MS;
    this.clean = deps.clean ?? ((s) => redact(s));
  }

  /** Whether the run executes on a linked machine. */
  isRemote(run: AgentRun): boolean {
    return run.machineId !== null;
  }

  private client(timeoutMs: number): LinkClient {
    return this.deps.client ? this.deps.client(timeoutMs) : this.deps.link.newClient(timeoutMs);
  }

  private machineName(machineId: string): string {
    return getMachine(this.deps.db, machineId)?.name ?? "a linked machine";
  }

  /**
   * Human only. Records `link.run_requested`, sends the project's repository and the run to the paired machine, and
   * follows the run once the worker has accepted it. Answers a provisional run built from this computer's own records:
   * its projection row appears with the worker's first entry. NotFoundError for a machine that is not paired, or a
   * project or card that is not here, before anything is recorded. A failure after the request is recorded commits
   * `link.run_failed` (the worker's code, or `unreachable`), removes the bundle and throws: MachineUnreachableError,
   * or RemoteRunRefusedError with the worker's code.
   */
  async start(
    actor: Actor,
    input: { projectId: string; machineId: string; adapter: AdapterId; prompt: string; cardId?: string | null; connectionIds?: string[] },
  ): Promise<AgentRun> {
    if (actor.kind !== "human") throw new HumanRequiredError();
    const { db, ledger, link } = this.deps;
    const machine = getMachine(db, input.machineId);
    if (!machine) throw new NotFoundError("machine", input.machineId);
    const project = db.prepare("SELECT name FROM projects WHERE id = ?").get(input.projectId) as { name: string } | undefined;
    if (!project || !ID_PATTERN.test(input.projectId)) throw new NotFoundError("project", input.projectId);
    const cardId = input.cardId ?? null;
    if (cardId !== null && !db.prepare("SELECT 1 FROM cards WHERE id = ? AND project_id = ?").get(cardId, input.projectId)) {
      throw new NotFoundError("card", cardId);
    }
    // Cleaned as a local run's recorded prompt is; only the cleaned text is recorded and leaves this computer.
    const prompt = agentPayloadSchemas["agent.started"].shape.prompt.parse([...this.clean(input.prompt)].slice(0, MAX_PROMPT).join(""));
    const connectionIds = input.connectionIds ?? [];
    const peer = link.peerFor(machine.id);
    // IdentityUnavailableError here, before anything is recorded.
    const slow = this.client(SLOW_TIMEOUT_MS);
    const runId = randomUUID();

    commitEvent(db, ledger, () => ({
      event: {
        projectId: input.projectId, actor, type: "link.run_requested",
        payload: { runId, machineId: machine.id, adapter: input.adapter, prompt, cardId, connectionIds },
      },
      result: () => undefined,
    }));

    const outgoing = join(this.deps.dataDir, "link", "outgoing");
    const bundle = join(outgoing, `${runId}.bundle`);
    try {
      await exportRepoBundle(this.deps.worktrees, input.projectId, bundle);
      await this.upload(slow, peer, runId, bundle);
      // The project's name is cleaned like any text that leaves this computer; the worker cleans it again.
      const projectName = [...this.clean(project.name).trim()].slice(0, 120).join("") || "Project";
      await slow.request(peer, "POST", `/link/v1/runs/${runId}/start`, {
        v: LINK_PROTOCOL_VERSION, projectId: input.projectId, projectName, adapter: input.adapter, prompt, cardId, connectionIds,
      });
    } catch (err) {
      const error = err instanceof RemoteRunRefusedError ? err.code
        : err instanceof RemoteRefusedError ? err.code
          : err instanceof MachineUnreachableError ? "unreachable"
            : err instanceof MachineKeyMismatchError ? "machine_key_mismatch"
              : err instanceof LinkProtocolError ? "machine_bad_reply" : "not_sent";
      this.recordFailed(input.projectId, runId, machine.id, error);
      if (err instanceof MachineUnreachableError) link.observed(machine.id, false);
      if (err instanceof RemoteRefusedError) throw new RemoteRunRefusedError(err.status, err.code, machine.name);
      throw err;
    } finally {
      rmSync(bundle, { force: true, maxRetries: 5, retryDelay: 50 });
    }
    link.observed(machine.id, true);
    this.follow(runId);
    const now = new Date().toISOString();
    return {
      id: runId, projectId: input.projectId, cardId, adapter: input.adapter, authMode: "none", prompt, status: "running",
      worktree: `projects/${input.projectId}/worktrees/${runId}`, base: null, costUsd: null, inputTokens: null, outputTokens: null,
      error: null, startedAt: now, finishedAt: null, machineId: machine.id,
    };
  }

  /**
   * Sends the repository. A worker that refuses an upload partway closes the connection, which reads as unreachable;
   * when the machine still answers a hello right after, the upload was refused (`upload_refused`), not lost.
   */
  private async upload(client: LinkClient, peer: Peer, runId: string, bundle: string): Promise<void> {
    try {
      await client.upload(peer, `/link/v1/runs/${runId}/repo`, bundle, MAX_BUNDLE_BYTES);
    } catch (err) {
      if (!(err instanceof MachineUnreachableError)) throw err;
      let answers = false;
      try {
        const hello = await this.client(QUICK_TIMEOUT_MS).request(peer, "GET", "/link/v1/hello", undefined, helloResponseSchema);
        answers = hello.machineId === peer.machineId;
      } catch {
        answers = false;
      }
      if (answers) throw new RemoteRunRefusedError(409, "upload_refused", this.machineName(peer.machineId));
      throw err;
    }
  }

  /**
   * Sends the Owner's decision on an action of a remote run to its worker. Nothing is recorded here: the worker's
   * `agent.action.decided` arrives on the stream. MachineUnreachableError when the worker does not answer;
   * RemoteRunRefusedError for its refusal (`already_decided`, say). Answers the action as this computer has it.
   */
  async decide(actor: Actor, run: AgentRun, actionId: string, decision: "allow" | "deny", reason: string): Promise<AgentAction> {
    if (actor.kind !== "human") throw new HumanRequiredError();
    const machineId = this.remoteOf(run);
    const action = listActions(this.deps.db, run.id).find((a) => a.id === actionId);
    if (!action) throw new NotFoundError("action", actionId);
    const why = [...this.clean(reason)].slice(0, MAX_REASON).join("");
    await this.send(machineId, `/link/v1/runs/${encodeURIComponent(run.id)}/actions/${encodeURIComponent(actionId)}/decision`, {
      v: LINK_PROTOCOL_VERSION, decision, reason: why,
    });
    return listActions(this.deps.db, run.id).find((a) => a.id === actionId) ?? action;
  }

  /** Asks the worker to stop a remote run; as decide, nothing is recorded here. Answers the run as this computer has it. */
  async stop(actor: Actor, run: AgentRun): Promise<AgentRun> {
    if (actor.kind !== "human") throw new HumanRequiredError();
    const machineId = this.remoteOf(run);
    await this.send(machineId, `/link/v1/runs/${encodeURIComponent(run.id)}/stop`, {});
    return getRun(this.deps.db, run.id) ?? run;
  }

  private remoteOf(run: AgentRun): string {
    if (run.machineId === null) throw new Error("not a remote run");
    if (!getMachine(this.deps.db, run.machineId)) throw new NotFoundError("machine", run.machineId);
    return run.machineId;
  }

  private async send(machineId: string, path: string, body: unknown): Promise<void> {
    const peer = this.deps.link.peerFor(machineId);
    try {
      await this.client(QUICK_TIMEOUT_MS).request(peer, "POST", path, body);
      this.deps.link.observed(machineId, true);
    } catch (err) {
      if (err instanceof MachineUnreachableError) this.deps.link.observed(machineId, false);
      if (err instanceof RemoteRefusedError) throw new RemoteRunRefusedError(err.status, err.code, this.machineName(machineId));
      throw err;
    }
  }

  /** Follows every run this computer requested that is not over yet (and imports the changes of one that is). */
  resume(): void {
    for (const r of listLinkRuns(this.deps.db)) {
      if (r.direction === "requested" && (r.state === "requested" || r.state === "running" || r.state === "finished")) this.follow(r.runId);
    }
  }

  /** Stops following every run (each stream is aborted) and waits for them to end. */
  async shutdown(): Promise<void> {
    this.closed = true;
    const all = [...this.following.values()];
    for (const f of all) f.abort.abort();
    await Promise.all(all.map((f) => f.done));
  }

  private follow(runId: string): void {
    if (this.closed || this.following.has(runId)) return;
    const abort = new AbortController();
    const done = this.followLoop(runId, abort.signal)
      .catch(() => undefined)
      .finally(() => {
        if (this.following.get(runId)?.abort === abort) this.following.delete(runId);
      });
    this.following.set(runId, { abort, done });
  }

  private backoff(attempt: number): number {
    return this.backoffMs[Math.min(attempt, this.backoffMs.length - 1)]!;
  }

  /**
   * The stream of one run, from the cursor (`link_runs.last_seq`), reconnecting after every cut with the backoff while
   * the run is not over; then the snapshot, retried with the same backoff until it is imported or refused for good.
   */
  private async followLoop(runId: string, signal: AbortSignal): Promise<void> {
    const { db, ledger, link } = this.deps;
    let attempt = 0;
    while (!signal.aborted) {
      const current = getLinkRun(db, runId);
      if (!current || current.direction !== "requested") return;
      if (current.state === "failed" || current.state === "imported") return;
      if (!getMachine(db, current.machineId)) {
        // Unpaired: its key is gone, so nothing from it can be checked any more.
        this.recordFailed(current.projectId, runId, current.machineId, "machine_unpaired");
        return;
      }
      if (current.state === "finished") return this.importLoop(runId, signal);
      let progressed = false;
      try {
        const peer = link.peerFor(current.machineId);
        const client = this.client(QUICK_TIMEOUT_MS);
        await client.stream(
          peer,
          `/link/v1/runs/${encodeURIComponent(runId)}/events?afterSeq=${current.lastSeq}`,
          async (line) => {
            link.observed(peer.machineId, true);
            const check = acceptMirroredLine(db, ledger, runId, line);
            if (check.ok) {
              progressed = true;
              attempt = 0;
              return;
            }
            if (FATAL_REFUSALS.has(check.reason) || check.reason === "run_failed" || check.reason === "wrong_run") throw new StopFollowing();
            if (check.reason === "conflict") {
              // This computer's own state refuses the worker's entry (a run id already used here): it would refuse it again.
              this.recordFailed(current.projectId, runId, current.machineId, "conflict");
              throw new StopFollowing();
            }
            throw new Reconnect(); // out_of_order, duplicate: resume from the cursor
          },
          signal,
          { idleMs: this.streamIdleMs },
        );
        link.observed(peer.machineId, true);
        // A clean end: after agent.finished the loop imports; otherwise (the worker ended early) reconnect.
        if (getLinkRun(db, runId)?.state === "finished") continue;
      } catch (err) {
        if (signal.aborted || err instanceof StopFollowing) return;
        if (err instanceof MachineUnreachableError) link.observed(current.machineId, false);
        if (err instanceof RemoteRefusedError && !transientRefusal(err)) {
          // The worker says no for good (it does not know the run, or not from us): the run cannot be followed.
          this.recordFailed(current.projectId, runId, current.machineId, `remote_${err.code}`.slice(0, 100));
          return;
        }
        // Unreachable, a cut, a key that does not match, an unreadable line, a transient refusal: wait and reconnect.
      }
      if (!progressed) attempt++;
      await sleep(this.backoff(Math.max(0, attempt - 1)), signal);
    }
  }

  /** Downloads and imports the run's snapshot, retrying a worker that is away or still settling with the backoff. */
  private async importLoop(runId: string, signal: AbortSignal): Promise<void> {
    let attempt = 0;
    while (!signal.aborted) {
      const outcome = await this.importOnce(runId, signal).catch((err: unknown) => err);
      if (outcome === "done" || outcome === "never") return;
      const retry = outcome instanceof MachineUnreachableError || outcome instanceof LinkProtocolError ||
        outcome instanceof BundleGitLimitError || (outcome instanceof RemoteRefusedError && transientRefusal(outcome));
      if (!retry) return; // refused for good, or not a snapshot this computer accepts: left for the Owner to see
      await sleep(this.backoff(attempt++), signal);
    }
  }

  /**
   * One download and import of the snapshot: into `<dataDir>/link/incoming` (created first), then importSnapshot,
   * which checks the bundle and adds the run's working copy at the path the run recorded; the snapshot must descend
   * from the run's starting commit. Commits `link.changes_imported`. Answers "never" when the run cannot be imported
   * here (no run row, a working copy path of another shape), and throws for a failure.
   */
  private async importOnce(runId: string, signal: AbortSignal): Promise<"done" | "never"> {
    const { db, ledger, link, worktrees } = this.deps;
    const current = getLinkRun(db, runId);
    const run = getRun(db, runId);
    if (!current || current.state !== "finished" || !run || run.machineId !== current.machineId) return "never";
    if (run.worktree !== `projects/${run.projectId}/worktrees/${runId}` || !ID_PATTERN.test(runId)) return "never";
    const peer = link.peerFor(current.machineId);
    const incoming = join(this.deps.dataDir, "link", "incoming");
    // The client writes into an existing folder only: without it a download would end with no file.
    mkdirSync(incoming, { recursive: true });
    const file = join(incoming, `${runId}.${randomUUID()}.bundle`);
    try {
      await this.client(SLOW_TIMEOUT_MS).download(peer, `/link/v1/runs/${encodeURIComponent(runId)}/changes`, file, MAX_BUNDLE_BYTES, signal);
      if (signal.aborted) return "never";
      link.observed(peer.machineId, true);
      const { commit, absPath, relPath } = await importSnapshot(worktrees, run.projectId, runId, file);
      if (!OBJECT_ID.test(commit) || relPath !== run.worktree || !(await this.descends(run, commit))) {
        await this.discard(run.projectId, runId, absPath);
        return "never";
      }
      commitEvent(db, ledger, () => ({
        event: { projectId: run.projectId, actor: LINK_ACTOR, type: "link.changes_imported", payload: { runId, machineId: current.machineId, commit } },
        result: () => undefined,
      }));
      return "done";
    } catch (err) {
      if (err instanceof MachineUnreachableError) link.observed(peer.machineId, false);
      if (err instanceof BundleInvalidError || err instanceof ConflictError) return "never";
      throw err;
    } finally {
      rmSync(file, { force: true, maxRetries: 5, retryDelay: 50 });
    }
  }

  /** Whether the snapshot commit descends from the commit the run started at (when the worker recorded one). */
  private async descends(run: AgentRun, commit: string): Promise<boolean> {
    if (run.base === null) return true;
    if (!/^[0-9a-f]{40,64}$/.test(run.base)) return false;
    const repo = this.deps.worktrees.repoPath(run.projectId);
    return this.deps.worktrees.runGit(repo, ["merge-base", "--is-ancestor", run.base, commit]).then(() => true, () => false);
  }

  /** Removes an imported working copy that did not pass the checks: the worktree, its branch and the snapshot ref. */
  private async discard(projectId: string, runId: string, absPath: string): Promise<void> {
    const wt = this.deps.worktrees;
    const repo = wt.repoPath(projectId);
    await wt.runGit(repo, ["worktree", "remove", "--force", absPath]).catch(() => undefined);
    await wt.runGit(repo, ["branch", "-D", `run/${runId}`]).catch(() => undefined);
    await wt.runGit(repo, ["update-ref", "-d", `refs/theterminal/snapshot/${runId}`]).catch(() => undefined);
  }

  /** Records that the remote run failed here (never throws: a read-only ledger must not hide the cause). */
  private recordFailed(projectId: string, runId: string, machineId: string, error: string): void {
    try {
      commitEvent(this.deps.db, this.deps.ledger, () => ({
        event: { projectId, actor: LINK_ACTOR, type: "link.run_failed", payload: { runId, machineId, error } },
        result: () => undefined,
      }));
    } catch {
      // Nothing more to do: the cause is still thrown or the run is no longer followed.
    }
  }
}
