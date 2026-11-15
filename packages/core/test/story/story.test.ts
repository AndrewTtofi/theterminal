import { beforeEach, describe, expect, it } from "vitest";
import { GATES, type LedgerEntry } from "@theterminal/shared";
import { NotFoundError } from "../../src/board/board-service.js";
import { cardStory, ledgerExportLines, narrationContext } from "../../src/story/story.js";
import { commitEvents } from "../../src/events/commit.js";
import { completeIntake, emit, finishedRun, human, world, type World } from "../gates/setup.js";

let w: World;
let cardId: string;

const all = (): LedgerEntry[] => w.ledger.list({ limit: 500 });
const payload = (e: LedgerEntry) => e.payload as Record<string, unknown>;

/** A run on `cardId` with one shell action, allowed (with output) or denied, finishing with `costUsd`. */
function runWithAction(runId: string, onCard: string, allow: boolean, costUsd: number | null): void {
  const p = w.planned;
  emit(w, p, "agent.started", { runId, adapter: "fake", authMode: "none", prompt: "go", cardId: onCard, worktree: `wt/${runId}` }, human);
  const actionId = `${runId}-a1`;
  emit(w, p, "agent.action.requested", {
    runId, actionId, kind: "shell", tool: "Bash", summary: "run the tests", input: { command: "npm test" },
  });
  emit(w, p, "agent.action.decided", {
    runId, actionId, decision: allow ? "allow" : "deny", by: "human", reason: allow ? "" : "not now",
  }, human);
  if (allow) emit(w, p, "agent.action.completed", { runId, actionId, ok: true, output: "tests passed\n" });
  emit(w, p, "agent.finished", { runId, status: "completed", costUsd, error: null });
}

beforeEach(() => {
  w = world();
  completeIntake(w, w.planned);
  cardId = w.board.addCard(human, w.planned, { title: "Checkout", stage: "build" }).id;
});

describe("cardStory", () => {
  it("tells a card's whole story in seq order: card events, both runs and the waiver", () => {
    const other = w.board.addCard(human, w.planned, { title: "Reading list", stage: "build" }).id;
    runWithAction("run-1", cardId, true, 0.25);
    runWithAction("run-other", other, true, 1);
    runWithAction("run-2", cardId, false, 0.5);
    const ack = GATES.find((g) => g.id === "ready_to_ship")!.acknowledgement;
    emit(w, w.planned, "gate.waived", {
      gateId: "ready_to_ship", cardId, from: "build", to: "ship", unmet: ["Tests have not been run"],
      reason: "A demo for the club tonight", acknowledgement: ack, waivedBy: "owner",
    }, human);
    emit(w, w.planned, "card.moved", { cardId, from: "build", to: "ship" }, human);

    const story = cardStory(w.db, w.ledger, cardId);

    expect(story.card).toMatchObject({ id: cardId, title: "Checkout", stage: "ship" });
    expect(story.runs.map((r) => r.id).sort()).toEqual(["run-1", "run-2"]);
    expect(story.actions.map((a) => [a.runId, a.status])).toEqual(
      expect.arrayContaining([["run-1", "completed"], ["run-2", "denied"]]),
    );
    expect(story.actions).toHaveLength(2);
    expect(story.costUsd).toBeCloseTo(0.75);
    expect(story.gateDecisions).toMatchObject([{ gateId: "ready_to_ship", kind: "waived", cardId }]);

    // Every entry about the card or its runs, and nothing else: no plan entries, since the plan did not list this card.
    const expected = all().filter((e) => {
      const p = payload(e);
      return p.cardId === cardId || p.runId === "run-1" || p.runId === "run-2";
    });
    expect(story.entries.map((e) => e.seq)).toEqual(expected.map((e) => e.seq));
    const seqs = story.entries.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    const types = story.entries.map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining([
      "card.created", "agent.started", "agent.action.requested",
      "agent.action.decided", "agent.action.completed", "agent.finished", "gate.waived", "card.moved",
    ]));
    expect(story.entries.some((e) => payload(e).runId === "run-other" || payload(e).cardId === other)).toBe(false);
    expect(types.filter((t) => t.startsWith("intake."))).toEqual([]);
  });

  it("includes the intake completion that planned the card, and only that intake's decisions up to it", () => {
    const planned = all().find((e) => e.type === "intake.completed")!;
    const plannedCard = (payload(planned).cards as { cardId: string }[])[0]!.cardId;
    // The other project's intake is not part of this card's story.
    completeIntake(w, w.bare);

    const story = cardStory(w.db, w.ledger, plannedCard);

    const decided = all().filter((e) => e.type === "intake.decided" && e.projectId === w.planned);
    expect(story.entries.filter((e) => e.type.startsWith("intake.")).map((e) => e.seq)).toEqual(
      [...decided.map((e) => e.seq), planned.seq],
    );
    expect(story.entries.map((e) => e.type)).toContain("card.created");
    expect(story.entries.map((e) => e.type)).not.toContain("intake.started");
    expect(story.entries.map((e) => e.type)).not.toContain("intake.answered");
    const seqs = story.entries.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(story.costUsd).toBeNull();
    expect(story.runs).toEqual([]);
  });

  it("pages through more entries than one page holds", () => {
    for (let i = 0; i < 260; i++) emit(w, w.planned, "card.moved", { cardId, from: "build", to: i % 2 ? "build" : "design" }, human);
    finishedRun(w, w.planned, "run-1", 0.1, cardId);
    for (let i = 0; i < 260; i++) emit(w, w.planned, "agent.message", { runId: "run-1", text: `line ${i}` });
    const story = cardStory(w.db, w.ledger, cardId);
    // card.created + 260 moves + started + finished + 260 messages
    expect(story.entries).toHaveLength(1 + 260 + 2 + 260);
    expect(story.costUsd).toBeCloseTo(0.1);
  });

  it("costUsd is null when no run reported a cost, and the sum of those that did otherwise", () => {
    finishedRun(w, w.planned, "run-1", null, cardId);
    expect(cardStory(w.db, w.ledger, cardId).costUsd).toBeNull();
    finishedRun(w, w.planned, "run-2", 0.4, cardId);
    expect(cardStory(w.db, w.ledger, cardId).costUsd).toBeCloseTo(0.4);
  });

  it("an unknown card is NotFoundError", () => {
    expect(() => cardStory(w.db, w.ledger, "nope")).toThrow(NotFoundError);
  });
});

