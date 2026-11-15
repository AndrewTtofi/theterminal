import Database from "better-sqlite3";

/** Recreated on every open, so triggers dropped out of band do not stay gone. */
const APPEND_ONLY_TRIGGERS = `
  CREATE TRIGGER IF NOT EXISTS ledger_no_update BEFORE UPDATE ON ledger
  BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;
  CREATE TRIGGER IF NOT EXISTS ledger_no_delete BEFORE DELETE ON ledger
  BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;`;

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS ledger (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT UNIQUE NOT NULL,
    ts TEXT NOT NULL,
    project_id TEXT,
    actor_kind TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    type TEXT NOT NULL,
    payload TEXT NOT NULL,
    prev_hash TEXT NOT NULL,
    hash TEXT NOT NULL
  );
  ${APPEND_ONLY_TRIGGERS}`,
  `CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    pitch TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE cards (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    title TEXT NOT NULL,
    stage TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX cards_project ON cards (project_id);`,
  `CREATE TABLE agent_runs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    card_id TEXT,
    adapter TEXT NOT NULL,
    auth_mode TEXT NOT NULL,
    prompt TEXT NOT NULL,
    status TEXT NOT NULL,
    worktree TEXT NOT NULL,
    cost_usd REAL,
    error TEXT,
    started_at TEXT NOT NULL,
    finished_at TEXT
  );
  CREATE INDEX agent_runs_project ON agent_runs (project_id);
  CREATE TABLE agent_actions (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    tool TEXT NOT NULL,
    summary TEXT NOT NULL,
    input TEXT NOT NULL,
    status TEXT NOT NULL,
    decided_by TEXT,
    reason TEXT NOT NULL,
    output TEXT,
    requested_at TEXT NOT NULL,
    decided_at TEXT
  );
  CREATE INDEX agent_actions_run ON agent_actions (run_id);
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );`,
  `ALTER TABLE agent_runs ADD COLUMN input_tokens INTEGER;
  ALTER TABLE agent_runs ADD COLUMN output_tokens INTEGER;`,
  `CREATE TABLE connections (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    provider TEXT NOT NULL,
    name TEXT NOT NULL,
    enabled INTEGER NOT NULL,
    config TEXT NOT NULL,
    secret_fields TEXT NOT NULL,
    private_fields TEXT NOT NULL,
    status_state TEXT NOT NULL,
    status_message TEXT NOT NULL,
    tested_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX connections_provider ON connections (provider);`,
  `CREATE TABLE rate_limits (
    run_id TEXT NOT NULL,
    adapter TEXT NOT NULL,
    at TEXT NOT NULL,
    retry_after_s INTEGER
  );
  CREATE INDEX rate_limits_at ON rate_limits (at);`,
  `CREATE TABLE intakes (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL UNIQUE,
    idea TEXT NOT NULL,
    status TEXT NOT NULL,
    summary TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT
  );
  CREATE TABLE intake_answers (
    intake_id TEXT NOT NULL,
    question_id TEXT NOT NULL,
    answer TEXT NOT NULL,
    answered_at TEXT NOT NULL,
    PRIMARY KEY (intake_id, question_id)
  );
  CREATE TABLE intake_decisions (
    intake_id TEXT NOT NULL,
    decision_id TEXT NOT NULL,
    chosen TEXT NOT NULL,
    rationale TEXT NOT NULL,
    owner TEXT NOT NULL,
    decided_at TEXT NOT NULL,
    PRIMARY KEY (intake_id, decision_id)
  );
  CREATE TABLE gate_decisions (
    entry_id TEXT PRIMARY KEY,
    gate_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    card_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    from_stage TEXT NOT NULL,
    to_stage TEXT NOT NULL,
    reason TEXT,
    decided_by TEXT NOT NULL,
    at TEXT NOT NULL
  );
  CREATE INDEX gate_decisions_card ON gate_decisions (card_id);`,
  // The commit a run's worktree was created at; NULL for runs recorded before it was kept.
  `ALTER TABLE agent_runs ADD COLUMN base TEXT;`,
  // Linked machines: paired machines, runs that cross a link, and the machine a mirrored run executes on.
  `CREATE TABLE machines (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    public_key TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    address TEXT NOT NULL,
    role TEXT NOT NULL,
    paired_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE link_runs (
    run_id TEXT PRIMARY KEY,
    machine_id TEXT NOT NULL,
    direction TEXT NOT NULL,
    project_id TEXT NOT NULL,
    state TEXT NOT NULL,
    last_seq INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX link_runs_machine ON link_runs (machine_id);
  ALTER TABLE agent_runs ADD COLUMN machine_id TEXT;`,
];

export type Db = Database.Database;

export function openDatabase(file: string | ":memory:"): Db {
  const db = new Database(file);
  db.pragma("busy_timeout = 5000");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  const version = db.pragma("user_version", { simple: true }) as number;
  for (let i = version; i < MIGRATIONS.length; i++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[i]!);
      db.pragma(`user_version = ${i + 1}`);
    }).immediate();
  }
  db.exec(APPEND_ONLY_TRIGGERS);
  return db;
}
