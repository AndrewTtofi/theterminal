import { beforeEach, describe, expect, it } from "vitest";
import { GATES, type GateId, type LedgerEntry } from "@theterminal/shared";
import { AgentCards } from "../../src/board/agent-cards.js";
import { NotFoundError, requireCard } from "../../src/board/board-service.js";
import { cardInfos, getRun, listCardComments, listMoveRequests, rebuildAllProjections } from "../../src/events/projections.js";
import { GateService } from "../../src/gates/service.js";
import { HumanRequiredError, RecordedText, SecretInTextError } from "../../src/intake/service.js";
import { completeIntake, emit, human, world, type World } from "../gates/setup.js";

const SECRET = "sk-ant-TESTKEY-0000000000";
const ANA = { name: "Ana", role: "maintainer" } as const;
const agentOf = (runId: string) => ({ kind: "agent", id: runId }) as const;

let w: World;
let gates: GateService;
let cards: AgentCards;
let ids: number;

beforeEach(() => {
  w = world();
  gates = new GateService({ db: w.db, ledger: w.ledger, username: "clubuser" });
  ids = 0;
  cards = new AgentCards({
    db: w.db, ledger: w.ledger, gates, board: w.board, recorded: new RecordedText({ username: "clubuser" }),
    newId: () => `id-${++ids}`,
  });
});

const start = (runId: string, projectId: string = w.bare, cardId: string | null = null, adapter = "claude") =>
  emit(w, projectId, "agent.started", { runId, adapter, authMode: "none", prompt: "go", cardId, worktree: `wt/${runId}` }, human);
const head = () => w.ledger.list({ afterSeq: 0 }).length;
const since = (seq: number): LedgerEntry[] => w.ledger.list({ afterSeq: seq });
const types = (seq: number) => since(seq).map((e) => e.type);
const cardOf = (runId: string) => getRun(w.db, runId)!.cardId!;
const ack = (id: GateId) => GATES.find((g) => g.id === id)!.acknowledgement;
function addNotes(cardId: string, n: number): string[] {
  return Array.from({ length: n }, (_, i) => cards.addComment(human, ANA, cardId, `Note ${i + 1}`).id);
}

describe("AgentCards.onCard", () => {
  it("creates a card in Plan with the agent as actor and links it to the run; a second card is ignored", () => {
    start("r1");
    const before = head();
    cards.onCard("r1", "Fix");
    const entries = since(before);
    expect(entries.map((e) => [e.type, e.actor])).toEqual([
      ["card.created", agentOf("r1")],
      ["card.run_linked", agentOf("r1")],
    ]);
    const cardId = cardOf("r1");
    expect(entries[0]!.payload).toEqual({ cardId, title: "Fix", stage: "plan" });
    expect(entries[1]!.payload).toEqual({ cardId, runId: "r1" });
    expect(requireCard(w.db, cardId)).toMatchObject({ projectId: w.bare, title: "Fix", stage: "plan" });
    const after = head();
    cards.onCard("r1", "Other");
    expect(head()).toBe(after);
  });

  it("is ignored for a run that already has a card, and for an unknown run", () => {
    const c = w.board.addCard(human, w.bare, { title: "Existing", stage: "plan" }).id;
    start("r1", w.bare, c);
    const before = head();
    cards.onCard("r1", "Fix");
    cards.onCard("nope", "Fix");
    expect(head()).toBe(before);
  });

  it("the title never carries a secret or a hidden control", () => {
    start("r1");
    cards.onCard("r1", `Fix ${SECRET}‮`);
    const title = requireCard(w.db, cardOf("r1")).title;
    expect(title).not.toContain("TESTKEY");
    expect(title).toContain("\\u202e");
  });
});

