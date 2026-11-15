import { describe, expect, it, vi } from "vitest";
import { openDatabase } from "../../src/db.js";
import { Ledger } from "../../src/ledger/ledger.js";
import { ledgerExportLines } from "../../src/story/story.js";

// Narration that fails on one kind of entry: the export must carry on, naming that entry by its type.
vi.mock("@theterminal/shared", async (importOriginal) => {
  const shared = await importOriginal<typeof import("@theterminal/shared")>();
  return {
    ...shared,
    narrate: (e: Parameters<typeof shared.narrate>[0], ctx: Parameters<typeof shared.narrate>[1]) => {
      if (e.type === "card.created") throw new Error("narration failed");
      return shared.narrate(e, ctx);
    },
  };
});

describe("export narration", () => {
  it("falls back to the event type when narration throws, and finishes the stream", () => {
    const db = openDatabase(":memory:");
    const ledger = new Ledger(db);
    const actor = { kind: "human", id: "owner" } as const;
    ledger.append({ projectId: "p1", actor, type: "project.created", payload: { projectId: "p1", name: "Book Club", pitch: "" } });
    ledger.append({ projectId: "p1", actor, type: "card.created", payload: { cardId: "c1", title: "List", stage: "plan" } });
    ledger.append({ projectId: "p1", actor, type: "card.moved", payload: { cardId: "c1", from: "plan", to: "design" } });

    const out = [...ledgerExportLines(db, ledger, null)].map((l) => JSON.parse(l) as Record<string, unknown>);

    expect(out.map((l) => l.headline ?? l.kind)).toEqual([
      "header", 'Owner created the project "Book Club"', "card.created", expect.stringContaining("moved"), "end",
    ]);
  });
});