describe("narrationContext", () => {
  it("knows card titles and adapter labels, and nothing it was not given", () => {
    finishedRun(w, w.planned, "run-1", 0.1, cardId);
    const ctx = narrationContext(w.db);
    expect(ctx.cardTitle!(cardId)).toBe("Checkout");
    expect(ctx.adapterName!("run-1")).toBe("Fake");
    expect(ctx.cardTitle!("nope")).toBeUndefined();
    expect(ctx.adapterName!("nope")).toBeUndefined();
  });
});

describe("ledgerExportLines", () => {
  const parse = (l: string) => JSON.parse(l) as Record<string, unknown>;

  it("stops at the header's headSeq even when entries are appended while it streams, and writes nothing", () => {
    const head = w.ledger.headSeq();
    const gen = ledgerExportLines(w.db, w.ledger, null, new Date("2026-11-15T00:00:00.000Z"));
    const header = parse(gen.next().value as string);
    expect(header).toEqual({
      kind: "header", exportedAt: "2026-11-15T00:00:00.000Z", projectId: null, headSeq: head, integrity: { ok: true, count: head },
    });
    const first = parse(gen.next().value as string);
    w.board.addCard(human, w.planned, { title: "Added during the export", stage: "build" });
    const rest = [...gen].map(parse);
    expect([first, ...rest].map((l) => l.seq)).toEqual(Array.from({ length: head }, (_, i) => i + 1));
    expect(w.ledger.headSeq()).toBe(head + 1); // only the card added above: the export appended nothing
    expect(rest.every((l) => l.kind === "entry" && typeof l.headline === "string")).toBe(true);
  });

  it("a project's export holds its entries and the connection.used entries of its runs, and nothing else", () => {
    finishedRun(w, w.planned, "run-club", 0.1, cardId);
    finishedRun(w, w.bare, "run-garden", 0.1);
    for (const runId of ["run-club", "run-garden"]) {
      commitEvents(w.db, w.ledger, () => ({
        events: [{
          projectId: null, actor: { kind: "system", id: "runner" }, type: "connection.used",
          payload: { connectionId: "conn-1", name: "Payments sandbox", runId, purpose: "api_key" },
        }],
        result: () => undefined,
      }));
    }
    const lines = [...ledgerExportLines(w.db, w.ledger, w.planned)].map(parse).slice(1);
    const expected = all().filter((e) => e.projectId === w.planned || (e.type === "connection.used" && payload(e).runId === "run-club"));
    expect(lines.map((l) => l.seq)).toEqual(expected.map((e) => e.seq));
    expect(lines.filter((l) => l.type === "connection.used")).toHaveLength(1);
  });

  it("pages through a ledger longer than one page", () => {
    for (let i = 0; i < 520; i++) emit(w, w.planned, "card.moved", { cardId, from: "build", to: i % 2 ? "build" : "design" }, human);
    const lines = [...ledgerExportLines(w.db, w.ledger, null)];
    expect(lines).toHaveLength(w.ledger.headSeq() + 1);
  });
});
