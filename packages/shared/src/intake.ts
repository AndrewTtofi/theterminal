import { z } from "zod";
import { STAGES, type Stage } from "./domain.js";
import { formatUsd, joinAnd, lowerFirst } from "./text.js";

/** Bumped whenever the questions, decisions, recommendations or proposed cards change meaning. */
export const INTAKE_VERSION = 1;

export const QUESTION_IDS = [
  "audience",
  "outcome",
  "success",
  "platform",
  "payments",
  "personal_data",
  "exposure",
  "budget_usd",
  "existing",
] as const;
export type QuestionId = (typeof QUESTION_IDS)[number];
export type QuestionKind = "text" | "choice" | "multi" | "number";
export type QuestionOption = { id: string; label: string };
export type IntakeQuestion = {
  id: QuestionId;
  kind: QuestionKind;
  label: string;
  help: string;
  required: boolean;
  options?: QuestionOption[];
  max?: number;
};

const TEXT_MAX = 2000;
const BUDGET_MAX = 1_000_000;

export const INTAKE_QUESTIONS: readonly IntakeQuestion[] = [
  {
    id: "audience",
    kind: "text",
    label: "Who is this for?",
    help: "Knowing who will use it decides what the first version must get right and what can wait.",
    required: true,
    max: TEXT_MAX,
  },
  {
    id: "outcome",
    kind: "text",
    label: "What should it do for them?",
    help: "Describe the result people get, not the features. The plan and the first version are built around this.",
    required: true,
    max: TEXT_MAX,
  },
  {
    id: "success",
    kind: "text",
    label: "How will you know it worked?",
    help: 'A clear sign of success tells everyone, people and agents, when the work is done. It becomes the "done" card of the plan.',
    required: true,
    max: TEXT_MAX,
  },
  {
    id: "platform",
    kind: "multi",
    label: "Where will people use it?",
    help: "Each place people use it needs its own design work. Pick every one that applies.",
    required: true,
    options: [
      { id: "web", label: "In a web browser" },
      { id: "mobile", label: "On a phone (an app)" },
      { id: "api", label: "From other software (an API)" },
      { id: "desktop", label: "On a computer (a desktop app)" },
    ],
  },
  {
    id: "payments",
    kind: "choice",
    label: "Will it take payments?",
    help: "Taking money brings legal and security duties, so it gets its own decision and a review before release.",
    required: true,
    options: [
      { id: "yes", label: "Yes" },
      { id: "no", label: "No" },
      { id: "later", label: "Not at first" },
    ],
  },
  {
    id: "personal_data",
    kind: "choice",
    label: "What personal data will it hold?",
    help: "Holding information about people means you must protect it and may owe them the right to see or delete it.",
    required: true,
    options: [
      { id: "none", label: "None" },
      { id: "accounts", label: "Accounts (names, emails, logins)" },
      { id: "sensitive", label: "Sensitive data (health, money, identity documents)" },
    ],
  },
  {
    id: "exposure",
    kind: "choice",
    label: "Who can reach it?",
    help: "The more people can reach it, the more it must be protected from misuse. This also decides where it should run.",
    required: true,
    options: [
      { id: "private", label: "Only me, on my computer" },
      { id: "network", label: "People on my network" },
      { id: "internet", label: "Anyone on the internet" },
    ],
  },
  {
    id: "budget_usd",
    kind: "number",
    label: "How much are you willing to spend on agents for this project? (USD)",
    help: "This is the agent budget for this project. When agent spend goes over it, moving work asks you first.",
    required: true,
    max: BUDGET_MAX,
  },
  {
    id: "existing",
    kind: "text",
    label: "Is there anything that already exists (code, designs, accounts)?",
    help: "Optional. Anything that already exists can save work. Describe it in words; write paths relative to the project.",
    required: false,
    max: TEXT_MAX,
  },
];

export type IntakeAnswer = string | string[] | number;
export type Answers = Partial<Record<QuestionId, IntakeAnswer>>;

