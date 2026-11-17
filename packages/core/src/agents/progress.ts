import { PROGRESS_LIMITS, type RunProgress } from "@theterminal/shared";
import { LineReader, parseProgressLine, type ProgressLine } from "./markers.js";

/**
 * Step reports: the one fixed instruction the runner appends to every prompt it gives an adapter, and the reader that
 * turns the agent's own `[[plan: …]]` and `[[step n/m …]]` lines into progress snapshots. Only whole lines of the
 * agent's messages are read (the runner never feeds tool output), and a step must fit the plan the agent stated.
 */

export const STEP_PLAN_INSTRUCTION = [
  "",
  "",
  "---",
  "Progress for The Terminal:",
  "Before you start, write your plan of 3 to 7 short steps as one line of its own, exactly like this:",
  "[[plan: step one | step two | step three]]",
  "Then, on lines of their own, write [[step n/m started]] when you start step n of m and [[step n/m done]] when it is finished.",
  "Keep each step under 80 characters, in plain words, and never put secrets, keys or passwords in them.",
  "You may also write these lines, each on a line of its own:",
  "[[card: short title]] to put this work on the project's board (only if this run has no card yet; it may already have one).",
  "[[card-stage: plan]] to move the card to a stage: plan, design, build, ship or operate.",
  "[[card-done]] when the card's work is finished.",
  "[[preview: npm run dev | port 5173]] to say how to start the website and its port (npm run, pnpm run, yarn run or npx only).",
  "[[app: ios <scheme or path>]] or [[app: android <module>]] to say which phone app to build.",
  "[[noted]] after you read notes from people about the card.",
  "Never put secrets, keys or passwords in any of these lines.",
].join("\n");

export type { ProgressLine };
export { parseProgressLine };

/**
 * Follows one run's step reports. The first plan wins and keeps its first `PROGRESS_LIMITS.maxSteps` steps, each passed
 * through `cleanStep`; a step line counts only when its total is the number of steps the agent stated and its number
 * is within the kept steps. `started` sets the current step; `done` adds the step to the done set (and clears it as
 * the current one). `feed` returns a new snapshot only when something changed.
 *
 * `feed` reads whole lines through its own `LineReader` (see `markers.ts`); `apply` takes one line the caller already
 * parsed, for a runner that reads every marker once.
 */
export class ProgressTracker {
  private steps: string[] | null = null;
  private stated = 0;
  private done: number[] = [];
  private current: number | null = null;
  private readonly lines = new LineReader();

  constructor(private readonly cleanStep: (s: string) => string) {}

  feed(text: string): RunProgress | null {
    let changed = false;
    for (const line of this.lines.feed(text)) {
      const m = parseProgressLine(line);
      if (m) changed = this.change(m) || changed;
    }
    return changed ? this.snapshot() : null;
  }

  /** Applies one plan or step line; a new snapshot when it changed something, else null. */
  apply(m: ProgressLine): RunProgress | null {
    return this.change(m) ? this.snapshot() : null;
  }

  private change(m: ProgressLine): boolean {
    if (m.kind === "plan") {
      if (this.steps !== null) return false;
      const steps = m.steps.slice(0, PROGRESS_LIMITS.maxSteps).map((s) => this.cleanStep(s));
      if (steps.some((s) => s === "")) return false;
      this.steps = steps;
      this.stated = m.steps.length;
      return true;
    }
    if (this.steps === null || m.of !== this.stated || m.n > this.steps.length) return false;
    if (m.state === "started") {
      if (this.current === m.n) return false;
      this.current = m.n;
      return true;
    }
    if (this.done.includes(m.n)) return false;
    this.done = [...this.done, m.n].sort((a, b) => a - b);
    if (this.current === m.n) this.current = null;
    return true;
  }

  private snapshot(): RunProgress {
    return { steps: [...this.steps!], done: [...this.done], current: this.current };
  }
}
