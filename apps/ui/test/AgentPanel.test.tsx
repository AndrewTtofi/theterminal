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

  const mount = (onStart: () => unknown) =>
    render(
      <AgentPanel adapters={["fake"]} runs={[]} selectedRunId={null} actions={[]}
        onStart={onStart as never} onSelectRun={vi.fn()} onStop={vi.fn()} />,
    );

  it("starts only one run on a double click", async () => {
    const onStart = vi.fn().mockReturnValue(new Promise(() => {}));
    mount(onStart);
    await userEvent.type(screen.getByLabelText("Prompt"), "hello");
    await userEvent.dblClick(screen.getByRole("button", { name: "Start agent" }));
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it("keeps the prompt when starting fails and clears it on success", async () => {
    const onStart = vi.fn().mockResolvedValueOnce(false).mockRejectedValueOnce(new Error("x")).mockResolvedValue(undefined);
    mount(onStart);
    const box = screen.getByLabelText("Prompt") as HTMLTextAreaElement;
    await userEvent.type(box, "hello");
    const start = screen.getByRole("button", { name: "Start agent" });
    await userEvent.click(start);
    expect(box.value).toBe("hello");
    await userEvent.click(start);
    expect(box.value).toBe("hello");
    await userEvent.click(start);
    expect(box.value).toBe("");
  });
});
