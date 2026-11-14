import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StatusBar } from "../src/shell/StatusBar";

describe("StatusBar", () => {
  it("shows the skeleton items with zero counts", () => {
    render(<StatusBar running={0} pending={0} onResetLayout={vi.fn()} />);
    const bar = screen.getByRole("contentinfo", { name: "Status bar" });
    for (const text of ["Agents running: 0", "Today: $0.00", "Needs you: 0", "Connections: 0 connected", "CI: not connected"]) {
      expect(bar.textContent).toContain(text);
    }
  });

  it("shows the counts it is given", () => {
    render(<StatusBar running={2} pending={3} onResetLayout={vi.fn()} />);
    expect(screen.getByText("Agents running: 2")).toBeTruthy();
    expect(screen.getByText("Needs you: 3")).toBeTruthy();
  });

  it("resets the layout", async () => {
    const onResetLayout = vi.fn();
    render(<StatusBar running={0} pending={0} onResetLayout={onResetLayout} />);
    await userEvent.click(screen.getByRole("button", { name: "Reset layout" }));
    expect(onResetLayout).toHaveBeenCalledTimes(1);
  });
});
