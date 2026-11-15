import { describe, expect, it } from "vitest";
import {
  GATES,
  GATE_IDS,
  applicableGates,
  conditionLabel,
  eventPayloadSchemas,
  gateDecisionInputSchema,
  gatePayloadSchemas,
  outcomeOf,
  type Answers,
  type CardStory,
  type ConditionResult,
  type GateDecision,
  type GateFacts,
  type GateId,
} from "../src/index.js";

const gate = (id: GateId) => GATES.find((g) => g.id === id)!;
const facts: GateFacts = { intakeCompleted: false, budgetUsd: null, spendUsd: 0 };
const fullAnswers: Answers = {
  audience: "the members of a small book club",
  outcome: "keep a shared reading list",
  success: "the club picks its next book in the app",
  platform: ["web"],
  payments: "yes",
  personal_data: "accounts",
  exposure: "internet",
  budget_usd: 50,
};
const ack = (title: string) =>
  `I have read what ${title} means for this project and I take responsibility for this step.`;

describe("gate catalog", () => {
  it("lists the gates in GATE_IDS order with the exact titles, sign-off and conditions", () => {
    expect(GATES.map((g) => [g.id, g.title, g.signOff, g.conditions])).toEqual([
      ["plan_approved", "Plan approved", false, ["intake_completed"]],
      ["ready_to_ship", "Ready to ship", true, ["intake_completed", "no_pending_actions", "no_running_runs_on_card"]],
      ["network_exposure", "Network exposure", true, ["decision_made:exposure_protection"]],
      ["payments", "Taking payments", true, ["decision_made:payments_scope"]],
      ["personal_data", "Holding personal data", true, ["decision_made:data_handling"]],
      ["go_live", "Going live", true, ["intake_completed", "no_pending_actions", "no_running_runs_on_card"]],
      ["over_budget", "Over budget", true, ["within_budget"]],
    ]);
    expect(GATES.map((g) => g.id)).toEqual([...GATE_IDS]);
  });

  it("uses the exact acknowledgement sentence for every gate, plan_approved included (for waivers)", () => {
    for (const g of GATES) expect(g.acknowledgement).toBe(ack(g.title.toLowerCase()));
    expect(gate("ready_to_ship").acknowledgement).toBe(
      "I have read what ready to ship means for this project and I take responsibility for this step.",
    );
  });

  it("keeps every gate's copy plain and within bounds", () => {
    const jargon = /\b(gates?|ledgers?|projections?)\b/i;
    for (const g of GATES) {
      expect(g.explanation.length, g.id).toBeGreaterThanOrEqual(100);
      expect(g.explanation.length, g.id).toBeLessThanOrEqual(900);
      expect(g.risks.length, g.id).toBeGreaterThanOrEqual(2);
      expect(g.risks.length, g.id).toBeLessThanOrEqual(5);
      expect(g.learn.length, g.id).toBeGreaterThanOrEqual(40);
      expect(g.learn.length, g.id).toBeLessThanOrEqual(400);
      for (const text of [g.explanation, g.learn, ...g.risks]) {
        expect(text.trim().length, g.id).toBeGreaterThan(0);
        expect(jargon.test(text), `${g.id}: ${text}`).toBe(false);
      }
    }
  });
});

describe("applicableGates", () => {
  it("asks for an approved plan when a card leaves Plan", () => {
    expect(applicableGates({ from: "plan", to: "build" }, {}, facts).map((g) => g.id)).toEqual(["plan_approved"]);
    expect(applicableGates({ from: "plan", to: "plan" }, {}, facts)).toEqual([]);
    expect(applicableGates({ from: "design", to: "build" }, {}, facts)).toEqual([]);
  });

  it("raises the ship gates the answers call for", () => {
    expect(applicableGates({ from: "build", to: "ship" }, fullAnswers, facts).map((g) => g.id)).toEqual([
      "ready_to_ship",
      "network_exposure",
      "payments",
      "personal_data",
    ]);
    expect(
      applicableGates(
        { from: "build", to: "ship" },
        { ...fullAnswers, payments: "later", personal_data: "none", exposure: "private" },
        facts,
      ).map((g) => g.id),
    ).toEqual(["ready_to_ship"]);
  });

  it("asks before going live", () => {
    expect(applicableGates({ from: "ship", to: "operate" }, fullAnswers, facts).map((g) => g.id)).toEqual(["go_live"]);
  });

  it("raises over_budget on any move once spend passes the budget", () => {
    expect(
      applicableGates({ from: "build", to: "design" }, {}, { intakeCompleted: true, budgetUsd: 10, spendUsd: 10.01 }).map(
        (g) => g.id,
      ),
    ).toEqual(["over_budget"]);
    expect(applicableGates({ from: "build", to: "design" }, {}, { intakeCompleted: true, budgetUsd: 10, spendUsd: 10 })).toEqual(
      [],
    );
    expect(applicableGates({ from: "build", to: "design" }, {}, { intakeCompleted: false, budgetUsd: 10, spendUsd: 20 })).toEqual(
      [],
    );
    expect(applicableGates({ from: "build", to: "design" }, {}, { intakeCompleted: true, budgetUsd: null, spendUsd: 20 })).toEqual(
      [],
    );
  });
});

