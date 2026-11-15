import { z } from "zod";
import type { AgentAction, AgentRun } from "./agents.js";
import { STAGES, type Card, type LedgerEntry, type Stage } from "./domain.js";
import { INTAKE_DECISIONS, type Answers, type DecisionId } from "./intake.js";
import { formatUsd } from "./text.js";

export const GATE_IDS = [
  "plan_approved",
  "ready_to_ship",
  "network_exposure",
  "payments",
  "personal_data",
  "go_live",
  "over_budget",
] as const;
export type GateId = (typeof GATE_IDS)[number];
export type ConditionId =
  | "intake_completed"
  | "no_pending_actions"
  | "no_running_runs_on_card"
  | "within_budget"
  | `decision_made:${DecisionId}`;
export type GateFacts = { intakeCompleted: boolean; budgetUsd: number | null; spendUsd: number };
export type Transition = { from: Stage; to: Stage };
export type GateDefinition = {
  id: GateId;
  title: string;
  explanation: string;
  risks: string[];
  learn: string;
  acknowledgement: string;
  signOff: boolean;
  conditions: ConditionId[];
  appliesWhen: (t: Transition, answers: Answers, facts: GateFacts) => boolean;
};

/** The sentence the Owner confirms to sign off or waive. `plan_approved` has one too, used only for waivers. */
const acknowledgement = (title: string) =>
  `I have read what ${title.toLowerCase()} means for this project and I take responsibility for this step.`;

const answerIs = (answers: Answers, id: "payments" | "personal_data" | "exposure", anyOf: string[]) =>
  typeof answers[id] === "string" && anyOf.includes(answers[id]);

