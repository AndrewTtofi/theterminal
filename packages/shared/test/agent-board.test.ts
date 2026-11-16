import { describe, expect, it } from "vitest";
import { agentBoardPayloadSchemas, commentStateLabel, COMMENT_LIMITS, eventPayloadSchemas, narrate } from "../src/index.js";
import type { LedgerEntry } from "../src/index.js";

const comment = { commentId: "m1", cardId: "c1", text: "Use the blue one", authorName: "Ana", role: "maintainer" };

describe("agent board payloads", () => {
  it("has the limits", () => {
    expect(COMMENT_LIMITS).toEqual({ textChars: 2000, perRun: 20 });
  });
  it("registers all six types", () => {
    for (const t of Object.keys(agentBoardPayloadSchemas)) expect(eventPayloadSchemas).toHaveProperty(t);
    expect(Object.keys(agentBoardPayloadSchemas).sort()).toEqual([
      "card.comment",
      "card.comments_given",
      "card.comments_read",
      "card.move_declined",
      "card.move_requested",
      "card.run_linked",
    ]);
  });
  it("accepts valid notes", () => {
    expect(eventPayloadSchemas["card.comment"]!.safeParse(comment).success).toBe(true);
    expect(eventPayloadSchemas["card.comment"]!.safeParse({ ...comment, text: "x".repeat(2000) }).success).toBe(true);
  });
  it("refuses bad notes", () => {
    const s = eventPayloadSchemas["card.comment"]!;
    expect(s.safeParse({ ...comment, text: "x".repeat(2001) }).success).toBe(false);
    expect(s.safeParse({ ...comment, text: "" }).success).toBe(false);
    expect(s.safeParse({ ...comment, role: "admin" }).success).toBe(false);
    expect(s.safeParse({ ...comment, extra: 1 }).success).toBe(false);
  });
  it("limits and de-duplicates given and read ids", () => {
    for (const t of ["card.comments_given", "card.comments_read"] as const) {
      const s = eventPayloadSchemas[t]!;
      const ids = (n: number) => Array.from({ length: n }, (_, i) => `n${i}`);
      expect(s.safeParse({ cardId: "c1", runId: "r1", commentIds: ids(20) }).success).toBe(true);
      expect(s.safeParse({ cardId: "c1", runId: "r1", commentIds: ids(21) }).success).toBe(false);
      expect(s.safeParse({ cardId: "c1", runId: "r1", commentIds: [] }).success).toBe(false);
      expect(s.safeParse({ cardId: "c1", runId: "r1", commentIds: ["a", "a"] }).success).toBe(false);
    }
  });
  it("refuses a move request to the same stage", () => {
    const s = eventPayloadSchemas["card.move_requested"]!;
    expect(s.safeParse({ cardId: "c1", runId: "r1", from: "build", to: "build" }).success).toBe(false);
    expect(s.safeParse({ cardId: "c1", runId: "r1", from: "build", to: "ship" }).success).toBe(true);
  });
  it("takes run links and declines, and refuses unknown keys", () => {
    expect(eventPayloadSchemas["card.run_linked"]!.safeParse({ cardId: "c1", runId: "r1" }).success).toBe(true);
    expect(eventPayloadSchemas["card.run_linked"]!.safeParse({ cardId: "c1", runId: "r1", x: 1 }).success).toBe(false);
    expect(eventPayloadSchemas["card.move_declined"]!.safeParse({ cardId: "c1", to: "ship" }).success).toBe(true);
    expect(eventPayloadSchemas["card.move_declined"]!.safeParse({ cardId: "c1", to: "moon" }).success).toBe(false);
  });
});

describe("commentStateLabel", () => {
  it("uses Ruling 7's words", () => {
    expect(commentStateLabel({ state: "given", adapter: "claude" })).toBe("Given to Claude");
    expect(commentStateLabel({ state: "read", adapter: "codex" })).toBe("Read by Codex");
    expect(commentStateLabel({ state: "waiting", adapter: null })).toBe("Waiting for the next run");
  });
});

describe("narration of board events", () => {
  const ctx = {
    cardTitle: (id: string) => (id === "c1" ? "Fix the form" : undefined),
    adapterName: (id: string) => (id === "r1" ? "claude" : undefined),
  };
  const entry = (type: string, payload: unknown, actor = { kind: "human", id: "owner" }): LedgerEntry =>
    ({ seq: 1, id: "e1", ts: "2026-11-17T00:00:00.000Z", projectId: "p1", actor, type, payload, prevHash: "", hash: "" }) as unknown as LedgerEntry;
  const say = (type: string, payload: unknown) => narrate(entry(type, payload), ctx);
  it("narrates each line", () => {
    expect(say("card.run_linked", { cardId: "c1", runId: "r1" }).headline).toBe("Claude took on “Fix the form”");
    expect(say("card.comment", comment).headline).toBe("Owner left a note on “Fix the form”");
    expect(say("card.comments_given", { cardId: "c1", runId: "r1", commentIds: ["a", "b"] }).headline).toBe(
      "2 notes on “Fix the form” were given to Claude",
    );
    expect(say("card.comments_given", { cardId: "c1", runId: "r1", commentIds: ["a"] }).headline).toBe(
      "1 note on “Fix the form” was given to Claude",
    );
    expect(say("card.comments_read", { cardId: "c1", runId: "r1", commentIds: ["a"] }).headline).toBe(
      "Claude read the notes on “Fix the form”",
    );
    expect(say("card.move_requested", { cardId: "c1", runId: "r1", from: "build", to: "ship" }).headline).toBe(
      "Claude wants to move “Fix the form” to Ship",
    );
    expect(say("card.move_declined", { cardId: "c1", to: "ship" }).headline).toBe(
      "Owner said not yet to moving “Fix the form” to Ship",
    );
  });
  it("files them under the board topic", () => {
    for (const [t, p] of [
      ["card.run_linked", { cardId: "c1", runId: "r1" }],
      ["card.comment", comment],
      ["card.move_declined", { cardId: "c1", to: "ship" }],
    ] as const)
      expect(say(t, p).topic).toBe("board");
  });
});
