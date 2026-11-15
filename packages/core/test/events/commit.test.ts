import { describe, it, expect, beforeEach, vi } from "vitest";
import { openDatabase, type Db } from "../../src/db.js";
import { Ledger } from "../../src/ledger/ledger.js";
import { applyEvent } from "../../src/events/projections.js";
import { commitEvent, commitEvents } from "../../src/events/commit.js";

const human = { kind: "human", id: "owner" } as const;
let db: Db;
let ledger: Ledger;

beforeEach(() => {
  db = openDatabase(":memory:");
  ledger = new Ledger(db);
});

const ev = { projectId: "p1", actor: human, type: "project.created", payload: { projectId: "p1", name: "A", pitch: "" } };

describe("commitEvent", () => {
  it("appends, applies, notifies after commit and returns the result", () => {
    const seen: string[] = [];
    ledger.onAppend(() => {
      seen.push(db.inTransaction ? "in-tx" : "committed");
    });
    const out = commitEvent(db, ledger, () => ({ event: ev, result: (e) => e?.seq }));
    expect(out).toBe(1);
    expect(seen).toEqual(["committed"]);
    expect(db.prepare("SELECT name FROM projects").all()).toEqual([{ name: "A" }]);
  });

  it("rolls back the ledger row and does not notify when apply throws", () => {
    let notified = 0;
    ledger.onAppend(() => notified++);
    expect(() =>
      commitEvent(db, ledger, () => ({ event: ev, result: () => 1 }), () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(ledger.list()).toHaveLength(0);
    expect(notified).toBe(0);
  });

  it("writes nothing when build returns no event", () => {
    const out = commitEvent(db, ledger, () => ({ result: (e) => e })); 
    expect(out).toBeNull();
    expect(ledger.list()).toHaveLength(0);
  });
});

const card = (cardId: string, title: string) => ({
  projectId: "p1", actor: human, type: "card.created" as const, payload: { cardId, title, stage: "plan" },
});

describe("commitEvents", () => {
  it("appends consecutive seqs, applies every event, and notifies each in order after commit", () => {
    commitEvent(db, ledger, () => ({ event: ev, result: () => null }));
    const seen: { seq: number; inTx: boolean }[] = [];
    ledger.onAppend((e) => seen.push({ seq: e.seq, inTx: db.inTransaction }));
    const out = commitEvents(db, ledger, () => ({
      events: [card("c1", "One"), card("c2", "Two")],
      result: (entries) => entries.map((e) => e.seq),
    }));
    expect(out).toEqual([2, 3]);
    expect(seen).toEqual([{ seq: 2, inTx: false }, { seq: 3, inTx: false }]);
    expect(db.prepare("SELECT id FROM cards ORDER BY id").all()).toEqual([{ id: "c1" }, { id: "c2" }]);
    expect(ledger.verify().ok).toBe(true);
  });

  it("leaves the ledger and projections unchanged when build throws after reading state", () => {
    commitEvent(db, ledger, () => ({ event: ev, result: () => null }));
    let notified = 0;
    ledger.onAppend(() => notified++);
    expect(() =>
      commitEvents(db, ledger, () => {
        const n = (db.prepare("SELECT COUNT(*) AS n FROM projects").get() as { n: number }).n;
        if (n === 1) throw new Error("refused");
        return { events: [card("c1", "One")], result: () => null };
      }),
    ).toThrow("refused");
    expect(ledger.list()).toHaveLength(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM cards").get()).toEqual({ n: 0 });
    expect(notified).toBe(0);
  });

  it("rolls back every event of the batch when a later apply throws", () => {
    expect(() =>
      commitEvents(
        db, ledger,
        () => ({ events: [card("c1", "One"), card("c2", "Two")], result: () => null }),
        (d, e) => {
          if (e.seq === 2) throw new Error("boom");
          applyEvent(d, e);
        },
      ),
    ).toThrow("boom");
    expect(ledger.list()).toHaveLength(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM cards").get()).toEqual({ n: 0 });
  });

  it("a listener that throws on the first entry does not stop the second notification", () => {
    const seen: number[] = [];
    ledger.onAppend((e) => {
      seen.push(e.seq);
      if (e.seq === 1) throw new Error("listener");
    });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    commitEvents(db, ledger, () => ({ events: [card("c1", "One"), card("c2", "Two")], result: () => null }));
    err.mockRestore();
    expect(seen).toEqual([1, 2]);
  });

  it("writes nothing for an empty batch and returns result([])", () => {
    let notified = 0;
    ledger.onAppend(() => notified++);
    const out = commitEvents(db, ledger, () => ({ events: [], result: (entries) => ({ n: entries.length }) }));
    expect(out).toEqual({ n: 0 });
    expect(ledger.list()).toHaveLength(0);
    expect(notified).toBe(0);
  });
});
