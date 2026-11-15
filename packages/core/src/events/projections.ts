import { DEFAULT_GATE_REQUIREMENT, DEFAULT_REMOTE, MIRRORABLE_TYPES, OWNER_ID } from "@theterminal/shared";
import type {
  AgentAction, AgentRun, Credential, DecisionId, GateDecision, GateId, GateRequirement, IntakeAnswer, IntakeSession, Invite,
  LedgerEntry, LinkRun, LinkRunState, Machine, PendingAgentAction, Person, QuestionId, RemoteState, Role, ShareLink, ShareLinkState,
  ShareSnapshotRecord, TlsMode,
} from "@theterminal/shared";
import type { Db } from "../db.js";
import { canonicalJson } from "../ledger/canonical.js";
import type { Ledger } from "../ledger/ledger.js";

type Payload = Record<string, any>;

/** The reason on a pending action of a remote run that ended here before anyone decided it. */
const RUN_ENDED_REASON = "The run ended before a decision was made.";

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
    case "machine.identity_created":
      setSetting(db, "link.machineId", p.machineId);
      setSetting(db, "link.publicKey", p.publicKey);
      setSetting(db, "link.fingerprint", p.fingerprint);
      break;
    case "machine.named":
      setSetting(db, "link.name", p.name);
      break;
    case "machine.linking_enabled":
      setSetting(db, "link.enabled", "1");
      setSetting(db, "link.port", String(p.port));
      break;
    case "machine.linking_disabled":
      setSetting(db, "link.enabled", "0");
      break;
    case "machine.paired":
      db.prepare(
        `INSERT OR REPLACE INTO machines (id, name, public_key, fingerprint, address, role, paired_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(p.machineId, p.name, p.publicKey, p.fingerprint, p.address, p.role, e.ts, e.ts);
      break;
    case "machine.unpaired":
      db.prepare("DELETE FROM machines WHERE id = ?").run(p.machineId);
      break;
    case "link.run_requested":
      // The payload carries no projectId: the entry's is the run's project (a NULL one fails the NOT NULL column).
      insertLinkRun(db, p.runId, p.machineId, "requested", e.projectId, "requested", e.ts);
      break;
    case "link.run_accepted":
      insertLinkRun(db, p.runId, p.machineId, "accepted", p.projectId, "running", e.ts);
      break;
    case "link.run_failed":
      db.prepare("UPDATE link_runs SET state = 'failed', error = ?, updated_at = ? WHERE run_id = ?").run(p.error, e.ts, p.runId);
      // The mirrored run of that machine ends with it while still running; this machine's own runs are never touched.
      db.prepare(
        "UPDATE agent_runs SET status = 'failed', error = ?, finished_at = ? WHERE id = ? AND status = 'running' AND machine_id = ?",
      ).run(p.error, e.ts, p.runId, p.machineId);
      // Nothing can settle its pending actions any more: closed as denied by nobody, so no view lists them as waiting.
      db.prepare(
        `UPDATE agent_actions SET status = 'denied', decided_by = NULL, reason = ?, decided_at = ? WHERE status = 'pending'
         AND run_id IN (SELECT id FROM agent_runs WHERE id = ? AND machine_id = ?)`,
      ).run(RUN_ENDED_REASON, e.ts, p.runId, p.machineId);
      break;
    case "link.changes_imported":
      db.prepare("UPDATE link_runs SET state = 'imported', updated_at = ? WHERE run_id = ?").run(e.ts, p.runId);
      break;
    case "link.changes_refused":
      // The link run ends here; the run itself stays as the worker reported it.
      db.prepare("UPDATE link_runs SET state = 'failed', error = ?, updated_at = ? WHERE run_id = ?").run(p.reason, e.ts, p.runId);
      break;
    case "link.mirrored":
      applyMirrored(db, e);
      break;
    case "share.confirmed":
      db.prepare(
        `INSERT INTO share_snapshots (id, project_id, content_hash, bytes, sections, options, head_seq, confirmed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(p.shareId, e.projectId, p.contentHash, p.bytes, canonicalJson(p.sections), canonicalJson(p.options), p.headSeq, e.ts);
      break;
    case "share.link_created":
      db.prepare(
        `INSERT INTO share_links (id, share_id, project_id, scope, port, state, created_at, expires_at, ended_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?, NULL)`,
      ).run(p.linkId, p.shareId, e.projectId, p.scope, p.port, e.ts, p.expiresAt);
      break;
    case "share.revoked":
    case "share.expired":
    case "share.stopped":
      db.prepare("UPDATE share_links SET state = ?, ended_at = ? WHERE id = ?").run(
        SHARE_END_STATES[e.type], e.ts, p.linkId,
      );
      break;
    case "person.invited":
      db.prepare(
        `INSERT INTO invites (id, code_hash, role, created_at, expires_at, status, used_by) VALUES (?, ?, ?, ?, ?, 'pending', NULL)`,
      ).run(p.inviteId, p.codeHash, p.role, e.ts, p.expiresAt);
      break;
    case "person.invite_revoked":
      db.prepare("UPDATE invites SET status = 'revoked' WHERE id = ? AND status = 'pending'").run(p.inviteId);
      break;
    case "person.joined":
      db.prepare(
        "INSERT INTO people (id, name, role, joined_at, last_seen_at, removed_at) VALUES (?, ?, ?, ?, NULL, NULL)",
      ).run(p.personId, p.name, p.role, e.ts);
      insertCredential(db, p.personId, p.credential, e.ts);
      db.prepare("UPDATE invites SET status = 'used', used_by = ? WHERE id = ?").run(p.personId, p.inviteId);
      break;
    case "person.credential_added":
      if (p.personId === OWNER_ID) insertOwnerRow(db);
      insertCredential(db, p.personId, p.credential, e.ts);
      break;
    case "person.credential_removed":
      db.prepare("UPDATE credentials SET removed_at = ? WHERE credential_id = ? AND person_id = ? AND removed_at IS NULL").run(
        e.ts, p.credentialId, p.personId,
      );
      break;
    case "person.renamed":
      if (p.personId === OWNER_ID) insertOwnerRow(db);
      db.prepare("UPDATE people SET name = ? WHERE id = ?").run(p.name, p.personId);
      break;
    case "person.role_changed":
      db.prepare("UPDATE people SET role = ? WHERE id = ?").run(p.to, p.personId);
      break;
    case "person.removed":
      db.prepare("UPDATE people SET removed_at = ? WHERE id = ? AND removed_at IS NULL").run(e.ts, p.personId);
      break;
    case "person.signed_in":
      db.prepare("UPDATE people SET last_seen_at = ? WHERE id = ?").run(e.ts, p.personId);
      break;
    case "remote.enabled":
      // The expiry stays only while the certificate does: a new fingerprint's expiry comes with certificate_changed.
      db.prepare(
        `INSERT INTO remote_state (id, enabled, port, bind, domain, tls, fingerprint, expires_at) VALUES (1, 1, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT(id) DO UPDATE SET enabled = 1, port = excluded.port, bind = excluded.bind, domain = excluded.domain,
           tls = excluded.tls,
           expires_at = CASE WHEN fingerprint IS excluded.fingerprint THEN expires_at ELSE NULL END,
           fingerprint = excluded.fingerprint`,
      ).run(p.port, p.bind, p.domain, p.tls, p.fingerprint);
      break;
    case "remote.disabled":
      db.prepare("UPDATE remote_state SET enabled = 0 WHERE id = 1").run();
      break;
    case "remote.certificate_changed":
      db.prepare(
        `INSERT INTO remote_state (id, enabled, port, bind, domain, tls, fingerprint, expires_at) VALUES (1, 0, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET tls = excluded.tls, fingerprint = excluded.fingerprint, domain = excluded.domain,
           expires_at = excluded.expires_at`,
      ).run(DEFAULT_REMOTE.port, DEFAULT_REMOTE.bind, p.domain, p.tls, p.fingerprint, p.expiresAt);
      break;
    case "gate.requirement_set":
      // The payload carries no projectId: the entry's is the project.
      if (e.projectId === null) throw new Error("gate requirement without a project");
      if (p.requirement === null) {
        db.prepare("DELETE FROM gate_requirements WHERE project_id = ? AND gate_id = ?").run(e.projectId, p.gateId);
      } else {
        db.prepare(
          `INSERT INTO gate_requirements (project_id, gate_id, requirement) VALUES (?, ?, ?)
           ON CONFLICT(project_id, gate_id) DO UPDATE SET requirement = excluded.requirement`,
        ).run(e.projectId, p.gateId, canonicalJson(p.requirement));
      }
      break;
    default: // gate.blocked, person.locked, conversation entries, link.project_received and link.decision_received project nothing
      break;
  }
}

