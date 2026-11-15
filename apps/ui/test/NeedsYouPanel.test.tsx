import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PendingAgentAction, RunChanges } from "@theterminal/shared";
import { ApiError } from "../src/api";
import { ShellContext } from "../src/shell/model";
import type { ShellContextValue, WorkbenchModel } from "../src/shell/model";
import { NeedsYouPanel } from "../src/views/NeedsYouPanel";
import { fakeDock, shellNav } from "./connections-harness";
import { message } from "./feed-fixtures";
import { shipBlocked } from "./gate-fixtures";

const pending = (over: Partial<PendingAgentAction> = {}): PendingAgentAction => ({
  id: "a1", runId: "run1", kind: "file_edit", tool: "Edit", summary: "Edit src/a.ts",
  input: { file_path: "src/a.ts", old_string: "a = 1", new_string: "a = 2" }, status: "pending", decidedBy: null, reason: "",
  output: null, requestedAt: "", decidedAt: null, projectId: "p1", projectName: "Demo", ...over,
});

const changes: RunChanges = {
  runId: "run1", base: "b".repeat(40), head: "h".repeat(40), truncated: false,
  files: [{ path: "src/a.ts", status: "modified", added: 1, deleted: 1, binary: false }],
};

function renderPanel(over: Partial<WorkbenchModel> = {}, stripShown = false) {
  const dock = fakeDock();
  const nav = { ...shellNav(), stripShown };
  const model = {
    selectedId: "p1",
    pending: [],
    gate: null,
    intake: null,
    status: null,
    projectEntries: [message(1, "run1", "Fixing the counter")],
    runChanges: vi.fn().mockResolvedValue(changes),
    onSelectProject: vi.fn(),
    onSelectChangesRun: vi.fn(),
    onDecide: vi.fn(),
    onResolveGate: vi.fn().mockResolvedValue(true),
    onCancelGate: vi.fn(),
    ...over,
  } as unknown as WorkbenchModel;
  render(
    <ShellContext.Provider value={{ model, dock: () => dock, ...nav } satisfies ShellContextValue}>
      <NeedsYouPanel />
    </ShellContext.Provider>,
  );
  return { model, nav, dock };
}

const panel = () => screen.getByRole("region", { name: "Everything that needs you" });

describe("NeedsYouPanel", () => {
  it("says so when nothing needs the Owner", () => {
    renderPanel();
    expect(within(panel()).getByText("Nothing needs you right now.")).toBeTruthy();
    expect(within(panel()).queryByRole("heading", { name: "Decisions" })).toBeNull();
  });

  it("shows a selected project's decision with its proposed change, what the agent said and what the run changed", async () => {
    const { model, nav } = renderPanel({ pending: [pending()] });
    expect(within(panel()).getByRole("heading", { level: 2, name: "Decisions" })).toBeTruthy();
    expect(within(panel()).getByRole("article", { name: "Decision: Edit src/a.ts" })).toBeTruthy();
    expect(within(panel()).getByRole("heading", { name: "Proposed change to src/a.ts" })).toBeTruthy();
    expect(within(panel()).getByText("Fixing the counter")).toBeTruthy();
    expect(await within(panel()).findByText("This run has changed 1 file so far")).toBeTruthy();
    expect(model.runChanges).toHaveBeenCalledWith("run1");

    await userEvent.click(within(panel()).getByRole("button", { name: "See changes" }));
    expect(model.onSelectChangesRun).toHaveBeenCalledWith("run1");
    expect(nav.showView).toHaveBeenCalledWith("changes");
  });

  it("shows the live run's answer plainly in place of the file list", async () => {
    renderPanel({
      pending: [pending()],
      runChanges: vi.fn().mockRejectedValue(new ApiError(409, "run_active")),
    });
    expect(await within(panel()).findByText("Changes show when the run is stopped or finished.")).toBeTruthy();
    expect(within(panel()).queryByRole("alert")).toBeNull();
  });

  it("offers to open another project's decision instead of reading its context", async () => {
    const { model } = renderPanel({ pending: [pending({ projectId: "p2", projectName: "Other", runId: "run9" })] });
    const card = within(panel()).getByRole("article", { name: "Decision: Edit src/a.ts" });
    expect(card).toBeTruthy();
    expect(within(panel()).getByText("Open this project to see more context")).toBeTruthy();
    // The proposed change is the action's own input, so it shows for any project.
    expect(within(panel()).getByRole("heading", { name: "Proposed change to src/a.ts" })).toBeTruthy();
    expect(within(panel()).queryByText("Before this, the agent said:")).toBeNull();
    expect(within(panel()).queryByText(/This run has changed/)).toBeNull();
    expect(model.runChanges).not.toHaveBeenCalled();
    await userEvent.click(within(panel()).getByRole("button", { name: "Open project" }));
    expect(model.onSelectProject).toHaveBeenCalledWith("p2");
  });

  it("shows the gates of a stopped move, without taking focus from the strip", async () => {
    const { model } = renderPanel({
      gate: { cardId: "c1", cardTitle: "Login", to: "ship", evaluations: [shipBlocked()], note: null, revision: 0, refreshing: false },
    });
    expect(within(panel()).getByRole("heading", { level: 2, name: "Gates" })).toBeTruthy();
    const gate = within(panel()).getByRole("article", { name: "Gate: Ready to ship" });
    expect(document.activeElement).toBe(document.body);
    await userEvent.click(within(gate).getByRole("button", { name: "Cancel" }));
    expect(model.onCancelGate).toHaveBeenCalled();
  });

  it("lists plans waiting on decisions under Plan", async () => {
    const { model, dock } = renderPanel({
      status: { intakeProjects: [{ projectId: "p2", name: "Other", decisions: 2 }] } as unknown as WorkbenchModel["status"],
    });
    expect(within(panel()).getByRole("heading", { level: 2, name: "Plan" })).toBeTruthy();
    expect(within(panel()).getByText("The plan for Other needs 2 decisions")).toBeTruthy();
    await userEvent.click(within(panel()).getByRole("button", { name: "Open intake" }));
    expect(model.onSelectProject).toHaveBeenCalledWith("p2");
    await waitFor(() => expect(dock.focus).toHaveBeenCalledWith("intake"));
  });

  it("shows read-only copies that point to the strip while the strip shows them", () => {
    renderPanel(
      {
        pending: [pending()],
        gate: { cardId: "c1", cardTitle: "Login", to: "ship", evaluations: [shipBlocked()], note: null, revision: 0, refreshing: false },
      },
      true,
    );
    const decision = within(panel()).getByRole("article", { name: "Decision: Edit src/a.ts" });
    expect(within(decision).queryByRole("button", { name: "Allow" })).toBeNull();
    expect(within(decision).getByText("Decide in the strip above")).toBeTruthy();
    const gate = within(panel()).getByRole("article", { name: "Gate: Ready to ship" });
    expect(within(gate).queryByRole("checkbox")).toBeNull();
    expect(within(panel()).queryByRole("button", { name: 'Move "Login" to Ship' })).toBeNull();
    expect(within(panel()).getAllByText("Decide in the strip above")).toHaveLength(2);
  });

  it("keeps its copies interactive when the strip is not showing them", () => {
    renderPanel({ pending: [pending()] }, false);
    expect(within(panel()).getByRole("button", { name: "Allow" })).toBeTruthy();
    expect(within(panel()).queryByText("Decide in the strip above")).toBeNull();
  });
});
