import {
  INTAKE_DECISIONS,
  INTAKE_QUESTIONS,
  applicableDecisions,
  intakeStep,
  planSummary,
  proposedCards,
  recommendedOption,
  renderAnswer,
} from "@theterminal/shared";
import type { Answers, Decisions, IntakeView } from "@theterminal/shared";

export const ALL_ANSWERS: Answers = {
  audience: "members of a book club",
  outcome: "keep a shared reading list",
  success: "the club picks its next book in the app",
  platform: ["web"],
  payments: "no",
  personal_data: "none",
  exposure: "private",
  budget_usd: 25,
};

const AT = "2026-11-15T10:00:00.000Z";

/** An intake view as the server builds it, from answers and decisions. */
export function intakeView(
  answers: Answers = {},
  decisions: Decisions = {},
  opts: { completed?: boolean; problem?: string | null; name?: string } = {},
): IntakeView {
  const status = opts.completed ? "completed" : "open";
  const step = intakeStep(status, answers, decisions);
  const name = opts.name ?? "Book Club";
  const summary = planSummary(name, answers, decisions);
  return {
    intake: {
      id: "i1", projectId: "p1", idea: "a reading list for a book club", status,
      summary: opts.completed ? summary : null, createdAt: AT, updatedAt: AT, completedAt: opts.completed ? AT : null,
    },
    step,
    questions: INTAKE_QUESTIONS.map((q) => ({ ...q, answer: answers[q.id] ?? null, answeredAt: answers[q.id] === undefined ? null : AT })),
    decisions: applicableDecisions(answers).map(({ appliesWhen: _a, recommend: _r, ...d }) => {
      const full = INTAKE_DECISIONS.find((x) => x.id === d.id)!;
      const chosen = decisions[d.id] ?? null;
      return {
        ...d,
        recommended: recommendedOption(full, answers),
        because: d.dependsOn.flatMap((qid) => {
          const a = answers[qid];
          const q = INTAKE_QUESTIONS.find((x) => x.id === qid)!;
          return a === undefined ? [] : [{ label: q.label, answer: renderAnswer(q, a) }];
        }),
        chosen,
        rationale: chosen === null ? null : "",
        owner: chosen === null ? null : "owner",
        decidedAt: chosen === null ? null : AT,
      };
    }),
    plan:
      step === "approve" || step === "completed"
        ? { summary, cards: proposedCards(answers, decisions), problem: opts.problem ?? null }
        : null,
  };
}

export const APPROVED_AT = AT;