export const DECISION_IDS = ["first_version", "hosting", "exposure_protection", "payments_scope", "data_handling"] as const;
export type DecisionId = (typeof DECISION_IDS)[number];
export type DecisionOption = { id: string; label: string; tradeoffs: string };
export type IntakeDecision = {
  id: DecisionId;
  question: string;
  learn: string;
  risk: string;
  options: DecisionOption[];
  /** The answers shown as evidence ("Because you answered…"); the decision waits until all are answered. */
  dependsOn: QuestionId[];
  /** null: always. */
  appliesWhen: { questionId: QuestionId; anyOf: string[] } | null;
  recommend: { default: string; when?: { questionId: QuestionId; anyOf: string[]; option: string }[] };
};

export const INTAKE_DECISIONS: readonly IntakeDecision[] = [
  {
    id: "first_version",
    question: "How much should the first version include?",
    learn:
      "A first version is the earliest thing people can try. Keeping it small gets it in front of them sooner, so you learn what matters before spending more.",
    risk: "Building everything at once costs more agent time and money, and the parts nobody needs are only found out at the end.",
    options: [
      {
        id: "smallest",
        label: "The smallest version that proves the idea",
        tradeoffs: "Cheaper and faster to try, and you learn early. Some things you described wait for a later version.",
      },
      {
        id: "full",
        label: "Everything described",
        tradeoffs: "Nothing is left for later, but it takes longer and costs more before anyone can try it.",
      },
    ],
    dependsOn: ["outcome", "success"],
    appliesWhen: null,
    recommend: { default: "smallest" },
  },
  {
    id: "hosting",
    question: "Where should it run?",
    learn:
      "Hosting is the computer the product runs on. Your own computer is free and private; a cloud account keeps it running for others when your computer is off.",
    risk: "A cloud account costs money every month and must be kept secure. Running only on this computer means nobody else can reach it.",
    options: [
      {
        id: "local",
        label: "On this computer only",
        tradeoffs: "Free and private, with nothing to set up. Only you can use it, and only while this computer is on.",
      },
      {
        id: "own_cloud",
        label: "In your own cloud account (AWS, Google Cloud or Azure)",
        tradeoffs: "Others can reach it at any time, under an account you control. It costs money and needs looking after.",
      },
    ],
    dependsOn: ["exposure"],
    appliesWhen: null,
    recommend: { default: "own_cloud", when: [{ questionId: "exposure", anyOf: ["private"], option: "local" }] },
  },
  {
    id: "exposure_protection",
    question: "Who should be able to use it once it is reachable?",
    learn:
      "Once other people can reach it, anything it shows or does is open to whoever finds it, unless people have to sign in first.",
    risk: "An open product can be misused, flooded with traffic or made to reveal what it holds, especially when it holds personal data.",
    options: [
      {
        id: "login",
        label: "Only people who sign in",
        tradeoffs: "Strangers cannot use it, and you know who did what. People need an account, which is a little more to build.",
      },
      {
        id: "open",
        label: "Anyone who finds it",
        tradeoffs: "Nothing stands between people and the product. Anyone, including people with bad intentions, can use it.",
      },
    ],
    dependsOn: ["exposure", "personal_data"],
    appliesWhen: { questionId: "exposure", anyOf: ["network", "internet"] },
    recommend: { default: "login" },
  },
  {
    id: "payments_scope",
    question: "How should payments be handled?",
    learn:
      "A payment provider can run the checkout for you, so card numbers go to them and never through your product.",
    risk: "Handling card details yourself brings strict security rules, and a mistake can leak people's cards or cost you fines.",
    options: [
      {
        id: "provider",
        label: "A payment provider's hosted checkout: card details never touch your product",
        tradeoffs: "Much less to secure and to get certified. The provider takes a fee and the checkout looks like theirs.",
      },
      {
        id: "custom",
        label: "A checkout built into the product",
        tradeoffs: "Full control of how paying looks and works, but your product handles card details and must meet the rules.",
      },
    ],
    dependsOn: ["payments"],
    appliesWhen: { questionId: "payments", anyOf: ["yes"] },
    recommend: { default: "provider" },
  },
  {
    id: "data_handling",
    question: "How much personal data should be kept?",
    learn:
      "Every piece of personal data you keep is something you must protect, and something people may ask you to show or delete.",
    risk: "Data kept just in case can leak, and the more you keep, the more harm a leak does to the people it describes.",
    options: [
      {
        id: "minimum",
        label: "Only what the product needs, deleted when no longer needed",
        tradeoffs: "Less to protect and less harm if something leaks. Some later ideas may need data you chose not to keep.",
      },
      {
        id: "full",
        label: "Everything that might be useful later",
        tradeoffs: "More options later, but more to protect, more to explain to people, and more harm if it leaks.",
      },
    ],
    dependsOn: ["personal_data"],
    appliesWhen: { questionId: "personal_data", anyOf: ["accounts", "sensitive"] },
    recommend: { default: "minimum" },
  },
];

