import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Actor, AdapterId, AgentAction, AgentRun, AuthMode } from "@theterminal/shared";
import type { Db } from "../db.js";
import { NotFoundError } from "../board/board-service.js";
import { commitEvent } from "../events/commit.js";
import { getRun, getSetting, listActions, listRuns } from "../events/projections.js";
import { LedgerReadOnlyError, type Ledger } from "../ledger/ledger.js";
import type { AdapterEvent, AgentAdapter, GateResult, ProposedAction } from "./adapter.js";
import { AlreadyDecidedError, type ApprovalBroker } from "./approvals.js";
import { classify } from "./policy.js";
import { redact, truncate } from "./redact.js";
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
  newId?: () => string;
};

type FinishStatus = "completed" | "failed" | "stopped";
type Session = {
  projectId: string;
  abort: AbortController;
  done: Promise<void>;
  costUsd: number | null;
  /** Set when the runner itself failed during the run (e.g. a commit failed); fails the run. */
  failure: string | null;
};
type ActionRow = { run_id: string; project_id: string; status: AgentAction["status"]; reason: string };
type GateOutcome = GateResult & { actionId: string };

const POLICY: Actor = { kind: "system", id: "policy" };
const RUNNER: Actor = { kind: "system", id: "runner" };
// Bounds from the agent payload schemas in @theterminal/shared; input has no schema bound, so we cap it.
const MAX = { tool: 200, summary: 200, reason: 500, text: 4000, output: 4000, prompt: 20000, error: 1000, input: 20000 };
const promptSchema = z.string().min(1).max(MAX.prompt);

function errorMessage(e: unknown): string {
  try {
    return e instanceof Error ? e.message : String(e);
  } catch {
    return "unknown error";
  }
}

/**
 * Runs agent adapters in the background behind the policy gate. Every proposed action is redacted and
 * committed to the ledger before it may run; anything that fails along the way is denied, and the denial
 * is recorded.
 */
export class AgentRunner {
  private readonly sessions = new Map<string, Session>();
  private readonly newId: () => string;

  constructor(private readonly deps: AgentRunnerDeps) {
    this.newId = deps.newId ?? (() => randomUUID());
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
    const run = commitEvent(db, ledger, () => ({
      event: {
        projectId: input.projectId,
        actor,
        type: "agent.started",
        payload: {
          runId, adapter: input.adapter, authMode, prompt: this.clean(prompt, MAX.prompt),
          cardId: input.cardId ?? null, worktree: wt.relPath,
        },
      },
      result: () => getRun(db, runId)!,
    }));
    this.launch(run, adapter, wt.absPath, prompt, authMode);
    return run;
  }

