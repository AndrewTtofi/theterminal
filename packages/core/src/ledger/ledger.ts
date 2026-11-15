import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { GENESIS_HASH, actorSchema, eventPayloadSchemas, type LedgerEntry, type NewLedgerEntry } from "@theterminal/shared";
import type { Db } from "../db.js";
import { canonicalJson } from "./canonical.js";

/** A ledger row as read: the entry, or only its seq when its payload cannot be parsed. */
export type LedgerRow = LedgerEntry | { seq: number; unreadable: true };

export type VerifyResult = { ok: true; count: number } | { ok: false; brokenAtSeq: number };

/** The most run ids one `list` call may filter by. */
export const MAX_RUN_IDS = 200;

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
  /** The last verify() result and the database state it was computed for. */
  private verified: { key: string; result: VerifyResult } | null = null;

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
    this.verified = null;
    const schema = eventPayloadSchemas[e.type];
    if (!schema) throw new Error(`unknown ledger event type: ${String(e.type)}`);
    const payload: unknown = schema.parse(e.payload);

    const actor = actorSchema.strict().parse(e.actor);
    const projectId = z.string().min(1).nullable().parse(e.projectId);

    const last = this.db.prepare("SELECT seq, hash FROM ledger ORDER BY seq DESC LIMIT 1").get() as
      | { seq: number; hash: string }
      | undefined;
    const base = {
      seq: (last?.seq ?? 0) + 1,
      id: this.newId(),
      ts: this.now().toISOString(),
      projectId,
      actor,
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
    // The entry is already committed: a failing listener must not fail the command or starve the others.
    for (const fn of [...this.listeners]) {
      try {
        fn(entry);
      } catch (err) {
        console.error("ledger listener failed", err);
      }
    }
  }

  /**
   * Entries in seq order. `cardId` and `runIds` keep the entries whose payload names that card or one of those
   * runs (their union when both are given); an empty `runIds` names no run. At most MAX_RUN_IDS run ids.
   */
  list(
    q: { projectId?: string; afterSeq?: number; limit?: number; cardId?: string; runIds?: string[] } = {},
  ): LedgerEntry[] {
    const where: string[] = ["seq > ?"];
    const params: unknown[] = [q.afterSeq ?? 0];
    if (q.projectId !== undefined) {
      where.push("project_id = ?");
      params.push(q.projectId);
    }
    if (q.cardId !== undefined || q.runIds !== undefined) {
      if (q.runIds !== undefined && q.runIds.length > MAX_RUN_IDS) {
        throw new RangeError(`at most ${MAX_RUN_IDS} run ids`);
      }
      const about: string[] = [];
      if (q.cardId !== undefined) {
        about.push("json_extract(payload, '$.cardId') = ?");
        params.push(q.cardId);
      }
      if (q.runIds !== undefined && q.runIds.length > 0) {
        about.push(`json_extract(payload, '$.runId') IN (${q.runIds.map(() => "?").join(", ")})`);
        params.push(...q.runIds);
      }
      // CASE guarantees json_valid runs first: json_extract throws on a tampered, unparseable payload.
      where.push(about.length > 0 ? `CASE WHEN json_valid(payload) THEN (${about.join(" OR ")}) ELSE 0 END` : "0");
    }
    params.push(q.limit ?? 500);
    const rows = this.db
      .prepare(`SELECT * FROM ledger WHERE ${where.join(" AND ")} ORDER BY seq ASC LIMIT ?`)
      .all(...params) as Row[];
    // Stop at the first row whose payload cannot be parsed (a tampered entry): serve what precedes it,
    // consistent with treating the ledger as read-only from the break.
    const entries: LedgerEntry[] = [];
    for (const row of rows) {
      try {
        entries.push(rowToEntry(row));
      } catch {
        break;
      }
    }
    return entries;
  }

  /**
   * Rows in seq order without stopping at an unreadable one: a row whose payload cannot be parsed comes back as
   * `{ seq, unreadable: true }`. `toSeq` is inclusive; `seqs` reads exactly those rows (at most 500).
   */
  listRows(q: { afterSeq?: number; toSeq?: number; limit?: number; seqs?: number[] } = {}): LedgerRow[] {
    const where: string[] = ["seq > ?"];
    const params: unknown[] = [q.afterSeq ?? 0];
    if (q.toSeq !== undefined) {
      where.push("seq <= ?");
      params.push(q.toSeq);
    }
    if (q.seqs !== undefined) {
      if (q.seqs.length > 500) throw new RangeError("at most 500 seqs");
      where.push(q.seqs.length > 0 ? `seq IN (${q.seqs.map(() => "?").join(", ")})` : "0");
      params.push(...q.seqs);
    }
    params.push(q.limit ?? 500);
    const rows = this.db
      .prepare(`SELECT * FROM ledger WHERE ${where.join(" AND ")} ORDER BY seq ASC LIMIT ?`)
      .all(...params) as Row[];
    return rows.map((row) => {
      try {
        return rowToEntry(row);
      } catch {
        return { seq: row.seq, unreadable: true as const };
      }
    });
  }

  /** The highest seq in the ledger, or 0 when it is empty. */
  headSeq(): number {
    return (this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS head FROM ledger").get() as { head: number }).head;
  }

  /**
   * Walk the whole hash chain. The result is memoised by headSeq, so repeated reads (every story request) do not
   * re-hash the ledger; an append invalidates it. The key also carries this connection's change count and SQLite's
   * data_version, so a row rewritten out of band (here or by another connection) is still caught on the next call.
   */
  verify(): VerifyResult {
    const key = this.verifyKey();
    if (this.verified?.key === key) return this.verified.result;
    const result = this.walkChain();
    this.verified = { key, result };
    return result;
  }

  private verifyKey(): string {
    const changes = (this.db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
    const dataVersion = this.db.pragma("data_version", { simple: true }) as number;
    return `${this.headSeq()}:${changes}:${dataVersion}`;
  }

  private walkChain(): VerifyResult {
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
