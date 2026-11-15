import { randomUUID } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { join } from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import { remoteDecisionSchema, remoteStartSchema, type AgentAction, type AgentRun, type LedgerEntry, type NewLedgerEntry } from "@theterminal/shared";
import type { Db } from "../db.js";
import type { Ledger } from "../ledger/ledger.js";
import { commitEvent, commitEvents } from "../events/commit.js";
import { getRun } from "../events/projections.js";
import { NotFoundError } from "../board/board-service.js";
import { ConflictError } from "../connections/service.js";
import { AlreadyDecidedError } from "../agents/approvals.js";
import { redact } from "../agents/redact.js";
import { RUN_ID_PATTERN, type AgentRunner } from "../agents/runner.js";
import type { WorktreeManager } from "../agents/worktrees.js";
import { stoppedRunWorktree, type ChangesDeps } from "../changes/changes.js";
import { MAX_BUNDLE_BYTES, NoRepoError, RepoTooLargeError, UploadLimitError, importRepoBundle, snapshotBundle } from "./bundles.js";
import { sendError } from "../server/routes.js";
import { MirrorFrameError, mirrorable, signFrame } from "./mirror.js";
import { IdentityUnavailableError, type LinkService } from "./service.js";

/**
 * The worker's side of remote runs: a paired machine (the requester) sends a project's repository and asks this
 * computer to run an agent on it. The run is an ordinary local run behind this computer's own gate: every action is
 * classified and, where policy says so, waits for a human decision here or relayed from the requester; nothing is
 * mediated differently. The agent gets this computer's own connections, chosen by id; no credential crosses the link.
 * The requester follows the run through signed copies of its ledger entries (the event stream) and fetches the
 * worktree as a snapshot bundle when the run is over.
 *
 * Every method takes the paired machine the request came from (the listener's pin) and only acts on runs this computer
 * accepted from that machine.
 */

export type LinkWorkerDeps = {
  link: LinkService;
  db: Db;
  ledger: Ledger;
  runner: AgentRunner;
  worktrees: WorktreeManager;
  /** For the snapshot: the same checks as the changes views before git touches a run's worktree. */
  changes: ChangesDeps;
  dataDir: string;
  /** How often a blank line is written on a quiet event stream; well under the link's 120 s idle timeout. */
  heartbeatMs?: number;
  /**
   * Cleans text another machine sent before it is recorded (the project name): the connections' publicText in the
   * server (redaction with every known secret, paths, the username, email addresses). Default: built-in redaction.
   */
  cleanText?: (s: string) => string;
  /** Milliseconds since the epoch; test-only. */
  now?: () => number;
};

/** Uploads one machine may leave waiting (stored and in flight), and their bytes together with a new declared length. */
export const MAX_UPLOADS_PER_MACHINE = 4;
export const MAX_UPLOAD_BYTES_PER_MACHINE = 1024 ** 3;
/** An upload never started within this long is removed. */
export const UPLOAD_TTL_MS = 60 * 60 * 1000;
const RECORD_NAME = /^([A-Za-z0-9_-]{1,100})\.json$/;
const BUNDLE_NAME = /^([A-Za-z0-9_-]{1,100})\.bundle$/;
const recordSchema = z.object({
  machineId: z.string().regex(/^[0-9a-f]{32}$/),
  bytes: z.number().int().nonnegative(),
  ts: z.iso.datetime(),
}).strict();
type UploadRecord = z.infer<typeof recordSchema>;
type InFlight = { peer: string; runId: string; reserve: number };

/** The Owner: the human who asked, through the requester, owns the run here too. */
const OWNER = { kind: "human", id: "owner" } as const;
const SYSTEM = { kind: "system", id: "link" } as const;
const DEFAULT_HEARTBEAT_MS = 30_000;
const PAGE = 500;
const runIdSchema = z.string().regex(RUN_ID_PATTERN);
const actionIdSchema = z.string().min(1).max(200);
const projectNameSchema = z.string().min(1).max(120);
const afterSeqSchema = z.string().regex(/^\d{1,15}$/).transform(Number);

export class LinkWorker {
  private readonly heartbeatMs: number;
  private readonly now: () => number;
  private readonly cleanText: (s: string) => string;
  /** Uploads being received, by their `.part` file name; any other `.part` file is left from a crash. */
  private readonly inFlight = new Map<string, InFlight>();

