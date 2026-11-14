import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StatusBar } from "../src/shell/StatusBar";
import type { Status } from "../src/api";

const status = (over: Partial<Status["connections"]> = {}): Status => ({
  runningAgents: 2,
  todayCostUsd: 0.4,
  pendingDecisions: 1,
  connections: { enabled: 3, failed: 1, keychain: "ok", ...over },
  ci: null,
});
const noop = { onSelectView: vi.fn(), onResetLayout: vi.fn() };

describe("StatusBar", () => {
  it("shows the skeleton items with zero counts", () => {
    render(<StatusBar status={null} running={0} pending={0} {...noop} />);
    const bar = screen.getByRole("contentinfo", { name: "Status bar" });
    for (const text of ["Agents running: 0", "Today: $0.00", "Needs you: 0", "Connections: 0 connected", "CI: not connected"]) {
      expect(bar.textContent).toContain(text);
    }
  });

  it("shows the counts it is given", () => {
    render(<StatusBar status={null} running={2} pending={3} {...noop} />);
    expect(screen.getByText("Agents running: 2")).toBeTruthy();
    expect(screen.getByText("Needs you: 3")).toBeTruthy();
  });

  it("resets the layout", async () => {
    const onResetLayout = vi.fn();
    render(<StatusBar status={null} running={0} pending={0} {...noop} onResetLayout={onResetLayout} />);
    await userEvent.click(screen.getByRole("button", { name: "Reset layout" }));
    expect(onResetLayout).toHaveBeenCalledTimes(1);
  });

  it("shows the server's status", () => {
    render(<StatusBar status={status()} running={0} pending={0} {...noop} />);
    const bar = screen.getByRole("contentinfo", { name: "Status bar" });
    for (const text of ["Agents running: 2", "Today: $0.40", "Needs you: 1", "Connections: 3 connected, 1 failed", "CI: not connected"]) {
      expect(bar.textContent).toContain(text);
    }
  });

  it("leaves out the failed count when nothing failed", () => {
    render(<StatusBar status={status({ failed: 0 })} running={0} pending={0} {...noop} />);
    expect(screen.getByText("Connections: 3 connected")).toBeTruthy();
  });

  it("replaces the connections item when the keychain is unavailable", () => {
    render(<StatusBar status={status({ keychain: "unavailable" })} running={0} pending={0} {...noop} />);
    expect(screen.getByText("Keychain unavailable")).toBeTruthy();
    expect(screen.queryByText(/Connections:/)).toBeNull();
  });

  it("selects the Needs you and Connections views when clicked", async () => {
    const onSelectView = vi.fn();
    render(<StatusBar status={status()} running={0} pending={0} {...noop} onSelectView={onSelectView} />);
    await userEvent.click(screen.getByRole("button", { name: "Needs you: 1" }));
    expect(onSelectView).toHaveBeenLastCalledWith("needs_you");
    await userEvent.click(screen.getByRole("button", { name: "Connections: 3 connected, 1 failed" }));
    expect(onSelectView).toHaveBeenLastCalledWith("connections");
  });
});
