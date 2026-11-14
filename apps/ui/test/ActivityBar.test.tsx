import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ActivityBar } from "../src/shell/ActivityBar";

describe("ActivityBar", () => {
  it("renders the seven views in order and marks the active one", () => {
    render(<ActivityBar active="agents" running={0} pending={0} onSelect={vi.fn()} />);
    const nav = screen.getByRole("navigation", { name: "Views" });
    const buttons = within(nav).getAllByRole("button");
    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual([
      "Board",
      "Agents",
      "Needs you",
      "Ledger",
      "Connections",
      "GitHub",
      "Capacity",
    ]);
    expect(buttons.map((b) => b.getAttribute("aria-pressed"))).toEqual([
      "false", "true", "false", "false", "false", "false", "false",
    ]);
  });

  it("shows badges for pending decisions and running agents, none when zero", () => {
    const { rerender } = render(<ActivityBar active="board" running={1} pending={2} onSelect={vi.fn()} />);
    expect(within(screen.getByRole("button", { name: "Needs you" })).getByText("2")).toBeTruthy();
    expect(within(screen.getByRole("button", { name: "Agents" })).getByText("1")).toBeTruthy();
    rerender(<ActivityBar active="board" running={0} pending={0} onSelect={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Needs you" }).querySelector(".badge")).toBeNull();
    expect(screen.getByRole("button", { name: "Agents" }).querySelector(".badge")).toBeNull();
  });

  it("reports the clicked view", async () => {
    const onSelect = vi.fn();
    render(<ActivityBar active="board" running={0} pending={0} onSelect={onSelect} />);
    await userEvent.click(screen.getByRole("button", { name: "Ledger" }));
    expect(onSelect).toHaveBeenCalledWith("ledger");
  });
});
