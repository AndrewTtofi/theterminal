import { beforeEach, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { GATES, STAGES, type GateDecisionInput, type GateId, type LedgerEntry } from "@theterminal/shared";
import { NotFoundError } from "../../src/board/board-service.js";
import { rebuildAllProjections } from "../../src/events/projections.js";
import { HumanRequiredError, SecretInTextError } from "../../src/intake/service.js";
import { GateBlockedError, GateNotMetError, GateService, stageHasEntryGates } from "../../src/gates/service.js";
import { completeIntake, emit, finishedRun, human, world, type World } from "./setup.js";

const SECRET = "sk-ant-TESTKEY-0000000000";
const SHIP_GATES = ["ready_to_ship", "network_exposure", "payments", "personal_data"];

let w: World;
let gates: GateService;

beforeEach(() => {
  w = world();
  gates = new GateService({ db: w.db, ledger: w.ledger, username: "clubuser" });
  completeIntake(w, w.planned);
});

const ack = (id: GateId) => GATES.find((g) => g.id === id)!.acknowledgement;
const signOff = (id: GateId): GateDecisionInput => ({ gateId: id, decision: "sign_off", acknowledgement: ack(id) });
const waive = (id: GateId, reason: string): GateDecisionInput => ({ gateId: id, decision: "waive", reason, acknowledgement: ack(id) });
const card = (projectId: string, stage: "plan" | "design" | "build" | "ship" = "build") =>
  w.board.addCard(human, projectId, { title: "Checkout", stage }).id;
const after = (seq: number): LedgerEntry[] => w.ledger.list({ afterSeq: seq });
const stageOf = (id: string) => (w.db.prepare("SELECT stage FROM cards WHERE id = ?").get(id) as { stage: string }).stage;
function caught<T extends Error>(fn: () => unknown, type: new (...a: never[]) => T): T {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(type);
    return e as T;
  }
  throw new Error("expected a throw");
}
function snapshot() {
  const tables = ["cards", "projects", "agent_runs", "agent_actions", "intakes", "intake_answers", "intake_decisions", "gate_decisions"];
  return Object.fromEntries(tables.map((t) => [t, w.db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()]));
}

describe("stageHasEntryGates", () => {
  it("is true for Ship and Operate only: the stages a gate stands in front of whatever the card comes from", () => {
    expect(STAGES.filter(stageHasEntryGates)).toEqual(["ship", "operate"]);
  });
});

describe("GateService.evaluate", () => {
  it("a move to Ship for the planned project raises four gates; the payments gate among them", () => {
    const got = gates.evaluate(card(w.planned), "ship");
    expect(got.map((g) => [g.id, g.outcome])).toEqual([
      ["ready_to_ship", "needs_sign_off"],
      ["network_exposure", "needs_sign_off"],
      ["payments", "needs_sign_off"],
      ["personal_data", "needs_sign_off"],
    ]);
    const payments = got[2]!;
    expect(payments).toMatchObject({ title: "Taking payments", acknowledgement: ack("payments"), signOff: true, met: true });
    expect(payments.conditions).toEqual([
      {
        id: "decision_made:payments_scope",
        label: "You have decided: How should payments be handled?",
        met: true,
        detail: "Chosen: A payment provider's hosted checkout: card details never touch your product",
      },
    ]);
  });

  it("carries each gate's default requirement, signable by the Owner until requirements are recorded", () => {
    const got = gates.evaluate(card(w.planned), "ship");
    expect(got.map((g) => [g.id, g.requirement, g.signable])).toEqual([
      ["ready_to_ship", { role: "reviewer" }, true],
      ["network_exposure", { role: "owner" }, true],
      ["payments", { role: "owner" }, true],
      ["personal_data", { role: "owner" }, true],
    ]);
  });

  it("without an intake, ready_to_ship is blocked on the plan", () => {
    const got = gates.evaluate(card(w.bare), "ship");
    expect(got.map((g) => g.id)).toEqual(["ready_to_ship"]);
    expect(got[0]).toMatchObject({ outcome: "blocked", met: false });
    expect(got[0]!.conditions.filter((c) => !c.met).map((c) => c.id)).toEqual(["intake_completed"]);
  });

  it("is empty for the card's own stage, NotFoundError for an unknown card, ZodError for an unknown stage", () => {
    expect(gates.evaluate(card(w.planned), "build")).toEqual([]);
    expect(() => gates.evaluate("nope", "ship")).toThrow(NotFoundError);
    expect(() => gates.evaluate(card(w.planned), "nowhere" as never)).toThrow(ZodError);
  });

  it("records nothing", () => {
    const id = card(w.planned);
    const head = w.ledger.headSeq();
    gates.evaluate(id, "ship");
    expect(w.ledger.headSeq()).toBe(head);
  });
});