  constructor(private readonly deps: LinkWorkerDeps) {
    this.heartbeatMs = deps.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.now = deps.now ?? Date.now;
    this.cleanText = deps.cleanText ?? ((t) => redact(t));
  }

  /** A run id as the runner accepts it, checked before it is used in any path. ZodError otherwise. */
  static runId(raw: unknown): string {
    return runIdSchema.parse(raw);
  }

  private incomingDir(): string {
    return join(this.deps.dataDir, "link", "incoming");
  }

  private incoming(runId: string): string {
    return join(this.incomingDir(), `${runIdSchema.parse(runId)}.bundle`);
  }

  private recordPath(runId: string): string {
    return join(this.incomingDir(), `${runIdSchema.parse(runId)}.json`);
  }

  /** The owner record of a waiting upload, or null when it is missing, unreadable or past UPLOAD_TTL_MS. */
  private readRecord(runId: string): UploadRecord | null {
    try {
      const record = recordSchema.parse(JSON.parse(readFileSync(this.recordPath(runId), "utf8")));
      return this.now() - Date.parse(record.ts) > UPLOAD_TTL_MS ? null : record;
    } catch {
      return null;
    }
  }

  /** Removes a waiting upload: its bundle and its record. */
  private dropUpload(runId: string): void {
    rmSync(this.incoming(runId), { force: true, maxRetries: 5, retryDelay: 50 });
    rmSync(this.recordPath(runId), { force: true, maxRetries: 5, retryDelay: 50 });
  }

  /**
   * Removes from `link/incoming` every upload never started within UPLOAD_TTL_MS, every bundle without a valid owner
   * record and every record without its bundle, and any other file (a `.part` left by a crash) that no upload in
   * progress is writing. Run when the listener starts and before each upload.
   */
  sweep(): void {
    let names: string[];
    try {
      names = readdirSync(this.incomingDir());
    } catch {
      return; // no folder yet: nothing to sweep
    }
    for (const name of names) {
      const bundle = BUNDLE_NAME.exec(name);
      const record = RECORD_NAME.exec(name);
      const id = bundle?.[1] ?? record?.[1];
      if (id !== undefined) {
        const keep = this.readRecord(id) !== null && existsSync(this.incoming(id));
        if (!keep) this.dropUpload(id);
        continue;
      }
      if (!this.inFlight.has(name)) rmSync(join(this.incomingDir(), name), { force: true, recursive: true, maxRetries: 5, retryDelay: 50 });
    }
  }

  /** What `peer` has waiting: its stored uploads (by their records) and the ones it is sending now. */
  private usageOf(peer: string): { count: number; bytes: number } {
    let count = 0;
    let bytes = 0;
    let names: string[] = [];
    try {
      names = readdirSync(this.incomingDir());
    } catch {
      // nothing stored
    }
    for (const name of names) {
      const id = RECORD_NAME.exec(name)?.[1];
      if (id === undefined) continue;
      const record = this.readRecord(id);
      if (record === null || record.machineId !== peer) continue;
      count++;
      bytes += record.bytes;
    }
    for (const f of this.inFlight.values()) {
      if (f.peer !== peer) continue;
      count++;
      bytes += f.reserve;
    }
    return { count, bytes };
  }

  /** ConflictError when this computer already has a run, or a link record of one, under `runId`. */
  private assertFree(runId: string): void {
    const { db } = this.deps;
    if (db.prepare("SELECT 1 FROM agent_runs WHERE id = ?").get(runId) || db.prepare("SELECT 1 FROM link_runs WHERE run_id = ?").get(runId)) {
      throw new ConflictError("a run with this id already exists");
    }
  }

  /** The project of a run this computer accepted from `peer`; NotFoundError for any other run id. */
  private acceptedRun(peer: string, runId: string): { projectId: string } {
    const row = this.deps.db
      .prepare("SELECT project_id FROM link_runs WHERE run_id = ? AND machine_id = ? AND direction = 'accepted'")
      .get(runIdSchema.parse(runId), peer) as { project_id: string } | undefined;
    if (!row) throw new NotFoundError("run", runId);
    return { projectId: row.project_id };
  }