describe("conditionLabel", () => {
  it("uses the exact labels", () => {
    expect(conditionLabel("intake_completed", facts)).toBe("The plan has been approved");
    expect(conditionLabel("no_pending_actions", facts)).toBe("No agent is waiting for a decision in this project");
    expect(conditionLabel("no_running_runs_on_card", facts)).toBe("No agent is still working on this card");
    expect(conditionLabel("decision_made:hosting", facts)).toBe("You have decided: Where should it run?");
    expect(conditionLabel("within_budget", { intakeCompleted: true, budgetUsd: 50, spendUsd: 12.5 })).toBe(
      "Agent spend is within the budget you set ($12.50 of $50.00)",
    );
    expect(conditionLabel("within_budget", { intakeCompleted: true, budgetUsd: null, spendUsd: 12.5 })).toBe(
      "No budget has been set",
    );
  });
});

describe("outcomeOf", () => {
  const met: ConditionResult = { id: "intake_completed", label: "The plan has been approved", met: true, detail: null };
  const unmet: ConditionResult = { ...met, met: false };

  it("passes a checklist-only gate whose conditions are met", () => {
    expect(outcomeOf(gate("plan_approved"), [met])).toBe("pass");
  });

  it("needs sign-off for a consequential gate whose conditions are met", () => {
    expect(outcomeOf(gate("ready_to_ship"), [met, met])).toBe("needs_sign_off");
  });

  it("blocks when any condition is unmet", () => {
    expect(outcomeOf(gate("ready_to_ship"), [met, unmet])).toBe("blocked");
    expect(outcomeOf(gate("plan_approved"), [unmet])).toBe("blocked");
  });
});

describe("gateDecisionInputSchema", () => {
  it("requires a reason of 10 to 500 characters to waive", () => {
    const base = { gateId: "plan_approved", decision: "waive", acknowledgement: gate("plan_approved").acknowledgement };
    expect(gateDecisionInputSchema.safeParse(base).success).toBe(false);
    expect(gateDecisionInputSchema.safeParse({ ...base, reason: "too short" }).success).toBe(false);
    expect(gateDecisionInputSchema.safeParse({ ...base, reason: "r".repeat(501) }).success).toBe(false);
    expect(gateDecisionInputSchema.safeParse({ ...base, reason: "a demo for the club, no real users" }).success).toBe(true);
  });

  it("accepts a sign-off without a reason and refuses unknown keys or gates", () => {
    const ok = { gateId: "ready_to_ship", decision: "sign_off", acknowledgement: gate("ready_to_ship").acknowledgement };
    expect(gateDecisionInputSchema.safeParse(ok).success).toBe(true);
    expect(gateDecisionInputSchema.safeParse({ ...ok, extra: 1 }).success).toBe(false);
    expect(gateDecisionInputSchema.safeParse({ ...ok, gateId: "nope" }).success).toBe(false);
    expect(gateDecisionInputSchema.safeParse({ ...ok, decision: "skip" }).success).toBe(false);
  });
});