const MIRRORED: ReadonlySet<string> = new Set(MIRRORABLE_TYPES);

/** A mirrored entry the projection refuses; the commit rolls back. */
export class MirroredEntryRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MirroredEntryRefusedError";
  }
}

/**
 * A linked machine's entry, committed here as `link.mirrored`: the worker's own entry (`payload.origin`, with its own
 * seq, ts and actor) is applied as if local, the run is marked as running on that machine, and the link run's cursor
 * moves to the worker's seq.
 *
 * The frame was checked before it was committed (`acceptMirroredLine`); this reducer still refuses, rolling the commit
 * back, anything that would let a worker touch state outside the run it was asked to run: a run never requested of
 * that machine, another project, an existing run id, an action of another run (actions are settled by id alone), and a
 * start naming a working copy other than the run's own or a card other than the one requested (the files views read
 * `agent_runs.worktree` under the data folder; the story selects by `card_id`).
 */
export function applyMirrored(db: Db, e: LedgerEntry): void {
  const p = e.payload as Payload;
  const inner = p.origin as LedgerEntry;
  if (!MIRRORED.has(inner.type)) throw new MirroredEntryRefusedError("mirrored entry of a type that is not mirrored");
  const ip = inner.payload as Payload;
  const runId = ip.runId as string;
  const link = db
    .prepare("SELECT project_id, state FROM link_runs WHERE run_id = ? AND machine_id = ? AND direction = 'requested'")
    .get(runId, p.machineId) as { project_id: string; state: LinkRunState } | undefined;
  if (!link) throw new MirroredEntryRefusedError("mirrored entry for a run not requested of that machine");
  const projectOk = inner.projectId === link.project_id || (inner.type === "connection.used" && inner.projectId === null);
  if (!projectOk || e.projectId !== inner.projectId) throw new MirroredEntryRefusedError("mirrored entry outside the run's project");
  if (inner.type === "agent.started") {
    if (ip.worktree !== `projects/${link.project_id}/worktrees/${runId}`) throw new MirroredEntryRefusedError("mirrored start naming another working copy");
    if ((ip.cardId ?? null) !== requestedCardId(db, runId)) throw new MirroredEntryRefusedError("mirrored start naming another card");
  }
  if (inner.type === "agent.action.requested" || inner.type === "agent.action.decided" || inner.type === "agent.action.completed") {
    const owner = db.prepare("SELECT run_id FROM agent_actions WHERE id = ?").get(ip.actionId) as { run_id: string } | undefined;
    const ok = inner.type === "agent.action.requested" ? owner === undefined : owner?.run_id === runId;
    if (!ok) throw new MirroredEntryRefusedError("mirrored entry about an action of another run");
  }
  if (inner.type !== "agent.started" && inner.type !== "connection.used") {
    const run = db.prepare("SELECT machine_id FROM agent_runs WHERE id = ?").get(runId) as { machine_id: string | null } | undefined;
    if (run && run.machine_id !== p.machineId) throw new MirroredEntryRefusedError("mirrored entry about a run of another machine");
  }

  applyEvent(db, inner); // an existing run id fails agent.started's INSERT and rolls the commit back
  if (inner.type === "agent.started") db.prepare("UPDATE agent_runs SET machine_id = ? WHERE id = ?").run(p.machineId, runId);
  // requested → running → finished; a run already imported or failed keeps its state.
  const state = inner.type === "agent.finished" && (link.state === "requested" || link.state === "running")
    ? "finished"
    : link.state === "requested" ? "running" : link.state;
  db.prepare("UPDATE link_runs SET last_seq = ?, state = ?, updated_at = ? WHERE run_id = ?").run(inner.seq, state, e.ts, runId);
}

