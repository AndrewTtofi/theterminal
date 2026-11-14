import { describe, expect, it } from "vitest";
import { CLAUDE_SUBSCRIPTION_ACK, eventPayloadSchemas } from "../src/index.js";

const ok = (type: keyof typeof eventPayloadSchemas, payload: unknown) =>
  expect(eventPayloadSchemas[type]!.safeParse(payload).success).toBe(true);
const bad = (type: keyof typeof eventPayloadSchemas, payload: unknown) =>
  expect(eventPayloadSchemas[type]!.safeParse(payload).success).toBe(false);

const started = {
  runId: "r1",
  adapter: "fake",
  authMode: "none",
  prompt: "do it",
  cardId: null,
  worktree: "worktrees/r1",
};

describe("agent.started", () => {
  it("accepts a valid payload", () => ok("agent.started", started));
  it("rejects absolute and unsafe worktrees", () => {
    for (const w of ["/abs/path", "\\share\\x", "C:\\x", "c:/x", "a/../b", ".."]) {
      bad("agent.started", { ...started, worktree: w });
    }
  });
  it("rejects empty or oversize prompt, unknown adapter, extra keys", () => {
    bad("agent.started", { ...started, prompt: "" });
    bad("agent.started", { ...started, prompt: "x".repeat(20001) });
    bad("agent.started", { ...started, adapter: "other" });
    bad("agent.started", { ...started, extra: 1 });
  });
});

describe("agent.message", () => {
  it("accepts empty text up to 4000", () => {
    ok("agent.message", { runId: "r1", text: "" });
    ok("agent.message", { runId: "r1", text: "x".repeat(4000) });
  });
  it("rejects longer text", () => bad("agent.message", { runId: "r1", text: "x".repeat(4001) }));
});

describe("agent.action.requested", () => {
  const base = { runId: "r1", actionId: "a1", kind: "shell", tool: "Bash", summary: "ls", input: { cmd: "ls" } };
  it("accepts any JSON input", () => {
    ok("agent.action.requested", base);
    ok("agent.action.requested", { ...base, input: [1, "a", null] });
    ok("agent.action.requested", { ...base, input: null });
  });
  it("rejects non-JSON input and bad kind", () => {
    bad("agent.action.requested", { ...base, input: () => 1 });
    bad("agent.action.requested", { ...base, input: undefined });
    bad("agent.action.requested", { ...base, kind: "nope" });
    bad("agent.action.requested", { ...base, summary: "" });
  });
});

describe("agent.action.decided", () => {
  const base = { runId: "r1", actionId: "a1", decision: "allow", by: "human", reason: "" };
  it("accepts", () => ok("agent.action.decided", base));
  it("rejects bad decision or long reason", () => {
    bad("agent.action.decided", { ...base, decision: "maybe" });
    bad("agent.action.decided", { ...base, reason: "x".repeat(501) });
  });
});

describe("agent.action.completed", () => {
  it("accepts and rejects", () => {
    ok("agent.action.completed", { runId: "r1", actionId: "a1", ok: true, output: "" });
    bad("agent.action.completed", { runId: "r1", actionId: "a1", ok: "yes", output: "" });
    bad("agent.action.completed", { runId: "r1", actionId: "a1", ok: true, output: "x".repeat(4001) });
  });
});

describe("agent.finished", () => {
  it("accepts and rejects", () => {
    ok("agent.finished", { runId: "r1", status: "completed", costUsd: 0.5, error: null });
    ok("agent.finished", { runId: "r1", status: "failed", costUsd: null, error: "boom" });
    bad("agent.finished", { runId: "r1", status: "running", costUsd: null, error: null });
    bad("agent.finished", { runId: "r1", status: "failed", costUsd: null, error: "x".repeat(1001) });
  });
});

describe("settings.claude_auth_changed", () => {
  it("accepts api_key with any acknowledgement", () =>
    ok("settings.claude_auth_changed", { mode: "api_key", acknowledgement: "" }));
  it("accepts subscription only with the exact acknowledgement", () => {
    ok("settings.claude_auth_changed", { mode: "subscription", acknowledgement: CLAUDE_SUBSCRIPTION_ACK });
    bad("settings.claude_auth_changed", { mode: "subscription", acknowledgement: "yes" });
    bad("settings.claude_auth_changed", { mode: "subscription", acknowledgement: "" });
  });
});
