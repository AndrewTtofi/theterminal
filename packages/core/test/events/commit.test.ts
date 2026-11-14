import { describe, it, expect, beforeEach } from "vitest";
import { openDatabase, type Db } from "../../src/db.js";
import { Ledger } from "../../src/ledger/ledger.js";
import { commitEvent } from "../../src/events/commit.js";

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
