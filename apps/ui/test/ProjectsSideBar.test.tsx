import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { IntakeView } from "@theterminal/shared";
import { ProjectsSideBar } from "../src/views/ProjectsSideBar";
import { ShellContext } from "../src/shell/model";
import type { WorkbenchModel } from "../src/shell/model";
import type { DockApi } from "../src/shell/Dock";
import { ALL_ANSWERS, APPROVED_AT, intakeView } from "./intake-fixtures";

function setup(intake: IntakeView | null | undefined, selectedId: string | null = "p1") {
  const model = {
    projects: [{ id: "p1", name: "Book Club", pitch: "", createdAt: "" }],
    selectedId,
    onSelectProject: vi.fn(),
    onCreateProject: vi.fn(),
    intake,
  } as unknown as WorkbenchModel;
  const dock = { focus: vi.fn() } as unknown as DockApi;
  const { unmount } = render(
    <ShellContext.Provider value={{ model, dock: () => dock, selectView: vi.fn() }}>
      <ProjectsSideBar />
    </ShellContext.Provider>,
  );
  return { dock, unmount };
}

const decided = { first_version: "smallest", hosting: "local" };

describe("ProjectsSideBar plan state", () => {
  it.each([
    ["no intake", null, "Plan: not started"],
    ["answering", intakeView({ audience: "book club members", payments: "no" }), "Plan: 2 of 9 questions answered"],
    ["deciding", intakeView(ALL_ANSWERS), "Plan: 2 decisions to make"],
    ["one decision left", intakeView(ALL_ANSWERS, { first_version: "smallest" }), "Plan: 1 decision to make"],
    ["approving", intakeView(ALL_ANSWERS, decided), "Plan: ready to approve"],
    ["approved", intakeView(ALL_ANSWERS, decided, { completed: true }), `Plan: approved ${new Date(APPROVED_AT).toLocaleDateString()}`],
  ])("shows the line while %s", (_name, intake, line) => {
    setup(intake);
    expect(screen.getByText(line)).toBeTruthy();
  });

  it("focuses the Plan intake tab from its button", async () => {
    const { dock } = setup(null);
    await userEvent.click(screen.getByRole("button", { name: "Plan intake" }));
    expect(dock.focus).toHaveBeenCalledWith("intake");
  });

  it("shows no line or button without a selected project, and no line while loading", () => {
    const first = setup(undefined, null);
    expect(screen.queryByRole("button", { name: "Plan intake" })).toBeNull();
    expect(screen.queryByText(/^Plan:/)).toBeNull();
    first.unmount();
    setup(undefined);
    expect(screen.queryByText(/^Plan:/)).toBeNull();
    expect(screen.getByRole("button", { name: "Plan intake" })).toBeTruthy();
  });
});
