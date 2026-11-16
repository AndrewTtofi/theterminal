import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ActivityBar } from "../src/shell/ActivityBar";
import { saveWorkspace } from "../src/shell/workspace-store";

beforeEach(() => {
  localStorage.clear();
  saveWorkspace({ showBoard: false });
});

describe("ActivityBar", () => {
  it("renders Home first and the twelve views after it with the Board hidden, Changes third, Machines, People and Share after Capacity and Learn last, and marks the active one", () => {
    render(<ActivityBar active="agents" running={0} pending={0} onSelect={vi.fn()} />);
    const nav = screen.getByRole("navigation", { name: "Views" });
    const buttons = within(nav).getAllByRole("button");
    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual([
      "Home",
      "Agents",
      "Changes",
      "Needs you",
      "Ledger",
      "Connections",
      "GitHub",
      "Capacity",
      "Machines",
      "People",
      "Share",
      "Learn",
    ]);
    expect(buttons.map((b) => b.getAttribute("aria-pressed"))).toEqual([
      "false", "true", "false", "false", "false", "false", "false", "false", "false", "false", "false", "false",
    ]);
  });

  it("hides the Board by default and shows it, after Home, once Show the Board is on", () => {
    const { rerender } = render(<ActivityBar active="home" running={0} pending={0} onSelect={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Board" })).toBeNull();
    act(() => saveWorkspace({ showBoard: true }));
    rerender(<ActivityBar active="home" running={0} pending={0} onSelect={vi.fn()} />);
    const names = within(screen.getByRole("navigation", { name: "Views" })).getAllByRole("button").map((b) => b.getAttribute("aria-label"));
    expect(names.slice(0, 2)).toEqual(["Home", "Board"]);
    expect(names).toHaveLength(13);
  });

  it("shows badges for pending decisions and running agents, none when zero", () => {
    const { rerender } = render(<ActivityBar active="home" running={1} pending={2} onSelect={vi.fn()} />);
    expect(within(screen.getByRole("button", { name: "Needs you" })).getByText("2")).toBeTruthy();
    expect(within(screen.getByRole("button", { name: "Agents" })).getByText("1")).toBeTruthy();
    rerender(<ActivityBar active="home" running={0} pending={0} onSelect={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Needs you" }).querySelector(".badge")).toBeNull();
    expect(screen.getByRole("button", { name: "Agents" }).querySelector(".badge")).toBeNull();
  });

  it("reports the clicked view", async () => {
    const onSelect = vi.fn();
    render(<ActivityBar active="home" running={0} pending={0} onSelect={onSelect} />);
    await userEvent.click(screen.getByRole("button", { name: "Ledger" }));
    expect(onSelect).toHaveBeenCalledWith("ledger");
  });

  it("pins a Settings gear below the views that reports the settings view and shows when it is active", async () => {
    const onSelect = vi.fn();
    const { rerender } = render(<ActivityBar active="home" running={0} pending={0} onSelect={onSelect} />);
    const gear = screen.getByRole("button", { name: "Settings" });
    expect(screen.getByRole("navigation", { name: "Views" }).contains(gear)).toBe(false);
    expect(gear.getAttribute("aria-pressed")).toBe("false");
    await userEvent.click(gear);
    expect(onSelect).toHaveBeenCalledWith("settings");
    rerender(<ActivityBar active="settings" running={0} pending={0} onSelect={onSelect} />);
    expect(screen.getByRole("button", { name: "Settings" }).getAttribute("aria-pressed")).toBe("true");
  });
});
