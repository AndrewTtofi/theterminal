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
