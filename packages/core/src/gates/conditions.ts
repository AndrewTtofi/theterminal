import {
  INTAKE_DECISIONS, conditionLabel, formatUsd, plural,
  type Answers, type ConditionId, type ConditionResult, type Decisions, type GateFacts,
} from "@theterminal/shared";
import type { Db } from "../db.js";
import { countPendingActions, countRunningRuns, getIntake, projectSpendUsd } from "../events/projections.js";

/**
 * What the gates of a project are evaluated against, all read from projections of the ledger: the intake's answers
 * and decisions (empty when there is none), whether it is completed, its agent budget, and the project's agent spend.
 */
export function gateFacts(db: Db, projectId: string): { answers: Answers; decisions: Decisions; facts: GateFacts } {
  const state = getIntake(db, projectId);
  const answers = Object.fromEntries(Object.entries(state?.answers ?? {}).map(([k, v]) => [k, v!.answer])) as Answers;
  const decisions = Object.fromEntries(Object.entries(state?.decisions ?? {}).map(([k, v]) => [k, v!.chosen])) as Decisions;
  const budget = answers.budget_usd;
  return {
    answers,
    decisions,
    facts: {
      intakeCompleted: state?.intake.status === "completed",
      budgetUsd: typeof budget === "number" ? budget : null,
      spendUsd: projectSpendUsd(db, projectId),
    },
  };
}

/** Runs of the project with no cost: still running, or finished without reporting one. Their spend counts as $0. */
function countRunsWithoutCost(db: Db, projectId: string): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM agent_runs WHERE project_id = ? AND cost_usd IS NULL").get(projectId) as {
    n: number;
  }).n;
}

/**
 * Each condition in order, with its catalog label. Every string comes from the catalog, a count or a formatted
 * amount, never from text anyone typed.
 */
export function evaluateConditions(
  db: Db,
  ids: ConditionId[],
  ctx: { projectId: string; cardId: string; facts: GateFacts; decisions: Decisions },
): ConditionResult[] {
  return ids.map((id) => {
    const { met, detail } = check(db, id, ctx);
    return { id, label: conditionLabel(id, ctx.facts), met, detail };
  });
}

function check(
  db: Db,
  id: ConditionId,
  ctx: { projectId: string; cardId: string; facts: GateFacts; decisions: Decisions },
): { met: boolean; detail: string | null } {
  switch (id) {
    case "intake_completed": {
      if (ctx.facts.intakeCompleted) return { met: true, detail: null };
      const written = getIntake(db, ctx.projectId) !== null;
      return {
        met: false,
        detail: written ? "The plan is written but not approved yet" : "No plan has been written for this project yet",
      };
    }
    case "no_pending_actions": {
      const n = countPendingActions(db, ctx.projectId);
      return n === 0 ? { met: true, detail: null } : { met: false, detail: `${plural(n, "decision")} ${n === 1 ? "is" : "are"} waiting` };
    }
    case "no_running_runs_on_card": {
      const n = countRunningRuns(db, ctx.cardId);
      return n === 0
        ? { met: true, detail: null }
        : { met: false, detail: `${plural(n, "agent run")} ${n === 1 ? "is" : "are"} still running` };
    }
    case "within_budget": {
      const { budgetUsd, spendUsd } = ctx.facts;
      if (budgetUsd === null) return { met: true, detail: null };
      const met = spendUsd <= budgetUsd;
      const noCost = countRunsWithoutCost(db, ctx.projectId);
      const parts = [
        ...(met ? [] : [`Over by ${formatUsd(spendUsd - budgetUsd)}.`]),
        "Includes estimates.",
        ...(noCost > 0 ? [`${plural(noCost, "run")} reported no cost, so the real spend may be higher.`] : []),
      ];
      return { met, detail: parts.join(" ") };
    }
    default: {
      const decisionId = id.slice("decision_made:".length) as keyof Decisions;
      const chosen = ctx.decisions[decisionId];
      if (chosen === undefined) return { met: false, detail: null };
      const label = INTAKE_DECISIONS.find((d) => d.id === decisionId)?.options.find((o) => o.id === chosen)?.label;
      return { met: true, detail: label === undefined ? null : `Chosen: ${label}` };
    }
  }
}
