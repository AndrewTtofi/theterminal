import type {
  AgentAction, AgentRun, DecisionId, GateDecision, IntakeAnswer, IntakeSession, LedgerEntry, PendingAgentAction, QuestionId,
} from "@theterminal/shared";
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
        `INSERT INTO agent_runs (id, project_id, card_id, adapter, auth_mode, prompt, status, worktree, base, started_at)
         VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, ?)`,
      ).run(p.runId, e.projectId, p.cardId, p.adapter, p.authMode, p.prompt, p.worktree, p.base ?? null, e.ts);
      break;
    case "agent.finished":
      db.prepare(
        "UPDATE agent_runs SET status = ?, cost_usd = ?, input_tokens = ?, output_tokens = ?, error = ?, finished_at = ? WHERE id = ?",
      ).run(p.status, p.costUsd, p.inputTokens ?? null, p.outputTokens ?? null, p.error, e.ts, p.runId);
      break;
    case "agent.rate_limited":
      // The adapter comes from the run; an entry for an unknown run projects nothing.
      db.prepare("INSERT INTO rate_limits (run_id, adapter, at, retry_after_s) SELECT id, adapter, ?, ? FROM agent_runs WHERE id = ?").run(
        e.ts, p.retryAfterS ?? null, p.runId,
      );
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
    case "connection.added":
      db.prepare(
        `INSERT INTO connections (id, kind, provider, name, enabled, config, secret_fields, private_fields,
           status_state, status_message, tested_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, ?, ?, 'untested', '', NULL, ?, ?)`,
      ).run(
        p.connectionId, p.kind, p.provider, p.name, canonicalJson(p.config),
        JSON.stringify(sortedFields(p.secretFields)), JSON.stringify(sortedFields(p.privateFields)), e.ts, e.ts,
      );
      break;
    case "connection.updated":
      updateConnection(db, p, e.ts);
      break;
    case "connection.removed":
      db.prepare("DELETE FROM connections WHERE id = ?").run(p.connectionId);
      break;
    case "connection.tested":
      db.prepare("UPDATE connections SET status_state = ?, status_message = ?, tested_at = ? WHERE id = ?").run(
        p.ok ? "ok" : "failed", p.message, e.ts, p.connectionId,
      );
      break;
    case "intake.started":
      db.prepare(
        `INSERT INTO intakes (id, project_id, idea, status, summary, created_at, updated_at, completed_at)
         VALUES (?, ?, ?, 'open', NULL, ?, ?, NULL)`,
      ).run(p.intakeId, e.projectId, p.idea, e.ts, e.ts);
      break;
    case "intake.answered":
      requireIntake(db, p.intakeId, e.projectId);
      db.prepare("INSERT OR REPLACE INTO intake_answers (intake_id, question_id, answer, answered_at) VALUES (?, ?, ?, ?)").run(
        p.intakeId, p.questionId, canonicalJson(p.answer), e.ts,
      );
      touchIntake(db, p.intakeId, e.ts);
      break;
    case "intake.decided":
      requireIntake(db, p.intakeId, e.projectId);
      db.prepare(
        `INSERT OR REPLACE INTO intake_decisions (intake_id, decision_id, chosen, rationale, owner, decided_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(p.intakeId, p.decisionId, p.chosen, p.rationale, p.owner, e.ts);
      touchIntake(db, p.intakeId, e.ts);
      break;
    case "intake.completed":
      requireIntake(db, p.intakeId, e.projectId);
      // The card.created entries committed with it are reduced by their own case.
      db.prepare("UPDATE intakes SET status = 'completed', summary = ?, completed_at = ?, updated_at = ? WHERE id = ?").run(
        p.summary, e.ts, e.ts, p.intakeId,
      );
      break;
    case "intake.reopened":
      requireIntake(db, p.intakeId, e.projectId);
      db.prepare("UPDATE intakes SET status = 'open', completed_at = NULL, updated_at = ? WHERE id = ?").run(e.ts, p.intakeId);
      break;
    case "gate.signed_off":
    case "gate.waived": {
      // The payload carries no projectId: the entry's projectId is the project (the gate service always sets it).
      if (e.projectId === null) throw new Error("gate event without a project");
      const waived = e.type === "gate.waived";
      db.prepare(
        `INSERT INTO gate_decisions (entry_id, gate_id, project_id, card_id, kind, from_stage, to_stage, reason, decided_by, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        e.id, p.gateId, e.projectId, p.cardId, waived ? "waived" : "signed_off", p.from, p.to,
        waived ? p.reason : null, waived ? p.waivedBy : p.signedBy, e.ts,
      );
      break;
    }
    default: // gate.blocked and conversation entries project nothing
      break;
  }
}

