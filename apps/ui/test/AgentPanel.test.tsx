import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AgentAction, AgentRun } from "@theterminal/shared";
import { AgentPanel } from "../src/components/AgentPanel";

const run: AgentRun = {
  id: "run1",
  projectId: "p1",
  cardId: null,
  adapter: "fake",
  authMode: "none",
  prompt: "do a thing",
  status: "completed",
  worktree: "w/run1",
  costUsd: 0.5,
  error: null,
  startedAt: "",
  finishedAt: null,
};
const act: AgentAction = {
  id: "a1",
  runId: "run1",
  kind: "file_write",
  tool: "Write",
  summary: "write notes.md",
  input: {},
  status: "allowed",
  decidedBy: "policy",
  reason: "",
  output: null,
  requestedAt: "",
  decidedAt: null,
};

describe("AgentPanel", () => {
  it("starts an agent with the chosen adapter and prompt", async () => {
    const onStart = vi.fn().mockResolvedValue(undefined);
    render(
      <AgentPanel adapters={["claude", "fake"]} runs={[]} selectedRunId={null} actions={[]}
        onStart={onStart} onSelectRun={vi.fn()} onStop={vi.fn()} />,
    );
    const start = screen.getByRole("button", { name: "Start agent" }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    await userEvent.selectOptions(screen.getByLabelText("Agent"), "fake");
    await userEvent.type(screen.getByLabelText("Prompt"), "hello");
    await userEvent.click(start);
    expect(onStart).toHaveBeenCalledWith("fake", "hello");
  });

  it("lists runs with status and cost and shows actions of the selected run", async () => {
    const onSelectRun = vi.fn();
    const { rerender } = render(
      <AgentPanel adapters={["fake"]} runs={[run]} selectedRunId={null} actions={[act]}
        onStart={vi.fn()} onSelectRun={onSelectRun} onStop={vi.fn()} />,
    );
    const btn = screen.getByRole("button", { name: /completed · \$0\.50/ });
    await userEvent.click(btn);
    expect(onSelectRun).toHaveBeenCalledWith("run1");
    rerender(
      <AgentPanel adapters={["fake"]} runs={[run]} selectedRunId="run1" actions={[act]}
        onStart={vi.fn()} onSelectRun={onSelectRun} onStop={vi.fn()} />,
    );
    expect(screen.getByText(/write notes\.md · allowed · decided by policy/)).toBeTruthy();
  });
});