/**
 * The card this computer asked a remote run for, as its own `link.run_requested` recorded it (null for none, and for
 * a run it never requested). Read from the ledger, so a rebuild sees the same answer.
 */
export function requestedCardId(db: Db, runId: string): string | null {
  const row = db
    .prepare(
      `SELECT json_extract(payload, '$.cardId') AS card_id FROM ledger WHERE type = 'link.run_requested'
       AND CASE WHEN json_valid(payload) THEN json_extract(payload, '$.runId') = ? ELSE 0 END LIMIT 1`,
    )
    .get(runId) as { card_id: string | null } | undefined;
  return typeof row?.card_id === "string" ? row.card_id : null;
}

/** The worker entry ids already mirrored for a run, read from the ledger. */
export function mirroredIds(db: Db, runId: string): Set<string> {
  const rows = db
    .prepare(
      `SELECT json_extract(payload, '$.origin.id') AS id FROM ledger
       WHERE type = 'link.mirrored' AND CASE WHEN json_valid(payload) THEN json_extract(payload, '$.origin.payload.runId') = ? ELSE 0 END`,
    )
    .all(runId) as { id: string }[];
  return new Set(rows.map((r) => r.id));
}
const SHARE_END_STATES = { "share.revoked": "revoked", "share.expired": "expired", "share.stopped": "stopped" } as const;

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

