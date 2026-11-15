import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Worker } from "node:worker_threads";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { GATES, GENESIS_HASH, type NewLedgerEntry } from "@theterminal/shared";
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

  describe("an own __proto__ key in a payload", () => {
    const action = (input: unknown): NewLedgerEntry =>
      ({
        projectId: "p",
        actor: { kind: "agent", id: "run-1" },
        type: "agent.action.requested",
        payload: { runId: "r1", actionId: "a1", kind: "shell", tool: "Bash", summary: "ls", input },
      }) as NewLedgerEntry;

    it("is covered by the hash, stored, and read back as data", () => {
      const input = JSON.parse('{"command":"ls","__proto__":{"polluted":true}}');
      const appended = ledger.append(action(input));
      const [read] = ledger.list();
      const readInput = (read!.payload as { input: Record<string, unknown> }).input;
      expect(Object.keys(readInput)).toEqual(["__proto__", "command"]);
      expect(Object.getPrototypeOf(readInput)).toBe(Object.prototype);
      expect(read).toEqual(appended);
      expect(ledger.verify()).toEqual({ ok: true, count: 1 });
      // The same action without the key hashes differently: the key is not free content.
      const other = new Ledger(openDatabase(":memory:"), { now: () => new Date(appended.ts), newId: () => appended.id });
      expect(other.append(action({ command: "ls" })).hash).not.toBe(appended.hash);
    });

    it("smuggled into a stored row out of band fails verification (fail closed)", () => {
      ledger.append(created(1));
      ledger.append(action({ command: "ls" }));
      ledger.append(created(3));
      expect(ledger.verify()).toEqual({ ok: true, count: 3 });
      db.exec("DROP TRIGGER IF EXISTS ledger_no_update; DROP TRIGGER IF EXISTS ledger_no_delete;");
      const stored = (db.prepare("SELECT payload FROM ledger WHERE seq=2").get() as { payload: string }).payload;
      const smuggled = stored.replace('"input":{', '"input":{"__proto__":{"polluted":true},');
      expect(smuggled).not.toBe(stored);
      db.prepare("UPDATE ledger SET payload=? WHERE seq=2").run(smuggled);
      expect(ledger.verify()).toEqual({ ok: false, brokenAtSeq: 2 });
    });
  });

  it("list filters by project, afterSeq and limit", () => {
    ledger.append({ ...created(1), projectId: "a" });
    ledger.append({ ...created(2), projectId: "b" });
    ledger.append({ ...created(3), projectId: "a" });
    expect(ledger.list({ projectId: "a" }).map((e) => e.seq)).toEqual([1, 3]);
    expect(ledger.list({ afterSeq: 1 }).map((e) => e.seq)).toEqual([2, 3]);
    expect(ledger.list({ limit: 2 }).map((e) => e.seq)).toEqual([1, 2]);
  });

  it("list with beforeSeq pages backwards: the newest `limit` before it, in ascending order", () => {
    for (let i = 1; i <= 12; i++) ledger.append(created(i));
    expect(ledger.list({ beforeSeq: 10, limit: 3 }).map((e) => e.seq)).toEqual([7, 8, 9]);
    expect(ledger.list({ afterSeq: 2, beforeSeq: 5 }).map((e) => e.seq)).toEqual([3, 4]);
    expect(ledger.list({ beforeSeq: 1 })).toEqual([]);
  });

  describe("list by card and runs", () => {
    const ack = GATES.find((g) => g.id === "payments")!.acknowledgement;
    const entry = (type: string, payload: unknown): NewLedgerEntry => ({ projectId: "p", actor, type, payload } as NewLedgerEntry);
    const started = (runId: string, cardId: string | null) =>
      entry("agent.started", { runId, adapter: "fake", authMode: "none", prompt: "go", cardId, worktree: `wt/${runId}` });
    beforeEach(() => {
      ledger.append(entry("card.created", { cardId: "c1", title: "One", stage: "design" })); // 1
      ledger.append(entry("card.created", { cardId: "c2", title: "Two", stage: "design" })); // 2
      ledger.append(entry("card.moved", { cardId: "c1", from: "design", to: "build" })); // 3
      ledger.append(entry("card.moved", { cardId: "c2", from: "design", to: "build" })); // 4
      ledger.append(started("a", null)); // 5
      ledger.append(started("b", null)); // 6
      ledger.append(entry("agent.message", { runId: "a", text: "hi" })); // 7
      ledger.append(entry("agent.message", { runId: "b", text: "hi" })); // 8
      ledger.append(entry("agent.finished", { runId: "a", status: "completed", costUsd: 0.1, error: null })); // 9
      ledger.append(entry("gate.signed_off", {
        gateId: "payments", cardId: "c1", from: "build", to: "ship", conditions: [], acknowledgement: ack, signedBy: "owner",
      })); // 10
      ledger.append(entry("gate.signed_off", {
        gateId: "payments", cardId: "c2", from: "build", to: "ship", conditions: [], acknowledgement: ack, signedBy: "owner",
      })); // 11
    });

    it("cardId keeps that card's entries only", () => {
      const got = ledger.list({ cardId: "c1" });
      expect(got.map((e) => [e.seq, e.type])).toEqual([[1, "card.created"], [3, "card.moved"], [10, "gate.signed_off"]]);
    });

    it("runIds keeps those runs' agent entries only", () => {
      expect(ledger.list({ runIds: ["a"] }).map((e) => e.seq)).toEqual([5, 7, 9]);
    });

    it("cardId and runIds together give the union, still combined with afterSeq, limit and projectId", () => {
      expect(ledger.list({ cardId: "c1", runIds: ["a"] }).map((e) => e.seq)).toEqual([1, 3, 5, 7, 9, 10]);
      expect(ledger.list({ cardId: "c1", runIds: ["a"], afterSeq: 3, limit: 2 }).map((e) => e.seq)).toEqual([5, 7]);
      expect(ledger.list({ cardId: "c1", projectId: "other" })).toEqual([]);
    });

    it("an empty runIds matches no run", () => {
      expect(ledger.list({ runIds: [] })).toEqual([]);
      expect(ledger.list({ cardId: "c2", runIds: [] }).map((e) => e.seq)).toEqual([2, 4, 11]);
    });

    it("skips a tampered, unparseable payload instead of failing", () => {
      db.exec("DROP TRIGGER IF EXISTS ledger_no_update; DROP TRIGGER IF EXISTS ledger_no_delete;");
      db.prepare("UPDATE ledger SET payload = ? WHERE seq = 3").run("{not json");
      expect(ledger.list({ cardId: "c1", runIds: ["a"] }).map((e) => e.seq)).toEqual([1, 5, 7, 9, 10]);
    });

    it("runIds and cardId also keep a linked machine's mirrored entries of those runs and that card", () => {
      const H = "e".repeat(64);
      const mirrored = (seq: number, type: string, payload: Record<string, unknown>) =>
        entry("link.mirrored", {
          machineId: "b".repeat(32), signature: "c".repeat(128),
          origin: { seq, id: `w${seq}`, ts: "2026-11-15T00:00:00.000Z", projectId: "p", actor: { kind: "agent", id: "x" }, type, payload, prevHash: H, hash: H },
        });
      ledger.append(mirrored(1, "agent.started", { runId: "r", adapter: "fake", authMode: "none", prompt: "go", cardId: "c9", worktree: "wt/r" })); // 12
      ledger.append(mirrored(2, "agent.message", { runId: "r", text: "hi" })); // 13
      ledger.append(mirrored(3, "agent.message", { runId: "a", text: "hi" })); // 14
      ledger.append(entry("link.run_failed", { runId: "r", machineId: "b".repeat(32), error: "unreachable" })); // 15
      expect(ledger.list({ runIds: ["r"] }).map((e) => e.seq)).toEqual([12, 13, 15]);
      expect(ledger.list({ runIds: ["a"] }).map((e) => e.seq)).toEqual([5, 7, 9, 14]);
      expect(ledger.list({ cardId: "c9" }).map((e) => e.seq)).toEqual([12]);
      expect(ledger.list({ cardId: "c9", runIds: [] }).map((e) => e.seq)).toEqual([12]);
    });

    it("refuses more than 200 runIds", () => {
      const many = Array.from({ length: 201 }, (_, i) => `r${i}`);
      expect(() => ledger.list({ runIds: many })).toThrow(RangeError);
      expect(() => ledger.list({ runIds: many.slice(0, 200) })).not.toThrow();
    });
  });

  it("listRows reads past an unparseable row, by range or by seqs", () => {
    for (let n = 1; n <= 4; n++) ledger.append(created(n));
    db.exec("DROP TRIGGER IF EXISTS ledger_no_update; DROP TRIGGER IF EXISTS ledger_no_delete;");
    db.prepare("UPDATE ledger SET payload = ? WHERE seq = 2").run("{not json");
    const rows = ledger.listRows({ toSeq: 3 });
    expect(rows.map((r) => ("unreadable" in r ? `gap ${r.seq}` : r.seq))).toEqual([1, "gap 2", 3]);
    expect(ledger.listRows({ afterSeq: 1, limit: 2 }).map((r) => r.seq)).toEqual([2, 3]);
    expect(ledger.listRows({ seqs: [4, 1] }).map((r) => r.seq)).toEqual([1, 4]);
    expect(ledger.listRows({ seqs: [] })).toEqual([]);
    expect(() => ledger.listRows({ seqs: Array.from({ length: 501 }, (_, i) => i) })).toThrow(RangeError);
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
