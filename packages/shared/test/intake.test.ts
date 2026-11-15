import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import {
  DECISION_IDS,
  INTAKE_DECISIONS,
  INTAKE_QUESTIONS,
  INTAKE_VERSION,
  QUESTION_IDS,
  applicableDecisions,
  eventPayloadSchemas,
  intakePayloadSchemas,
  intakeStep,
  planSummary,
  proposedCards,
  recommendedOption,
  renderAnswer,
  validateAnswer,
  type Answers,
  type Decisions,
  type DecisionId,
  type IntakeDecision,
  type IntakeQuestion,
  type QuestionId,
} from "../src/index.js";

const q = (id: QuestionId): IntakeQuestion => INTAKE_QUESTIONS.find((x) => x.id === id)!;
const d = (id: DecisionId): IntakeDecision => INTAKE_DECISIONS.find((x) => x.id === id)!;

/** Every required answer, private and without payments or personal data. */
const required: Answers = {
  audience: "the members of a small book club",
  outcome: "keep a shared reading list and vote on the next book",
  success: "the club picks its next book in the app every month",
  platform: ["web"],
  payments: "no",
  personal_data: "none",
  exposure: "private",
  budget_usd: 50,
};

/** One of web/mobile/desktop and not api, so exactly eight cards are proposed. */
const full: Answers = { ...required, payments: "yes", personal_data: "accounts", exposure: "internet" };

const allDecided: Decisions = {
  first_version: "smallest",
  hosting: "own_cloud",
  exposure_protection: "login",
  payments_scope: "provider",
  data_handling: "minimum",
};

const plainCopy = (text: string, min: number, max: number) => {
  expect(text.length, text).toBeGreaterThanOrEqual(min);
  expect(text.length, text).toBeLessThanOrEqual(max);
};

describe("intake catalog", () => {
  it("is version 1", () => {
    expect(INTAKE_VERSION).toBe(1);
  });

  it("lists the questions in QUESTION_IDS order", () => {
    expect(INTAKE_QUESTIONS.map((x) => x.id)).toEqual([...QUESTION_IDS]);
  });

  it("uses the exact kinds, labels and options", () => {
    expect(INTAKE_QUESTIONS.map((x) => [x.id, x.kind, x.label, x.required])).toEqual([
      ["audience", "text", "Who is this for?", true],
      ["outcome", "text", "What should it do for them?", true],
      ["success", "text", "How will you know it worked?", true],
      ["platform", "multi", "Where will people use it?", true],
      ["payments", "choice", "Will it take payments?", true],
      ["personal_data", "choice", "What personal data will it hold?", true],
      ["exposure", "choice", "Who can reach it?", true],
      ["budget_usd", "number", "How much are you willing to spend on agents for this project? (USD)", true],
      ["existing", "text", "Is there anything that already exists (code, designs, accounts)?", false],
    ]);
    expect(q("platform").options).toEqual([
      { id: "web", label: "In a web browser" },
      { id: "mobile", label: "On a phone (an app)" },
      { id: "api", label: "From other software (an API)" },
      { id: "desktop", label: "On a computer (a desktop app)" },
    ]);
    expect(q("payments").options).toEqual([
      { id: "yes", label: "Yes" },
      { id: "no", label: "No" },
      { id: "later", label: "Not at first" },
    ]);
    expect(q("personal_data").options).toEqual([
      { id: "none", label: "None" },
      { id: "accounts", label: "Accounts (names, emails, logins)" },
      { id: "sensitive", label: "Sensitive data (health, money, identity documents)" },
    ]);
    expect(q("exposure").options).toEqual([
      { id: "private", label: "Only me, on my computer" },
      { id: "network", label: "People on my network" },
      { id: "internet", label: "Anyone on the internet" },
    ]);
  });

  it("explains every question in 20 to 400 characters", () => {
    for (const x of INTAKE_QUESTIONS) plainCopy(x.help, 20, 400);
  });

  it("lists the decisions in DECISION_IDS order with the exact questions and options", () => {
    expect(INTAKE_DECISIONS.map((x) => x.id)).toEqual([...DECISION_IDS]);
    expect(INTAKE_DECISIONS.map((x) => [x.id, x.question, x.options.map((o) => [o.id, o.label])])).toEqual([
      [
        "first_version",
        "How much should the first version include?",
        [
          ["smallest", "The smallest version that proves the idea"],
          ["full", "Everything described"],
        ],
      ],
      [
        "hosting",
        "Where should it run?",
        [
          ["local", "On this computer only"],
          ["own_cloud", "In your own cloud account (AWS, Google Cloud or Azure)"],
        ],
      ],
      [
        "exposure_protection",
        "Who should be able to use it once it is reachable?",
        [
          ["login", "Only people who sign in"],
          ["open", "Anyone who finds it"],
        ],
      ],
      [
        "payments_scope",
        "How should payments be handled?",
        [
          ["provider", "A payment provider's hosted checkout: card details never touch your product"],
          ["custom", "A checkout built into the product"],
        ],
      ],
      [
        "data_handling",
        "How much personal data should be kept?",
        [
          ["minimum", "Only what the product needs, deleted when no longer needed"],
          ["full", "Everything that might be useful later"],
        ],
      ],
    ]);
    expect(INTAKE_DECISIONS.map((x) => [x.id, x.dependsOn])).toEqual([
      ["first_version", ["outcome", "success"]],
      ["hosting", ["exposure"]],
      ["exposure_protection", ["exposure", "personal_data"]],
      ["payments_scope", ["payments"]],
      ["data_handling", ["personal_data"]],
    ]);
  });

  it("explains every decision and option in 20 to 400 characters", () => {
    for (const x of INTAKE_DECISIONS) {
      plainCopy(x.learn, 20, 400);
      plainCopy(x.risk, 20, 400);
      for (const o of x.options) plainCopy(o.tradeoffs, 20, 400);
    }
  });

  it("recommends one of each decision's own options", () => {
    for (const x of INTAKE_DECISIONS) {
      const ids = x.options.map((o) => o.id);
      expect(ids).toContain(x.recommend.default);
      for (const w of x.recommend.when ?? []) expect(ids).toContain(w.option);
    }
  });
});