function insertLinkRun(
  db: Db, runId: string, machineId: string, direction: LinkRun["direction"], projectId: string | null, state: LinkRunState, ts: string,
): void {
  db.prepare(
    `INSERT INTO link_runs (run_id, machine_id, direction, project_id, state, last_seq, error, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, NULL, ?)`,
  ).run(runId, machineId, direction, projectId, state, ts);
}

/** A credential row; a key credential has no transports and stores "[]". */
function insertCredential(db: Db, personId: string, c: Credential, ts: string): void {
  db.prepare(
    `INSERT INTO credentials (credential_id, person_id, kind, public_key, transports, label, added_at, removed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(c.credentialId, personId, c.kind, c.publicKey, JSON.stringify(c.kind === "passkey" ? c.transports : []), c.label, ts);
}

/** The Owner's row, made the first time something about the Owner is recorded (the Owner is virtual before that). */
function insertOwnerRow(db: Db): void {
  db.prepare(
    "INSERT OR IGNORE INTO people (id, name, role, joined_at, last_seen_at, removed_at) VALUES (?, 'Owner', 'owner', NULL, NULL, NULL)",
  ).run(OWNER_ID);
}

function setSetting(db: Db, key: string, value: string): void {
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

const PROJECTION_TABLES = [
  "cards", "projects", "agent_actions", "agent_runs", "settings", "connections", "rate_limits",
  "intakes", "intake_answers", "intake_decisions", "gate_decisions", "share_snapshots", "share_links", "machines", "link_runs",
  // Not sessions or credential_state: neither is in the ledger.
  "people", "credentials", "invites", "remote_state", "gate_requirements",
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
  started_at: string; finished_at: string | null; machine_id: string | null;
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
  startedAt: r.started_at, finishedAt: r.finished_at, machineId: r.machine_id,
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

/**
 * Pending actions across every project, oldest first, each with its project's id and name. Only a running run's
 * actions wait for a decision: a run on a linked machine that ended here (link.run_failed) keeps its last record.
 */
export function listAllPendingActions(db: Db): PendingAgentAction[] {
  const rows = db
    .prepare(
      `SELECT a.*, r.project_id AS p_id, p.name AS p_name, m.name AS m_name FROM agent_actions a
       JOIN agent_runs r ON r.id = a.run_id JOIN projects p ON p.id = r.project_id
       LEFT JOIN machines m ON m.id = r.machine_id
       WHERE a.status = 'pending' AND r.status = 'running' ORDER BY a.requested_at, a.rowid`,
    )
    .all() as (ActionRow & { p_id: string; p_name: string; m_name: string | null })[];
  return rows.map((r) => ({
    ...toAction(r), projectId: r.p_id, projectName: r.p_name, ...(r.m_name !== null && { machineName: r.m_name }),
  }));
}

export function listPendingActions(db: Db, projectId: string): AgentAction[] {
  const rows = db
    .prepare(
      `SELECT a.* FROM agent_actions a JOIN agent_runs r ON r.id = a.run_id
       WHERE r.project_id = ? AND a.status = 'pending' AND r.status = 'running' ORDER BY a.requested_at, a.rowid`,
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
    pendingDecisions: count(
      "SELECT COUNT(*) AS n FROM agent_actions a JOIN agent_runs r ON r.id = a.run_id WHERE a.status = 'pending' AND r.status = 'running'",
    ),
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

const toGateDecision = (r: GateDecisionRow): GateDecision => ({
  entryId: r.entry_id, gateId: r.gate_id, projectId: r.project_id, cardId: r.card_id, kind: r.kind,
  from: r.from_stage, to: r.to_stage, reason: r.reason, decidedBy: r.decided_by, at: r.at,
});

/** The card's gate sign-offs and waivers, in ledger order. */
export function listGateDecisions(db: Db, cardId: string): GateDecision[] {
  const rows = db
    .prepare("SELECT * FROM gate_decisions WHERE card_id = ? ORDER BY at, rowid")
    .all(cardId) as GateDecisionRow[];
  return rows.map(toGateDecision);
}

/** The project's gate sign-offs and waivers across all its cards, in ledger order. */
export function listProjectGateDecisions(db: Db, projectId: string): GateDecision[] {
  const rows = db
    .prepare("SELECT * FROM gate_decisions WHERE project_id = ? ORDER BY at, rowid")
    .all(projectId) as GateDecisionRow[];
  return rows.map(toGateDecision);
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
       WHERE r.project_id = ? AND a.status = 'pending' AND r.status = 'running'`,
    )
    .get(projectId) as { n: number }).n;
}

