import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Worker } from "node:worker_threads";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { GENESIS_HASH, type NewLedgerEntry } from "@theterminal/shared";
import { openDatabase } from "../../src/db.js";
import { Ledger, LedgerReadOnlyError } from "../../src/ledger/ledger.js";

const actor = { kind: "human", id: "owner" } as const;
const created = (n: number): NewLedgerEntry => ({
  projectId: null,
  actor,
  type: "project.created",
  payload: { projectId: `p${n}`, name: "n", pitch: "p" },
});

describe("Ledger", () => {
  let db: ReturnType<typeof openDatabase>;
  let ledger: Ledger;
  beforeEach(() => {
    db = openDatabase(":memory:");
    ledger = new Ledger(db);
  });

  it("chains entries and verifies", () => {
    const e1 = ledger.append(created(1));
    const e2 = ledger.append(created(2));
    const e3 = ledger.append(created(3));
    expect([e1.seq, e2.seq, e3.seq]).toEqual([1, 2, 3]);
    expect(e1.prevHash).toBe(GENESIS_HASH);
    expect(e2.prevHash).toBe(e1.hash);
    expect(e3.prevHash).toBe(e2.hash);
    expect(ledger.verify()).toEqual({ ok: true, count: 3 });
  });

  it("uses injectable now and newId", () => {
    const l = new Ledger(openDatabase(":memory:"), {
      now: () => new Date("2026-01-02T03:04:05.000Z"),
      newId: () => "fixed-id",
    });
    const e = l.append(created(1));
    expect(e.ts).toBe("2026-01-02T03:04:05.000Z");
    expect(e.id).toBe("fixed-id");
  });

  it("rejects invalid payloads and unknown types, writing nothing", () => {
    expect(() => ledger.append({ ...created(1), payload: { nope: true } })).toThrow();
    expect(() => ledger.append({ ...created(1), type: "bogus" as never })).toThrow();
    expect(ledger.list()).toEqual([]);
  });

  it("rejects invalid envelopes, writing nothing", () => {
    const bad = (patch: Partial<NewLedgerEntry>) => () => ledger.append({ ...created(1), ...patch });
    expect(bad({ actor: { kind: "human", id: "owner", name: "x" } as never })).toThrow();
    expect(bad({ actor: { kind: "robot", id: "" } as never })).toThrow();
    expect(bad({ actor: { kind: "human", id: "" } })).toThrow();
    expect(bad({ projectId: 5 as never })).toThrow();
    expect(ledger.list()).toEqual([]);
  });

  it("blocks UPDATE and DELETE via triggers", () => {
    ledger.append(created(1));
    expect(() => db.prepare("UPDATE ledger SET payload='{}' WHERE seq=1").run()).toThrow(/append-only/);
    expect(() => db.prepare("DELETE FROM ledger WHERE seq=1").run()).toThrow(/append-only/);
  });

  it("detects tampering", () => {
    ledger.append(created(1));
    ledger.append(created(2));
    ledger.append(created(3));
    db.exec("DROP TRIGGER IF EXISTS ledger_no_update; DROP TRIGGER IF EXISTS ledger_no_delete;");
    db.prepare("UPDATE ledger SET payload=? WHERE seq=2").run(
      JSON.stringify({ projectId: "evil", name: "n", pitch: "p" }),
    );
    expect(ledger.verify()).toEqual({ ok: false, brokenAtSeq: 2 });
  });

  it("list filters by project, afterSeq and limit", () => {
    ledger.append({ ...created(1), projectId: "a" });
    ledger.append({ ...created(2), projectId: "b" });
    ledger.append({ ...created(3), projectId: "a" });
    expect(ledger.list({ projectId: "a" }).map((e) => e.seq)).toEqual([1, 3]);
    expect(ledger.list({ afterSeq: 1 }).map((e) => e.seq)).toEqual([2, 3]);
    expect(ledger.list({ limit: 2 }).map((e) => e.seq)).toEqual([1, 2]);
  });

  it("notifies listeners once per append; unsubscribe stops", () => {
    const seen: number[] = [];
    const off = ledger.onAppend((e) => seen.push(e.seq));
    ledger.append(created(1));
    off();
    ledger.append(created(2));
    expect(seen).toEqual([1]);
  });

  it("does not notify for a rolled-back outer transaction; notify() after commit works", () => {
    const seen: number[] = [];
    ledger.onAppend((e) => seen.push(e.seq));
    expect(() =>
      db.transaction(() => {
        ledger.appendInTransaction(created(1));
        throw new Error("boom");
      })(),
    ).toThrow("boom");
    expect(seen).toEqual([]);
    expect(ledger.list()).toEqual([]);

    const entry = db.transaction(() => ledger.appendInTransaction(created(1))).immediate();
    expect(seen).toEqual([]);
    ledger.notify(entry);
    expect(seen).toEqual([1]);
  });

  it("list stops before the first row whose payload JSON is unparseable", () => {
    ledger.append(created(1));
    ledger.append(created(2));
    ledger.append(created(3));
    db.exec("DROP TRIGGER IF EXISTS ledger_no_update; DROP TRIGGER IF EXISTS ledger_no_delete;");
    db.prepare("UPDATE ledger SET payload = ? WHERE seq = 2").run("{not json");
    expect(ledger.verify()).toEqual({ ok: false, brokenAtSeq: 2 });
    expect(ledger.list().map((e) => e.seq)).toEqual([1]);
    expect(ledger.list({ afterSeq: 1 })).toEqual([]);
  });

  it("isolates listeners: a throwing one neither stops the others nor makes append throw", () => {
    const errors: unknown[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args) => void errors.push(args));
    try {
      const seen: number[] = [];
      ledger.onAppend(() => {
        throw new Error("listener boom");
      });
      ledger.onAppend((e) => seen.push(e.seq));
      expect(() => ledger.append(created(1))).not.toThrow();
      expect(seen).toEqual([1]);
      expect(ledger.list().map((e) => e.seq)).toEqual([1]);
      expect(errors).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("readOnly makes append throw", () => {
    ledger.readOnly = true;
    expect(() => ledger.append(created(1))).toThrow(LedgerReadOnlyError);
    expect(() => ledger.appendInTransaction(created(1))).toThrow(LedgerReadOnlyError);
  });
});

describe("Ledger across connections", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ledger-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("keeps a single gap-free chain with two concurrent writer threads", async () => {
    const file = join(dir, "t.db");
    openDatabase(file).close(); // create schema first
    const workerUrl = fileURLToPath(new URL("./worker.mjs", import.meta.url));
    const run = (tag: string) =>
      new Promise<void>((resolve, reject) => {
        const w = new Worker(workerUrl, { workerData: { file, count: 25, tag } });
        w.once("message", () => resolve());
        w.once("error", reject);
      });
    await Promise.all([run("a"), run("b")]);

    const db = openDatabase(file);
    const ledger = new Ledger(db);
    const seqs = ledger.list({ limit: 1000 }).map((e) => e.seq);
    expect(seqs).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    expect(ledger.verify()).toEqual({ ok: true, count: 50 });
    db.close();
  });
});

describe("openDatabase", () => {
  it("recreates the append-only triggers on every open", () => {
    const dir = mkdtempSync(join(tmpdir(), "tt-db-"));
    try {
      const file = join(dir, "ledger.db");
      const a = openDatabase(file);
      new Ledger(a).append(created(1));
      a.exec("DROP TRIGGER ledger_no_update; DROP TRIGGER ledger_no_delete;");
      a.close();

      const b = openDatabase(file);
      expect(() => b.prepare("UPDATE ledger SET payload='{}' WHERE seq=1").run()).toThrow(/append-only/);
      expect(() => b.prepare("DELETE FROM ledger WHERE seq=1").run()).toThrow(/append-only/);
      b.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