describe("validateAnswer", () => {
  it("accepts known platform options and refuses unknown ones", () => {
    expect(validateAnswer(q("platform"), ["web"])).toEqual(["web"]);
    expect(() => validateAnswer(q("platform"), ["web", "nope"])).toThrow(ZodError);
  });

  it("refuses an empty or repeated platform list", () => {
    expect(() => validateAnswer(q("platform"), [])).toThrow(ZodError);
    expect(() => validateAnswer(q("platform"), ["web", "web"])).toThrow(ZodError);
  });

  it("refuses a budget with more than two decimals", () => {
    expect(validateAnswer(q("budget_usd"), 12.34)).toBe(12.34);
    expect(validateAnswer(q("budget_usd"), 0.29)).toBe(0.29);
    expect(() => validateAnswer(q("budget_usd"), 12.345)).toThrow(ZodError);
  });

  it("refuses a budget outside 0 to 1,000,000", () => {
    expect(validateAnswer(q("budget_usd"), 0)).toBe(0);
    expect(validateAnswer(q("budget_usd"), 1_000_000)).toBe(1_000_000);
    expect(() => validateAnswer(q("budget_usd"), -1)).toThrow(ZodError);
    expect(() => validateAnswer(q("budget_usd"), 1_000_000.01)).toThrow(ZodError);
    expect(() => validateAnswer(q("budget_usd"), Number.NaN)).toThrow(ZodError);
  });

  it("refuses an empty answer to a required question and accepts one for an optional question", () => {
    expect(() => validateAnswer(q("audience"), "")).toThrow(ZodError);
    expect(() => validateAnswer(q("audience"), "   ")).toThrow(ZodError);
    expect(validateAnswer(q("existing"), "")).toBe("");
  });

  it("refuses text over 2000 characters", () => {
    expect(() => validateAnswer(q("outcome"), "a".repeat(2001))).toThrow(ZodError);
    expect(validateAnswer(q("outcome"), "a".repeat(2000))).toHaveLength(2000);
  });

  it("refuses a choice outside the options and an answer of the wrong kind", () => {
    expect(validateAnswer(q("payments"), "yes")).toBe("yes");
    expect(() => validateAnswer(q("payments"), "maybe")).toThrow(ZodError);
    expect(() => validateAnswer(q("audience"), 3)).toThrow(ZodError);
    expect(() => validateAnswer(q("budget_usd"), "50")).toThrow(ZodError);
  });

  it("reports the error at the path answer", () => {
    try {
      validateAnswer(q("payments"), "maybe");
      expect.unreachable();
    } catch (e) {
      expect((e as ZodError).issues[0]?.path).toEqual(["answer"]);
    }
  });
});

