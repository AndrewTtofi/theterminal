import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StatusBar } from "../src/shell/StatusBar";
import type { LayoutControls } from "../src/shell/StatusBar";
import type { Status } from "../src/api";

const status = (over: Partial<Status["connections"]> = {}): Status => ({
  runningAgents: 2,
  todayCostUsd: 0.4,
  monthCostUsd: 12,
  monthlyBudgetUsd: null,
  pendingDecisions: 1,
  connections: { enabled: 3, failed: 1, keychain: "ok", ...over },
  ci: null,
  intakeDecisions: 0,
  intakeProjects: [],
  machines: { linked: 0, online: 0 },
});
const layout = (over: Partial<LayoutControls> = {}): LayoutControls => ({
  current: "Guided",
  saved: [],
  applyPreset: vi.fn(),
  applySaved: vi.fn(),
  saveAs: vi.fn(),
  ...over,
});
const noop = { onSelectView: vi.fn(), onResetLayout: vi.fn(), layout: layout() };

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

  it("counts open plan decisions in Needs you", () => {
    render(
      <StatusBar
        status={{ ...status(), pendingDecisions: 1, intakeDecisions: 2, intakeProjects: [{ projectId: "p1", name: "Book Club", decisions: 2 }] }}
        running={0}
        pending={0}
        {...noop}
      />,
    );
    expect(screen.getByText("Needs you: 3")).toBeTruthy();
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

  it("shows the CI state as a link, marking a failing one", () => {
    const url = "https://github.com/octo-org/example/actions/runs/1";
    render(<StatusBar status={{ ...status(), ci: { state: "failing", url, branch: "main", updatedAt: null } }} running={0} pending={0} {...noop} />);
    const link = screen.getByRole("link", { name: "CI: failing" });
    expect(link.getAttribute("href")).toBe(url);
    expect(link.className).toContain("attention");
    expect(screen.queryByText("CI: not connected")).toBeNull();
  });

  it("shows the CI state without a link when there is no run", () => {
    render(<StatusBar status={{ ...status(), ci: { state: "unknown", url: null, branch: null, updatedAt: null } }} running={0} pending={0} {...noop} />);
    expect(screen.getByText("CI: unknown")).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("shows the month's spend against the budget when one is set, marking it once reached", () => {
    const { rerender } = render(<StatusBar status={{ ...status(), monthlyBudgetUsd: 50 }} running={0} pending={0} {...noop} />);
    const bar = screen.getByRole("contentinfo", { name: "Status bar" });
    expect(bar.textContent).toContain("Today: $0.40 · Month: $12.00 of $50.00");
    const monthItem = screen.getByText("· Month: $12.00 of $50.00", { exact: false });
    expect(monthItem.className).not.toContain("attention");
    expect(monthItem.getAttribute("title")).toBe("Includes estimates: Claude's cost is computed by its SDK, not billed by the provider.");
    rerender(<StatusBar status={{ ...status(), monthCostUsd: 50, monthlyBudgetUsd: 50 }} running={0} pending={0} {...noop} />);
    expect(screen.getByText("· Month: $50.00 of $50.00", { exact: false }).className).toContain("attention");
  });

  it("leaves the month out when no budget is set", () => {
    render(<StatusBar status={status()} running={0} pending={0} {...noop} />);
    expect(screen.queryByText(/Month:/)).toBeNull();
  });

  it("selects the Needs you and Connections views when clicked", async () => {
    const onSelectView = vi.fn();
    render(<StatusBar status={status()} running={0} pending={0} {...noop} onSelectView={onSelectView} />);
    await userEvent.click(screen.getByRole("button", { name: "Needs you: 1" }));
    expect(onSelectView).toHaveBeenLastCalledWith("needs_you");
    await userEvent.click(screen.getByRole("button", { name: "Connections: 3 connected, 1 failed" }));
    expect(onSelectView).toHaveBeenLastCalledWith("connections");
  });

  it("counts linked machines, adding how many are online once any is linked, and selects Machines", async () => {
    const onSelectView = vi.fn();
    const { rerender } = render(<StatusBar status={null} running={0} pending={0} {...noop} onSelectView={onSelectView} />);
    expect(screen.getByRole("button", { name: "Machines: 0 linked" })).toBeTruthy();
    rerender(<StatusBar status={status()} running={0} pending={0} {...noop} onSelectView={onSelectView} />);
    expect(screen.getByRole("button", { name: "Machines: 0 linked" })).toBeTruthy();
    rerender(<StatusBar status={{ ...status(), machines: { linked: 2, online: 1 } }} running={0} pending={0} {...noop} onSelectView={onSelectView} />);
    await userEvent.click(screen.getByRole("button", { name: "Machines: 2 linked, 1 online" }));
    expect(onSelectView).toHaveBeenLastCalledWith("machines");
    rerender(<StatusBar status={{ ...status(), machines: { linked: 1, online: 0 } }} running={0} pending={0} {...noop} onSelectView={onSelectView} />);
    expect(screen.getByRole("button", { name: "Machines: 1 linked, 0 online" })).toBeTruthy();
  });

  describe("layouts", () => {
    const select = () => screen.getByRole("combobox", { name: "Layout" }) as HTMLSelectElement;
    const options = () => within(select()).getAllByRole("option") as HTMLOptionElement[];

    it("lists Guided, Operator and the saved layouts, showing the current one", () => {
      render(<StatusBar status={null} running={0} pending={0} {...noop} layout={layout({ current: "Mine", saved: ["Mine"] })} />);
      expect(options().map((o) => o.textContent)).toEqual(["Guided", "Operator", "Mine"]);
      expect(select().selectedOptions[0]!.textContent).toBe("Mine");
    });

    it("shows a disabled Custom first when the layout matches none", () => {
      const { rerender } = render(<StatusBar status={null} running={0} pending={0} {...noop} />);
      expect(select().selectedOptions[0]!.textContent).toBe("Guided");
      expect(options().some((o) => o.textContent === "Custom")).toBe(false);
      rerender(<StatusBar status={null} running={0} pending={0} {...noop} layout={layout({ current: "Custom", saved: ["Mine"] })} />);
      expect(options().map((o) => o.textContent)).toEqual(["Custom", "Guided", "Operator", "Mine"]);
      expect(options()[0]!.disabled).toBe(true);
      expect(select().selectedOptions[0]!.textContent).toBe("Custom");
    });

    it("applies the chosen preset or saved layout", async () => {
      const l = layout({ saved: ["Mine"] });
      render(<StatusBar status={null} running={0} pending={0} {...noop} layout={l} />);
      await userEvent.selectOptions(select(), "Operator");
      expect(l.applyPreset).toHaveBeenCalledWith("operator");
      await userEvent.selectOptions(select(), "Mine");
      expect(l.applySaved).toHaveBeenCalledWith("Mine");
    });

    it("saves the layout under a name", async () => {
      const l = layout();
      render(<StatusBar status={null} running={0} pending={0} {...noop} layout={l} />);
      expect(screen.queryByLabelText("Layout name")).toBeNull();
      await userEvent.click(screen.getByRole("button", { name: "Save layout" }));
      const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
      expect(save.disabled).toBe(true);
      await userEvent.type(screen.getByLabelText("Layout name"), "Mine");
      await userEvent.click(save);
      expect(l.saveAs).toHaveBeenCalledWith("Mine");
      expect(screen.queryByLabelText("Layout name")).toBeNull();
      // Focus goes back to the button that opened the name form, not to the page.
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Save layout" }));
    });

    it("returns focus to Save layout when the name form is closed with Escape", async () => {
      render(<StatusBar status={null} running={0} pending={0} {...noop} layout={layout()} />);
      await userEvent.click(screen.getByRole("button", { name: "Save layout" }));
      expect(document.activeElement).toBe(screen.getByLabelText("Layout name"));
      await userEvent.keyboard("{Escape}");
      expect(screen.queryByLabelText("Layout name")).toBeNull();
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Save layout" }));
    });

    it("shows a saved layout's name with hidden characters made visible", () => {
      render(<StatusBar status={null} running={0} pending={0} {...noop} layout={layout({ current: "Guided", saved: ["Mi\u202Ene"] })} />);
      expect(options().map((o) => o.textContent)).toEqual(["Guided", "Operator", "Mi\\u202ene"]);
    });

    it("shows why a save was refused, keeping the name to fix", async () => {
      const saveAs = vi.fn(() => {
        throw new RangeError("You can keep up to 10 layouts");
      });
      render(<StatusBar status={null} running={0} pending={0} {...noop} layout={layout({ saveAs })} />);
      await userEvent.click(screen.getByRole("button", { name: "Save layout" }));
      await userEvent.type(screen.getByLabelText("Layout name"), "Eleventh{Enter}");
      expect(saveAs).toHaveBeenCalledWith("Eleventh");
      expect(screen.getByText("You can keep up to 10 layouts")).toBeTruthy();
      expect(screen.getByLabelText("Layout name")).toBeTruthy();
    });
  });
});
