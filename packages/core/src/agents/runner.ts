import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { z } from "zod";
import { ACTION_KINDS, type Actor, type AdapterId, type AgentAction, type AgentRun, type AuthMode } from "@theterminal/shared";
import type { Db } from "../db.js";
import { NotFoundError } from "../board/board-service.js";
import { commitEvent } from "../events/commit.js";
import { getRun, getSetting, listActions, listRuns } from "../events/projections.js";
import { LedgerReadOnlyError, type Ledger } from "../ledger/ledger.js";
import type { AdapterEvent, AgentAdapter, GateResult, ProposedAction } from "./adapter.js";
import { AlreadyDecidedError, type ApprovalBroker } from "./approvals.js";
import { classify } from "./policy.js";
import { redact, truncate } from "./redact.js";
import { pathScrubber, type Scrub } from "./scrub-paths.js";
import type { WorktreeManager } from "./worktrees.js";

export class AdapterUnavailableError extends Error {
  constructor(adapter: string) {
    super(`agent adapter unavailable: ${adapter}`);
    this.name = "AdapterUnavailableError";
  }
}

export type AgentRunnerDeps = {
  db: Db;
  ledger: Ledger;
  worktrees: WorktreeManager;
  broker: ApprovalBroker;
  adapters: Partial<Record<AdapterId, AgentAdapter>>;
  extraSecrets: string[];
  /** Recorded strings show this directory as `<data>`. */
  dataDir: string;
  newId?: () => string;
  /** How long shutdown() waits for adapters to return after aborting them. Default 5000. */
  shutdownTimeoutMs?: number;
};

type FinishStatus = "completed" | "failed" | "stopped";
type Session = {
  projectId: string;
  /** Replaces this run's absolute paths in recorded strings. */
  scrub: Scrub;
  abort: AbortController;
  done: Promise<void>;
  costUsd: number | null;
  /** Set when the runner itself failed during the run (e.g. a commit failed); fails the run. */
  failure: string | null;
};
type Payload = Record<string, unknown>;
type ActionRow = { run_id: string; project_id: string; status: AgentAction["status"]; reason: string };
type GateOutcome = GateResult & { actionId: string };

const POLICY: Actor = { kind: "system", id: "policy" };
const RUNNER: Actor = { kind: "system", id: "runner" };
// Bounds from the agent payload schemas in @theterminal/shared; input has no schema bound, so we cap it.
const MAX = { tool: 200, summary: 200, reason: 500, text: 4000, output: 4000, prompt: 20000, error: 1000, input: 20000 };
const promptSchema = z.string().min(1).max(MAX.prompt);
const INTERNAL_ERROR = "internal error";
const NOT_ALLOWED_RESULT = "adapter reported a result for an action that was not allowed";

function errorMessage(e: unknown): string {
  try {
    return e instanceof Error ? e.message : String(e);
  } catch {
    return "unknown error";
  }
}

/**
 * Reads each field of a proposal exactly once, so a getter cannot show policy one thing and the
 * ledger another. Unknown kinds become "other"; a non-array `paths` is checked as a single path.
 */
function snapshot(a: ProposedAction): ProposedAction {
  const { kind, tool, summary, input, paths } = a;
  const list: unknown[] = Array.isArray(paths) ? [...paths] : paths === null || paths === undefined ? [] : [paths];
  return {
    kind: (ACTION_KINDS as readonly unknown[]).includes(kind) ? kind : "other",
    tool: asText(tool),
    summary: asText(summary),
    input,
    paths: list as string[],
  };
}

/** Adapter-reported text as a string; anything unprintable becomes "". */
function asText(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === null || v === undefined) return "";
  try {
    return String(v);
  } catch {
    return "";
  }
}

function scrubJson(v: unknown, scrub: Scrub): unknown {
  if (typeof v === "string") return scrub(v);
  if (Array.isArray(v)) return v.map((x) => scrubJson(x, scrub));
  if (v !== null && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [scrub(k), scrubJson(x, scrub)]));
  }
  return v;
}

/**
 * Runs agent adapters in the background behind the policy gate. Every proposed action is redacted and
 * committed to the ledger before it may run; anything that fails along the way is denied, and the denial
 * is recorded.
 */
export class AgentRunner {
  private readonly sessions = new Map<string, Session>();
  private readonly newId: () => string;
  /** Scrubs dataDir and the home directory, for strings recorded outside a live run. */
  private readonly scrub: Scrub;

