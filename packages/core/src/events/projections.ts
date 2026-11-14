import type { AgentAction, AgentRun, LedgerEntry, PendingAgentAction } from "@theterminal/shared";
import type { Db } from "../db.js";
import { canonicalJson } from "../ledger/canonical.js";
import type { Ledger } from "../ledger/ledger.js";

type Payload = Record<string, any>;

/** Projection reducer: applies one ledger entry to the read tables. Unknown types are ignored. */
export function applyEvent(db: Db, e: LedgerEntry): void {
  const p = e.payload as Payload;
  switch (e.type) {
    case "project.created":
      db.prepare("INSERT INTO projects (id, name, pitch, created_at) VALUES (?, ?, ?, ?)").run(
        p.projectId, p.name, p.pitch, e.ts,
      );
      break;
    case "card.created":
      db.prepare(
        `INSERT INTO cards (id, project_id, title, stage, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'todo', ?, ?)`,
      ).run(p.cardId, e.projectId, p.title, p.stage, e.ts, e.ts);
      break;
    case "card.moved":
      db.prepare("UPDATE cards SET stage = ?, updated_at = ? WHERE id = ?").run(p.to, e.ts, p.cardId);
      break;
    case "card.status_changed":
      db.prepare("UPDATE cards SET status = ?, updated_at = ? WHERE id = ?").run(p.to, e.ts, p.cardId);
      break;
    case "agent.started":
      db.prepare(
        `INSERT INTO agent_runs (id, project_id, card_id, adapter, auth_mode, prompt, status, worktree, started_at)
         VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?)`,
      ).run(p.runId, e.projectId, p.cardId, p.adapter, p.authMode, p.prompt, p.worktree, e.ts);
      break;
    case "agent.finished":
      db.prepare(
        "UPDATE agent_runs SET status = ?, cost_usd = ?, input_tokens = ?, output_tokens = ?, error = ?, finished_at = ? WHERE id = ?",
      ).run(p.status, p.costUsd, p.inputTokens ?? null, p.outputTokens ?? null, p.error, e.ts, p.runId);
      break;
    case "agent.action.requested":
      db.prepare(
        `INSERT INTO agent_actions (id, run_id, kind, tool, summary, input, status, decided_by, reason, output, requested_at, decided_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, '', NULL, ?, NULL)`,
      ).run(p.actionId, p.runId, p.kind, p.tool, p.summary, canonicalJson(p.input), e.ts);
      break;
    case "agent.action.decided":
      db.prepare("UPDATE agent_actions SET status = ?, decided_by = ?, reason = ?, decided_at = ? WHERE id = ?").run(
        p.decision === "allow" ? "allowed" : "denied", p.by, p.reason, e.ts, p.actionId,
      );
      break;
    case "agent.action.completed":
      db.prepare("UPDATE agent_actions SET status = ?, output = ? WHERE id = ?").run(
        p.ok ? "completed" : "failed", p.output, p.actionId,
      );
      break;
    case "settings.claude_auth_changed": // legacy entries stay readable
      setSetting(db, "auth_mode:claude", p.mode);
      break;
    case "settings.provider_auth_changed":
      setSetting(db, `auth_mode:${p.provider}`, p.mode);
      break;
    default:
      break;
  }
}

function setSetting(db: Db, key: string, value: string): void {
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

const PROJECTION_TABLES = ["cards", "projects", "agent_actions", "agent_runs", "settings"];

/** Rebuilds every projection table from the ledger; with `beforeSeq`, only from entries with seq < beforeSeq. */
export function rebuildAllProjections(db: Db, ledger: Ledger, opts: { beforeSeq?: number } = {}): void {
  const beforeSeq = opts.beforeSeq ?? Infinity;
  db.transaction(() => {
    for (const t of PROJECTION_TABLES) db.exec(`DELETE FROM ${t}`);
    let afterSeq = 0;
    for (;;) {
      const batch = ledger.list({ afterSeq, limit: 500 }).filter((e) => e.seq < beforeSeq);
      if (batch.length === 0) break;
      for (const e of batch) applyEvent(db, e);
      afterSeq = batch[batch.length - 1]!.seq;
    }
  }).immediate();
}

export function getSetting(db: Db, key: string): string | null {
  const r = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return r ? r.value : null;
}

type RunRow = {
  id: string; project_id: string; card_id: string | null; adapter: AgentRun["adapter"];
  auth_mode: AgentRun["authMode"]; prompt: string; status: AgentRun["status"]; worktree: string;
  cost_usd: number | null; input_tokens: number | null; output_tokens: number | null; error: string | null;
  started_at: string; finished_at: string | null;
};
type ActionRow = {
  id: string; run_id: string; kind: AgentAction["kind"]; tool: string; summary: string; input: string;
  status: AgentAction["status"]; decided_by: AgentAction["decidedBy"]; reason: string; output: string | null;
  requested_at: string; decided_at: string | null;
};

const toRun = (r: RunRow): AgentRun => ({
  id: r.id, projectId: r.project_id, cardId: r.card_id, adapter: r.adapter, authMode: r.auth_mode,
  prompt: r.prompt, status: r.status, worktree: r.worktree, costUsd: r.cost_usd,
  inputTokens: r.input_tokens, outputTokens: r.output_tokens, error: r.error,
  startedAt: r.started_at, finishedAt: r.finished_at,
});
const toAction = (r: ActionRow): AgentAction => ({
  id: r.id, runId: r.run_id, kind: r.kind, tool: r.tool, summary: r.summary, input: JSON.parse(r.input),
  status: r.status, decidedBy: r.decided_by, reason: r.reason, output: r.output,
  requestedAt: r.requested_at, decidedAt: r.decided_at,
});

export function listRuns(db: Db, projectId: string): AgentRun[] {
  const rows = db
    .prepare("SELECT * FROM agent_runs WHERE project_id = ? ORDER BY started_at DESC, rowid DESC")
    .all(projectId) as RunRow[];
  return rows.map(toRun);
}

export function getRun(db: Db, runId: string): AgentRun | null {
  const r = db.prepare("SELECT * FROM agent_runs WHERE id = ?").get(runId) as RunRow | undefined;
  return r ? toRun(r) : null;
}

export function listActions(db: Db, runId: string): AgentAction[] {
  const rows = db
    .prepare("SELECT * FROM agent_actions WHERE run_id = ? ORDER BY requested_at, rowid")
    .all(runId) as ActionRow[];
  return rows.map(toAction);
}

/** Pending actions across every project, oldest first, each with its project's id and name. */
export function listAllPendingActions(db: Db): PendingAgentAction[] {
  const rows = db
    .prepare(
      `SELECT a.*, r.project_id AS p_id, p.name AS p_name FROM agent_actions a
       JOIN agent_runs r ON r.id = a.run_id JOIN projects p ON p.id = r.project_id
       WHERE a.status = 'pending' ORDER BY a.requested_at, a.rowid`,
    )
    .all() as (ActionRow & { p_id: string; p_name: string })[];
  return rows.map((r) => ({ ...toAction(r), projectId: r.p_id, projectName: r.p_name }));
}

export function listPendingActions(db: Db, projectId: string): AgentAction[] {
  const rows = db
    .prepare(
      `SELECT a.* FROM agent_actions a JOIN agent_runs r ON r.id = a.run_id
       WHERE r.project_id = ? AND a.status = 'pending' ORDER BY a.requested_at, a.rowid`,
    )
    .all(projectId) as ActionRow[];
  return rows.map(toAction);
}
