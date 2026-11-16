import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AgentRun, Board, CardInfo } from "@theterminal/shared";

vi.mock("../src/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/api")>();
  return { ...real, api: { cardComments: vi.fn().mockResolvedValue({ comments: [] }), addCardComment: vi.fn() } };
});

import { ShellContext } from "../src/shell/model";
import type { WorkbenchModel } from "../src/shell/model";
import { BoardView, spendLine } from "../src/views/BoardView";
import { fakeDock, shellNav } from "./connections-harness";
import { feedRun } from "./feed-fixtures";

const board: Board = {
  project: { id: "p1", name: "Demo", pitch: "", createdAt: "" },
  columns: { plan: [], design: [], build: [], ship: [], operate: [] },
};

const withCard: Board = {
  ...board,
  columns: {
    ...board.columns,
    build: [{ id: "c1", projectId: "p1", title: "Fix the contact form", stage: "build", status: "active", createdAt: "", updatedAt: "" }],
  },
};
const info: CardInfo = {
  cardId: "c1", runId: "r1", adapter: "claude", runStatus: "running", percent: 50, now: "Checking it works", waiting: false,
  progress: { steps: ["Found the problem", "Wrote the fix", "Checking it works", "Ready for your review"], done: [1, 2], current: 3 },
  comments: 0, commentsWaiting: 0, screenshots: 0, moveRequest: null,
};

function renderBoard(runs: AgentRun[], b: Board = board) {
  const model = {
    selectedId: "p1", board: b, runs, onAddCard: vi.fn(), onMoveCard: vi.fn(),
    cardInfos: { data: { c1: info }, refresh: vi.fn() }, subscribeEntries: vi.fn(() => () => {}),
    home: { data: null, error: null, scope: "project", setScope: vi.fn(), refresh: vi.fn() },
  } as unknown as WorkbenchModel;
  render(
    <ShellContext.Provider value={{ model, dock: () => fakeDock(), ...shellNav() }}>
      <BoardView />
    </ShellContext.Provider>,
  );
}

describe("BoardView", () => {
  it("says who manages the cards", () => {
    renderBoard([]);
    expect(screen.getByText("Cards are managed by agents · click a card to leave a note")).toBeTruthy();
  });

  it("opens a card's panel beside the columns; Escape closes it and focuses the card", async () => {
    renderBoard([], withCard);
    expect(screen.queryByRole("complementary", { name: "Card" })).toBeNull();
    const button = screen.getByRole("button", { name: "Open Fix the contact form" });
    await userEvent.click(button);
    const panel = screen.getByRole("complementary", { name: "Card" });
    const current = within(panel).getAllByRole("listitem").find((li) => li.getAttribute("aria-current") === "step");
    expect(current?.textContent).toContain("Checking it works");
    expect(button.getAttribute("aria-pressed")).toBe("true");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("complementary", { name: "Card" })).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it("closes the panel from its close button", async () => {
    renderBoard([], withCard);
    await userEvent.click(screen.getByRole("button", { name: "Open Fix the contact form" }));
    await userEvent.click(screen.getByRole("button", { name: "Close the card" }));
    expect(screen.queryByRole("complementary", { name: "Card" })).toBeNull();
  });
});

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
      "Agent spend: $0.25 (estimate) · 2 runs, 1 did not report a cost (actual spend may be higher)",
    );
  });

  it("never shows $0.00 when no run reported a cost", () => {
    expect(spendLine([feedRun("r1", { costUsd: null })])).toBe("Agent spend: not reported · 1 run (actual spend may be higher)");
  });

  it("is labelled reported only when every run that cost something reported its own cost", () => {
    const gemini = (id: string, costUsd: number | null) => feedRun(id, { adapter: "gemini", costUsd });
    expect(spendLine([gemini("r1", 1), gemini("r2", 0.5)])).toBe("Agent spend: $1.50 (reported) · 2 runs");
    expect(spendLine([gemini("r1", 1), feedRun("r2", { adapter: "claude", costUsd: 0.5 })])).toBe(
      "Agent spend: $1.50 (estimate) · 2 runs",
    );
  });

  it("adds cents without floating-point drift", () => {
    expect(spendLine([0.07, 0.07, 0.07].map((c, i) => feedRun(`r${i}`, { costUsd: c })))).toBe("Agent spend: $0.21 (estimate) · 3 runs");
  });
});

describe("BoardView empty state", () => {
  it("shows the wordmark and one line when no project is open", () => {
    const model = { selectedId: null, board: null, runs: [] } as unknown as WorkbenchModel;
    render(
      <ShellContext.Provider value={{ model, dock: () => fakeDock(), ...shellNav() }}>
        <BoardView />
      </ShellContext.Provider>,
    );
    const mark = screen.getByRole("img", { name: "The Terminal" });
    expect(mark.textContent).toBe("THE TERMINAL");
    expect(mark.querySelector(".accent")?.textContent).toBe("TERMINAL");
    expect(screen.getByText("Start by opening a project.")).toBeTruthy();
  });
});