  /**
   * Receives a run's repository bundle, streamed to `<dataDir>/link/incoming/<runId>.bundle` and counted as it
   * arrives, with an owner record `<runId>.json` (`{ machineId, bytes, ts }`) written atomically beside it. Before a
   * byte is read: expired and stray uploads are swept; a run id in use, or one whose repository is already waiting or
   * arriving, is ConflictError; a declared length over MAX_BUNDLE_BYTES is RepoTooLargeError; and a machine with
   * MAX_UPLOADS_PER_MACHINE uploads waiting, or whose waiting bytes plus this one's (declared, else MAX_BUNDLE_BYTES)
   * would pass MAX_UPLOAD_BYTES_PER_MACHINE, gets UploadLimitError. A body that passes the cap is cut off and its
   * partial file removed (RepoTooLargeError).
   */
  async receiveRepo(peer: string, runId: string, body: Readable, declaredLength: string | undefined): Promise<void> {
    const file = this.incoming(runId);
    this.sweep();
    this.assertFree(runId);
    if (existsSync(file) || [...this.inFlight.values()].some((f) => f.runId === runId)) {
      throw new ConflictError("the repository for this run is already waiting");
    }
    const declared = declaredLength === undefined ? null : Number(declaredLength);
    if (declared !== null && !(declared >= 0 && declared <= MAX_BUNDLE_BYTES)) throw new RepoTooLargeError();
    const reserve = declared ?? MAX_BUNDLE_BYTES;
    const usage = this.usageOf(peer);
    if (usage.count >= MAX_UPLOADS_PER_MACHINE || usage.bytes + reserve > MAX_UPLOAD_BYTES_PER_MACHINE) throw new UploadLimitError();
    mkdirSync(this.incomingDir(), { recursive: true });
    const partName = `${runId}.${peer}.${randomUUID()}.part`;
    const part = join(this.incomingDir(), partName);
    // Reserved before the first await, so two uploads can never both pass the checks above.
    this.inFlight.set(partName, { peer, runId, reserve });
    let size = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _enc, done) {
        size += chunk.length;
        if (size > MAX_BUNDLE_BYTES) done(new RepoTooLargeError());
        else done(null, chunk);
      },
    });
    try {
      await pipeline(body, counter, createWriteStream(part, { flags: "wx" }));
      // Uploaded while the start of the same id was running: refused, so a live run's bundle is never replaced.
      this.assertFree(runId);
      renameSync(part, file);
      const record: UploadRecord = { machineId: peer, bytes: size, ts: new Date(this.now()).toISOString() };
      const tmp = join(this.incomingDir(), `${runId}.${randomUUID()}.tmp`);
      try {
        writeFileSync(tmp, JSON.stringify(record), { flag: "wx" });
        renameSync(tmp, this.recordPath(runId));
      } catch (err) {
        rmSync(tmp, { force: true });
        this.dropUpload(runId);
        throw err;
      }
    } catch (err) {
      rmSync(part, { force: true, maxRetries: 5, retryDelay: 50 });
      throw err;
    } finally {
      this.inFlight.delete(partName);
    }
  }

  /**
   * Accepts a run from `peer`: the repository must have been uploaded by it (NoRepoError); it is imported into the
   * project's repository (BundleInvalidError → nothing recorded); one transaction then records `project.created` and
   * `link.project_received` for a project this computer does not have yet, and always `link.run_accepted`; then the
   * runner starts the run under `runId` for the Owner. A project id this computer already has must be one it received
   * from `peer` (ConflictError otherwise), so a paired machine can never overwrite a local project's repository. A
   * start that fails leaves `link.run_accepted` in place, and the error is answered as the runner threw it.
   */
  async acceptRun(peer: string, runId: string, body: unknown): Promise<AgentRun> {
    const id = runIdSchema.parse(runId);
    const input = remoteStartSchema.parse(body);
    const projectId = runIdSchema.parse(input.projectId);
    // Text from another machine: cleaned as anything this computer records, never trusted as sent.
    const projectName = projectNameSchema.parse(this.cleanText(input.projectName).trim() || "Project");
    this.assertFree(id);
    const file = this.incoming(id);
    const record = this.readRecord(id);
    if (record === null) {
      // No owner (or an expired one): whatever is there is nobody's upload.
      this.dropUpload(id);
      throw new NoRepoError();
    }
    if (record.machineId !== peer || !existsSync(file)) throw new NoRepoError();
    rmSync(this.recordPath(id), { force: true });
    try {
      this.assertProjectOf(peer, projectId);
    } catch (err) {
      rmSync(file, { force: true });
      throw err;
    }
    await importRepoBundle(this.deps.worktrees, projectId, file); // deletes the file in every case
    const { db, ledger } = this.deps;
    commitEvents(db, ledger, () => {
      this.assertFree(id);
      this.assertProjectOf(peer, projectId);
      const events: NewLedgerEntry[] = [];
      if (!db.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId)) {
        events.push(
          { projectId, actor: SYSTEM, type: "project.created", payload: { projectId, name: projectName, pitch: "" } },
          { projectId, actor: SYSTEM, type: "link.project_received", payload: { projectId, machineId: peer, name: projectName } },
        );
      }
      events.push({ projectId, actor: SYSTEM, type: "link.run_accepted", payload: { runId: id, machineId: peer, projectId } });
      return { events, result: () => undefined };
    });
    try {
      return await this.deps.runner.start(OWNER, {
        projectId,
        adapter: input.adapter,
        prompt: input.prompt,
        cardId: input.cardId,
        connectionIds: input.connectionIds,
        runId: id,
        // The card is the requester's: this computer has none of its cards.
        foreignCard: true,
      });
    } catch (err) {
      // The accepted run did not start: recorded with the code the requester is answered, then answered as it is.
      try {
        commitEvent(db, ledger, () => ({
          event: { projectId, actor: SYSTEM, type: "link.run_failed", payload: { runId: id, machineId: peer, error: errorCode(err) } },
          result: () => undefined,
        }));
      } catch {
        // A ledger that cannot record (read-only) must not hide the start's own error.
      }
      throw err;
    }
  }

  /** A project this computer has must be one it received from `peer` (a run of it accepted from `peer`). */
  private assertProjectOf(peer: string, projectId: string): void {
    const { db } = this.deps;
    if (!db.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId)) return;
    const received = db
      .prepare("SELECT 1 FROM link_runs WHERE project_id = ? AND machine_id = ? AND direction = 'accepted'")
      .get(projectId, peer);
    if (!received) throw new ConflictError("this computer already has a project with that id");
  }

  /**
   * A decision relayed from `peer` on an action of a run accepted from it: `link.decision_received` names the machine
   * it came through, then the runner records the Owner's decision as for one made here. NotFoundError for an action of
   * any other run; AlreadyDecidedError (and nothing recorded) for an action no longer pending.
   */
  decide(peer: string, runId: string, actionId: string, body: unknown): AgentAction {
    const id = runIdSchema.parse(runId);
    const action = actionIdSchema.parse(actionId);
    const { decision, reason } = remoteDecisionSchema.parse(body);
    const { projectId } = this.acceptedRun(peer, id);
    const { db, ledger, runner } = this.deps;
    commitEvent(db, ledger, () => {
      const row = db.prepare("SELECT run_id, status FROM agent_actions WHERE id = ?").get(action) as
        | { run_id: string; status: string }
        | undefined;
      if (!row || row.run_id !== id) throw new NotFoundError("action", action);
      if (row.status !== "pending") throw new AlreadyDecidedError(action);
      return {
        event: { projectId, actor: SYSTEM, type: "link.decision_received", payload: { runId: id, actionId: action, machineId: peer, decision } },
        result: () => undefined,
      };
    });
    return runner.decide(OWNER, action, decision, reason);
  }

  /** Stops a run accepted from `peer`, as the Owner would here. */
  stop(peer: string, runId: string): AgentRun {
    const id = runIdSchema.parse(runId);
    this.acceptedRun(peer, id);
    this.deps.runner.stop(OWNER, id);
    return this.deps.runner.getRun(id).run;
  }

  /**
   * Checks an event stream request before anything is written: a run accepted from `peer` that the runner started
   * (NotFoundError otherwise), a cursor that is a seq (ZodError), and an identity to sign with.
   */
  openStream(peer: string, runId: string, afterSeq: unknown): { runId: string; afterSeq: number } {
    const id = runIdSchema.parse(runId);
    const after = afterSeqSchema.parse(afterSeq ?? "0");
    this.acceptedRun(peer, id);
    if (!getRun(this.deps.db, id)) throw new NotFoundError("run", id);
    if (this.deps.link.signer() === null) throw new IdentityUnavailableError();
    return { runId: id, afterSeq: after };
  }

  /**
   * Writes the run's mirrorable entries with seq > afterSeq to `res` as NDJSON, one signed frame per line, in seq
   * order: the backlog first, then each new entry as it is appended (subscribed before the backlog is read, so none is
   * missed). A blank line every `heartbeatMs` keeps a quiet stream inside the link's idle timeout. The response ends
   * after the frame of `agent.finished`, when the run is already over and nothing is left to send, or (cleanly, so the
   * requester can resume from its cursor) when an entry cannot be signed as a frame the requester would accept.
   */
  pipeStream(runId: string, afterSeq: number, res: ServerResponse): void {
    const { ledger, db } = this.deps;
    const identity = this.deps.link.signer();
    let closed = false;
    let last = afterSeq;
    const queue: LedgerEntry[] = [];
    let wake: (() => void) | null = null;
    const unsubscribe = ledger.onAppend((e) => {
      if (closed || !mirrorable(e, runId)) return;
      queue.push(e);
      wake?.();
    });
    const heartbeat = setInterval(() => {
      if (!closed && res.writableLength === 0) res.write("\n");
    }, this.heartbeatMs);
    heartbeat.unref();
    const stop = (): void => {
      closed = true;
      unsubscribe();
      clearInterval(heartbeat);
      wake?.();
    };
    const finish = (): void => {
      if (closed) return;
      stop();
      res.end();
    };
    res.on("close", stop);
    res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store" });

    const write = async (line: string): Promise<void> => {
      if (res.write(line)) return;
      await new Promise<void>((resolve) => {
        const done = (): void => {
          res.off("drain", done);
          res.off("close", done);
          resolve();
        };
        res.on("drain", done);
        res.on("close", done);
      });
    };
    /** Sends one entry; true when the stream is over. */
    const send = async (e: LedgerEntry): Promise<boolean> => {
      if (e.seq <= last) return false;
      last = e.seq;
      let line: string;
      try {
        line = `${JSON.stringify(signFrame(identity!, e))}\n`;
      } catch (err) {
        if (err instanceof MirrorFrameError) {
          finish();
          return true;
        }
        throw err;
      }
      await write(line);
      if (e.type === "agent.finished") {
        finish();
        return true;
      }
      return closed;
    };

    const run = async (): Promise<void> => {
      let cursor = afterSeq;
      for (;;) {
        const page = ledger.list({ afterSeq: cursor, limit: PAGE, runIds: [runId] });
        for (const e of page) if (mirrorable(e, runId) && (await send(e))) return;
        if (page.length > 0) cursor = page[page.length - 1]!.seq;
        if (page.length < PAGE || closed) break;
      }
      for (;;) {
        while (queue.length > 0) if (await send(queue.shift()!)) return;
        if (closed) return;
        // Over before this stream reached its end (the requester's cursor was past agent.finished): nothing will come.
        if (getRun(db, runId)?.status !== "running") {
          finish();
          return;
        }
        await new Promise<void>((resolve) => (wake = resolve));
        wake = null;
      }
    };
    void run().catch(() => finish());
  }

  /**
   * The snapshot of a finished run accepted from `peer`, written as a bundle under `<dataDir>/link/outgoing`; the
   * caller streams it and deletes it. RunActiveError while the run is live, WorktreeMissingError when its working copy
   * is gone. Each request writes its own file, so two requests never share one.
   */
  async exportChanges(peer: string, runId: string): Promise<{ file: string; size: number }> {
    const id = runIdSchema.parse(runId);
    this.acceptedRun(peer, id);
    const { abs } = await stoppedRunWorktree(this.deps.changes, id);
    const dir = join(this.deps.dataDir, "link", "outgoing");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${id}.${randomUUID()}.bundle`);
    try {
      await snapshotBundle(this.deps.worktrees, abs, id, file);
      return { file, size: statSync(file).size };
    } catch (err) {
      rmSync(file, { force: true });
      throw err;
    }
  }
}

/** The code the listener's error handler answers for `err` (`invalid_input`, `not_found`, ...), as recorded. */
function errorCode(err: unknown): string {
  let code = "internal";
  const reply = {
    code: () => reply,
    header: () => reply,
    send: (body: unknown) => {
      const e = (body as { error?: unknown } | undefined)?.error;
      if (typeof e === "string" && /^[a-z0-9_]{1,100}$/.test(e)) code = e;
      return reply;
    },
  };
  const quiet = { error: () => undefined };
  sendError(err, reply as never, quiet as never);
  return code;
}
