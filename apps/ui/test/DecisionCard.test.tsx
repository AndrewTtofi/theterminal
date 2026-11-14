import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AgentAction } from "@theterminal/shared";
import { ApiError } from "../src/api";
import { DecisionCard } from "../src/components/DecisionCard";

const action: AgentAction = {
  id: "act1",
  runId: "run1",
  kind: "shell",
  tool: "Bash",
  summary: "run npm test",
  input: { command: "npm test" },
  status: "pending",
  decidedBy: null,
  reason: "",
  output: null,
  requestedAt: "2026-01-01T10:00:00Z",
  decidedAt: null,
};

describe("DecisionCard", () => {
  it("shows the title and collapsible details", () => {
    render(<DecisionCard action={action} onDecide={vi.fn()} />);
    expect(screen.getByText("Agent wants to: run npm test")).toBeTruthy();
    expect(screen.getByText("Details")).toBeTruthy();
    expect(document.querySelector("pre")?.textContent).toContain("npm test");
  });

  it("allows", async () => {
    const onDecide = vi.fn().mockResolvedValue(undefined);
    render(<DecisionCard action={action} onDecide={onDecide} />);
    await userEvent.click(screen.getByRole("button", { name: "Allow" }));
    expect(onDecide).toHaveBeenCalledWith("act1", "allow");
  });

  it("denies with a reason", async () => {
    const onDecide = vi.fn().mockResolvedValue(undefined);
    render(<DecisionCard action={action} onDecide={onDecide} />);
    await userEvent.click(screen.getByRole("button", { name: "Deny" }));
    await userEvent.type(screen.getByLabelText("Reason (optional)"), "too risky");
    await userEvent.click(screen.getByRole("button", { name: "Confirm deny" }));
    expect(onDecide).toHaveBeenCalledWith("act1", "deny", "too risky");
  });

  it("shows Already decided on 409", async () => {
    const onDecide = vi.fn().mockRejectedValue(new ApiError(409, "already_decided"));
    render(<DecisionCard action={action} onDecide={onDecide} />);
    await userEvent.click(screen.getByRole("button", { name: "Allow" }));
    expect(await screen.findByText("Already decided")).toBeTruthy();
  });
});