/** Runs on the card that are still running. */
export function countRunningRuns(db: Db, cardId: string): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM agent_runs WHERE card_id = ? AND status = 'running'").get(cardId) as { n: number }).n;
}

type MachineRow = {
  id: string; name: string; public_key: string; fingerprint: string; address: string; role: Machine["role"];
  paired_at: string; updated_at: string;
};
const toMachine = (r: MachineRow): Machine => ({
  id: r.id, name: r.name, publicKey: r.public_key, fingerprint: r.fingerprint, address: r.address, role: r.role,
  pairedAt: r.paired_at, updatedAt: r.updated_at,
});

/** Paired machines, by name then id. */
export function listMachines(db: Db): Machine[] {
  return (db.prepare("SELECT * FROM machines ORDER BY name, id").all() as MachineRow[]).map(toMachine);
}

export function getMachine(db: Db, id: string): Machine | null {
  const r = db.prepare("SELECT * FROM machines WHERE id = ?").get(id) as MachineRow | undefined;
  return r ? toMachine(r) : null;
}

type LinkRunRow = {
  run_id: string; machine_id: string; direction: LinkRun["direction"]; project_id: string; state: LinkRunState;
  last_seq: number; error: string | null; updated_at: string;
};
const toLinkRun = (r: LinkRunRow): LinkRun => ({
  runId: r.run_id, machineId: r.machine_id, direction: r.direction, projectId: r.project_id, state: r.state,
  lastSeq: r.last_seq, error: r.error, updatedAt: r.updated_at,
});

export function getLinkRun(db: Db, runId: string): LinkRun | null {
  const r = db.prepare("SELECT * FROM link_runs WHERE run_id = ?").get(runId) as LinkRunRow | undefined;
  return r ? toLinkRun(r) : null;
}

/** Runs that cross a link, in the order they were first recorded; with `state`, only those in it. */
export function listLinkRuns(db: Db, state?: LinkRunState): LinkRun[] {
  const rows = (state === undefined
    ? db.prepare("SELECT * FROM link_runs ORDER BY rowid").all()
    : db.prepare("SELECT * FROM link_runs WHERE state = ? ORDER BY rowid").all(state)) as LinkRunRow[];
  return rows.map(toLinkRun);
}

