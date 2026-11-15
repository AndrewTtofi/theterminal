import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Board as BoardData } from "@theterminal/shared";
import { Board } from "../src/components/Board";

const board: BoardData = {
  project: { id: "p1", name: "Demo", pitch: "", createdAt: "2026-01-01T00:00:00Z" },
  columns: {
    plan: [
      { id: "c1", projectId: "p1", title: "Existing", stage: "plan", status: "todo", createdAt: "", updatedAt: "" },
    ],
    design: [],
    build: [],
    ship: [],
    operate: [],
  },
};

describe("Board", () => {
  it("renders the five column headings in order", () => {
    render(<Board board={board} onAddCard={vi.fn()} onMoveCard={vi.fn()} />);
    const headings = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(headings).toEqual(["Plan", "Design", "Build", "Ship", "Operate"]);
  });

  it("adds a card from the Plan column input", async () => {
    const onAddCard = vi.fn();
    render(<Board board={board} onAddCard={onAddCard} onMoveCard={vi.fn()} />);
    const plan = screen.getByRole("region", { name: "Plan" });
    await userEvent.type(within(plan).getByPlaceholderText("+ Add"), "Detect GPU{Enter}");
    expect(onAddCard).toHaveBeenCalledWith("plan", "Detect GPU");
  });

  it("moves a card via the Move select", async () => {
    const onMoveCard = vi.fn();
    render(<Board board={board} onAddCard={vi.fn()} onMoveCard={onMoveCard} />);
    await userEvent.selectOptions(screen.getByLabelText("Move Existing to"), "Build");
    expect(onMoveCard).toHaveBeenCalledWith("c1", "build");
  });

  it("opens a card's story from its title", async () => {
    const onOpenStory = vi.fn();
    render(<Board board={board} onAddCard={vi.fn()} onMoveCard={vi.fn()} onOpenStory={onOpenStory} />);
    await userEvent.click(screen.getByRole("button", { name: "Open the story of Existing" }));
    expect(onOpenStory).toHaveBeenCalledWith("c1");
  });
});
