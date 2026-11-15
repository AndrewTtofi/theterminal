import { describe, expect, it } from "vitest";
import {
  agentPayloadSchemas,
  clip,
  currentStep,
  finalSummary,
  jobTitle,
  nowLine,
  overallProgress,
  PROGRESS_LIMITS,
  progressPercent,
  type RunProgress,
} from "../src/index.js";

const p = (steps: string[], done: number[], current: number | null): RunProgress => ({ steps, done, current });
const schema = agentPayloadSchemas["agent.progress"];

describe("progressPercent", () => {
  it("floors done over steps", () => {
    expect(progressPercent(p(["a", "b", "c"], [1], 2))).toBe(33);
    expect(progressPercent(p(["a", "b", "c"], [1, 2, 3], null))).toBe(100);
    expect(progressPercent(null)).toBeNull();
    expect(progressPercent(undefined)).toBeNull();
  });
});

describe("agent.progress schema", () => {
  const ok = { runId: "r1", steps: ["a", "b", "c"], done: [1], current: 2 };
  it("accepts a valid snapshot", () => {
    expect(schema.safeParse(ok).success).toBe(true);
    expect(schema.safeParse({ ...ok, done: [], current: null }).success).toBe(true);
  });
  it("rejects bad shapes", () => {
    expect(PROGRESS_LIMITS).toEqual({ maxSteps: 7, stepChars: 80 });
    expect(schema.safeParse({ ...ok, steps: Array(8).fill("a") }).success).toBe(false);
    expect(schema.safeParse({ ...ok, steps: ["a".repeat(81)] }).success).toBe(false);
    expect(schema.safeParse({ ...ok, done: [2, 2] }).success).toBe(false);
    expect(schema.safeParse({ ...ok, done: [2, 1] }).success).toBe(false);
    expect(schema.safeParse({ ...ok, done: [4] }).success).toBe(false);
    expect(schema.safeParse({ ...ok, current: 4 }).success).toBe(false);
    expect(schema.safeParse({ ...ok, extra: 1 }).success).toBe(false);
  });
});

describe("text helpers", () => {
  it("clips with an ellipsis", () => {
    expect(clip("abc", 3)).toBe("abc");
    expect(clip("abcd", 3)).toBe("ab…");
  });
  it("titles a job", () => {
    expect(jobTitle({ prompt: "Fix the login\nmore", progress: null })).toBe("Fix the login");
    const t = jobTitle({ prompt: "x".repeat(70), progress: null });
    expect(t).toHaveLength(60);
    expect(t.endsWith("…")).toBe(true);
    expect(jobTitle({ prompt: "\n  \nreal", progress: undefined })).toBe("real");
    expect(jobTitle({ prompt: "x", progress: p(["Plan A", "b"], [], 1) })).toBe("Plan A");
  });
  it("summarises", () => {
    expect(finalSummary(null, "Claude finished")).toBe("Claude finished");
    expect(finalSummary("y".repeat(250), "h")).toHaveLength(200);
  });
  it("phrases the current action", () => {
    expect(nowLine(null)).toBeNull();
    expect(nowLine({ kind: "other", tool: "t", summary: "check the build", input: {} })).toBe("Check the build");
  });
  it("reads the current step", () => {
    expect(currentStep(p(["a", "b"], [1], 2))).toBe("b");
    expect(currentStep(p(["a"], [1], null))).toBeNull();
    expect(currentStep(null)).toBeNull();
  });
});

describe("overallProgress", () => {
  it("sums running runs with a plan", () => {
    const r = overallProgress([
      { status: "running", progress: p(["a", "b"], [1], 2) },
      { status: "running", progress: p(["a", "b", "c", "d"], [1, 2, 3], 4) },
      { status: "running", progress: null },
      { status: "completed", progress: p(["a"], [1], null) },
    ]);
    expect(r).toEqual({ percent: 66, withPlan: 2, withoutPlan: 1 });
    expect(overallProgress([{ status: "running" }])).toEqual({ percent: null, withPlan: 0, withoutPlan: 1 });
  });
});