  constructor(private readonly deps: AgentRunnerDeps) {
    this.newId = deps.newId ?? (() => randomUUID());
    this.scrub = pathScrubber([[deps.dataDir, "<data>"], [homedir(), "~"]]);
  }

  private runScrubber(worktreeAbs: string): Scrub {
    return pathScrubber([[worktreeAbs, "."], [this.deps.dataDir, "<data>"], [homedir(), "~"]]);
  }

  async start(
    actor: Actor,
    input: { projectId: string; adapter: AdapterId; prompt: string; cardId?: string | null },
  ): Promise<AgentRun> {
    const { db, ledger, worktrees } = this.deps;
    if (!db.prepare("SELECT 1 FROM projects WHERE id = ?").get(input.projectId)) {
      throw new NotFoundError("project", input.projectId);
    }
    if (ledger.readOnly) throw new LedgerReadOnlyError();
    const adapter = this.deps.adapters[input.adapter];
    if (!adapter) throw new AdapterUnavailableError(input.adapter);
    const prompt = promptSchema.parse(input.prompt);
    const authMode: AuthMode =
      input.adapter === "claude" ? (getSetting(db, "claude_auth_mode") === "subscription" ? "subscription" : "api_key") : "none";

    const runId = this.newId();
    const wt = await worktrees.createRunWorktree(input.projectId, runId);
    const scrub = this.runScrubber(wt.absPath);
    const run = commitEvent(db, ledger, () => ({
      event: {
        projectId: input.projectId,
        actor,
        type: "agent.started",
        payload: {
          runId, adapter: input.adapter, authMode, prompt: this.clean(prompt, MAX.prompt, scrub),
          cardId: input.cardId ?? null, worktree: wt.relPath,
        },
      },
      result: () => getRun(db, runId)!,
    }));
    this.launch(run, adapter, wt.absPath, scrub, prompt, authMode);
    return run;
  }

  /** A human decision on a pending action. The check and the commit share one transaction. */
  decide(actor: Actor, actionId: string, decision: "allow" | "deny", reason = ""): AgentAction {
    const { db, ledger, broker } = this.deps;
    let why = "";
    const runId = commitEvent(db, ledger, () => {
      const row = this.actionRow(actionId);
      if (!row) throw new NotFoundError("action", actionId);
      if (row.status !== "pending" || !broker.pendingIds().includes(actionId)) throw new AlreadyDecidedError(actionId);
      why = this.clean(reason, MAX.reason, this.sessions.get(row.run_id)?.scrub ?? this.scrub);
      return {
        event: {
          projectId: row.project_id, actor, type: "agent.action.decided",
          payload: { runId: row.run_id, actionId, decision, by: "human", reason: why },
        },
        result: () => row.run_id,
      };
    });
    broker.decide(actionId, decision, why);
    return listActions(db, runId).find((a) => a.id === actionId)!;
  }

  stop(_actor: Actor, runId: string): void {
    if (!getRun(this.deps.db, runId)) throw new NotFoundError("run", runId);
    this.close(runId, "stopped", null, "run stopped");
  }

  listRuns(projectId: string): AgentRun[] {
    return listRuns(this.deps.db, projectId);
  }

  getRun(runId: string): { run: AgentRun; actions: AgentAction[] } {
    const run = getRun(this.deps.db, runId);
    if (!run) throw new NotFoundError("run", runId);
    return { run, actions: listActions(this.deps.db, runId) };
  }

  /** After a restart nothing is waiting any more: deny every pending action and fail every running run. */
  recoverOnStartup(): void {
    const { db, ledger } = this.deps;
    if (ledger.readOnly) return;
    const pending = db
      .prepare(
        `SELECT a.id, a.run_id, r.project_id FROM agent_actions a JOIN agent_runs r ON r.id = a.run_id
         WHERE a.status = 'pending' ORDER BY a.requested_at, a.rowid`,
      )
      .all() as { id: string; run_id: string; project_id: string }[];
    for (const a of pending) {
      if (!this.sessions.has(a.run_id)) this.settle(a.project_id, a.run_id, a.id, "deny", "workspace restarted");
    }
    const running = db.prepare("SELECT id FROM agent_runs WHERE status = 'running' ORDER BY started_at, rowid").all() as {
      id: string;
    }[];
    for (const r of running) {
      if (!this.sessions.has(r.id)) this.close(r.id, "failed", "workspace restarted", "workspace restarted");
    }
  }

