import { beforeEach, describe, expect, it } from "vitest";
import type { ConditionId, GateFacts } from "@theterminal/shared";
import { evaluateConditions, gateFacts } from "../../src/gates/conditions.js";
import { ANSWERS, completeIntake, emit, finishedRun, human, world, type World } from "./setup.js";

let w: World;
let cardId: string;

beforeEach(() => {
  w = world();
  cardId = w.board.addCard(human, w.planned, { title: "Checkout", stage: "build" }).id;
});

const one = (id: ConditionId, facts: GateFacts, projectId = w.planned, decisions = {}) =>
  evaluateConditions(w.db, [id], { projectId, cardId, facts, decisions })[0]!;
const FACTS: GateFacts = { intakeCompleted: true, budgetUsd: 10, spendUsd: 0 };

describe("gateFacts", () => {
  it("is empty without an intake", () => {
    expect(gateFacts(w.db, w.bare)).toEqual({
      answers: {}, decisions: {}, facts: { intakeCompleted: false, budgetUsd: null, spendUsd: 0 },
    });
  });

  it("reads the answers, decisions and budget from the intake and the spend from the project's runs", () => {
    completeIntake(w, w.planned);
    finishedRun(w, w.planned, "r1", 2.5);
    finishedRun(w, w.planned, "r2", null);
    finishedRun(w, w.bare, "r3", 7);
    const got = gateFacts(w.db, w.planned);
    expect(got.answers).toEqual(ANSWERS);
    expect(got.decisions).toMatchObject({ payments_scope: "provider", exposure_protection: "login", data_handling: "minimum" });
    expect(got.facts).toEqual({ intakeCompleted: true, budgetUsd: 10, spendUsd: 2.5 });
  });

  it("an open intake is not completed", () => {
    w.intake.start(human, w.planned, "A reading list for a book club");
    expect(gateFacts(w.db, w.planned).facts.intakeCompleted).toBe(false);
  });
});

describe("evaluateConditions", () => {
  it("returns one result per id, in order, with the catalog label", () => {
    const got = evaluateConditions(w.db, ["intake_completed", "no_pending_actions"], {
      projectId: w.planned, cardId, facts: FACTS, decisions: {},
    });
    expect(got.map((c) => [c.id, c.label, c.met])).toEqual([
      ["intake_completed", "The plan has been approved", true],
      ["no_pending_actions", "No agent is waiting for a decision in this project", true],
    ]);
  });

  it("intake_completed", () => {
    expect(one("intake_completed", FACTS)).toMatchObject({ met: true, detail: null });
    expect(one("intake_completed", { ...FACTS, intakeCompleted: false }, w.bare)).toMatchObject({
      met: false, detail: "No plan has been written for this project yet",
    });
    w.intake.start(human, w.planned, "A reading list for a book club");
    expect(one("intake_completed", { ...FACTS, intakeCompleted: false })).toMatchObject({
      met: false, detail: "The plan is written but not approved yet",
    });
  });

  it("no_pending_actions counts pending actions anywhere in the project", () => {
    expect(one("no_pending_actions", FACTS)).toMatchObject({ met: true, detail: null });
    emit(w, w.planned, "agent.started", { runId: "r1", adapter: "fake", authMode: "none", prompt: "go", cardId: null, worktree: "wt/r1" }, human);
    for (const a of ["a1", "a2"]) {
      emit(w, w.planned, "agent.action.requested", { runId: "r1", actionId: a, kind: "shell", tool: "Bash", summary: "ls", input: null });
    }
    expect(one("no_pending_actions", FACTS)).toMatchObject({ met: false, detail: "2 decisions are waiting" });
    expect(one("no_pending_actions", FACTS, w.bare)).toMatchObject({ met: true });
  });

  it("no_running_runs_on_card counts only this card's running runs", () => {
    finishedRun(w, w.planned, "done", 1, cardId);
    emit(w, w.planned, "agent.started", { runId: "other", adapter: "fake", authMode: "none", prompt: "go", cardId: null, worktree: "wt/o" }, human);
    expect(one("no_running_runs_on_card", FACTS)).toMatchObject({ met: true, detail: null });
    emit(w, w.planned, "agent.started", { runId: "r1", adapter: "fake", authMode: "none", prompt: "go", cardId, worktree: "wt/r1" }, human);
    expect(one("no_running_runs_on_card", FACTS)).toMatchObject({ met: false, detail: "1 agent run is still running" });
  });

  it("decision_made names the chosen option, from the catalog", () => {
    expect(one("decision_made:payments_scope", FACTS)).toMatchObject({
      label: "You have decided: How should payments be handled?", met: false, detail: null,
    });
    expect(one("decision_made:payments_scope", FACTS, w.planned, { payments_scope: "provider" })).toMatchObject({
      met: true, detail: "Chosen: A payment provider's hosted checkout: card details never touch your product",
    });
  });

  it("within_budget: met and unmet, always saying it includes estimates and counting runs with no cost", () => {
    expect(one("within_budget", { ...FACTS, spendUsd: 10 })).toEqual({
      id: "within_budget",
      label: "Agent spend is within the budget you set ($10.00 of $10.00)",
      met: true,
      detail: "Includes estimates.",
    });
    expect(one("within_budget", { ...FACTS, spendUsd: 10.01 })).toEqual({
      id: "within_budget",
      label: "Agent spend is within the budget you set ($10.01 of $10.00)",
      met: false,
      detail: "Over by $0.01. Includes estimates.",
    });
    finishedRun(w, w.planned, "r1", null);
    finishedRun(w, w.planned, "r2", null);
    finishedRun(w, w.bare, "r3", null);
    expect(one("within_budget", { ...FACTS, spendUsd: 10.01 }).detail).toBe(
      "Over by $0.01. Includes estimates. 2 runs reported no cost, so the real spend may be higher.",
    );
  });

  it("within_budget without a budget", () => {
    expect(one("within_budget", { ...FACTS, budgetUsd: null, spendUsd: 3 })).toEqual({
      id: "within_budget", label: "No budget has been set", met: true, detail: null,
    });
  });
});
