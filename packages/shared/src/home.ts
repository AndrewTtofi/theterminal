import { actionPhrase, type ActionLike } from "./narration.js";
import type { AgentRun, RunProgress } from "./agents.js";

/** `s`, or its first `max - 1` characters and an ellipsis when it is longer than `max`. */
export function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  if (max <= 0) return "";
  return `${s.slice(0, max - 1)}…`;
}

/** Whole percent done: `floor(100 * done / steps)`; null when there is no plan. */
export function progressPercent(p: RunProgress | null | undefined): number | null {
  if (!p || p.steps.length === 0) return null;
  return Math.floor((100 * p.done.length) / p.steps.length);
}

/** The text of the step in hand, or null. */
export function currentStep(p: RunProgress | null | undefined): string | null {
  if (!p || p.current === null) return null;
  return p.steps[p.current - 1] ?? null;
}

/** The first plan step, else the first non-empty line of the prompt, at most 60 characters. */
export function jobTitle(run: Pick<AgentRun, "prompt" | "progress">): string {
  const first = run.progress?.steps[0];
  if (first) return first;
  const line = run.prompt.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  return clip(line, 60);
}

/** What the agent is doing, with a capital; the UI prefixes "Now:". */
export function nowLine(a: ActionLike | null): string | null {
  if (!a) return null;
  const phrase = actionPhrase(a);
  return phrase.charAt(0).toUpperCase() + phrase.slice(1);
}

/** A whole line that is one of the agent's markers (`[[noted]]`, `[[step 1/2 done]]`, …): protocol, not prose. */
const MARKER_LINE = /^\[\[[^\]]*\]\]$/;

/**
 * The agent's last message without its marker lines (at most 200 characters), else the headline. A marker inside a
 * sentence stays: only whole lines are protocol.
 */
export function finalSummary(lastMessage: string | null | undefined, finishedHeadline: string): string {
  const text = (lastMessage ?? "")
    .split(/\r?\n/)
    .filter((l) => !MARKER_LINE.test(l.trim()))
    .join("\n")
    .trim();
  return text ? clip(text, 200) : finishedHeadline;
}

/** Done steps over all steps of the running runs that have a plan. */
export function overallProgress(
  runs: Pick<AgentRun, "status" | "progress">[],
): { percent: number | null; withPlan: number; withoutPlan: number } {
  let done = 0;
  let steps = 0;
  let withPlan = 0;
  let withoutPlan = 0;
  for (const r of runs) {
    if (r.status !== "running") continue;
    if (r.progress && r.progress.steps.length > 0) {
      withPlan++;
      done += r.progress.done.length;
      steps += r.progress.steps.length;
    } else withoutPlan++;
  }
  return { percent: steps === 0 ? null : Math.floor((100 * done) / steps), withPlan, withoutPlan };
}
