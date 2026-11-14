import { createHash, randomUUID } from "node:crypto";
import { GENESIS_HASH, eventPayloadSchemas, type LedgerEntry, type NewLedgerEntry } from "@theterminal/shared";
import type { Db } from "../db.js";
import { canonicalJson } from "./canonical.js";

export type VerifyResult = { ok: true; count: number } | { ok: false; brokenAtSeq: number };

export class LedgerReadOnlyError extends Error {
  constructor() {
    super("ledger is read-only");
    this.name = "LedgerReadOnlyError";
  }
}

type Row = {
  seq: number;
  id: string;
  ts: string;
  project_id: string | null;
  actor_kind: string;
  actor_id: string;
  type: string;
  payload: string;
  prev_hash: string;
  hash: string;
};

function hashEntry(e: Omit<LedgerEntry, "hash">): string {
  const { seq, id, ts, projectId, actor, type, payload, prevHash } = e;
  return createHash("sha256")
    .update(canonicalJson({ seq, id, ts, projectId, actor, type, payload, prevHash }))
    .digest("hex");
}

function rowToEntry(r: Row): LedgerEntry {
  return {
    seq: r.seq,
    id: r.id,
    ts: r.ts,
    projectId: r.project_id,
    actor: { kind: r.actor_kind, id: r.actor_id } as LedgerEntry["actor"],
    type: r.type as LedgerEntry["type"],
    payload: JSON.parse(r.payload),
    prevHash: r.prev_hash,
    hash: r.hash,
  };
}

export class Ledger {
  readOnly = false;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly listeners = new Set<(e: LedgerEntry) => void>();

  constructor(
    private readonly db: Db,
    opts: { now?: () => Date; newId?: () => string } = {},
  ) {
    this.now = opts.now ?? (() => new Date());
    this.newId = opts.newId ?? (() => randomUUID());
  }

  /** Append in its own immediate transaction, then notify listeners. Not for use inside another transaction. */
  append(e: NewLedgerEntry): LedgerEntry {
    if (this.db.inTransaction) {
      throw new Error("Ledger.append called inside a transaction; use appendInTransaction and notify after commit");
    }
    const entry = this.db.transaction(() => this.appendInTransaction(e)).immediate();
    this.notify(entry);
    return entry;
  }

  /**
   * Write an entry without notifying listeners. Safe to call inside an outer transaction
   * (the caller must hold a write lock, e.g. `.immediate()`); call `notify(entry)` after the OUTER commit.
   */
  appendInTransaction(e: NewLedgerEntry): LedgerEntry {
    if (this.readOnly) throw new LedgerReadOnlyError();
    const schema = eventPayloadSchemas[e.type];
    if (!schema) throw new Error(`unknown ledger event type: ${String(e.type)}`);
    const payload: unknown = schema.parse(e.payload);

    const last = this.db.prepare("SELECT seq, hash FROM ledger ORDER BY seq DESC LIMIT 1").get() as
      | { seq: number; hash: string }
      | undefined;
    const base = {
      seq: (last?.seq ?? 0) + 1,
      id: this.newId(),
      ts: this.now().toISOString(),
      projectId: e.projectId,
      actor: e.actor,
      type: e.type,
      payload,
      prevHash: last?.hash ?? GENESIS_HASH,
    };
    const entry: LedgerEntry = { ...base, hash: hashEntry(base) };
    this.db
      .prepare(
        `INSERT INTO ledger (seq, id, ts, project_id, actor_kind, actor_id, type, payload, prev_hash, hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.seq, entry.id, entry.ts, entry.projectId, entry.actor.kind, entry.actor.id,
        entry.type, canonicalJson(entry.payload), entry.prevHash, entry.hash,
      );
    return entry;
  }

  /** Fire onAppend listeners for an entry whose transaction has committed. */
  notify(entry: LedgerEntry): void {
    for (const fn of [...this.listeners]) fn(entry);
  }

  list(q: { projectId?: string; afterSeq?: number; limit?: number } = {}): LedgerEntry[] {
    const where: string[] = ["seq > ?"];
    const params: unknown[] = [q.afterSeq ?? 0];
    if (q.projectId !== undefined) {
      where.push("project_id = ?");
      params.push(q.projectId);
    }
    params.push(q.limit ?? 500);
    const rows = this.db
      .prepare(`SELECT * FROM ledger WHERE ${where.join(" AND ")} ORDER BY seq ASC LIMIT ?`)
      .all(...params) as Row[];
    return rows.map(rowToEntry);
  }

  verify(): VerifyResult {
    let prevHash = GENESIS_HASH;
    let count = 0;
    for (const row of this.db.prepare("SELECT * FROM ledger ORDER BY seq ASC").iterate() as Iterable<Row>) {
      let ok = row.prev_hash === prevHash;
      if (ok) {
        try {
          const { hash, ...rest } = rowToEntry(row);
          ok = hashEntry(rest) === hash;
        } catch {
          ok = false;
        }
      }
      if (!ok) return { ok: false, brokenAtSeq: row.seq };
      prevHash = row.hash;
      count++;
    }
    return { ok: true, count };
  }

  onAppend(fn: (e: LedgerEntry) => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }
}