export type Decisions = Partial<Record<DecisionId, string>>;
export type IntakeStatus = "open" | "completed";
export type IntakeStep = "answer" | "decide" | "approve" | "completed";
export type ProposedCard = { title: string; stage: Stage };

const question = (id: QuestionId): IntakeQuestion => INTAKE_QUESTIONS.find((q) => q.id === id)!;
const decision = (id: DecisionId): IntakeDecision => INTAKE_DECISIONS.find((d) => d.id === id)!;

/** True when at least two decimals are enough to write `n` (integer-cents check, tolerant of `0.29 * 100`). */
function hasAtMostTwoDecimals(n: number): boolean {
  const cents = n * 100;
  return Math.abs(cents - Math.round(cents)) < 1e-6;
}

function answerSchema(q: IntakeQuestion): z.ZodType<IntakeAnswer> {
  const ids = (q.options ?? []).map((o) => o.id);
  switch (q.kind) {
    case "text": {
      const s = z.string().max(q.max ?? TEXT_MAX);
      return q.required ? s.refine((v) => v.trim().length > 0, "an answer is required") : s;
    }
    case "choice":
      return z.string().refine((v) => ids.includes(v), `must be one of: ${ids.join(", ")}`);
    case "multi":
      return z
        .array(z.string().refine((v) => ids.includes(v), `must be one of: ${ids.join(", ")}`))
        .min(q.required ? 1 : 0)
        .max(ids.length)
        .refine((v) => new Set(v).size === v.length, "each option may be chosen once");
    case "number":
      return z
        .number()
        .finite()
        .min(0)
        .max(q.max ?? BUDGET_MAX)
        .refine(hasAtMostTwoDecimals, "at most two decimals");
  }
}

/** Checks an answer against its catalog question; throws a ZodError whose issues sit at the path `["answer"]`. */
export function validateAnswer(q: IntakeQuestion, answer: unknown): IntakeAnswer {
  return z.object({ answer: answerSchema(q) }).parse({ answer }).answer;
}

/** The answer in words: option labels joined by ", ", the budget in dollars, text as written. */
export function renderAnswer(q: IntakeQuestion, answer: IntakeAnswer): string {
  const label = (id: string) => q.options?.find((o) => o.id === id)?.label ?? id;
  if (Array.isArray(answer)) return answer.map(label).join(", ");
  if (typeof answer === "number") return q.id === "budget_usd" ? formatUsd(answer) : String(answer);
  return q.kind === "choice" ? label(answer) : answer;
}

function isAnswered(answers: Answers, id: QuestionId): boolean {
  const a = answers[id];
  if (a === undefined || a === null) return false;
  if (typeof a === "string") return a.trim().length > 0;
  if (Array.isArray(a)) return a.length > 0;
  return true;
}

/** Whether the answer to `id` is (or, for a list, contains) one of `anyOf`. */
function answerIsAnyOf(answers: Answers, id: QuestionId, anyOf: string[]): boolean {
  const a = answers[id];
  if (Array.isArray(a)) return a.some((x) => anyOf.includes(x));
  return typeof a === "string" && anyOf.includes(a);
}

