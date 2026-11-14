import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { LedgerEntry } from "@theterminal/shared";
import { LedgerPanel, describeEntry } from "../src/components/LedgerPanel";

const base = { id: "x", ts: "2026-01-01T10:00:00Z", projectId: "p1", prevHash: "", hash: "" };
const owner = { kind: "human", id: "owner" } as const;
const entry = (seq: number, type: LedgerEntry["type"], payload: unknown, actor: LedgerEntry["actor"] = owner): LedgerEntry => ({
  ...base,
  seq,
  type,
  payload,
  actor,
});

describe("describeEntry", () => {
  it("describes each event type", () => {
    expect(describeEntry(entry(1, "project.created", { name: "Demo" }))).toBe('Owner created project "Demo"');
    expect(describeEntry(entry(2, "card.created", { title: "Detect GPU", stage: "plan" }))).toBe(
      'Owner added "Detect GPU" to Plan',
    );
    expect(describeEntry(entry(3, "card.moved", { from: "plan", to: "build" }))).toBe(
      "Owner moved a card from Plan to Build",
    );
    expect(describeEntry(entry(4, "card.status_changed", { from: "todo", to: "done" }))).toBe(
      "Owner marked a card done",
    );
  });

  it("shows agent actors as Agent <id>", () => {
    const e = entry(5, "card.moved", { from: "build", to: "ship" }, { kind: "agent", id: "a7" });
    expect(describeEntry(e)).toBe("Agent a7 moved a card from Build to Ship");
  });
});

describe("describeEntry agent events", () => {
  const agent = { kind: "agent", id: "abcdef123456" } as const;
  const policy = { kind: "system", id: "policy" } as const;
  const runner = { kind: "system", id: "runner" } as const;

  it("describes agent.started with capitalised adapter and truncated prompt", () => {
    expect(describeEntry(entry(1, "agent.started", { adapter: "claude", prompt: "Fix it" }))).toBe(
      'Owner started a Claude agent: "Fix it"',
    );
    const long = "x".repeat(70);
    expect(describeEntry(entry(2, "agent.started", { adapter: "fake", prompt: long }))).toBe(
      `Owner started a Fake agent: "${"x".repeat(60)}…"`,
    );
  });

  it("describes requests, decisions and completions", () => {
    expect(describeEntry(entry(3, "agent.action.requested", { summary: "run ls" }, agent))).toBe(
      "Agent abcdef12 wants to: run ls",
    );
    expect(describeEntry(entry(4, "agent.action.decided", { decision: "allow", reason: "" }, policy))).toBe(
      "Policy allowed: approved",
    );
    expect(describeEntry(entry(5, "agent.action.decided", { decision: "deny", reason: "" }))).toBe(
      "Owner denied: rejected",
    );
    expect(describeEntry(entry(6, "agent.action.decided", { decision: "deny", reason: "too risky" }))).toBe(
      "Owner denied: too risky",
    );
    expect(describeEntry(entry(7, "agent.action.completed", { ok: true }, agent))).toBe(
      "Agent abcdef12 finished an action",
    );
    expect(describeEntry(entry(8, "agent.action.completed", { ok: false }, agent))).toBe(
      "Agent abcdef12 action failed",
    );
  });

  it("describes messages, finish and settings", () => {
    expect(describeEntry(entry(9, "agent.message", { text: "hi" }, agent))).toBe('Agent abcdef12 said: "hi"');
    expect(describeEntry(entry(10, "agent.message", { text: "y".repeat(90) }, agent))).toBe(
      `Agent abcdef12 said: "${"y".repeat(80)}…"`,
    );
    expect(describeEntry(entry(11, "agent.finished", { status: "completed" }, runner))).toBe(
      "Agent run completed",
    );
    expect(describeEntry(entry(12, "settings.claude_auth_changed", { mode: "api_key" }))).toBe(
      "Owner set Claude to use API key",
    );
    expect(describeEntry(entry(13, "settings.claude_auth_changed", { mode: "subscription" }))).toBe(
      "Owner set Claude to use own subscription",
    );
  });

  it("falls back for unknown types", () => {
    expect(describeEntry(entry(14, "something.new" as LedgerEntry["type"], {}, runner))).toBe(
      "System recorded something.new",
    );
  });
});

describe("LedgerPanel", () => {
  it("lists entries newest first", () => {
    render(
      <LedgerPanel
        entries={[
          entry(1, "project.created", { name: "Demo" }),
          entry(2, "card.created", { title: "Detect GPU", stage: "plan" }),
        ]}
      />,
    );
    const items = screen.getAllByRole("listitem").map((li) => li.textContent ?? "");
    expect(items[0]).toContain("Detect GPU");
    expect(items[1]).toContain("Demo");
  });
});