/** An intake event must name an intake of its own project; otherwise the append rolls back instead of writing orphan rows. */
function requireIntake(db: Db, intakeId: string, projectId: string | null): void {
  const row = db.prepare("SELECT 1 FROM intakes WHERE id = ? AND project_id IS ?").get(intakeId, projectId);
  if (!row) throw new Error("intake event for an unknown intake");
}

function touchIntake(db: Db, intakeId: string, ts: string): void {
  db.prepare("UPDATE intakes SET updated_at = ? WHERE id = ?").run(ts, intakeId);
}

/** `current` plus `added` minus `removed`, deduplicated and sorted. */
function sortedFields(current: string[], added: string[] = [], removed: string[] = []): string[] {
  const out = new Set([...current, ...added]);
  for (const f of removed) out.delete(f);
  return [...out].sort();
}

function updateConnection(db: Db, p: Payload, ts: string): void {
  const row = db.prepare("SELECT secret_fields, private_fields FROM connections WHERE id = ?").get(p.connectionId) as
    | { secret_fields: string; private_fields: string }
    | undefined;
  if (!row) return;
  const c = p.changes as Payload;
  const secretFields = sortedFields(JSON.parse(row.secret_fields), c.secretsSet, c.secretsRemoved);
  const privateFields = sortedFields(JSON.parse(row.private_fields), c.privateSet, c.privateRemoved);
  db.prepare(
    `UPDATE connections SET name = COALESCE(?, name), config = COALESCE(?, config), enabled = COALESCE(?, enabled),
       secret_fields = ?, private_fields = ?, updated_at = ? WHERE id = ?`,
  ).run(
    c.name ?? null, c.config === undefined ? null : canonicalJson(c.config),
    c.enabled === undefined ? null : c.enabled ? 1 : 0,
    JSON.stringify(secretFields), JSON.stringify(privateFields), ts, p.connectionId,
  );
}

