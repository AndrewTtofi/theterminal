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

  it("sends one decision when Allow is double-clicked", async () => {
    let resolve!: () => void;
    const onDecide = vi.fn().mockReturnValue(new Promise<void>((r) => (resolve = r)));
    render(<DecisionCard action={action} onDecide={onDecide} />);
    const allow = screen.getByRole("button", { name: "Allow" });
    await userEvent.dblClick(allow);
    expect(onDecide).toHaveBeenCalledTimes(1);
    expect((screen.getByRole("button", { name: "Deny" }) as HTMLButtonElement).disabled).toBe(true);
    resolve();
  });

  it("sends one decision when Confirm deny is double-clicked", async () => {
    const onDecide = vi.fn().mockReturnValue(new Promise<void>(() => {}));
    render(<DecisionCard action={action} onDecide={onDecide} />);
    await userEvent.click(screen.getByRole("button", { name: "Deny" }));
    await userEvent.dblClick(screen.getByRole("button", { name: "Confirm deny" }));
    expect(onDecide).toHaveBeenCalledTimes(1);
  });

  it("says how much of a truncated input is hidden", () => {
    const preview = `{"command":"echo ${"z".repeat(3970)}…[truncated]`;
    const truncated = { ...action, input: { truncated: true, sha256: "ab".repeat(32), totalChars: 25000, preview } };
    render(<DecisionCard action={truncated} onDecide={vi.fn()} />);
    expect(screen.getByText(`${25000 - (preview.length - "…[truncated]".length)} characters hidden — full input not shown`)).toBeTruthy();
  });

  it("does not show a hidden-characters note for a complete input", () => {
    render(<DecisionCard action={action} onDecide={vi.fn()} />);
    expect(screen.queryByText(/characters hidden/)).toBeNull();
  });

  it("renders hostile summary and input as inert text", () => {
    const evil = { ...action, summary: '<img src=x onerror="window.__pwned=1">', input: { x: "<script>window.__pwned=1</script>" } };
    const { container } = render(<DecisionCard action={evil} onDecide={vi.fn()} />);
    expect(container.querySelector("img, script")).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror="window.__pwned=1">');
    expect(container.querySelector("pre")?.textContent).toContain("<script>");
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });
});