const GATE_COPY = [
  {
    id: "plan_approved",
    title: "Plan approved",
    explanation:
      "Work on this card is about to start. Before agents design or build anything, the plan for this project should be written down and approved, so everyone works toward the same result and nothing is built that nobody asked for.",
    risks: [
      "Work may start on something that is not part of the plan, and the time and money spent on it are lost.",
      "Without an approved plan, nobody has agreed what done looks like for this project.",
    ],
    learn: "An approved plan is your written agreement about what will be built, for whom, and how you will know it worked.",
    signOff: false,
    conditions: ["intake_completed"],
    appliesWhen: (t) => t.from === "plan" && t.to !== "plan",
  },
  {
    id: "ready_to_ship",
    title: "Ready to ship",
    explanation:
      "Shipping means putting this work where it is meant to run, for the people it is meant for. Before that happens, the plan should be approved, no agent should be waiting for your answer, and no agent should still be changing this card.",
    risks: [
      "Unfinished or unchecked work may reach the people who use it.",
      "An agent still working on this card may change it after you have checked it.",
      "A question an agent is waiting on may hide a problem nobody has looked at yet.",
    ],
    learn: "Shipping is the step where your work leaves the workshop. You confirm that it is finished and that you have looked at it.",
    signOff: true,
    conditions: ["intake_completed", "no_pending_actions", "no_running_runs_on_card"],
    appliesWhen: (t) => t.to === "ship",
  },
  {
    id: "network_exposure",
    title: "Network exposure",
    explanation:
      "This product can be reached by other people, on your network or on the internet. Before it ships, you should have decided who is allowed to use it, because anything reachable will be found, and some visitors will try to misuse it.",
    risks: [
      "Strangers may use the product, see what it holds or change it.",
      "Automated programs constantly look for reachable products and try common weaknesses.",
      "Heavy or hostile traffic can make it slow, unavailable or expensive to run.",
    ],
    learn: "Network exposure means people other than you can reach the product. Deciding who may use it is the first protection.",
    signOff: true,
    conditions: ["decision_made:exposure_protection"],
    appliesWhen: (t, answers) => t.to === "ship" && answerIs(answers, "exposure", ["network", "internet"]),
  },
  {
    id: "payments",
    title: "Taking payments",
    explanation:
      "This product will take money from people. Before it ships, you should have decided how payments are handled, because card details are among the most sought-after data there is and handling them carries legal duties.",
    risks: [
      "Card details could leak, harming the people who trusted you with them.",
      "Payment rules and card networks can fine you or stop you from taking payments.",
      "Mistakes in charging people, such as double charges, damage trust and take time to put right.",
    ],
    learn: "Taking payments means you are responsible for people's money. A payment provider can carry most of that burden for you.",
    signOff: true,
    conditions: ["decision_made:payments_scope"],
    appliesWhen: (t, answers) => t.to === "ship" && answerIs(answers, "payments", ["yes"]),
  },
  {
    id: "personal_data",
    title: "Holding personal data",
    explanation:
      "This product will keep information about people. Before it ships, you should have decided how much of it to keep, because you must protect it, and in many places the law gives people the right to see or delete it.",
    risks: [
      "A leak can expose the people the data describes to fraud or embarrassment.",
      "Data protection laws can require you to report leaks and can impose fines.",
      "Keeping more than you need makes any leak worse.",
    ],
    learn: "Personal data is any information about a person. Keeping less of it is the simplest way to protect people.",
    signOff: true,
    conditions: ["decision_made:data_handling"],
    appliesWhen: (t, answers) =>
      t.to === "ship" && typeof answers.personal_data === "string" && answers.personal_data !== "none",
  },
  {
    id: "go_live",
    title: "Going live",
    explanation:
      "Moving this card to Operate means the work is live: people depend on it and it must be watched and kept running. Before that, the plan should be approved, no agent should be waiting for your answer, and no agent should still be changing this card.",
    risks: [
      "People may come to rely on something that is not ready for them.",
      "Problems found after going live affect real people, not just tests.",
      "An agent still working on this card may change something that is already live.",
    ],
    learn: "Going live is the moment real people start relying on the product. From here on it needs watching and care.",
    signOff: true,
    conditions: ["intake_completed", "no_pending_actions", "no_running_runs_on_card"],
    appliesWhen: (t) => t.to === "operate",
  },
  {
    id: "over_budget",
    title: "Over budget",
    explanation:
      "Agents have spent more on this project than the agent budget you set during planning. Moving work forward will likely mean more agent spend, so you are asked to confirm, with a reason, that you want to continue past your own limit.",
    risks: [
      "Spending may keep growing past what you meant to spend.",
      "The figures include estimates and runs that reported no cost, so the real spend may be higher.",
    ],
    learn: "Your agent budget is the limit you chose for this project. Going past it is allowed, but only on purpose.",
    signOff: true,
    conditions: ["within_budget"],
    appliesWhen: (_t, _answers, facts) =>
      facts.intakeCompleted && facts.budgetUsd !== null && facts.spendUsd > facts.budgetUsd,
  },
] satisfies Omit<GateDefinition, "acknowledgement">[];

export const GATES: readonly GateDefinition[] = GATE_COPY.map((g) => ({
  ...g,
  conditions: g.conditions as ConditionId[],
  acknowledgement: acknowledgement(g.title),
}));

export type ConditionResult = { id: ConditionId; label: string; met: boolean; detail: string | null };
export type GateOutcome = "pass" | "needs_sign_off" | "blocked";
export type GateEvaluation = Pick<
  GateDefinition,
  "id" | "title" | "explanation" | "risks" | "learn" | "acknowledgement" | "signOff"
> & { conditions: ConditionResult[]; met: boolean; outcome: GateOutcome };

export type GateDecisionInput = { gateId: GateId; decision: "sign_off" | "waive"; reason?: string; acknowledgement: string };
export const gateDecisionInputSchema = z
  .object({
    gateId: z.enum(GATE_IDS),
    decision: z.enum(["sign_off", "waive"]),
    reason: z.string().min(10).max(500).optional(),
    acknowledgement: z.string().max(1000),
  })
  .strict()
  .superRefine((p, ctx) => {
    if (p.decision === "waive" && p.reason === undefined) {
      ctx.addIssue({ code: "custom", message: "a reason of 10 to 500 characters is required to waive", path: ["reason"] });
    }
    if (p.decision === "sign_off" && p.reason !== undefined) {
      ctx.addIssue({ code: "custom", message: "a sign-off takes no reason", path: ["reason"] });
    }
    if (p.acknowledgement !== GATES.find((g) => g.id === p.gateId)?.acknowledgement) {
      ctx.addIssue({ code: "custom", message: "must be the gate's exact acknowledgement sentence", path: ["acknowledgement"] });
    }
  });