function setSetting(db: Db, key: string, value: string): void {
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

const PROJECTION_TABLES = [
  "cards", "projects", "agent_actions", "agent_runs", "settings", "connections", "rate_limits",
  "intakes", "intake_answers", "intake_decisions", "gate_decisions",
];

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
  auth_mode: AgentRun["authMode"]; prompt: string; status: AgentRun["status"]; worktree: string; base: string | null;
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
  prompt: r.prompt, status: r.status, worktree: r.worktree, base: r.base, costUsd: r.cost_usd,
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

export type WorkspaceCounts = {
  runningAgents: number;
  pendingDecisions: number;
  /** Sum of cost over runs started on the local calendar day of `now`; a running run has no cost yet. */
  todayCostUsd: number;
  /** The same over runs started in the local calendar month of `now`. */
  monthCostUsd: number;
  /** Enabled connections, and those of them whose last test failed. */
  connections: { enabled: number; failed: number };
};

/** Counts for the status bar. */
export function workspaceCounts(db: Db, now: Date = new Date()): WorkspaceCounts {
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const nextDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  const cost = (from: Date, to: Date) =>
    (db
      .prepare("SELECT COALESCE(SUM(cost_usd), 0) AS total FROM agent_runs WHERE started_at >= ? AND started_at < ?")
      .get(from.toISOString(), to.toISOString()) as { total: number }).total;
  return {
    runningAgents: count("SELECT COUNT(*) AS n FROM agent_runs WHERE status = 'running'"),
    pendingDecisions: count("SELECT COUNT(*) AS n FROM agent_actions WHERE status = 'pending'"),
    todayCostUsd: cost(dayStart, nextDay),
    monthCostUsd: cost(monthStart, nextMonth),
    connections: {
      enabled: count("SELECT COUNT(*) AS n FROM connections WHERE enabled = 1"),
      failed: count("SELECT COUNT(*) AS n FROM connections WHERE enabled = 1 AND status_state = 'failed'"),
    },
  };
}

export type { GateDecision };
export type IntakeRow = IntakeSession;

type IntakeTableRow = {
  id: string; project_id: string; idea: string; status: IntakeSession["status"]; summary: string | null;
  created_at: string; updated_at: string; completed_at: string | null;
};
const toIntake = (r: IntakeTableRow): IntakeSession => ({
  id: r.id, projectId: r.project_id, idea: r.idea, status: r.status, summary: r.summary,
  createdAt: r.created_at, updatedAt: r.updated_at, completedAt: r.completed_at,
});

export type IntakeState = {
  intake: IntakeSession;
  answers: Partial<Record<QuestionId, { answer: IntakeAnswer; answeredAt: string }>>;
  decisions: Partial<Record<DecisionId, { chosen: string; rationale: string; owner: string; decidedAt: string }>>;
};

/** The project's intake with its answers and decisions, or null when it has none. */
export function getIntake(db: Db, projectId: string): IntakeState | null {
  const r = db.prepare("SELECT * FROM intakes WHERE project_id = ?").get(projectId) as IntakeTableRow | undefined;
  if (!r) return null;
  const answers: IntakeState["answers"] = {};
  const answerRows = db
    .prepare("SELECT question_id, answer, answered_at FROM intake_answers WHERE intake_id = ?")
    .all(r.id) as { question_id: QuestionId; answer: string; answered_at: string }[];
  for (const a of answerRows) answers[a.question_id] = { answer: JSON.parse(a.answer), answeredAt: a.answered_at };
  const decisions: IntakeState["decisions"] = {};
  const decisionRows = db
    .prepare("SELECT decision_id, chosen, rationale, owner, decided_at FROM intake_decisions WHERE intake_id = ?")
    .all(r.id) as { decision_id: DecisionId; chosen: string; rationale: string; owner: string; decided_at: string }[];
  for (const d of decisionRows) {
    decisions[d.decision_id] = { chosen: d.chosen, rationale: d.rationale, owner: d.owner, decidedAt: d.decided_at };
  }
  return { intake: toIntake(r), answers, decisions };
}

/** Open intakes across every project, oldest first, at most 500. */
export function listOpenIntakes(db: Db): IntakeSession[] {
  const rows = db.prepare("SELECT * FROM intakes WHERE status = 'open' ORDER BY created_at, rowid LIMIT 500").all() as IntakeTableRow[];
  return rows.map(toIntake);
}

type GateDecisionRow = {
  entry_id: string; gate_id: GateDecision["gateId"]; project_id: string; card_id: string; kind: GateDecision["kind"];
  from_stage: GateDecision["from"]; to_stage: GateDecision["to"]; reason: string | null; decided_by: string; at: string;
};

/** The card's gate sign-offs and waivers, in ledger order. */
export function listGateDecisions(db: Db, cardId: string): GateDecision[] {
  const rows = db
    .prepare("SELECT * FROM gate_decisions WHERE card_id = ? ORDER BY at, rowid")
    .all(cardId) as GateDecisionRow[];
  return rows.map((r) => ({
    entryId: r.entry_id, gateId: r.gate_id, projectId: r.project_id, cardId: r.card_id, kind: r.kind,
    from: r.from_stage, to: r.to_stage, reason: r.reason, decidedBy: r.decided_by, at: r.at,
  }));
}

/** Sum of reported cost over the project's runs; a run with no reported cost counts as 0, and no runs gives 0. */
export function projectSpendUsd(db: Db, projectId: string): number {
  return (db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS total FROM agent_runs WHERE project_id = ?").get(projectId) as {
    total: number;
  }).total;
}

/** Pending actions on the project's runs. */
export function countPendingActions(db: Db, projectId: string): number {
  return (db
    .prepare(
      `SELECT COUNT(*) AS n FROM agent_actions a JOIN agent_runs r ON r.id = a.run_id
       WHERE r.project_id = ? AND a.status = 'pending'`,
    )
    .get(projectId) as { n: number }).n;
}

/** Runs on the card that are still running. */
export function countRunningRuns(db: Db, cardId: string): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM agent_runs WHERE card_id = ? AND status = 'running'").get(cardId) as { n: number }).n;
}