describe("renderAnswer", () => {
  it("joins option labels and formats the budget in dollars", () => {
    expect(renderAnswer(q("platform"), ["web", "api"])).toBe("In a web browser, From other software (an API)");
    expect(renderAnswer(q("payments"), "later")).toBe("Not at first");
    expect(renderAnswer(q("budget_usd"), 1000)).toBe("$1,000.00");
    expect(renderAnswer(q("budget_usd"), 1234567.5)).toBe("$1,234,567.50");
    expect(renderAnswer(q("budget_usd"), 0.29)).toBe("$0.29");
    expect(renderAnswer(q("audience"), "readers")).toBe("readers");
  });
});

describe("applicableDecisions", () => {
  it("raises nothing before any answer", () => {
    expect(applicableDecisions({})).toEqual([]);
  });

  it("raises first_version and hosting for a private product without payments or personal data", () => {
    expect(applicableDecisions(required).map((x) => x.id)).toEqual(["first_version", "hosting"]);
  });

  it("raises all five for an internet product that takes payments and holds accounts", () => {
    expect(applicableDecisions(full).map((x) => x.id)).toEqual([...DECISION_IDS]);
  });

  it("waits until every question a decision depends on is answered", () => {
    const { personal_data: _omit, ...partial } = full;
    expect(applicableDecisions(partial).map((x) => x.id)).toEqual(["first_version", "hosting", "payments_scope"]);
  });
});

describe("recommendedOption", () => {
  it("recommends local hosting for a private product and your own cloud otherwise", () => {
    expect(recommendedOption(d("hosting"), { exposure: "private" })).toBe("local");
    expect(recommendedOption(d("hosting"), { exposure: "internet" })).toBe("own_cloud");
  });

  it("recommends the safer option for the rest", () => {
    expect(recommendedOption(d("first_version"), full)).toBe("smallest");
    expect(recommendedOption(d("exposure_protection"), full)).toBe("login");
    expect(recommendedOption(d("payments_scope"), full)).toBe("provider");
    expect(recommendedOption(d("data_handling"), full)).toBe("minimum");
  });
});

describe("intakeStep", () => {
  it("walks answer, decide, approve, completed", () => {
    expect(intakeStep("open", {}, {})).toBe("answer");
    const { budget_usd: _omit, ...missingBudget } = full;
    expect(intakeStep("open", missingBudget, allDecided)).toBe("answer");
    expect(intakeStep("open", full, {})).toBe("decide");
    expect(intakeStep("open", full, { first_version: "smallest", hosting: "own_cloud" })).toBe("decide");
    expect(intakeStep("open", full, allDecided)).toBe("approve");
    expect(intakeStep("open", required, { first_version: "smallest", hosting: "local" })).toBe("approve");
    expect(intakeStep("completed", {}, {})).toBe("completed");
  });

  it("does not wait for the optional question", () => {
    expect(intakeStep("open", { ...required }, { first_version: "full", hosting: "local" })).toBe("approve");
  });
});

describe("proposedCards", () => {
  it("proposes the eight cards for the full answer set", () => {
    expect(proposedCards(full, allDecided)).toEqual([
      { title: 'Define what "done" means', stage: "plan" },
      { title: "Sketch the main screens and flows", stage: "design" },
      { title: "Build the smallest version that proves the idea", stage: "build" },
      { title: "Set up hosting in your own cloud account", stage: "ship" },
      { title: "Payments readiness review", stage: "ship" },
      { title: "Personal data readiness review", stage: "ship" },
      { title: "Network exposure readiness review", stage: "ship" },
      { title: "Monitoring and health checks", stage: "operate" },
    ]);
  });

  it("follows the platform, first version and hosting choices", () => {
    expect(
      proposedCards({ ...required, platform: ["api", "mobile"] }, { first_version: "full", hosting: "local" }),
    ).toEqual([
      { title: 'Define what "done" means', stage: "plan" },
      { title: "Sketch the main screens and flows", stage: "design" },
      { title: "Define the API", stage: "design" },
      { title: "Build everything described", stage: "build" },
      { title: "Run it on this computer", stage: "ship" },
      { title: "Monitoring and health checks", stage: "operate" },
    ]);
    expect(
      proposedCards({ ...required, platform: ["api"] }, { first_version: "smallest", hosting: "local" }).map((c) => c.title),
    ).not.toContain("Sketch the main screens and flows");
  });
});