/** The decisions the answers raise, in catalog order; a decision waits until every question it depends on is answered. */
export function applicableDecisions(answers: Answers): IntakeDecision[] {
  return INTAKE_DECISIONS.filter(
    (d) =>
      d.dependsOn.every((id) => isAnswered(answers, id)) &&
      (d.appliesWhen === null || answerIsAnyOf(answers, d.appliesWhen.questionId, d.appliesWhen.anyOf)),
  );
}

export function recommendedOption(d: IntakeDecision, answers: Answers): string {
  return d.recommend.when?.find((w) => answerIsAnyOf(answers, w.questionId, w.anyOf))?.option ?? d.recommend.default;
}

export function intakeStep(status: IntakeStatus, answers: Answers, decisions: Decisions): IntakeStep {
  if (status === "completed") return "completed";
  if (INTAKE_QUESTIONS.some((q) => q.required && !isAnswered(answers, q.id))) return "answer";
  if (applicableDecisions(answers).some((d) => decisions[d.id] === undefined)) return "decide";
  return "approve";
}

/** The chosen option, or the recommendation while the decision is still open. */
function choice(id: DecisionId, answers: Answers, decisions: Decisions): string {
  return decisions[id] ?? recommendedOption(decision(id), answers);
}

export function proposedCards(answers: Answers, decisions: Decisions): ProposedCard[] {
  const cards: ProposedCard[] = [{ title: 'Define what "done" means', stage: "plan" }];
  if (answerIsAnyOf(answers, "platform", ["web", "mobile", "desktop"])) {
    cards.push({ title: "Sketch the main screens and flows", stage: "design" });
  }
  if (answerIsAnyOf(answers, "platform", ["api"])) cards.push({ title: "Define the API", stage: "design" });
  cards.push({
    title:
      choice("first_version", answers, decisions) === "full"
        ? "Build everything described"
        : "Build the smallest version that proves the idea",
    stage: "build",
  });
  cards.push({
    title:
      choice("hosting", answers, decisions) === "local"
        ? "Run it on this computer"
        : "Set up hosting in your own cloud account",
    stage: "ship",
  });
  if (answers.payments === "yes") cards.push({ title: "Payments readiness review", stage: "ship" });
  if (isAnswered(answers, "personal_data") && answers.personal_data !== "none") {
    cards.push({ title: "Personal data readiness review", stage: "ship" });
  }
  if (isAnswered(answers, "exposure") && answers.exposure !== "private") {
    cards.push({ title: "Network exposure readiness review", stage: "ship" });
  }
  cards.push({ title: "Monitoring and health checks", stage: "operate" });
  return cards;
}

/** A text answer inside a sentence: trimmed, without its own closing full stops. */
function clause(answers: Answers, id: QuestionId): string {
  const a = answers[id];
  return typeof a === "string" ? a.trim().replace(/\.+$/, "") : "";
}

function optionLabel(id: QuestionId, answers: Answers): string {
  const a = answers[id];
  return typeof a === "string" ? (question(id).options?.find((o) => o.id === a)?.label ?? a) : "";
}

const PAYMENTS_PHRASE: Record<string, string> = {
  yes: "takes payments",
  no: "does not take payments",
  later: "will take payments later",
};
const PERSONAL_DATA_PHRASE: Record<string, string> = {
  none: "no personal data",
  accounts: "account data",
  sensitive: "sensitive personal data",
};

