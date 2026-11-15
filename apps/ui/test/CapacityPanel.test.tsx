import { describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { ShellContext } from "../src/shell/model";
import type { WorkbenchModel } from "../src/shell/model";
import { CapacityPanel } from "../src/views/CapacityPanel";
import { localEngines, machines, report } from "./capacity-fixtures";
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

  it("adds a Local models table with one row per model, and nothing when none was detected", () => {
    renderPanel({ report: report({ localModels: localEngines }) });
    const table = screen.getByRole("table", { name: "Local models" });
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Engine", "Model", "Size", "Parameters", "Quantization"]);
    const rows = within(table).getAllByRole("row").slice(1).map((r) => within(r).getAllByRole("cell").map((c) => c.textContent));
    expect(rows).toEqual([
      ["Ollama 0.12.3", "qwen2.5-coder:14b", "9.0 GB", "14.8B", "Q4_K_M"],
      ["Ollama 0.12.3", "llama3.2:3b", "not reported", "not reported", "not reported"],
      ["llama.cpp", "gpt-oss-20b", "not reported", "not reported", "not reported"],
    ]);
  });

  it("has no Local models table without a detected server", () => {
    renderPanel({ report: report() });
    expect(screen.queryByRole("table", { name: "Local models" })).toBeNull();
  });

  it("adds a Machines table: one row per linked machine, the offline one greyed with when it was last seen", () => {
    renderPanel({ report: report({ machines }) });
    const table = screen.getByRole("table", { name: "Machines" });
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual([
      "Machine", "State", "CPU", "Memory", "GPU", "Local models", "Checked",
    ]);
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((r) => within(r).getAllByRole("cell").map((c) => c.textContent))).toEqual([
      ["GPU box", "online", "AMD Ryzen 9 7950X (16 cores)", "64 GB", "NVIDIA RTX 4090, 24 GB", "3", new Date("2026-11-15T12:00:00.000Z").toLocaleString()],
      [
        "<img src=x onerror=alert(1)>", "offline", "Apple M1 (8 cores)", "16 GB", "not detected", "0",
        `last seen ${new Date("2026-11-15T09:30:00.000Z").toLocaleString()}`,
      ],
    ]);
    expect(rows[0]!.className).not.toContain("offline");
    expect(rows[1]!.className).toContain("offline");
    expect(within(rows[1]!).getByText(/^last seen/).querySelector("time")!.getAttribute("dateTime")).toBe("2026-11-15T09:30:00.000Z");
    // A machine's name is text, never markup.
    expect(table.querySelector("img")).toBeNull();
  });

  it("says not reported for a machine that sent no hardware, and has no Machines table without linked machines", () => {
    renderPanel({ report: report({ machines: [{ ...machines[0]!, hardware: null, localModels: [] }] }) });
    const cellsText = within(screen.getByRole("table", { name: "Machines" })).getAllByRole("row")[1]!.textContent;
    expect(cellsText).toContain("not reported");
    cleanup();
    renderPanel({ report: report() });
    expect(screen.queryByRole("table", { name: "Machines" })).toBeNull();
  });
});