describe("planSummary", () => {
  it("writes one deterministic paragraph", () => {
    expect(planSummary("Book Club", full, allDecided)).toBe(
      "Book Club is for the members of a small book club. It should keep a shared reading list and vote on the next book. " +
        "You will know it worked when the club picks its next book in the app every month. People use it in a web browser. " +
        "It takes payments. It holds account data and can be reached by anyone on the internet. " +
        "First version: The smallest version that proves the idea. Hosting: In your own cloud account (AWS, Google Cloud or Azure). " +
        "Access: Only people who sign in. " +
        "Payments: A payment provider's hosted checkout: card details never touch your product. " +
        "Personal data: Only what the product needs, deleted when no longer needed. Agent budget: $50.00.",
    );
  });

  it("joins several platforms and leaves out decisions that do not apply", () => {
    expect(
      planSummary(
        "Book Club",
        { ...required, platform: ["web", "mobile", "api"], payments: "later", budget_usd: 1250.5 },
        { first_version: "full", hosting: "local", payments_scope: "provider" },
      ),
    ).toBe(
      "Book Club is for the members of a small book club. It should keep a shared reading list and vote on the next book. " +
        "You will know it worked when the club picks its next book in the app every month. " +
        "People use it in a web browser, on a phone (an app) and from other software (an API). " +
        "It will take payments later. It holds no personal data and can be reached by only me, on my computer. " +
        "First version: Everything described. Hosting: On this computer only. Agent budget: $1,250.50.",
    );
  });
});

describe("intake event payloads", () => {
  it("is registered in eventPayloadSchemas", () => {
    for (const type of Object.keys(intakePayloadSchemas)) {
      expect(eventPayloadSchemas[type as keyof typeof intakePayloadSchemas]).toBe(
        intakePayloadSchemas[type as keyof typeof intakePayloadSchemas],
      );
    }
  });

  it("checks intake.started", () => {
    const s = intakePayloadSchemas["intake.started"];
    expect(s.safeParse({ intakeId: "i1", idea: "a reading list for a book club", version: 1 }).success).toBe(true);
    expect(s.safeParse({ intakeId: "i1", idea: "", version: 1 }).success).toBe(false);
    expect(s.safeParse({ intakeId: "i1", idea: "x", version: 2 }).success).toBe(false);
    expect(s.safeParse({ intakeId: "i1", idea: "x", version: 1, extra: 1 }).success).toBe(false);
  });

  it("checks intake.answered against the catalog question", () => {
    const s = intakePayloadSchemas["intake.answered"];
    expect(s.safeParse({ intakeId: "i1", questionId: "payments", answer: "maybe" }).success).toBe(false);
    expect(s.safeParse({ intakeId: "i1", questionId: "payments", answer: "yes" }).success).toBe(true);
    expect(s.safeParse({ intakeId: "i1", questionId: "platform", answer: ["web", "api"] }).success).toBe(true);
    expect(s.safeParse({ intakeId: "i1", questionId: "budget_usd", answer: 12.345 }).success).toBe(false);
    expect(s.safeParse({ intakeId: "i1", questionId: "budget_usd", answer: 12.34 }).success).toBe(true);
    expect(s.safeParse({ intakeId: "i1", questionId: "nope", answer: "yes" }).success).toBe(false);
  });

  it("checks intake.decided against the decision's options", () => {
    const s = intakePayloadSchemas["intake.decided"];
    const ok = { intakeId: "i1", decisionId: "hosting", chosen: "local", rationale: "", owner: "owner" };
    expect(s.safeParse(ok).success).toBe(true);
    expect(s.safeParse({ ...ok, chosen: "nope" }).success).toBe(false);
    expect(s.safeParse({ ...ok, chosen: "smallest" }).success).toBe(false);
    expect(s.safeParse({ ...ok, owner: "" }).success).toBe(false);
  });

  it("checks intake.completed and allows at most 20 cards", () => {
    const s = intakePayloadSchemas["intake.completed"];
    const card = { cardId: "c1", title: "Monitoring and health checks", stage: "operate", outcome: "created" };
    expect(s.safeParse({ intakeId: "i1", summary: "A plan.", cards: [card] }).success).toBe(true);
    expect(s.safeParse({ intakeId: "i1", summary: "A plan.", cards: Array(20).fill(card) }).success).toBe(true);
    expect(s.safeParse({ intakeId: "i1", summary: "A plan.", cards: Array(21).fill(card) }).success).toBe(false);
    expect(s.safeParse({ intakeId: "i1", summary: "A plan.", cards: [{ ...card, outcome: "moved" }] }).success).toBe(false);
  });

  it("checks intake.reopened", () => {
    const s = intakePayloadSchemas["intake.reopened"];
    expect(s.safeParse({ intakeId: "i1", reason: "payments are needed after all" }).success).toBe(true);
    expect(s.safeParse({ intakeId: "i1", reason: "" }).success).toBe(false);
  });
});