/** One deterministic paragraph describing the plan; the same answers and decisions always give the same text. */
export function planSummary(projectName: string, answers: Answers, decisions: Decisions): string {
  const platforms = Array.isArray(answers.platform) ? answers.platform : [];
  const platformText = joinAnd(platforms.map((p) => lowerFirst(renderAnswer(question("platform"), [p]))));
  const chosenLabel = (id: DecisionId) => {
    const c = choice(id, answers, decisions);
    return decision(id).options.find((o) => o.id === c)?.label ?? c;
  };
  const applicable = new Set(applicableDecisions(answers).map((d) => d.id));
  const optional = (id: DecisionId, name: string) =>
    applicable.has(id) && decisions[id] !== undefined ? ` ${name}: ${chosenLabel(id)}.` : "";
  const budget = typeof answers.budget_usd === "number" ? answers.budget_usd : 0;
  return (
    `${projectName} is for ${clause(answers, "audience")}. ` +
    `It should ${clause(answers, "outcome")}. ` +
    `You will know it worked when ${clause(answers, "success")}. ` +
    `People use it ${platformText}. ` +
    `It ${PAYMENTS_PHRASE[String(answers.payments)] ?? ""}. ` +
    `It holds ${PERSONAL_DATA_PHRASE[String(answers.personal_data)] ?? ""} and can be reached by ${lowerFirst(optionLabel("exposure", answers))}. ` +
    `First version: ${chosenLabel("first_version")}. Hosting: ${chosenLabel("hosting")}.` +
    optional("exposure_protection", "Access") +
    optional("payments_scope", "Payments") +
    optional("data_handling", "Personal data") +
    ` Agent budget: ${formatUsd(budget)}.`
  );
}

export type IntakeSession = {
  id: string;
  projectId: string;
  idea: string;
  status: IntakeStatus;
  summary: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};
export type IntakeQuestionView = IntakeQuestion & { answer: IntakeAnswer | null; answeredAt: string | null };
export type IntakeDecisionView = Omit<IntakeDecision, "appliesWhen" | "recommend"> & {
  recommended: string;
  because: { label: string; answer: string }[];
  chosen: string | null;
  rationale: string | null;
  owner: string | null;
  decidedAt: string | null;
};
export type IntakeView = {
  intake: IntakeSession;
  step: IntakeStep;
  questions: IntakeQuestionView[];
  decisions: IntakeDecisionView[];
  /** `problem`: why the plan cannot be approved yet (a fixed sentence naming the field to change), else null. */
  plan: { summary: string; cards: ProposedCard[]; problem: string | null } | null;
};

// Defined here rather than imported from events.ts, which imports this module.
const stageSchema = z.enum(STAGES);
const id = z.string().min(1);

export const intakePayloadSchemas = {
  "intake.started": z
    .object({ intakeId: id, idea: z.string().min(1).max(4000), version: z.literal(INTAKE_VERSION) })
    .strict(),
  "intake.answered": z
    .object({
      intakeId: id,
      questionId: z.enum(QUESTION_IDS),
      answer: z.union([
        z.string().max(TEXT_MAX),
        z.array(z.string().max(100)).max(10),
        z.number().finite().min(0).max(BUDGET_MAX),
      ]),
    })
    .strict()
    .superRefine((p, ctx) => {
      const r = z.object({ answer: answerSchema(question(p.questionId)) }).safeParse({ answer: p.answer });
      for (const issue of r.error?.issues ?? []) {
        ctx.addIssue({ code: "custom", message: issue.message, path: issue.path });
      }
    }),
  "intake.decided": z
    .object({
      intakeId: id,
      decisionId: z.enum(DECISION_IDS),
      chosen: z.string().min(1).max(40),
      rationale: z.string().max(1000),
      owner: z.string().min(1).max(200),
    })
    .strict()
    .superRefine((p, ctx) => {
      const ids = decision(p.decisionId).options.map((o) => o.id);
      if (!ids.includes(p.chosen)) {
        ctx.addIssue({ code: "custom", message: `must be one of: ${ids.join(", ")}`, path: ["chosen"] });
      }
    }),
  "intake.completed": z
    .object({
      intakeId: id,
      summary: z.string().min(1).max(4000),
      cards: z
        .array(
          z
            .object({
              cardId: id,
              title: z.string().min(1).max(200),
              stage: stageSchema,
              outcome: z.enum(["created", "existing"]),
            })
            .strict(),
        )
        .max(20),
    })
    .strict(),
  "intake.reopened": z.object({ intakeId: id, reason: z.string().min(1).max(500) }).strict(),
};
export type IntakeEventType = keyof typeof intakePayloadSchemas;
