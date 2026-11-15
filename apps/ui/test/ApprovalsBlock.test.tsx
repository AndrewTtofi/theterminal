import { describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError } from "../src/api";
import { ApprovalsBlock } from "../src/home/ApprovalsBlock";
import { asRole, homeModel, homeRun, pendingAction, renderInShell } from "./home-fixtures";
import { shipBlocked } from "./gate-fixtures";

const withReason = (reason: string | null) => ({ working: [homeRun("r1", {}, { waiting: true, reason })], finishedToday: [] });

describe("ApprovalsBlock", () => {
  it("says so when nothing is pending", () => {
    renderInShell(<ApprovalsBlock />, homeModel());
    expect(screen.getByRole("heading", { name: "Needs your approval" })).toBeTruthy();
    expect(screen.getByText("Nothing needs you right now.")).toBeTruthy();
  });

  it("shows one sentence with the agent's reason and the three buttons", () => {
    renderInShell(<ApprovalsBlock />, homeModel({ pending: [pendingAction()], runs: [homeRun("r1").run] }, withReason("Change the form")));
    expect(screen.getByText("Claude wants to change src/a.ts")).toBeTruthy();
    expect(screen.getByText("Change the form")).toBeTruthy();
    for (const name of ["Approve", "Deny", "Ask why"]) expect(screen.getByRole("button", { name })).toBeTruthy();
  });

  it("leaves the reason line out when there is none", () => {
    const { container } = renderInShell(<ApprovalsBlock />, homeModel({ pending: [pendingAction()] }, withReason(null)));
    expect(container.querySelector(".approval-reason")).toBeNull();
  });

  it("Approve sends allow once, even when clicked again while in flight", async () => {
    let resolve: () => void = () => {};
    const onDecide = vi.fn(() => new Promise<void>((r) => (resolve = r)));
    renderInShell(<ApprovalsBlock />, homeModel({ pending: [pendingAction()], onDecide }));
    const approve = screen.getByRole("button", { name: "Approve" });
    await userEvent.click(approve);
    await userEvent.click(approve);
    expect(onDecide).toHaveBeenCalledTimes(1);
    expect(onDecide).toHaveBeenCalledWith("a1", "allow");
    resolve();
  });

  it("Deny asks for a reason inline and sends it", async () => {
    const onDecide = vi.fn().mockResolvedValue(undefined);
    renderInShell(<ApprovalsBlock />, homeModel({ pending: [pendingAction()], onDecide }));
    await userEvent.click(screen.getByRole("button", { name: "Deny" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Reason (optional)" }), "not now");
    await userEvent.click(screen.getByRole("button", { name: "Confirm deny" }));
    expect(onDecide).toHaveBeenCalledWith("a1", "deny", "not now");
  });

  it("says Already decided when the other place decided first", async () => {
    const onDecide = vi.fn().mockRejectedValue(new ApiError(409, "already_decided"));
    renderInShell(<ApprovalsBlock />, homeModel({ pending: [pendingAction()], onDecide }));
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(await screen.findByText("Already decided")).toBeTruthy();
  });

  it("Ask why focuses the Needs-you tab", async () => {
    const { dock } = renderInShell(<ApprovalsBlock />, homeModel({ pending: [pendingAction()] }));
    await userEvent.click(screen.getByRole("button", { name: "Ask why" }));
    expect(dock.focus).toHaveBeenCalledWith("needs_you");
  });

  it("a viewer sees the sentence and no buttons", () => {
    renderInShell(<ApprovalsBlock />, homeModel({ pending: [pendingAction()], runs: [homeRun("r1").run], me: asRole("viewer") }));
    expect(screen.getByText("Claude wants to change src/a.ts")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Deny" })).toBeNull();
  });

  it("names another project's decision", () => {
    renderInShell(<ApprovalsBlock />, homeModel({ pending: [pendingAction({ projectId: "p2", projectName: "Photos", runId: "x" })] }));
    const item = screen.getByRole("listitem");
    expect(within(item).getByText("Photos")).toBeTruthy();
    expect(within(item).getByText("Agent wants to change src/a.ts")).toBeTruthy();
  });

  it("lists a stopped move and a waiting plan with Review only", async () => {
    const { dock } = renderInShell(<ApprovalsBlock />, homeModel({
      gate: { cardId: "c1", cardTitle: "Ship it", to: "ship", evaluations: [shipBlocked()], note: null, revision: 0, refreshing: false },
      status: { intakeProjects: [{ projectId: "p2", name: "Photos", decisions: 2 }] } as never,
    }));
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    const reviews = screen.getAllByRole("button", { name: "Review" });
    expect(reviews).toHaveLength(2);
    expect(screen.getByText(/Ship it/)).toBeTruthy();
    expect(screen.getByText("The plan for Photos needs 2 decisions")).toBeTruthy();
    await userEvent.click(reviews[0]!);
    expect(dock.focus).toHaveBeenCalledWith("needs_you");
  });
});
