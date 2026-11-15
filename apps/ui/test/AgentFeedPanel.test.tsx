import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { AgentAction, AgentRun, LedgerEntry } from "@theterminal/shared";
import { ShellContext } from "../src/shell/model";
import type { WorkbenchModel } from "../src/shell/model";
import { AgentFeedPanel } from "../src/views/AgentFeedPanel";
import { fakeDock } from "./connections-harness";

const run: AgentRun = {
  id: "run1", projectId: "p1", cardId: null, adapter: "fake", authMode: "none", prompt: "Detect GPU",
  status: "running", worktree: "w/run1", costUsd: null, inputTokens: null, outputTokens: null, error: null, startedAt: "", finishedAt: null,
};
const shell: AgentAction = {
  id: "a1", runId: "run1", kind: "shell", tool: "Bash", summary: "Run: nvidia-smi", input: { command: "nvidia-smi" },
  status: "pending", decidedBy: null, reason: "", output: null, requestedAt: "", decidedAt: null,
};
const message = (seq: number, runId: string, text: string): LedgerEntry => ({
  seq, id: `e${seq}`, ts: "", projectId: "p1", actor: { kind: "agent", id: runId },
  type: "agent.message", payload: { runId, text }, prevHash: "", hash: "",
});

function renderFeed(over: Partial<WorkbenchModel> = {}) {
  const model = { runs: [run], selectedRunId: "run1", runActions: [shell], entries: [], ...over } as unknown as WorkbenchModel;
  const dock = fakeDock();
  return render(
    <ShellContext.Provider value={{ model, dock: () => dock, selectView: vi.fn() }}>
      <AgentFeedPanel />
    </ShellContext.Provider>,
  );
}

const actions = () => screen.getByRole("list", { name: "Run actions" });

describe("AgentFeedPanel", () => {
  it("narrates a pending shell action, with its status and the raw input underneath", () => {
    renderFeed();
    const li = within(actions()).getByRole("listitem");
    expect(li.textContent).toContain('Wants to run the command "nvidia-smi"');
    expect(li.textContent).toContain("pending");
    expect(li.textContent).not.toContain("Run: nvidia-smi ·");
    const raw = li.querySelector("details");
    expect(raw?.querySelector("summary")?.textContent).toBe("Raw");
    expect(raw?.textContent).toContain('"command": "nvidia-smi"');
  });

  it("shows who decided and the raw output after completion", () => {
    const done = { ...shell, status: "completed" as const, decidedBy: "human" as const, output: "GPU 0: Test Card\n" };
    renderFeed({ runActions: [done] });
    const li = within(actions()).getByRole("listitem");
    expect(li.textContent).toContain('Did run the command "nvidia-smi"');
    expect(li.textContent).toContain("decided by human");
    expect(li.querySelector("details")?.textContent).toContain("GPU 0: Test Card");
  });

  it("shows the run's messages in order as The agent said", () => {
    renderFeed({
      runActions: [],
      entries: [message(1, "run1", "Looking for a GPU"), message(2, "other", "Not this run"), message(3, "run1", "Found one")],
    });
    const said = screen.getAllByText(/^The agent said: /).map((n) => n.textContent);
    expect(said).toEqual(["The agent said: Looking for a GPU", "The agent said: Found one"]);
  });

  it("renders hostile input and output as inert text with hidden characters visible", () => {
    const evil = { ...shell, status: "completed" as const, input: { command: "<script>window.__pwned=1</script>" }, output: "ok‮ko" };
    const { container } = renderFeed({ runActions: [evil], entries: [message(1, "run1", "<img src=x onerror=alert(1)>​")] });
    expect(container.querySelector("img, script")).toBeNull();
    expect(container.textContent).toContain("ok\\u202eko");
    expect(container.textContent).toContain("<img src=x onerror=alert(1)>\\u200b");
    expect(container.textContent).not.toMatch(/[​‮]/);
  });
});
