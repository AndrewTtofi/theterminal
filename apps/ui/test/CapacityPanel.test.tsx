import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { ShellContext } from "../src/shell/model";
import type { WorkbenchModel } from "../src/shell/model";
import { CapacityPanel } from "../src/views/CapacityPanel";
import { report } from "./capacity-fixtures";
import { fakeDock, shellNav } from "./connections-harness";

const TITLE = "Not a figure from the provider. Computed by The Terminal from observed usage.";

function renderPanel(capacity: Partial<WorkbenchModel["capacity"]>) {
  const refresh = vi.fn();
  const model = { capacity: { report: null, error: null, refresh, ...capacity } } as unknown as WorkbenchModel;
  render(
    <ShellContext.Provider value={{ model, dock: () => fakeDock(), ...shellNav() }}>
      <CapacityPanel id="capacity" />
    </ShellContext.Provider>,
  );
  return { refresh };
}

const cells = (name: string) => within(screen.getByRole("row", { name: new RegExp(`^${name}`) })).getAllByRole("cell");

describe("CapacityPanel", () => {
  it("renders the eight columns and the footer", () => {
    const { refresh } = renderPanel({ report: report() });
    expect(refresh).toHaveBeenCalled();
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual([
      "Source", "Mode", "Plan", "Today", "This month", "Budget", "Tokens (in / out)", "Rate limits (24 h)",
    ]);
    expect(
      screen.getByText(
        "Rate-limit counts are what The Terminal observed in errors, not a quota the provider published. Figures from the providers themselves are not shown yet.",
      ),
    ).toBeTruthy();
  });

  it("labels every estimated cell and says not reported, never $0, for what was not reported", () => {
    renderPanel({ report: report() });
    const [, mode, plan, today, month, budget, tokens, limits] = cells("Claude");
    expect(mode!.textContent).toBe("API key");
    expect(plan!.textContent).toBe("Max 5x");
    expect(today!.textContent).toBe("$0.40 estimate");
    expect(month!.textContent).toBe("$12.00 estimate");
    expect(budget!.textContent).toBe("$50.00");
    expect(tokens!.textContent).toBe("45,000 / 9,000");
    expect(limits!.textContent).toBe("2 estimate");
    for (const c of [today!, month!, limits!]) expect(within(c).getByText("estimate").closest("abbr")!.getAttribute("title")).toBe(TITLE);

    const codex = cells("Codex");
    expect(codex[1]!.textContent).toBe("My own ChatGPT plan");
    expect(codex[2]!.textContent).toBe("no plan set");
    expect(codex[4]!.textContent).toBe("not reported");
    expect(codex[5]!.textContent).toBe("none");
    expect(codex[6]!.textContent).toBe("500 / 50");
    // Runs happened and none hit a limit: an observed zero.
    expect(codex[7]!.textContent).toBe("0 estimate");

    const gemini = cells("Gemini");
    expect(gemini[3]!.textContent).toBe("not reported");
    expect(gemini[6]!.textContent).toBe("not reported");
    // No runs at all: nothing was observed, so no count is shown.
    expect(gemini[7]!.textContent).toBe("none observed");
    expect(screen.queryByText(/\$0\.00/)).toBeNull();
  });

  it("says when the report is loading or failed", () => {
    renderPanel({ error: "request_failed" });
    expect(screen.getByText("Could not load capacity")).toBeTruthy();
  });
});
