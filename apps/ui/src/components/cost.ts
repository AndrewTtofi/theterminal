import { formatUsd, plural } from "@theterminal/shared";
import type { AdapterId, AgentRun } from "@theterminal/shared";

/** Where a cost comes from: the provider's own figure, or an estimate (Claude's Agent SDK, the test double). */
export type CostBasis = "reported" | "estimate";

/** Adapters whose cost is the provider's own figure; any other is an estimate. Matches the Capacity report. */
const REPORTS_OWN_COST: ReadonlySet<AdapterId> = new Set(["codex", "gemini"]);

/** A run's cost basis; null when it reported no cost. */
export function costBasis(r: AgentRun): CostBasis | null {
  if (r.costUsd === null) return null;
  return REPORTS_OWN_COST.has(r.adapter) ? "reported" : "estimate";
}

/** `$0.50 (estimate)`, or `cost not reported`: never `$0.00` for a run that reported nothing. */
export function runCost(r: AgentRun): string {
  const basis = costBasis(r);
  return r.costUsd === null || basis === null ? "cost not reported" : `${formatUsd(r.costUsd)} (${basis})`;
}

/**
 * What a project's agents have cost: the sum of the costs runs reported, labelled `estimate` unless every one of
 * them was the provider's own figure, and how many runs reported none (never counted as $0).
 */
export function spendLine(runs: AgentRun[]): string {
  if (runs.length === 0) return "No agent spend recorded yet";
  const costed = runs.filter((r) => r.costUsd !== null);
  const count = plural(runs.length, "run");
  if (costed.length === 0) return `Agent spend: not reported · ${count}`;
  const sum = costed.reduce((a, r) => a + (r.costUsd ?? 0), 0);
  const basis: CostBasis = costed.every((r) => costBasis(r) === "reported") ? "reported" : "estimate";
  const missing = runs.length - costed.length;
  return `Agent spend: ${formatUsd(sum)} (${basis}) · ${count}${missing > 0 ? `, ${missing} did not report a cost` : ""}`;
}
