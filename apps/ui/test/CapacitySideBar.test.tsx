import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CapacityReport } from "@theterminal/shared";

vi.mock("../src/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/api")>();
  return { ...real, api: { detectHardware: vi.fn() } };
});

import { api } from "../src/api";
import { ShellContext } from "../src/shell/model";
import type { WorkbenchModel } from "../src/shell/model";
import { CapacitySideBar } from "../src/views/CapacitySideBar";
import { hardware, localEngines, machines, report } from "./capacity-fixtures";
import { fakeDock, shellNav } from "./connections-harness";

const m = vi.mocked(api);

function renderSideBar(capacity: Partial<WorkbenchModel["capacity"]>) {
  const refresh = vi.fn();
  const dock = fakeDock();
  const model = { capacity: { report: null, error: null, refresh, ...capacity } } as unknown as WorkbenchModel;
  render(
    <ShellContext.Provider value={{ model, dock: () => dock, ...shellNav() }}>
      <CapacitySideBar />
    </ShellContext.Provider>,
  );
  return { refresh, dock };
}

const row = (name: RegExp) => screen.getByRole("listitem", { name });

beforeEach(() => vi.clearAllMocks());

describe("CapacitySideBar", () => {
  it("loads the report when it opens", () => {
    const { refresh } = renderSideBar({});
    expect(refresh).toHaveBeenCalled();
    expect(screen.getByText("Loading…")).toBeTruthy();
  });

  it("shows each source with its plan, the month's spend against the budget, and labels Claude's cost an estimate", () => {
    renderSideBar({ report: report() });
    const claude = row(/Claude · Max 5x/);
    expect(within(claude).getByText("$12.00 of $50.00 this month", { exact: false })).toBeTruthy();
    const bar = within(claude).getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("12");
    expect(bar.getAttribute("aria-valuemax")).toBe("50");
    const est = within(claude).getByText("estimate");
    expect(est.tagName).toBe("ABBR");
    expect(est.getAttribute("title")).toBe("Not a figure from the provider. Computed by The Terminal from observed usage.");

    const codex = row(/Codex · no plan set/);
    expect(within(codex).getByText("not reported")).toBeTruthy();
    expect(within(codex).queryByText("estimate")).toBeNull();
    expect(within(codex).queryByRole("progressbar")).toBeNull();
    expect(within(codex).queryByText(/\$0\.00/)).toBeNull();
  });

  it("shows the month's spend without a bar when there is cost but no budget", () => {
    const r = report();
    r.sources[0] = { ...r.sources[0]!, monthlyBudgetUsd: null };
    renderSideBar({ report: r });
    const claude = row(/Claude · Max 5x/);
    expect(within(claude).getByText("$12.00 this month", { exact: false })).toBeTruthy();
    expect(within(claude).queryByRole("progressbar")).toBeNull();
  });

  it("focuses the Capacity tab", async () => {
    const { dock } = renderSideBar({ report: report() });
    await userEvent.click(screen.getByRole("button", { name: "Open capacity" }));
    expect(dock.focus).toHaveBeenCalledWith("capacity");
  });

  it("says this computer is not detected yet, and detects it through the API, then refreshes", async () => {
    m.detectHardware.mockResolvedValue(hardware);
    const { refresh } = renderSideBar({ report: report() });
    const section = screen.getByRole("region", { name: "This computer" });
    expect(within(section).getByText("Not detected yet")).toBeTruthy();
    refresh.mockClear();
    await userEvent.click(within(section).getByRole("button", { name: "Detect this computer" }));
    expect(m.detectHardware).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("shows the detected CPU, memory and GPU, noting unified memory and WSL", () => {
    renderSideBar({ report: report({ hardware }) });
    const section = screen.getByRole("region", { name: "This computer" });
    expect(section.textContent).toContain("CPU: Apple M2 Max (12 cores)");
    expect(section.textContent).toContain("Memory: 32 GB");
    expect(section.textContent).toContain("GPU: Apple M2 Max, 32 GB shared with the CPU");
  });

  it("notes that the GPU inside WSL is the Windows machine's, and an undetected GPU", () => {
    const wsl: CapacityReport["hardware"] = { ...hardware, platform: "linux", wsl: true, gpu: null, gpuMemoryGb: null };
    renderSideBar({ report: report({ hardware: wsl }) });
    const section = screen.getByRole("region", { name: "This computer" });
    expect(section.textContent).toContain("GPU: not detected");
    expect(section.textContent).toContain("Running inside WSL: the GPU is the Windows machine's.");
  });

  it("says This computer is turned off in Connections when the Owner disabled it", async () => {
    renderSideBar({ report: report({ hardware: { ...hardware, enabled: false } }) });
    const section = screen.getByRole("region", { name: "This computer" });
    expect(within(section).getByText("Turned off in Connections")).toBeTruthy();
    expect(within(section).queryByText("Not detected yet")).toBeNull();
    expect(section.textContent).not.toContain("CPU:");
  });

  it("lists each local model server with its version and model count", () => {
    renderSideBar({ report: report({ localModels: localEngines }) });
    const section = screen.getByRole("region", { name: "Local models" });
    expect(within(section).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Ollama 0.12.3 · 2 models", "llama.cpp · 1 model"]);
  });

  it("says how to get a local model server when none was detected", () => {
    renderSideBar({ report: report() });
    const section = screen.getByRole("region", { name: "Local models" });
    expect(section.textContent).toContain("No local model server detected. Install Ollama or llama.cpp server and detect again.");
  });

  it("says when the report could not be loaded", () => {
    renderSideBar({ error: "request_failed" });
    expect(screen.getByText("Could not load capacity")).toBeTruthy();
  });

  it("adds a section per linked machine: its state, a one-line hardware summary and its local model count", () => {
    renderSideBar({ report: report({ machines }) });
    const box = screen.getByRole("region", { name: "GPU box · online" });
    expect(within(box).getByText("AMD Ryzen 9 7950X · 64 GB · NVIDIA RTX 4090")).toBeTruthy();
    expect(within(box).getByText("3 local models")).toBeTruthy();
    expect(box.className).not.toContain("offline");

    const off = screen.getByRole("region", { name: "<img src=x onerror=alert(1)> · offline" });
    expect(off.className).toContain("offline");
    expect(within(off).getByText("Apple M1 · 16 GB · GPU not detected")).toBeTruthy();
    expect(within(off).getByText("0 local models")).toBeTruthy();
    expect(within(off).getByText(/^last seen/).textContent).toBe(`last seen ${new Date("2026-11-15T08:45:00.000Z").toLocaleString()}`);
    expect(within(box).queryByText(/^last seen/)).toBeNull();
    expect(document.querySelector(".capacity-side img")).toBeNull();
  });

  it("says one local model, and hardware not reported, for a machine that sent none", () => {
    const one = { ...localEngines[1]! };
    renderSideBar({ report: report({ machines: [{ ...machines[0]!, hardware: null, localModels: [one] }] }) });
    const box = screen.getByRole("region", { name: "GPU box · online" });
    expect(within(box).getByText("Hardware not reported")).toBeTruthy();
    expect(within(box).getByText("1 local model")).toBeTruthy();
  });

  it("has no machine sections without linked machines", () => {
    renderSideBar({ report: report() });
    expect(screen.queryByRole("region", { name: / · (online|offline)$/ })).toBeNull();
  });

  it("says key changed for a machine whose address presented another key, with no last seen", () => {
    renderSideBar({ report: report({ machines: [{ ...machines[1]!, name: "Laptop", problem: "key_mismatch", lastSeenAt: null, hardware: null }] }) });
    const section = screen.getByRole("region", { name: "Laptop · key changed" });
    expect(section.textContent).not.toMatch(/last seen|never seen/);
  });

  it("shows a remote machine's hardware summary with hidden characters made visible", () => {
    const hardware = { ...machines[0]!.hardware!, cpu: "Ryzen\u202E9" };
    renderSideBar({ report: report({ machines: [{ ...machines[0]!, hardware }] }) });
    const box = screen.getByRole("region", { name: "GPU box · online" });
    expect(within(box).getByText("Ryzen\\u202e9 · 64 GB · NVIDIA RTX 4090")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/[\u202E\u200B]/);
  });

  it("shows a remote machine's name with hidden characters made visible", () => {
    const name = "GPU\u202Eexe.bat\u200Bbox";
    renderSideBar({ report: report({ machines: [{ ...machines[0]!, name }] }) });
    expect(screen.getByRole("region", { name: "GPU\\u202eexe.bat\\u200bbox · online" })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/[\u202E\u200B]/);
  });
});