describe("GateService.move", () => {
  it("without decisions: one gate.blocked listing every unresolved gate, no card.moved, then GateBlockedError", () => {
    const id = card(w.planned);
    const head = w.ledger.headSeq();
    const err = caught(() => gates.move(human, id, "ship"), GateBlockedError);
    expect(err.gates.map((g) => g.id)).toEqual(SHIP_GATES);
    const added = after(head);
    expect(added.map((e) => e.type)).toEqual(["gate.blocked"]);
    expect(added[0]).toMatchObject({ projectId: w.planned, actor: human });
    expect(added[0]!.payload).toEqual({
      cardId: id, from: "build", to: "ship",
      gates: SHIP_GATES.map((gateId) => ({ gateId, outcome: "needs_sign_off", unmet: [] })),
    });
    expect(stageOf(id)).toBe("build");
  });

  it("four sign-offs with the exact sentences: four gate.signed_off then card.moved, consecutive, card in Ship", () => {
    const id = card(w.planned);
    const head = w.ledger.headSeq();
    const moved = gates.move(human, id, "ship", SHIP_GATES.map((g) => signOff(g as GateId)));
    expect(moved).toMatchObject({ id, stage: "ship" });
    const added = after(head);
    expect(added.map((e) => e.type)).toEqual([...SHIP_GATES.map(() => "gate.signed_off"), "card.moved"]);
    expect(added.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5].map((n) => head + n));
    for (const e of added) expect(e.projectId).toBe(w.planned);
    expect(added[0]!.payload).toEqual({
      gateId: "ready_to_ship", cardId: id, from: "build", to: "ship",
      conditions: ["intake_completed", "no_pending_actions", "no_running_runs_on_card"],
      acknowledgement: ack("ready_to_ship"), signedBy: "owner",
    });
    expect(added[2]!.payload).toMatchObject({ gateId: "payments", conditions: ["decision_made:payments_scope"] });
    expect(w.db.prepare("SELECT gate_id, kind, project_id FROM gate_decisions ORDER BY rowid").all()).toEqual(
      SHIP_GATES.map((g) => ({ gate_id: g, kind: "signed_off", project_id: w.planned })),
    );
  });

  it("three sign-offs of four: blocked by the one left, and nothing but gate.blocked is recorded", () => {
    const id = card(w.planned);
    const head = w.ledger.headSeq();
    const err = caught(() => gates.move(human, id, "ship", SHIP_GATES.slice(0, 3).map((g) => signOff(g as GateId))), GateBlockedError);
    expect(err.gates).toHaveLength(4);
    const added = after(head);
    expect(added.map((e) => e.type)).toEqual(["gate.blocked"]);
    expect((added[0]!.payload as { gates: unknown[] }).gates).toEqual([{ gateId: "personal_data", outcome: "needs_sign_off", unmet: [] }]);
  });

  it("a sign-off for a blocked gate is GateNotMetError and records nothing", () => {
    const id = card(w.bare);
    const head = w.ledger.headSeq();
    const err = caught(() => gates.move(human, id, "ship", [signOff("ready_to_ship")]), GateNotMetError);
    expect(err.gateId).toBe("ready_to_ship");
    expect(err.unmet).toEqual(["intake_completed"]);
    expect(w.ledger.headSeq()).toBe(head);
  });

  it("a waiver needs a reason of at least 10 characters; with one, gate.waived then card.moved", () => {
    const id = card(w.bare);
    const head = w.ledger.headSeq();
    expect(() => gates.move(human, id, "ship", [waive("ready_to_ship", "deadline")])).toThrow(ZodError);
    expect(w.ledger.headSeq()).toBe(head);
    gates.move(human, id, "ship", [waive("ready_to_ship", "  club demo!!  ")]);
    const added = after(head);
    expect(added.map((e) => e.type)).toEqual(["gate.waived", "card.moved"]);
    expect(added[0]).toMatchObject({ projectId: w.bare });
    expect(added[0]!.payload).toEqual({
      gateId: "ready_to_ship", cardId: id, from: "build", to: "ship", unmet: ["intake_completed"],
      reason: "club demo!!", acknowledgement: ack("ready_to_ship"), waivedBy: "owner",
    });
  });

  it("refuses a wrong sentence, a reason on a sign-off, two decisions for one gate and more than ten", () => {
    const id = card(w.planned);
    const head = w.ledger.headSeq();
    const bad: GateDecisionInput[][] = [
      [{ ...signOff("payments"), acknowledgement: ack("ready_to_ship") }],
      [{ ...signOff("payments"), reason: "because I said so" }],
      [signOff("payments"), signOff("payments")],
      Array.from({ length: 11 }, () => signOff("payments")),
    ];
    for (const d of bad) expect(() => gates.move(human, id, "ship", d)).toThrow(ZodError);
    expect(w.ledger.headSeq()).toBe(head);
  });

  it("a waiver for a gate whose conditions hold is not a decision: the move is blocked", () => {
    const id = card(w.planned);
    const head = w.ledger.headSeq();
    const decisions = [...SHIP_GATES.slice(1).map((g) => signOff(g as GateId)), waive("ready_to_ship", "a reason long enough")];
    const err = caught(() => gates.move(human, id, "ship", decisions), GateBlockedError);
    expect(err.gates.map((g) => g.id)).toEqual(SHIP_GATES);
    const added = after(head);
    expect(added.map((e) => e.type)).toEqual(["gate.blocked"]);
    expect((added[0]!.payload as { gates: unknown }).gates).toEqual([{ gateId: "ready_to_ship", outcome: "needs_sign_off", unmet: [] }]);
  });

  it("a decision for a gate that does not apply is ignored and not recorded", () => {
    const id = card(w.planned, "plan");
    const head = w.ledger.headSeq();
    gates.move(human, id, "build", [signOff("payments"), waive("over_budget", "not over budget at all")]);
    expect(after(head).map((e) => e.type)).toEqual(["card.moved"]);
  });

  it("a non-human actor is refused when any gate needs a decision, before anything is recorded", () => {
    const id = card(w.planned);
    const head = w.ledger.headSeq();
    const system = { kind: "system", id: "runner" } as const;
    expect(() => gates.move(system, id, "ship", SHIP_GATES.map((g) => signOff(g as GateId)))).toThrow(HumanRequiredError);
    expect(() => gates.move(system, id, "ship")).toThrow(HumanRequiredError);
    // The actor is checked first: a reason that would be refused as a secret still answers HumanRequiredError.
    expect(() => gates.move(system, id, "ship", [waive("ready_to_ship", `demo ${SECRET}`)])).toThrow(HumanRequiredError);
    expect(w.ledger.headSeq()).toBe(head);
    // A move no gate stops is not a decision.
    gates.move(system, id, "design");
    expect(after(head).map((e) => e.type)).toEqual(["card.moved"]);
  });

  it("from Plan: blocked by plan_approved alone without an intake; passes silently with one", () => {
    const bare = card(w.bare, "plan");
    const head = w.ledger.headSeq();
    const err = caught(() => gates.move(human, bare, "build"), GateBlockedError);
    expect(err.gates.map((g) => [g.id, g.outcome])).toEqual([["plan_approved", "blocked"]]);
    expect((after(head)[0]!.payload as { gates: unknown }).gates).toEqual([
      { gateId: "plan_approved", outcome: "blocked", unmet: ["intake_completed"] },
    ]);
    const planned = card(w.planned, "plan");
    const head2 = w.ledger.headSeq();
    expect(gates.move(human, planned, "build")).toMatchObject({ stage: "build" });
    expect(after(head2).map((e) => e.type)).toEqual(["card.moved"]);
  });

  it("the same stage records nothing and returns the card; an unknown card is NotFoundError", () => {
    const id = card(w.planned);
    const head = w.ledger.headSeq();
    expect(gates.move(human, id, "build")).toMatchObject({ id, stage: "build" });
    expect(w.ledger.headSeq()).toBe(head);
    expect(() => gates.move(human, "nope", "ship")).toThrow(NotFoundError);
  });

  it("over_budget applies to any move once spend passes the budget, and can only be waived", () => {
    const id = card(w.planned);
    finishedRun(w, w.planned, "r1", 10.01);
    const got = gates.evaluate(id, "design");
    expect(got.map((g) => [g.id, g.outcome])).toEqual([["over_budget", "blocked"]]);
    expect(got[0]!.conditions[0]).toMatchObject({ met: false, detail: "Over by $0.01. Includes estimates." });
    caught(() => gates.move(human, id, "design", [signOff("over_budget")]), GateNotMetError);
    const head = w.ledger.headSeq();
    gates.move(human, id, "design", [waive("over_budget", "one more design pass")]);
    expect(after(head).map((e) => e.type)).toEqual(["gate.waived", "card.moved"]);
    expect(after(head)[0]!.payload).toMatchObject({ gateId: "over_budget", unmet: ["within_budget"] });
  });

  it("conditions are checked at the move: a sign-off whose conditions stopped holding is refused", () => {
    const id = card(w.planned);
    expect(gates.evaluate(id, "operate").map((g) => [g.id, g.outcome])).toEqual([["go_live", "needs_sign_off"]]);
    emit(w, w.planned, "agent.started", { runId: "r1", adapter: "fake", authMode: "none", prompt: "go", cardId: id, worktree: "wt/r1" }, human);
    emit(w, w.planned, "agent.action.requested", { runId: "r1", actionId: "a1", kind: "shell", tool: "Bash", summary: "ls", input: null });
    const head = w.ledger.headSeq();
    const err = caught(() => gates.move(human, id, "operate", [signOff("go_live")]), GateNotMetError);
    expect(err.gateId).toBe("go_live");
    expect(err.unmet).toContain("no_pending_actions");
    expect(w.ledger.headSeq()).toBe(head);
    emit(w, w.planned, "agent.action.decided", { runId: "r1", actionId: "a1", decision: "deny", by: "human", reason: "" }, human);
    emit(w, w.planned, "agent.finished", { runId: "r1", status: "completed", costUsd: 0.5, error: null });
    expect(gates.move(human, id, "operate", [signOff("go_live")])).toMatchObject({ stage: "operate" });
  });

  it("a waiver reason holding a secret is refused and nothing is recorded; paths are scrubbed", () => {
    const id = card(w.bare);
    const head = w.ledger.headSeq();
    expect(() => gates.move(human, id, "ship", [waive("ready_to_ship", `demo with ${SECRET}`)])).toThrow(SecretInTextError);
    expect(w.ledger.headSeq()).toBe(head);
    gates.move(human, id, "ship", [waive("ready_to_ship", "a demo for clubuser only")]);
    expect(after(head)[0]!.payload).toMatchObject({ reason: "a demo for <user> only" });
  });

  it("projections rebuild exactly from the ledger after the sequence", () => {
    const a = card(w.planned);
    const b = card(w.bare);
    caught(() => gates.move(human, a, "ship"), GateBlockedError);
    gates.move(human, a, "ship", SHIP_GATES.map((g) => signOff(g as GateId)));
    gates.move(human, b, "ship", [waive("ready_to_ship", "a demo for the club")]);
    const live = snapshot();
    rebuildAllProjections(w.db, w.ledger);
    expect(snapshot()).toEqual(live);
    expect(live.gate_decisions).toHaveLength(5);
  });
});
