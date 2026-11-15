import { describe, expect, it } from "vitest";
import { visibleControls } from "@theterminal/shared";
import { ProgressTracker, STEP_PLAN_INSTRUCTION, parseProgressLine } from "../../src/agents/progress.js";
import { redact, truncate } from "../../src/agents/redact.js";

const FAKE_KEY = "sk-ant-TESTKEY0123456789abcdef";
/** The runner's step cleaning without the path scrub: redact, make controls visible, at most 80 characters. */
const cleanStep = (s: string) => truncate(visibleControls(redact(s)), 80);
const tracker = () => new ProgressTracker(cleanStep);

describe("STEP_PLAN_INSTRUCTION", () => {
  it("starts with the fixed separator and asks for the plan and step lines", () => {
    expect(STEP_PLAN_INSTRUCTION.startsWith("\n\n---\nProgress for The Terminal:")).toBe(true);
    expect(STEP_PLAN_INSTRUCTION).toContain("[[plan: ");
    expect(STEP_PLAN_INSTRUCTION).toContain("[[step n/m started]]");
    expect(STEP_PLAN_INSTRUCTION).toContain("[[step n/m done]]");
    expect(STEP_PLAN_INSTRUCTION).toMatch(/3 to 7/);
    expect(STEP_PLAN_INSTRUCTION).toMatch(/80 characters/);
    expect(STEP_PLAN_INSTRUCTION).toMatch(/secret/i);
  });
});

describe("parseProgressLine", () => {
  it("reads a plan and a step on a trimmed line", () => {
    expect(parseProgressLine("[[plan: a | b | c]]")).toEqual({ kind: "plan", steps: ["a", "b", "c"] });
    expect(parseProgressLine("  [[step 2/3 done]] ")).toEqual({ kind: "step", n: 2, of: 3, state: "done" });
    expect(parseProgressLine("[[step 1/3 started]]")).toEqual({ kind: "step", n: 1, of: 3, state: "started" });
  });

  it("refuses a zero step, a marker mid-line and an empty plan step", () => {
    expect(parseProgressLine("[[step 0/3 done]]")).toBeNull();
    expect(parseProgressLine("x [[step 1/3 done]]")).toBeNull();
    expect(parseProgressLine("[[step 1/3 done]] later")).toBeNull();
    expect(parseProgressLine("[[plan: a || b]]")).toBeNull();
    expect(parseProgressLine("[[plan: a | ]]")).toBeNull();
    expect(parseProgressLine("[[step 1/3 finished]]")).toBeNull();
    expect(parseProgressLine("")).toBeNull();
  });
});

describe("ProgressTracker", () => {
  it("follows a plan through started and done, and records nothing for a line that changes nothing", () => {
    const t = tracker();
    expect(t.feed("[[plan: Read | Fix | Test]]")).toEqual({ steps: ["Read", "Fix", "Test"], done: [], current: null });
    expect(t.feed("[[step 1/3 started]]")).toEqual({ steps: ["Read", "Fix", "Test"], done: [], current: 1 });
    expect(t.feed("[[step 1/3 done]]")).toEqual({ steps: ["Read", "Fix", "Test"], done: [1], current: null });
    expect(t.feed("[[step 1/3 done]]")).toBeNull();
    expect(t.feed("[[step 2/4 started]]")).toBeNull(); // wrong total
    expect(t.feed("[[plan: Other | Plan | Here]]")).toBeNull(); // the first plan wins
    expect(t.feed("[[step 3/3 done]]")).toEqual({ steps: ["Read", "Fix", "Test"], done: [1, 3], current: null });
  });

  it("ignores a step before any plan", () => {
    const t = tracker();
    expect(t.feed("[[step 1/3 started]]")).toBeNull();
  });

  it("keeps the first 7 steps of a longer plan, and counts only steps that fit them", () => {
    const t = tracker();
    const first = t.feed("[[plan: s1 | s2 | s3 | s4 | s5 | s6 | s7 | s8 | s9]]");
    expect(first).toEqual({ steps: ["s1", "s2", "s3", "s4", "s5", "s6", "s7"], done: [], current: null });
    expect(t.feed("[[step 8/9 started]]")).toBeNull();
    expect(t.feed("[[step 7/7 done]]")).toBeNull(); // the agent stated 9
    expect(t.feed("[[step 7/9 done]]")).toEqual({ steps: first!.steps, done: [7], current: null });
  });

  it("joins a marker split across two chunks, and counts it once", () => {
    const t = tracker();
    t.feed("[[plan: a | b | c]]\n");
    expect(t.feed("[[step 1/3 do")).toBeNull();
    expect(t.feed("ne]]\n")).toEqual({ steps: ["a", "b", "c"], done: [1], current: null });
    expect(t.feed("\n")).toBeNull();
  });

  it("reads markers among other lines of one message", () => {
    const t = tracker();
    expect(t.feed("Here is my plan.\n[[plan: a | b | c]]\nStarting now.\n[[step 1/3 started]]\nok")).toEqual({
      steps: ["a", "b", "c"], done: [], current: 1,
    });
  });

  it("does not join a finished message to the next one", () => {
    const t = tracker();
    t.feed("Let me look.");
    expect(t.feed("[[plan: a | b | c]]")).toEqual({ steps: ["a", "b", "c"], done: [], current: null });
  });

  it("ignores a marker mid-line, in one message or across chunks", () => {
    const t = tracker();
    t.feed("[[plan: a | b | c]]");
    expect(t.feed("I will [[step 1/3 done]] later")).toBeNull();
    expect(t.feed("[[step 1/3 do")).toBeNull();
    expect(t.feed("ne]] and more\n")).toBeNull();
  });

  it("drops a carry longer than 400 characters", () => {
    const t = tracker();
    t.feed("[[plan: a | b | c]]");
    expect(t.feed(`[[step 1/3 ${"x".repeat(400)}`)).toBeNull();
    expect(t.feed("done]]\n")).toBeNull();
  });

  it("records a step text escaped, redacted and at most 80 characters", () => {
    const t = tracker();
    const snap = t.feed(`[[plan: Read \u202e ${FAKE_KEY} ${"y".repeat(100)} | Fix | Test]]`)!;
    const step = snap.steps[0]!;
    expect(step).not.toContain("\u202e");
    expect(step).toContain(visibleControls("\u202e"));
    expect(step).not.toContain("TESTKEY");
    expect(step.length).toBeLessThanOrEqual(80);
  });
});