describe("gate event payloads", () => {
  it("is registered in eventPayloadSchemas", () => {
    for (const type of Object.keys(gatePayloadSchemas) as (keyof typeof gatePayloadSchemas)[]) {
      expect(eventPayloadSchemas[type]).toBe(gatePayloadSchemas[type]);
    }
  });

  it("checks gate.blocked", () => {
    const s = gatePayloadSchemas["gate.blocked"];
    const g = { gateId: "ready_to_ship", outcome: "blocked", unmet: ["intake_completed"] };
    expect(s.safeParse({ cardId: "c1", from: "build", to: "ship", gates: [g] }).success).toBe(true);
    expect(s.safeParse({ cardId: "c1", from: "build", to: "ship", gates: [] }).success).toBe(false);
    expect(s.safeParse({ cardId: "c1", from: "build", to: "ship", gates: [{ ...g, outcome: "pass" }] }).success).toBe(false);
  });

  it("accepts gate.signed_off only with the gate's exact sentence", () => {
    const s = gatePayloadSchemas["gate.signed_off"];
    const ok = {
      gateId: "ready_to_ship",
      cardId: "c1",
      from: "build",
      to: "ship",
      conditions: ["intake_completed", "no_pending_actions", "no_running_runs_on_card"],
      acknowledgement: "I have read what ready to ship means for this project and I take responsibility for this step.",
      signedBy: "owner",
    };
    expect(s.safeParse(ok).success).toBe(true);
    expect(s.safeParse({ ...ok, acknowledgement: gate("go_live").acknowledgement }).success).toBe(false);
    expect(s.safeParse({ ...ok, extra: 1 }).success).toBe(false);
  });

  it("refuses gate.waived with a short reason or a wrong sentence", () => {
    const s = gatePayloadSchemas["gate.waived"];
    const ok = {
      gateId: "plan_approved",
      cardId: "c1",
      from: "plan",
      to: "build",
      unmet: ["intake_completed"],
      reason: "a demo for the club",
      acknowledgement: gate("plan_approved").acknowledgement,
      waivedBy: "owner",
    };
    expect(s.safeParse(ok).success).toBe(true);
    expect(s.safeParse({ ...ok, reason: "123456789" }).success).toBe(false);
    expect(s.safeParse({ ...ok, acknowledgement: "I agree." }).success).toBe(false);
    expect(s.safeParse({ ...ok, unmet: [] }).success).toBe(false);
  });

  it("caps each unmet and condition string at 300 characters", () => {
    const long = "x".repeat(301);
    const ok = "x".repeat(300);
    const blocked = gatePayloadSchemas["gate.blocked"];
    const g = (unmet: string[]) => ({ cardId: "c1", from: "build", to: "ship", gates: [{ gateId: "ready_to_ship", outcome: "blocked", unmet }] });
    expect(blocked.safeParse(g([ok])).success).toBe(true);
    expect(blocked.safeParse(g([long])).success).toBe(false);
    const signed = {
      gateId: "ready_to_ship", cardId: "c1", from: "build", to: "ship", conditions: [ok],
      acknowledgement: gate("ready_to_ship").acknowledgement, signedBy: "owner",
    };
    expect(gatePayloadSchemas["gate.signed_off"].safeParse(signed).success).toBe(true);
    expect(gatePayloadSchemas["gate.signed_off"].safeParse({ ...signed, conditions: [long] }).success).toBe(false);
    const waived = {
      gateId: "plan_approved", cardId: "c1", from: "plan", to: "build", unmet: [ok], reason: "a demo for the club",
      acknowledgement: gate("plan_approved").acknowledgement, waivedBy: "owner",
    };
    expect(gatePayloadSchemas["gate.waived"].safeParse(waived).success).toBe(true);
    expect(gatePayloadSchemas["gate.waived"].safeParse({ ...waived, unmet: [long] }).success).toBe(false);
  });
});

describe("shared story types", () => {
  it("exports GateDecision and CardStory for the core and the UI", () => {
    const decision: GateDecision = {
      entryId: "e1",
      gateId: "plan_approved",
      projectId: "p1",
      cardId: "c1",
      kind: "waived",
      from: "plan",
      to: "build",
      reason: "a demo for the club",
      decidedBy: "owner",
      at: "2026-01-01T00:00:00.000Z",
    };
    const story: CardStory = {
      card: { id: "c1", projectId: "p1", title: "t", stage: "build", status: "todo", createdAt: "x", updatedAt: "x" },
      runs: [],
      actions: [],
      entries: [],
      gateDecisions: [decision],
      costUsd: null,
    };
    expect(story.gateDecisions[0]?.kind).toBe("waived");
  });
});