describe("AgentCards.onStage", () => {
  it("a move the plan gate holds becomes one request, not a move", () => {
    start("r1");
    cards.onCard("r1", "Fix");
    const before = head();
    cards.onStage("r1", "design");
    expect(types(before)).toEqual(["card.move_requested"]);
    expect(since(before)[0]!).toMatchObject({
      actor: agentOf("r1"), payload: { cardId: cardOf("r1"), runId: "r1", from: "plan", to: "design" },
    });
    const after = head();
    cards.onStage("r1", "design");
    expect(head()).toBe(after);
    expect(listMoveRequests(w.db)).toHaveLength(1);
    expect(requireCard(w.db, cardOf("r1")).stage).toBe("plan");
  });

  it("with the intake complete the move happens with the agent as actor, and clears the request", () => {
    start("r1");
    cards.onCard("r1", "Fix");
    cards.onStage("r1", "design");
    expect(listMoveRequests(w.db)).toHaveLength(1);
    completeIntake(w, w.bare);
    const before = head();
    cards.onStage("r1", "design");
    const moved = since(before).filter((e) => e.type === "card.moved");
    expect(moved).toHaveLength(1);
    expect(moved[0]!.actor).toEqual(agentOf("r1"));
    expect(requireCard(w.db, cardOf("r1")).stage).toBe("design");
    expect(listMoveRequests(w.db)).toEqual([]);
  });

  it("does nothing without a card or when the card is already there", () => {
    start("r1");
    const before = head();
    cards.onStage("r1", "design");
    cards.onCard("r1", "Fix");
    const linked = head();
    cards.onStage("r1", "plan");
    expect(head()).toBe(linked);
    expect(linked - before).toBe(2);
  });

  it("a request to Ship is cleared when a human moves the card there with the sign-offs", () => {
    completeIntake(w, w.planned);
    start("r1", w.planned);
    cards.onCard("r1", "Checkout");
    cards.onStage("r1", "design");
    cards.onStage("r1", "build");
    expect(requireCard(w.db, cardOf("r1")).stage).toBe("build");
    const before = head();
    cards.onStage("r1", "ship");
    expect(types(before)).toEqual(["card.move_requested"]);
    expect(listMoveRequests(w.db)).toMatchObject([{ cardId: cardOf("r1"), from: "build", to: "ship", runId: "r1", adapter: "claude" }]);
    // The run ends first: Ship's readiness gate holds while a run still works on the card.
    emit(w, w.planned, "agent.finished", { runId: "r1", status: "completed", costUsd: 0, error: null });
    const signOffs = gates.evaluate(cardOf("r1"), "ship").filter((g) => g.outcome !== "pass")
      .map((g) => ({ gateId: g.id, decision: "sign_off" as const, acknowledgement: ack(g.id) }));
    gates.move(human, cardOf("r1"), "ship", signOffs);
    expect(requireCard(w.db, cardOf("r1")).stage).toBe("ship");
    expect(listMoveRequests(w.db)).toEqual([]);
  });

  it("a HumanRequiredError from a race also records the request", () => {
    start("r1");
    cards.onCard("r1", "Fix");
    const racing = new AgentCards({
      db: w.db, ledger: w.ledger, board: w.board, recorded: new RecordedText({ username: "clubuser" }),
      gates: { evaluate: () => [], move: () => { throw new HumanRequiredError(); } },
    });
    const before = head();
    racing.onStage("r1", "design");
    expect(types(before)).toEqual(["card.move_requested"]);
  });
});

describe("AgentCards.onDone", () => {
  it("marks the card done once without moving it", () => {
    start("r1");
    cards.onCard("r1", "Fix");
    const before = head();
    cards.onDone("r1");
    cards.onDone("r1");
    expect(since(before).map((e) => [e.type, e.actor, (e.payload as { to: string }).to])).toEqual([
      ["card.status_changed", agentOf("r1"), "done"],
    ]);
    expect(requireCard(w.db, cardOf("r1"))).toMatchObject({ status: "done", stage: "plan" });
  });

  it("does nothing without a card", () => {
    start("r1");
    const before = head();
    cards.onDone("r1");
    expect(head()).toBe(before);
  });
});

describe("AgentCards.addComment", () => {
  let c: string;
  beforeEach(() => {
    c = w.board.addCard(human, w.bare, { title: "Fix", stage: "plan" }).id;
  });

  it("clips the text to 2,000 characters and escapes hidden controls", () => {
    const long = cards.addComment(human, ANA, c, "a".repeat(2500));
    expect(long.text).toHaveLength(2000);
    const bidi = cards.addComment(human, ANA, c, "look ‮ here");
    expect(bidi.text).toBe("look \\u202e here");
    expect(bidi).toMatchObject({ cardId: c, authorName: "Ana", role: "maintainer", state: "waiting", runId: null, adapter: null });
    const entry = since(0).filter((e) => e.type === "card.comment").at(-1)!;
    expect(entry.actor).toEqual(human);
    expect(entry.payload).toEqual({ commentId: bidi.id, cardId: c, text: "look \\u202e here", authorName: "Ana", role: "maintainer" });
  });

  it("refuses a secret, an agent actor and an unknown card, recording nothing", () => {
    const before = head();
    expect(() => cards.addComment(human, ANA, c, `key ${SECRET}`)).toThrow(SecretInTextError);
    expect(() => cards.addComment(agentOf("r1"), ANA, c, "hello")).toThrow(HumanRequiredError);
    expect(() => cards.addComment(human, ANA, "missing", "hello")).toThrow(NotFoundError);
    expect(head()).toBe(before);
  });
});

