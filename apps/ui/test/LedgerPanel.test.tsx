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
