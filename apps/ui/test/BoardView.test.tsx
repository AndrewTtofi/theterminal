import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { AgentRun, Board } from "@theterminal/shared";
import { ShellContext } from "../src/shell/model";
import type { WorkbenchModel } from "../src/shell/model";
import { BoardView, spendLine } from "../src/views/BoardView";
import { fakeDock, shellNav } from "./connections-harness";
import { feedRun } from "./feed-fixtures";

const board: Board = {
  project: { id: "p1", name: "Demo", pitch: "", createdAt: "" },
  columns: { plan: [], design: [], build: [], ship: [], operate: [] },
};

function renderBoard(runs: AgentRun[]) {
  const model = { selectedId: "p1", board, runs, onAddCard: vi.fn(), onMoveCard: vi.fn() } as unknown as WorkbenchModel;
  render(
    <ShellContext.Provider value={{ model, dock: () => fakeDock(), ...shellNav() }}>
      <BoardView />
    </ShellContext.Provider>,
  );
}

describe("BoardView spend line", () => {
  it("sums the project's run costs as an estimate in the header", () => {
    renderBoard([feedRun("r1", { costUsd: 0.1 }), feedRun("r2", { costUsd: 0.2 })]);
    expect(screen.getByText("Agent spend: $0.30 (estimate) · 2 runs")).toBeTruthy();
  });

  it("says when nothing has been spent yet", () => {
    renderBoard([]);
    expect(screen.getByText("No agent spend recorded yet")).toBeTruthy();
  });
});

describe("spendLine", () => {
  it("counts runs that reported no cost without adding them as $0", () => {
    expect(spendLine([feedRun("r1", { costUsd: 0.25 }), feedRun("r2", { costUsd: null })])).toBe(
      "Agent spend: $0.25 (estimate) · 2 runs, 1 did not report a cost",
    );
  });

  it("never shows $0.00 when no run reported a cost", () => {
    expect(spendLine([feedRun("r1", { costUsd: null })])).toBe("Agent spend: not reported · 1 run");
  });

  it("is labelled reported only when every run that cost something reported its own cost", () => {
    const gemini = (id: string, costUsd: number | null) => feedRun(id, { adapter: "gemini", costUsd });
    expect(spendLine([gemini("r1", 1), gemini("r2", 0.5)])).toBe("Agent spend: $1.50 (reported) · 2 runs");
    expect(spendLine([gemini("r1", 1), feedRun("r2", { adapter: "claude", costUsd: 0.5 })])).toBe(
      "Agent spend: $1.50 (estimate) · 2 runs",
    );
  });
});