describe("AgentCards.notesFor", () => {
  it("gives the 20 oldest waiting notes as lines naming the author and role", () => {
    const c = w.board.addCard(human, w.bare, { title: "Fix", stage: "plan" }).id;
    expect(cards.notesFor(c)).toBeNull();
    const noteIds = addNotes(c, 25);
    const notes = cards.notesFor(c)!;
    expect(notes.ids).toEqual(noteIds.slice(0, 20));
    expect(notes.lines[0]).toBe("Note from Ana (Maintainer): Note 1");
    expect(notes.lines[19]).toBe("Note from Ana (Maintainer): Note 20");
  });
});

describe("AgentCards.onNoted", () => {
  it("marks the notes given to that run read, once; notes given to another run stay given", () => {
    const c = w.board.addCard(human, w.bare, { title: "Fix", stage: "plan" }).id;
    start("r1", w.bare, c);
    start("r2", w.bare, c, "codex");
    const [n1, n2, n3] = addNotes(c, 3);
    emit(w, w.bare, "card.comments_given", { cardId: c, runId: "r1", commentIds: [n1, n2] });
    emit(w, w.bare, "card.comments_given", { cardId: c, runId: "r2", commentIds: [n3] });
    const before = head();
    cards.onNoted("r1");
    cards.onNoted("r1");
    expect(since(before).map((e) => [e.type, e.actor, e.payload])).toEqual([
      ["card.comments_read", agentOf("r1"), { cardId: c, runId: "r1", commentIds: [n1, n2] }],
    ]);
    expect(listCardComments(w.db, c).map((x) => [x.id, x.state, x.runId])).toEqual([
      [n1, "read", "r1"], [n2, "read", "r1"], [n3, "given", "r2"],
    ]);
  });

  it("does nothing for a run given no notes", () => {
    start("r1");
    const before = head();
    cards.onNoted("r1");
    expect(head()).toBe(before);
  });
});

describe("AgentCards.declineMove", () => {
  it("records card.move_declined for the pending request and clears it", () => {
    start("r1");
    cards.onCard("r1", "Fix");
    cards.onStage("r1", "design");
    const before = head();
    cards.declineMove(human, cardOf("r1"));
    expect(since(before).map((e) => [e.type, e.actor, e.payload])).toEqual([
      ["card.move_declined", human, { cardId: cardOf("r1"), to: "design" }],
    ]);
    expect(listMoveRequests(w.db)).toEqual([]);
    expect(() => cards.declineMove(human, cardOf("r1"))).toThrow(NotFoundError);
  });

  it("is a human's decision", () => {
    start("r1");
    cards.onCard("r1", "Fix");
    cards.onStage("r1", "design");
    expect(() => cards.declineMove(agentOf("r1"), cardOf("r1"))).toThrow(HumanRequiredError);
    expect(listMoveRequests(w.db)).toHaveLength(1);
  });
});

describe("notes and requests across a rebuild", () => {
  it("notes keep their state across rebuild", () => {
    const c = w.board.addCard(human, w.bare, { title: "Fix", stage: "plan" }).id;
    start("r1", w.bare, c);
    const [n1, n2] = addNotes(c, 3);
    emit(w, w.bare, "card.comments_given", { cardId: c, runId: "r1", commentIds: [n1, n2] });
    emit(w, w.bare, "card.comments_read", { cardId: c, runId: "r1", commentIds: [n1] });
    start("r2");
    cards.onCard("r2", "Other");
    cards.onStage("r2", "design");
    const comments = listCardComments(w.db, c);
    expect(comments.map((x) => x.state)).toEqual(["read", "given", "waiting"]);
    const requests = listMoveRequests(w.db);
    expect(requests).toHaveLength(1);
    const infos = cardInfos(w.db, w.bare);
    rebuildAllProjections(w.db, w.ledger);
    expect(listCardComments(w.db, c)).toEqual(comments);
    expect(listMoveRequests(w.db)).toEqual(requests);
    expect(cardInfos(w.db, w.bare)).toEqual(infos);
  });
});

describe("cardInfos", () => {
  it("shows the latest run's percent, the note counts and the move request", () => {
    completeIntake(w, w.planned);
    start("r1", w.planned);
    cards.onCard("r1", "Checkout");
    cards.onStage("r1", "design");
    cards.onStage("r1", "build");
    cards.onStage("r1", "ship");
    const c = cardOf("r1");
    emit(w, w.planned, "agent.progress", { runId: "r1", steps: ["One", "Two", "Three"], done: [1], current: 2 });
    const [n1] = addNotes(c, 2);
    emit(w, w.planned, "card.comments_given", { cardId: c, runId: "r1", commentIds: [n1] });
    const info = cardInfos(w.db, w.planned).find((i) => i.cardId === c)!;
    expect(info).toMatchObject({
      runId: "r1", adapter: "claude", runStatus: "running", percent: 33, waiting: false,
      comments: 2, commentsWaiting: 1, screenshots: 0, moveRequest: { to: "ship" },
    });
  });
});