/** The gates a move raises, in catalog order. */
export function applicableGates(t: Transition, answers: Answers, facts: GateFacts): GateDefinition[] {
  return GATES.filter((g) => g.appliesWhen(t, answers, facts));
}

export function conditionLabel(id: ConditionId, facts: GateFacts): string {
  switch (id) {
    case "intake_completed":
      return "The plan has been approved";
    case "no_pending_actions":
      return "No agent is waiting for a decision in this project";
    case "no_running_runs_on_card":
      return "No agent is still working on this card";
    case "within_budget":
      return facts.budgetUsd === null
        ? "No budget has been set"
        : `Agent spend is within the budget you set (${formatUsd(facts.spendUsd)} of ${formatUsd(facts.budgetUsd)})`;
    default: {
      const decisionId = id.slice("decision_made:".length);
      const d = INTAKE_DECISIONS.find((x) => x.id === decisionId);
      return `You have decided: ${d?.question ?? decisionId}`;
    }
  }
}

/** pass: every condition met and no sign-off needed; needs_sign_off: met, sign-off needed; blocked: any condition unmet. */
export function outcomeOf(def: GateDefinition, conditions: ConditionResult[]): GateOutcome {
  if (!conditions.every((c) => c.met)) return "blocked";
  return def.signOff ? "needs_sign_off" : "pass";
}

/** A sign-off or waiver as the gate decisions table holds it (one row per `gate.signed_off` / `gate.waived`). */
export type GateDecision = {
  entryId: string;
  gateId: GateId;
  projectId: string;
  cardId: string;
  kind: "signed_off" | "waived";
  from: Stage;
  to: Stage;
  reason: string | null;
  decidedBy: string;
  at: string;
};

/** Everything that happened to one card: `GET /api/cards/:id/story`. */
export type CardStory = {
  card: Card;
  runs: AgentRun[];
  actions: AgentAction[];
  entries: LedgerEntry[];
  gateDecisions: GateDecision[];
  costUsd: number | null;
};

// Defined here rather than imported from events.ts, which imports this module.
const stageSchema = z.enum(STAGES);
const id = z.string().min(1);
const gateIdSchema = z.enum(GATE_IDS);

const ackMatches = (p: { gateId: GateId; acknowledgement: string }) =>
  p.acknowledgement === GATES.find((g) => g.id === p.gateId)?.acknowledgement;
const ackIssue = { message: "must be the gate's exact acknowledgement sentence", path: ["acknowledgement"] };

export const gatePayloadSchemas = {
  "gate.blocked": z
    .object({
      cardId: id,
      from: stageSchema,
      to: stageSchema,
      gates: z
        .array(
          z
            .object({
              gateId: gateIdSchema,
              outcome: z.enum(["needs_sign_off", "blocked"]),
              unmet: z.array(z.string().max(300)).max(20),
            })
            .strict(),
        )
        .min(1)
        .max(10),
    })
    .strict(),
  "gate.signed_off": z
    .object({
      gateId: gateIdSchema,
      cardId: id,
      from: stageSchema,
      to: stageSchema,
      conditions: z.array(z.string().max(300)).max(20),
      acknowledgement: z.string().max(1000),
      signedBy: z.string().min(1).max(200),
    })
    .strict()
    .refine(ackMatches, ackIssue),
  "gate.waived": z
    .object({
      gateId: gateIdSchema,
      cardId: id,
      from: stageSchema,
      to: stageSchema,
      unmet: z.array(z.string().max(300)).min(1).max(20),
      reason: z.string().min(10).max(500),
      acknowledgement: z.string().max(1000),
      waivedBy: z.string().min(1).max(200),
    })
    .strict()
    .refine(ackMatches, ackIssue),
};
export type GateEventType = keyof typeof gatePayloadSchemas;