  /** A human decision on a pending action. The check and the commit share one transaction. */
  decide(actor: Actor, actionId: string, decision: "allow" | "deny", reason = ""): AgentAction {
    const { db, ledger, broker } = this.deps;
    const why = this.clean(reason, MAX.reason);
    const runId = commitEvent(db, ledger, () => {
      const row = this.actionRow(actionId);
      if (!row) throw new NotFoundError("action", actionId);
      if (row.status !== "pending" || !broker.pendingIds().includes(actionId)) throw new AlreadyDecidedError(actionId);
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
    await Promise.all(all.map(([, s]) => s.done));
  }

  private launch(run: AgentRun, adapter: AgentAdapter, cwd: string, prompt: string, authMode: AuthMode): void {
    const abort = new AbortController();
    const session: Session = { projectId: run.projectId, abort, done: Promise.resolve(), costUsd: null, failure: null };
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

  private async gate(runId: string, s: Session, worktreeAbs: string, a: ProposedAction): Promise<GateOutcome> {
    const actionId = this.newId();
    try {
      const payload = {
        runId, actionId, kind: a.kind,
        tool: this.clean(a.tool, MAX.tool) || "unknown",
        summary: this.clean(a.summary, MAX.summary) || "(no summary)",
        input: this.cleanInput(a.input),
      };
      commitEvent(this.deps.db, this.deps.ledger, () => ({
        event: { projectId: s.projectId, actor: { kind: "agent", id: runId }, type: "agent.action.requested", payload },
        result: () => undefined,
      }));
      if (s.abort.signal.aborted) return this.settle(s.projectId, runId, actionId, "deny", "run stopped");
      const v = classify(a, worktreeAbs, this.deps.worktrees);
      if (v.verdict !== "ask") {
        return this.settle(s.projectId, runId, actionId, v.verdict === "auto_allow" ? "allow" : "deny", v.reason);
      }
      const r = await this.deps.broker.wait(actionId, s.abort.signal);
      // decide() has already committed a human decision; any other outcome (a stop) is recorded here.
      return this.settle(s.projectId, runId, actionId, r.decision, r.reason);
    } catch (e) {
      const reason = this.clean(`internal error: ${errorMessage(e)}`, MAX.reason);
      try {
        this.settle(s.projectId, runId, actionId, "deny", reason);
      } catch {
        // Nothing more we can record; deny regardless.
      }
      return { actionId, decision: "deny", reason };
    }
  }

  /**
   * Commits a policy decision unless the action is already decided, and returns what the ledger holds.
   * Only an action the ledger records as allowed is allowed.
   */
  private settle(projectId: string, runId: string, actionId: string, decision: "allow" | "deny", reason: string): GateOutcome {
    return commitEvent(this.deps.db, this.deps.ledger, () => {
      const row = this.actionRow(actionId);
      if (row && row.status !== "pending") {
        const decided: GateOutcome = { actionId, decision: row.status === "allowed" ? "allow" : "deny", reason: row.reason };
        return { result: () => decided };
      }
      const final = row ? decision : "deny";
      return {
        event: {
          projectId, actor: POLICY, type: "agent.action.decided",
          payload: { runId, actionId, decision: final, by: "policy", reason },
        },
        result: () => ({ actionId, decision: final, reason }),
      };
    });
  }

  private onEmit(runId: string, s: Session, e: AdapterEvent): void {
    if (s.abort.signal.aborted) return; // the run is over; late events are dropped
    const { db, ledger, extraSecrets } = this.deps;
    const agent: Actor = { kind: "agent", id: runId };
    try {
      if (e.type === "message") {
        commitEvent(db, ledger, () => ({
          event: { projectId: s.projectId, actor: agent, type: "agent.message", payload: { runId, text: this.clean(e.text, MAX.text) } },
          result: () => undefined,
        }));
      } else if (e.type === "action_result") {
        commitEvent(db, ledger, () => {
          const row = this.actionRow(e.actionId);
          if (!row || row.run_id !== runId || row.status !== "allowed") {
            throw new Error("result reported for an action that was not allowed");
          }
          return {
            event: {
              projectId: s.projectId, actor: agent, type: "agent.action.completed",
              payload: { runId, actionId: e.actionId, ok: e.ok === true, output: this.clean(e.output, MAX.output) },
            },
            result: () => undefined,
          };
        });
      } else if (e.type === "usage") {
        if (typeof e.costUsd === "number" && Number.isFinite(e.costUsd) && e.costUsd >= 0) {
          s.costUsd = (s.costUsd ?? 0) + e.costUsd;
        }
      }
    } catch (err) {
      s.failure ??= truncate(redact(`internal error: ${errorMessage(err)}`, extraSecrets), MAX.error);
      s.abort.abort();
    }
  }

  /** Aborts the run, denies its pending actions, then commits agent.finished once (guarded by run status). */
  private close(runId: string, status: FinishStatus, error: string | null, pendingReason: string): void {
    const { db, ledger } = this.deps;
    const s = this.sessions.get(runId);
    s?.abort.abort();
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
          payload: { runId, status, costUsd: s?.costUsd ?? null, error: error === null ? null : this.clean(error, MAX.error) },
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

  /** Redact, then truncate: never the other way round. */
  private clean(s: string, max: number): string {
    return truncate(redact(s, this.deps.extraSecrets), max);
  }

  private cleanInput(input: unknown): unknown {
    const value = redact(input === undefined ? null : input, this.deps.extraSecrets);
    const json = JSON.stringify(value);
    if (json === undefined) return null;
    return json.length > MAX.input ? truncate(json, MAX.input) : value;
  }
}
