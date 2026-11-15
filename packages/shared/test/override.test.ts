import { describe, expect, it } from "vitest";
import { OVERRIDE_MEANS, OVERRIDE_PROGRAM, OVERRIDE_REASON, overridePayloadSchemas } from "../src/index.js";

const reason = "The agent left a server running";
const command = { overrideId: "o1", runId: "r1", program: "git", args: ["status"], cwd: ".", reason };
const discard = { overrideId: "o1", runId: "r1", reason, files: 3 };
const completed = { overrideId: "o1", runId: "r1", ok: true, exitCode: 0, signal: null, timedOut: false, durationMs: 12, output: "ok" };

describe("override payloads", () => {
  it("accepts a valid payload of each type", () => {
    expect(overridePayloadSchemas["override.command"].safeParse(command).success).toBe(true);
    expect(overridePayloadSchemas["override.discard"].safeParse(discard).success).toBe(true);
    expect(overridePayloadSchemas["override.completed"].safeParse(completed).success).toBe(true);
  });

  it("needs a reason of 10 to 500 characters", () => {
    expect(OVERRIDE_REASON.safeParse("x".repeat(9)).success).toBe(false);
    expect(OVERRIDE_REASON.safeParse("x".repeat(10)).success).toBe(true);
    expect(OVERRIDE_REASON.safeParse("x".repeat(501)).success).toBe(false);
    expect(overridePayloadSchemas["override.command"].safeParse({ ...command, reason: "too short" }).success).toBe(false);
    expect(overridePayloadSchemas["override.discard"].safeParse({ ...discard, reason: "too short" }).success).toBe(false);
  });

  it("refuses more than 64 arguments", () => {
    const schema = overridePayloadSchemas["override.command"];
    expect(schema.safeParse({ ...command, args: Array(64).fill("a") }).success).toBe(true);
    expect(schema.safeParse({ ...command, args: Array(65).fill("a") }).success).toBe(false);
  });

  it("caps the recorded output at 16,000 characters", () => {
    const schema = overridePayloadSchemas["override.completed"];
    expect(schema.safeParse({ ...completed, output: "x".repeat(16000) }).success).toBe(true);
    expect(schema.safeParse({ ...completed, output: "x".repeat(16001) }).success).toBe(false);
  });

  it("records a kill by signal", () => {
    const killed = { ...completed, ok: false, exitCode: null, signal: "SIGKILL", timedOut: true };
    expect(overridePayloadSchemas["override.completed"].safeParse(killed).success).toBe(true);
  });

  it("refuses extra keys and a negative file count", () => {
    expect(overridePayloadSchemas["override.discard"].safeParse({ ...discard, extra: 1 }).success).toBe(false);
    expect(overridePayloadSchemas["override.discard"].safeParse({ ...discard, files: -1 }).success).toBe(false);
  });
});

describe("OVERRIDE_PROGRAM", () => {
  it("matches a bare program name only", () => {
    for (const ok of ["git", "node", "npm", "python3.12", "g++", "kill_all-now"]) expect(OVERRIDE_PROGRAM.test(ok), ok).toBe(true);
    for (const bad of ["", "a b", "../x", "/usr/bin/git", "x;y", "x".repeat(101)]) expect(OVERRIDE_PROGRAM.test(bad), bad).toBe(false);
  });
});

describe("OVERRIDE_MEANS", () => {
  it("says what an override is, in exact words", () => {
    expect(OVERRIDE_MEANS).toBe(
      "An emergency override is you acting directly on the project instead of asking an agent. It is recorded in red in the ledger as an exception, with your reason.",
    );
  });
});