type ShareSnapshotRow = {
  id: string; project_id: string; content_hash: string; bytes: number; sections: string; options: string; head_seq: number;
  confirmed_at: string;
};
const toShareSnapshot = (r: ShareSnapshotRow): ShareSnapshotRecord => ({
  id: r.id, projectId: r.project_id, contentHash: r.content_hash, bytes: r.bytes, sections: JSON.parse(r.sections),
  options: JSON.parse(r.options), headSeq: r.head_seq, confirmedAt: r.confirmed_at,
});

/** The project's confirmed share pages, newest first. */
export function listShareSnapshots(db: Db, projectId: string): ShareSnapshotRecord[] {
  const rows = db
    .prepare("SELECT * FROM share_snapshots WHERE project_id = ? ORDER BY confirmed_at DESC, rowid DESC")
    .all(projectId) as ShareSnapshotRow[];
  return rows.map(toShareSnapshot);
}

export function getShareSnapshot(db: Db, shareId: string): ShareSnapshotRecord | null {
  const r = db.prepare("SELECT * FROM share_snapshots WHERE id = ?").get(shareId) as ShareSnapshotRow | undefined;
  return r ? toShareSnapshot(r) : null;
}

type ShareLinkRow = {
  id: string; share_id: string; project_id: string; scope: ShareLink["scope"]; port: number; state: ShareLinkState;
  created_at: string; expires_at: string; ended_at: string | null;
};

/** Share links, newest first, optionally of one state and one project. */
export function listShareLinks(db: Db, q: { state?: ShareLinkState; projectId?: string } = {}): ShareLink[] {
  const where: string[] = [];
  const params: string[] = [];
  if (q.state !== undefined) {
    where.push("state = ?");
    params.push(q.state);
  }
  if (q.projectId !== undefined) {
    where.push("project_id = ?");
    params.push(q.projectId);
  }
  const rows = db
    .prepare(`SELECT * FROM share_links${where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, rowid DESC`)
    .all(...params) as ShareLinkRow[];
  return rows.map((r) => ({
    id: r.id, shareId: r.share_id, projectId: r.project_id, scope: r.scope, port: r.port, state: r.state,
    createdAt: r.created_at, expiresAt: r.expires_at, endedAt: r.ended_at,
  }));
}

/** Share links the ledger says are active (whether a listener is up is the link manager's to say). */
export function countActiveShareLinks(db: Db): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM share_links WHERE state = 'active'").get() as { n: number }).n;
}

type PersonRow = {
  id: string; name: string; role: Role; joined_at: string | null; last_seen_at: string | null; removed_at: string | null;
  credentials: number;
};
const PERSON_SELECT = `SELECT p.*, (SELECT COUNT(*) FROM credentials c WHERE c.person_id = p.id AND c.removed_at IS NULL) AS credentials
  FROM people p`;
const toPerson = (r: PersonRow): Person => ({
  id: r.id, name: r.name, role: r.role, joinedAt: r.joined_at, lastSeenAt: r.last_seen_at, removedAt: r.removed_at,
  credentials: r.credentials,
});
/** The Owner before anything about them is recorded: every ledger before collaboration already names `owner`. */
const VIRTUAL_OWNER: Person = {
  id: OWNER_ID, name: "Owner", role: "owner", joinedAt: null, lastSeenAt: null, removedAt: null, credentials: 0,
};

/** A person, removed or not; the Owner always exists (virtual until a row is recorded). */
export function getPerson(db: Db, id: string): Person | null {
  const r = db.prepare(`${PERSON_SELECT} WHERE p.id = ?`).get(id) as PersonRow | undefined;
  if (r) return toPerson(r);
  return id === OWNER_ID ? { ...VIRTUAL_OWNER } : null;
}

/** The Owner first (once, the row when there is one), then everyone else by when they joined. */
export function listPeople(db: Db, opts: { includeRemoved?: boolean } = {}): Person[] {
  const rows = db
    .prepare(`${PERSON_SELECT} WHERE p.id <> ?${opts.includeRemoved ? "" : " AND p.removed_at IS NULL"} ORDER BY p.joined_at, p.rowid`)
    .all(OWNER_ID) as PersonRow[];
  return [getPerson(db, OWNER_ID)!, ...rows.map(toPerson)];
}

