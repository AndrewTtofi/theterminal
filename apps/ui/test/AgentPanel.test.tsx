import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AgentAction, AgentRun, Connection } from "@theterminal/shared";
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
  base: null,
  costUsd: 0.5,
  inputTokens: null,
  outputTokens: null,
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
    expect(onStart).toHaveBeenCalledWith("fake", "hello", []);
  });

  it("ties the run to the card chosen in the optional card select", async () => {
    const onStart = vi.fn().mockResolvedValue(true);
    const cards = [
      { id: "c1", projectId: "p1", title: "Login", stage: "build", status: "todo", createdAt: "", updatedAt: "" },
      { id: "c2", projectId: "p1", title: "Search", stage: "plan", status: "todo", createdAt: "", updatedAt: "" },
    ] as const;
    render(
      <AgentPanel adapters={["fake"]} cards={[...cards]} runs={[]} selectedRunId={null}
        onStart={onStart} onSelectRun={vi.fn()} onStop={vi.fn()} />,
    );
    const select = screen.getByLabelText("Card (optional)") as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(["No card", "Login", "Search"]);
    expect(select.value).toBe("");
    await userEvent.selectOptions(select, "Search");
    await userEvent.type(screen.getByLabelText("Prompt"), "find books");
    await userEvent.click(screen.getByRole("button", { name: "Start agent" }));
    expect(onStart).toHaveBeenCalledWith("fake", "find books", [], "c2");
  });

  it("lists runs with status and cost and shows actions of the selected run", async () => {
    const onSelectRun = vi.fn();
    const { rerender } = render(
      <AgentPanel adapters={["fake"]} runs={[run]} selectedRunId={null} actions={[act]}
        onStart={vi.fn()} onSelectRun={onSelectRun} onStop={vi.fn()} />,
    );
    const btn = screen.getByRole("button", { name: /completed · \$0\.50 \(estimate\)/ });
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

  it("disables providers whose program is unavailable, whatever their auth mode", () => {
    render(
      <AgentPanel
        adapters={["claude", "codex", "gemini"]}
        providers={{
          claude: { mode: "api_key", available: false },
          codex: { mode: "api_key", available: false },
          gemini: { mode: "api_key", available: true },
        }}
        runs={[]} selectedRunId={null} actions={[]}
        onStart={vi.fn()} onSelectRun={vi.fn()} onStop={vi.fn()}
      />,
    );
    const opt = (n: RegExp) => screen.getByRole("option", { name: n }) as HTMLOptionElement;
    expect(opt(/Claude \(unavailable\)/).disabled).toBe(true);
    expect(opt(/Codex \(unavailable\)/).disabled).toBe(true);
    expect(opt(/^Gemini$/).disabled).toBe(false);
    expect(screen.queryByText(/not installed/)).toBeNull();
  });

  it("disables Claude when unavailable in subscription mode, and defaults to an enabled adapter", () => {
    render(
      <AgentPanel
        adapters={["claude", "codex"]}
        providers={{
          claude: { mode: "subscription", available: false },
          codex: { mode: "api_key", available: true },
          gemini: { mode: "api_key", available: true },
        }}
        runs={[]} selectedRunId={null} actions={[]}
        onStart={vi.fn()} onSelectRun={vi.fn()} onStop={vi.fn()}
      />,
    );
    expect((screen.getByRole("option", { name: /Claude \(unavailable\)/ }) as HTMLOptionElement).disabled).toBe(true);
    expect((screen.getByLabelText("Agent") as HTMLSelectElement).value).toBe("codex");
  });

  describe("giving a run access to connections", () => {
    const conn = (id: string, kind: Connection["kind"], provider: Connection["provider"], name: string, enabled = true): Connection => ({
      id, kind, provider, name, enabled, config: {}, private: {}, secretFields: [],
      status: { state: "untested", message: "", testedAt: null }, createdAt: "", updatedAt: "",
    });
    const list = [
      conn("aws-1", "cloud", "aws", "AWS dev"),
      conn("mcp-1", "mcp", "mcp_http", "Docs"),
      conn("gcp-1", "cloud", "gcp", "Old GCP", false),
      conn("llm-1", "llm", "claude", "Claude key"),
      conn("gh-1", "github", "github", "GitHub"),
    ];
    const NOTE = "Codex cannot use MCP servers in The Terminal yet: Codex gives no approval step for MCP tool calls under its strict policy.";

    it("lists only enabled cloud and MCP connections, and sends the ones ticked", async () => {
      const onStart = vi.fn().mockResolvedValue(true);
      render(
        <AgentPanel adapters={["claude", "codex"]} connections={list} runs={[]} selectedRunId={null}
          onStart={onStart} onSelectRun={vi.fn()} onStop={vi.fn()} />,
      );
      const group = screen.getByRole("group", { name: "Give this run access to" });
      const boxes = Array.from(group.querySelectorAll("input[type=checkbox]")).map((b) => (b as HTMLInputElement).labels![0]!.textContent);
      expect(boxes).toEqual(["AWS dev (cloud account)", "Docs (MCP server)"]);
      expect(screen.queryByText(NOTE)).toBeNull();
      await userEvent.click(screen.getByLabelText("AWS dev (cloud account)"));
      await userEvent.type(screen.getByLabelText("Prompt"), "deploy");
      await userEvent.click(screen.getByRole("button", { name: "Start agent" }));
      expect(onStart).toHaveBeenCalledWith("claude", "deploy", ["aws-1"]);
    });

    it("with Codex disables the MCP boxes, explains why, and never sends one", async () => {
      const onStart = vi.fn().mockResolvedValue(true);
      render(
        <AgentPanel adapters={["claude", "codex"]} connections={list} runs={[]} selectedRunId={null}
          onStart={onStart} onSelectRun={vi.fn()} onStop={vi.fn()} />,
      );
      await userEvent.click(screen.getByLabelText("Docs (MCP server)"));
      await userEvent.selectOptions(screen.getByLabelText("Agent"), "codex");
      expect((screen.getByLabelText("Docs (MCP server)") as HTMLInputElement).disabled).toBe(true);
      expect((screen.getByLabelText("AWS dev (cloud account)") as HTMLInputElement).disabled).toBe(false);
      expect(screen.getByText(NOTE)).toBeTruthy();
      await userEvent.type(screen.getByLabelText("Prompt"), "go");
      await userEvent.click(screen.getByRole("button", { name: "Start agent" }));
      expect(onStart).toHaveBeenCalledWith("codex", "go", []);
    });

    it("with Gemini disables the MCP boxes, explains why, and never sends one", async () => {
      const onStart = vi.fn().mockResolvedValue(true);
      render(
        <AgentPanel adapters={["claude", "gemini"]} connections={list} runs={[]} selectedRunId={null}
          onStart={onStart} onSelectRun={vi.fn()} onStop={vi.fn()} />,
      );
      await userEvent.click(screen.getByLabelText("Docs (MCP server)"));
      await userEvent.selectOptions(screen.getByLabelText("Agent"), "gemini");
      expect((screen.getByLabelText("Docs (MCP server)") as HTMLInputElement).disabled).toBe(true);
      expect(screen.getByText("Gemini cannot use MCP servers in The Terminal yet: Gemini only starts MCP servers in a trusted folder, and The Terminal never trusts agent worktrees.")).toBeTruthy();
      expect(screen.queryByText(NOTE)).toBeNull();
      await userEvent.type(screen.getByLabelText("Prompt"), "go");
      await userEvent.click(screen.getByRole("button", { name: "Start agent" }));
      expect(onStart).toHaveBeenCalledWith("gemini", "go", []);
    });

    it("shows no picker when there is nothing to offer", () => {
      render(
        <AgentPanel adapters={["claude"]} connections={[list[2]!, list[3]!]} runs={[]} selectedRunId={null}
          onStart={vi.fn()} onSelectRun={vi.fn()} onStop={vi.fn()} />,
      );
      expect(screen.queryByRole("group", { name: "Give this run access to" })).toBeNull();
    });
  });
});
