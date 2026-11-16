import { PROGRESS_LIMITS, type RunProgress } from "@theterminal/shared";

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
].join("\n");

export type ProgressLine =
  | { kind: "plan"; steps: string[] }
  | { kind: "step"; n: number; of: number; state: "started" | "done" };

const PLAN = /^\[\[plan: (.+)\]\]$/;
const STEP = /^\[\[step ([1-9]\d?)\/([1-9]\d?) (started|done)\]\]$/;

/** Reads one line as a plan or a step marker; anything else, a marker mid-line included, is null. */
export function parseProgressLine(line: string): ProgressLine | null {
  const t = line.trim();
  const plan = PLAN.exec(t);
  if (plan) {
    const steps = plan[1]!.split("|").map((s) => s.trim());
    return steps.some((s) => s === "") ? null : { kind: "plan", steps };
  }
  const step = STEP.exec(t);
  if (step) return { kind: "step", n: Number(step[1]), of: Number(step[2]), state: step[3] as "started" | "done" };
  return null;
}

/** The longest unfinished line kept between chunks, to join a marker a streaming adapter split. */
const MAX_CARRY = 400;
const MARKER_STARTS = ["[[plan: ", "[[step "];

/** Whether an unfinished line could still become a marker: a prefix of a marker's start, or a line that starts like one. */
function couldBeMarker(partial: string): boolean {
  const t = partial.trimStart();
  return t !== "" && MARKER_STARTS.some((m) => m.startsWith(t) || t.startsWith(m));
}

/**
 * Follows one run's step reports. The first plan wins and keeps its first `PROGRESS_LIMITS.maxSteps` steps, each passed
 * through `cleanStep`; a step line counts only when its total is the number of steps the agent stated and its number
 * is within the kept steps. `started` sets the current step; `done` adds the step to the done set (and clears it as
 * the current one). `feed` returns a new snapshot only when something changed.
 *
 * Lines are read whole. A message's last line without a newline is read at once when it is a marker on its own (an
 * adapter that sends whole messages); otherwise it is kept, at most 400 characters and only while it could still be a
 * marker, and joined to the start of the next chunk (an adapter that streams a message in pieces).
 */
export class ProgressTracker {
  private steps: string[] | null = null;
  private stated = 0;
  private done: number[] = [];
  private current: number | null = null;
  private carry = "";

  constructor(private readonly cleanStep: (s: string) => string) {}

  feed(text: string): RunProgress | null {
    const lines = (this.carry + text).split("\n");
    const last = lines.pop()!;
    this.carry = "";
    let changed = false;
    for (const line of lines) changed = this.apply(line) || changed;
    if (parseProgressLine(last)) changed = this.apply(last) || changed;
    else if (last.length <= MAX_CARRY && couldBeMarker(last)) this.carry = last;
    return changed ? this.snapshot() : null;
  }

  private apply(line: string): boolean {
    const m = parseProgressLine(line);
    if (!m) return false;
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