type CredentialRow = {
  credential_id: string; person_id: string; kind: Credential["kind"]; public_key: string; transports: string; label: string;
};
const toCredential = (r: CredentialRow): Credential =>
  r.kind === "passkey"
    ? { kind: "passkey", credentialId: r.credential_id, publicKey: r.public_key, transports: JSON.parse(r.transports), label: r.label }
    : { kind: "key", credentialId: r.credential_id, publicKey: r.public_key, label: r.label };

/** A person's credentials that are not removed, oldest first. */
export function listCredentials(db: Db, personId: string): Credential[] {
  const rows = db
    .prepare("SELECT * FROM credentials WHERE person_id = ? AND removed_at IS NULL ORDER BY added_at, rowid")
    .all(personId) as CredentialRow[];
  return rows.map(toCredential);
}

/** A credential someone may sign in with: null when it, or its person, is removed (or unknown). */
export function findCredential(db: Db, credentialId: string): (Credential & { personId: string }) | null {
  const r = db
    .prepare(
      `SELECT c.* FROM credentials c JOIN people p ON p.id = c.person_id
       WHERE c.credential_id = ? AND c.removed_at IS NULL AND p.removed_at IS NULL`,
    )
    .get(credentialId) as CredentialRow | undefined;
  return r ? { ...toCredential(r), personId: r.person_id } : null;
}

type InviteRow = {
  id: string; code_hash: string; role: Role; created_at: string; expires_at: string; status: Invite["status"]; used_by: string | null;
};
/** A pending invite past its expiry reads as `expired`; no entry records that. */
const toInvite = (r: InviteRow, now: Date): Invite => ({
  id: r.id, role: r.role, createdAt: r.created_at, expiresAt: r.expires_at,
  status: r.status === "pending" && Date.parse(r.expires_at) <= now.getTime() ? "expired" : r.status,
});

export function getInviteByHash(db: Db, codeHash: string, now: Date = new Date()): Invite | null {
  const r = db.prepare("SELECT * FROM invites WHERE code_hash = ?").get(codeHash) as InviteRow | undefined;
  return r ? toInvite(r, now) : null;
}

export function getInvite(db: Db, inviteId: string, now: Date = new Date()): Invite | null {
  const r = db.prepare("SELECT * FROM invites WHERE id = ?").get(inviteId) as InviteRow | undefined;
  return r ? toInvite(r, now) : null;
}

/** Every invite, newest first. */
export function listInvites(db: Db, now: Date = new Date()): Invite[] {
  const rows = db.prepare("SELECT * FROM invites ORDER BY created_at DESC, rowid DESC").all() as InviteRow[];
  return rows.map((r) => toInvite(r, now));
}

type RemoteRow = {
  enabled: number; port: number; bind: string; domain: string | null; tls: TlsMode; fingerprint: string | null; expires_at: string | null;
};

/** Remote access as the ledger records it; DEFAULT_REMOTE before any entry. */
export function getRemoteState(db: Db): RemoteState {
  const r = db.prepare("SELECT * FROM remote_state WHERE id = 1").get() as RemoteRow | undefined;
  if (!r) return { ...DEFAULT_REMOTE };
  return {
    enabled: r.enabled === 1, port: r.port, bind: r.bind, domain: r.domain, tls: r.tls, fingerprint: r.fingerprint, expiresAt: r.expires_at,
  };
}

/** Who may sign a project's gate off: what was set for it, else the gate's default. */
export function getGateRequirement(db: Db, projectId: string, gateId: GateId): GateRequirement {
  const r = db.prepare("SELECT requirement FROM gate_requirements WHERE project_id = ? AND gate_id = ?").get(projectId, gateId) as
    | { requirement: string }
    | undefined;
  return r ? (JSON.parse(r.requirement) as GateRequirement) : { ...DEFAULT_GATE_REQUIREMENT[gateId] };
}
