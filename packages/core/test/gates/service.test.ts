import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { GATES, STAGES, type GateDecisionInput, type GateId, type LedgerEntry, type NewLedgerEntry } from "@theterminal/shared";
import { NotFoundError } from "../../src/board/board-service.js";
import { rebuildAllProjections } from "../../src/events/projections.js";
import { HumanRequiredError, SecretInTextError } from "../../src/intake/service.js";
import { GateBlockedError, GateNotMetError, GateRequirementError, GateService, stageHasEntryGates } from "../../src/gates/service.js";
import { commitEvents } from "../../src/events/commit.js";
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

describe("gate requirements (Review Focus 5)", () => {
  const p = (id: string) => ({ kind: "human", id }) as const;
  const reviewer = p("r1");
  const m1 = p("m1");
  const m2 = p("m2");
  const asReviewer = { personId: "r1", role: "reviewer" } as const;

  function join(personId: string, name: string, role: "viewer" | "reviewer" | "maintainer"): void {
    commitEvents(w.db, w.ledger, () => ({
      events: [
        {
          projectId: null, actor: human, type: "person.invited",
          payload: { inviteId: `i-${personId}`, role, codeHash: createHash("sha256").update(personId).digest("hex"), expiresAt: "2099-01-01T00:00:00.000Z" },
        },
        {
          projectId: null, actor: p(personId), type: "person.joined",
          payload: {
            personId, inviteId: `i-${personId}`, name, role,
            credential: { kind: "key", credentialId: `key-${personId}`, publicKey: `TESTKEY${personId}`, label: "CLI" },
          },
        },
      ] as NewLedgerEntry[],
      result: () => undefined,
    }));
  }
  const requirementRows = () => w.db.prepare("SELECT * FROM gate_requirements ORDER BY rowid").all();

  beforeEach(() => {
    join("r1", "Reviewer One", "reviewer");
    join("m1", "Maintainer One", "maintainer");
    join("m2", "Maintainer Two", "maintainer");
  });

  it("a reviewer signing go_live is GateRequirementError naming the gate and requirement; nothing recorded, card unmoved", () => {
    const id = card(w.planned, "ship");
    const head = w.ledger.headSeq();
    const err = caught(() => gates.move(reviewer, id, "operate", [signOff("go_live")]), GateRequirementError);
    expect(err.gateId).toBe("go_live");
    expect(err.requirement).toEqual({ role: "owner" });
    expect(w.ledger.headSeq()).toBe(head);
    expect(stageOf(id)).toBe("ship");
    // The same with the signer passed explicitly, and for a waiver.
    caught(() => gates.move(reviewer, id, "operate", [signOff("go_live")], asReviewer), GateRequirementError);
    expect(w.ledger.headSeq()).toBe(head);
  });

  it("a waiver by someone the requirement does not allow is refused before the reason is recorded", () => {
    const id = card(w.planned);
    finishedRun(w, w.planned, "r9", 10.01);
    const head = w.ledger.headSeq();
    const err = caught(() => gates.move(reviewer, id, "design", [waive("over_budget", "one more design pass")]), GateRequirementError);
    expect(err).toMatchObject({ gateId: "over_budget", requirement: { role: "owner" } });
    expect(w.ledger.headSeq()).toBe(head);
  });

  it("a named person only: another maintainer and the Owner are refused; back to the default, the reviewer signs", () => {
    const id = card(w.planned);
    const head = w.ledger.headSeq();
    gates.setRequirement(human, w.planned, "ready_to_ship", { personId: "m1" });
    const set = after(head);
    expect(set.map((e) => [e.type, e.projectId, e.actor])).toEqual([["gate.requirement_set", w.planned, human]]);
    expect(set[0]!.payload).toEqual({ gateId: "ready_to_ship", requirement: { personId: "m1" } });
    expect(requirementRows()).toHaveLength(1);

    const decisions = SHIP_GATES.map((g) => signOff(g as GateId));
    const head2 = w.ledger.headSeq();
    expect(caught(() => gates.move(m2, id, "ship", [signOff("ready_to_ship")]), GateRequirementError)).toMatchObject({
      gateId: "ready_to_ship", requirement: { personId: "m1" },
    });
    expect(caught(() => gates.move(human, id, "ship", decisions), GateRequirementError)).toMatchObject({
      gateId: "ready_to_ship", requirement: { personId: "m1" },
    });
    expect(w.ledger.headSeq()).toBe(head2);
    expect(stageOf(id)).toBe("build");

    gates.setRequirement(human, w.planned, "ready_to_ship", null);
    expect(after(head2).map((e) => [e.type, e.payload])).toEqual([
      ["gate.requirement_set", { gateId: "ready_to_ship", requirement: null }],
    ]);
    expect(requirementRows()).toEqual([]);

    // Only ready_to_ship is the reviewer's to sign; the Owner signs the other three first, so only it is left.
    gates.setRequirement(human, w.planned, "network_exposure", { role: "reviewer" });
    gates.setRequirement(human, w.planned, "payments", { role: "reviewer" });
    gates.setRequirement(human, w.planned, "personal_data", { role: "reviewer" });
    const head3 = w.ledger.headSeq();
    expect(gates.move(reviewer, id, "ship", decisions)).toMatchObject({ stage: "ship" });
    const added = after(head3);
    expect(added.map((e) => e.type)).toEqual([...SHIP_GATES.map(() => "gate.signed_off"), "card.moved"]);
    expect(added[0]!.payload).toMatchObject({ gateId: "ready_to_ship", signedBy: "r1" });
    expect(added.at(-1)!.actor).toEqual(reviewer);
  });

  it("the named person signs their gate", () => {
    const id = card(w.planned, "ship");
    gates.setRequirement(human, w.planned, "go_live", { personId: "m1" });
    expect(gates.move(m1, id, "operate", [signOff("go_live")])).toMatchObject({ stage: "operate" });
    expect(w.ledger.list().at(-2)!.payload).toMatchObject({ gateId: "go_live", signedBy: "m1" });
  });

  it("setRequirement refuses a removed or unknown person, an unknown project and gate, and a non-human", () => {
    commitEvents(w.db, w.ledger, () => ({
      events: [{ projectId: null, actor: human, type: "person.removed", payload: { personId: "m2" } }] as NewLedgerEntry[],
      result: () => undefined,
    }));
    const head = w.ledger.headSeq();
    expect(() => gates.setRequirement(human, w.planned, "go_live", { personId: "m2" })).toThrow(NotFoundError);
    expect(() => gates.setRequirement(human, w.planned, "go_live", { personId: "nobody" })).toThrow(NotFoundError);
    expect(() => gates.setRequirement(human, "nope", "go_live", { role: "owner" })).toThrow(NotFoundError);
    expect(() => gates.setRequirement(human, w.planned, "nowhere" as GateId, { role: "owner" })).toThrow(ZodError);
    expect(() => gates.setRequirement(human, w.planned, "go_live", { role: "boss" } as never)).toThrow(ZodError);
    expect(() => gates.setRequirement({ kind: "agent", id: "run-1" }, w.planned, "go_live", { role: "reviewer" })).toThrow(HumanRequiredError);
    expect(w.ledger.headSeq()).toBe(head);
  });

  it("a removed person cannot sign even a gate that names them", () => {
    const id = card(w.planned, "ship");
    gates.setRequirement(human, w.planned, "go_live", { personId: "m1" });
    commitEvents(w.db, w.ledger, () => ({
      events: [{ projectId: null, actor: human, type: "person.removed", payload: { personId: "m1" } }] as NewLedgerEntry[],
      result: () => undefined,
    }));
    const head = w.ledger.headSeq();
    caught(() => gates.move(m1, id, "operate", [signOff("go_live")]), GateRequirementError);
    expect(w.ledger.headSeq()).toBe(head);
  });

  it("evaluate for the reviewer: go_live not signable, ready_to_ship signable; requirements are the project's", () => {
    expect(gates.evaluate(card(w.planned, "ship"), "operate", asReviewer).map((g) => [g.id, g.requirement, g.signable])).toEqual([
      ["go_live", { role: "owner" }, false],
    ]);
    const id = card(w.planned);
    expect(gates.evaluate(id, "ship", asReviewer).find((g) => g.id === "ready_to_ship")).toMatchObject({ signable: true });
    gates.setRequirement(human, w.planned, "ready_to_ship", { personId: "m1" });
    expect(gates.evaluate(id, "ship", asReviewer)[0]).toMatchObject({ requirement: { personId: "m1" }, signable: false });
    expect(gates.evaluate(id, "ship", { personId: "m1", role: "maintainer" })[0]).toMatchObject({ signable: true });
    // Without a signer: judged for the Owner, who is not the named person.
    expect(gates.evaluate(id, "ship").map((g) => [g.id, g.signable])).toEqual([
      ["ready_to_ship", false], ["network_exposure", true], ["payments", true], ["personal_data", true],
    ]);
    // Another project keeps the default.
    finishedRun(w, w.bare, "rb", null);
    expect(gates.evaluate(card(w.bare), "ship")[0]).toMatchObject({ requirement: { role: "reviewer" }, signable: true });
  });

  it("a blocked move sends back evaluations judged for the signer; for a removed person, signable nowhere", () => {
    const id = card(w.planned);
    const err = caught(() => gates.move(reviewer, id, "ship"), GateBlockedError);
    expect(err.gates.map((g) => [g.id, g.signable])).toEqual([
      ["ready_to_ship", true], ["network_exposure", false], ["payments", false], ["personal_data", false],
    ]);
    gates.setRequirement(human, w.planned, "ready_to_ship", { role: "viewer" });
    commitEvents(w.db, w.ledger, () => ({
      events: [{ projectId: null, actor: human, type: "person.removed", payload: { personId: "r1" } }] as NewLedgerEntry[],
      result: () => undefined,
    }));
    expect(caught(() => gates.move(reviewer, id, "ship"), GateBlockedError).gates.every((g) => !g.signable)).toBe(true);
  });

  it("setting the same stored requirement again records nothing", () => {
    gates.setRequirement(human, w.planned, "go_live", { role: "maintainer" });
    const head = w.ledger.headSeq();
    gates.setRequirement(human, w.planned, "go_live", { role: "maintainer" });
    gates.setRequirement(human, w.planned, "payments", null);
    expect(w.ledger.headSeq()).toBe(head);
  });

  it("projections rebuild exactly, gate_requirements included", () => {
    const id = card(w.planned);
    gates.setRequirement(human, w.planned, "ready_to_ship", { personId: "m1" });
    gates.setRequirement(human, w.planned, "go_live", { role: "maintainer" });
    gates.setRequirement(human, w.planned, "ready_to_ship", null);
    gates.setRequirement(human, w.planned, "network_exposure", { role: "reviewer" });
    caught(() => gates.move(reviewer, id, "ship", SHIP_GATES.map((g) => signOff(g as GateId)), asReviewer), GateRequirementError);
    gates.move(human, id, "ship", SHIP_GATES.map((g) => signOff(g as GateId)));
    const tables = () => ({ ...snapshot(), gate_requirements: requirementRows() });
    const live = tables();
    rebuildAllProjections(w.db, w.ledger);
    expect(tables()).toEqual(live);
    expect(live.gate_requirements).toHaveLength(2);
  });
});
