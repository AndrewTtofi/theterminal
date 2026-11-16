import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  currentStep, finalSummary, jobTitle, narrate, nowLine, progressPercent,
  type AgentRun, type HomeRun, type HomeRuns, type LedgerEntry,
} from "@theterminal/shared";
import type { Db } from "../db.js";
import { NotFoundError } from "../board/board-service.js";
import { getRun, listActions } from "../events/projections.js";
import { remoteDisplay } from "../link/mirrored.js";
import { narrationContext } from "../story/story.js";
import { needs } from "./auth.js";

export type HomeRouteDeps = {
  db: Db;
  /** This machine's redaction, for runs on a linked machine. */
  clean: (s: string) => string;
};

/** The most runs each list holds: Home shows cards, not a history. */
const MAX_LISTED = 100;

const homeQuery = z.object({ projectId: z.string().min(1).max(200).optional() });

/**
 * What Home shows of the agents' work: the running runs (newest first), each with its job title, its percentage from
 * its own step reports, what it is doing now and whether it waits on a decision (the current step as the reason), and
 * the runs that finished on the local day of `now` (newest first) with a one-line summary. Every project's runs
 * without `projectId`. A run on a linked machine is shown through this machine's cleaning (`remoteDisplay`).
 */
export function homeRuns(db: Db, o: { projectId?: string; now?: Date; clean: (s: string) => string }): HomeRuns {
  const now = o.now ?? new Date();
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const nextDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();
  const shown = remoteDisplay(db, o.clean);
  const ctx = narrationContext(db);
  const scope = o.projectId === undefined ? "" : "AND r.project_id = ?";
  const scoped = (params: unknown[]) => (o.projectId === undefined ? params : [...params, o.projectId]);
  const rows = (where: string, params: unknown[], order: string) =>
    db
      .prepare(
        `SELECT r.id AS id, p.name AS project_name FROM agent_runs r JOIN projects p ON p.id = r.project_id
         WHERE ${where} ${scope} ORDER BY ${order}, r.rowid DESC LIMIT ${MAX_LISTED}`,
      )
      .all(...scoped(params)) as { id: string; project_name: string }[];

  const card = (id: string, projectName: string, finished: boolean): HomeRun | null => {
    const stored = getRun(db, id);
    if (stored === null) return null;
    const run = shown.run(stored);
    const actions = listActions(db, id).map(shown.action);
    const latest = actions.length === 0 ? null : actions[actions.length - 1]!;
    const waiting = !finished && actions.some((a) => a.status === "pending");
    return {
      run,
      projectName,
      title: jobTitle(run),
      percent: progressPercent(run.progress),
      now: finished ? null : nowLine(latest),
      summary: finished ? finalSummary(run.lastMessage, finishedHeadline(run, ctx)) : null,
      waiting,
      reason: waiting ? currentStep(run.progress) : null,
    };
  };

  const working = rows("r.status = 'running'", [], "r.started_at DESC")
    .map((r) => card(r.id, r.project_name, false))
    .filter((h): h is HomeRun => h !== null);
  const finishedToday = rows("r.status <> 'running' AND r.finished_at >= ? AND r.finished_at < ?", [dayStart, nextDay], "r.finished_at DESC")
    .map((r) => card(r.id, r.project_name, true))
    .filter((h): h is HomeRun => h !== null);
  return { working, finishedToday };
}

/**
 * The narrated headline of the run's `agent.finished` entry ("Claude finished", "Codex failed: …"), told from the
 * run as the projection holds it, which that entry set (status, cost and error; a linked machine's error already
 * cleaned by `remoteDisplay`).
 */
function finishedHeadline(run: AgentRun, ctx: ReturnType<typeof narrationContext>): string {
  const status = run.status === "running" ? "completed" : run.status;
  const entry: LedgerEntry = {
    seq: 0, id: "", ts: run.finishedAt ?? run.startedAt, projectId: run.projectId, actor: { kind: "agent", id: run.id },
    type: "agent.finished", payload: { runId: run.id, status, costUsd: run.costUsd, error: run.error }, prevHash: "", hash: "",
  };
  return narrate(entry, ctx).headline;
}

/** Home's runs. Errors are mapped by the handler in routes.ts. */
export function registerHomeRoutes(app: FastifyInstance, deps: HomeRouteDeps): void {
  const { db } = deps;
  app.get("/api/home", needs("viewer"), async (req) => {
    const { projectId } = homeQuery.parse(req.query);
    if (projectId !== undefined && !db.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId)) {
      throw new NotFoundError("project", "(given)");
    }
    return homeRuns(db, { ...(projectId !== undefined && { projectId }), clean: deps.clean });
  });
}