  /** Stops every running run and waits for the adapters to return. */
  async shutdown(): Promise<void> {
    const all = [...this.sessions.entries()];
    for (const [runId] of all) {
      try {
        this.close(runId, "stopped", null, "run stopped");
      } catch {
        // Keep stopping the others; the adapters are aborted either way.
      }
    }
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.deps.shutdownTimeoutMs ?? 5000);
    });
    // An adapter that ignores the abort must not hang shutdown; its run is already recorded as stopped.
    await Promise.race([Promise.all(all.map(([, s]) => s.done)), timeout]);
    clearTimeout(timer);
  }

  private launch(run: AgentRun, adapter: AgentAdapter, cwd: string, scrub: Scrub, prompt: string, authMode: AuthMode): void {
    const abort = new AbortController();
    const session: Session = { projectId: run.projectId, scrub, abort, done: Promise.resolve(), costUsd: null, failure: null };
    this.sessions.set(run.id, session);
    session.done = (async () => {
      let status: FinishStatus;
      let error: string | null = null;
      try {
        const r = await adapter.start({
          cwd, prompt, authMode, signal: abort.signal,
          gate: (a) => this.gate(run.id, session, cwd, a),
          emit: (e) => this.onEmit(run.id, session, e),
        });
        status = r.status;
        error = r.status === "failed" ? (r.error ?? "agent failed") : null;
      } catch (e) {
        status = "failed";
        error = errorMessage(e);
      }
      if (session.failure) {
        status = "failed";
        error = session.failure;
      }
      try {
        this.close(run.id, status, error, "run finished");
      } catch (e) {
        console.error(`agent run ${run.id} could not be finished: ${e instanceof Error ? e.name : "error"}`);
      } finally {
        this.sessions.delete(run.id);
      }
    })();
  }

  private async gate(runId: string, s: Session, worktreeAbs: string, proposed: ProposedAction): Promise<GateOutcome> {
    const actionId = this.newId();
    let recorded = false;
    try {
      const a = snapshot(proposed); // recording and classify see only this copy
      this.recordRequest(s, runId, {
        runId, actionId, kind: a.kind,
        tool: this.clean(a.tool, MAX.tool, s.scrub) || "unknown",
        summary: this.clean(a.summary, MAX.summary, s.scrub) || "(no summary)",
        input: this.cleanInput(a.input, s.scrub),
      });
      recorded = true;
      if (s.abort.signal.aborted) return this.settle(s.projectId, runId, actionId, "deny", "run stopped");
      const v = classify(a, worktreeAbs, this.deps.worktrees);
      if (v.verdict !== "ask") {
        return this.settle(s.projectId, runId, actionId, v.verdict === "auto_allow" ? "allow" : "deny", v.reason);
      }
      const r = await this.deps.broker.wait(actionId, s.abort.signal);
      // decide() has already committed a human decision; any other outcome (a stop) is recorded here.
      return this.settle(s.projectId, runId, actionId, r.decision, r.reason);
    } catch {
      try {
        if (!recorded) {
          // The proposal itself could not be recorded: record that an unrecordable action was denied.
          this.recordRequest(s, runId, {
            runId, actionId, kind: "other", tool: "unknown", summary: "(unrecordable action)", input: null,
          });
        }
        this.settle(s.projectId, runId, actionId, "deny", INTERNAL_ERROR);
      } catch {
        // Nothing more we can record; deny regardless.
      }
      return { actionId, decision: "deny", reason: INTERNAL_ERROR };
    }
  }

  private recordRequest(s: Session, runId: string, payload: Payload): void {
    commitEvent(this.deps.db, this.deps.ledger, () => ({
      event: { projectId: s.projectId, actor: { kind: "agent", id: runId }, type: "agent.action.requested", payload },
      result: () => undefined,
    }));
  }

  /**
   * Commits a policy decision unless the action is already decided, and returns what the ledger holds.
   * Only an action the ledger records as allowed is allowed.
   */
  private settle(projectId: string, runId: string, actionId: string, decision: "allow" | "deny", reason: string): GateOutcome {
    return commitEvent(this.deps.db, this.deps.ledger, () => {
      const row = this.actionRow(actionId);
      // Never record a decision for an action that was not recorded as requested.
      if (!row) return { result: (): GateOutcome => ({ actionId, decision: "deny", reason }) };
      if (row.status !== "pending") {
        const decided: GateOutcome = { actionId, decision: row.status === "allowed" ? "allow" : "deny", reason: row.reason };
        return { result: () => decided };
      }
      return {
        event: {
          projectId, actor: POLICY, type: "agent.action.decided",
          payload: { runId, actionId, decision, by: "policy", reason },
        },
        result: () => ({ actionId, decision, reason }),
      };
    });
  }

  private onEmit(runId: string, s: Session, e: AdapterEvent): void {
    if (s.abort.signal.aborted) return; // the run is over; late events are dropped
    const { db, ledger } = this.deps;
    const agent: Actor = { kind: "agent", id: runId };
    const fail = (why: string) => {
      s.failure ??= why;
      s.abort.abort();
    };
    try {
      if (e.type === "message") {
        const text = this.clean(asText(e.text), MAX.text, s.scrub);
        commitEvent(db, ledger, () => ({
          event: { projectId: s.projectId, actor: agent, type: "agent.message", payload: { runId, text } },
          result: () => undefined,
        }));
      } else if (e.type === "action_result") {
        const output = this.clean(asText(e.output), MAX.output, s.scrub);
        const committed = commitEvent(db, ledger, () => {
          const row = this.actionRow(e.actionId);
          if (!row || row.run_id !== runId || row.status !== "allowed") return { result: () => false };
          return {
            event: {
              projectId: s.projectId, actor: agent, type: "agent.action.completed",
              payload: { runId, actionId: e.actionId, ok: e.ok === true, output },
            },
            result: () => true,
          };
        });
        if (!committed) fail(NOT_ALLOWED_RESULT);
      } else if (e.type === "usage") {
        if (typeof e.costUsd === "number" && Number.isFinite(e.costUsd) && e.costUsd >= 0) {
          s.costUsd = (s.costUsd ?? 0) + e.costUsd;
        }
      }
    } catch {
      fail(INTERNAL_ERROR);
    }
  }

  /** Aborts the run, denies its pending actions, then commits agent.finished once (guarded by run status). */
  private close(runId: string, status: FinishStatus, error: string | null, pendingReason: string): void {
    const { db, ledger } = this.deps;
    const s = this.sessions.get(runId);
    s?.abort.abort();
    this.sessions.delete(runId); // even if its adapter never returns
    const run = getRun(db, runId);
    if (!run || run.status !== "running") return;
    for (const a of listActions(db, runId)) {
      if (a.status === "pending") this.settle(run.projectId, runId, a.id, "deny", pendingReason);
    }
    commitEvent(db, ledger, () => {
      const cur = getRun(db, runId);
      if (!cur || cur.status !== "running") return { result: () => undefined };
      return {
        event: {
          projectId: cur.projectId, actor: RUNNER, type: "agent.finished",
          payload: { runId, status, costUsd: s?.costUsd ?? null, error: error === null ? null : this.clean(error, MAX.error, s?.scrub ?? this.scrub) },
        },
        result: () => undefined,
      };
    });
  }

  private actionRow(actionId: string): ActionRow | undefined {
    return this.deps.db
      .prepare(
        `SELECT a.run_id, a.status, a.reason, r.project_id FROM agent_actions a JOIN agent_runs r ON r.id = a.run_id
         WHERE a.id = ?`,
      )
      .get(actionId) as ActionRow | undefined;
  }

  /** Scrub paths, redact, then truncate: never truncate first. */
  private clean(s: string, max: number, scrub: Scrub): string {
    return truncate(redact(scrub(s), this.deps.extraSecrets), max);
  }

  /**
   * Normalises to plain JSON first (class instances and toJSON values become plain data that redact
   * can see into); a value that cannot be serialised throws and is denied by the gate.
   */
  private cleanInput(input: unknown, scrub: Scrub): unknown {
    const json = JSON.stringify(input ?? null);
    const plain: unknown = json === undefined ? null : JSON.parse(json);
    const value = redact(scrubJson(plain, scrub), this.deps.extraSecrets);
    const out = JSON.stringify(value);
    return out.length > MAX.input ? truncate(out, MAX.input) : value;
  }
}
