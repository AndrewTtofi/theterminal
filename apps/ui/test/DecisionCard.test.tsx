import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AgentAction } from "@theterminal/shared";
import { ApiError } from "../src/api";
import { DecisionCard } from "../src/components/DecisionCard";
import { ShellContext } from "../src/shell/model";
import type { ShellContextValue, WorkbenchModel } from "../src/shell/model";
import { fakeDock, shellNav } from "./connections-harness";

const action: AgentAction = {
  id: "act1",
  runId: "run1",
  kind: "shell",
  tool: "Bash",
  summary: "run npm test",
  input: { command: "npm test" },
  status: "pending",
  decidedBy: null,
  reason: "",
  output: null,
  requestedAt: "2026-01-01T10:00:00Z",
  decidedAt: null,
};

describe("DecisionCard", () => {
  it("shows the title and collapsible details", () => {
    render(<DecisionCard action={action} onDecide={vi.fn()} />);
    expect(screen.getByRole("heading", { level: 3 }).textContent).toBe('Agent wants to run the command "npm test"');
    expect(screen.getByText("Details")).toBeTruthy();
    expect(document.querySelector("pre")?.textContent).toContain("npm test");
  });

  it("says what the kind of action means, and keeps the summary in its label", () => {
    const { container } = render(<DecisionCard action={action} onDecide={vi.fn()} />);
    const heading = screen.getByRole("heading", { level: 4, name: "What this means" });
    expect(heading.nextElementSibling).toBe(container.querySelector("p.means"));
    expect(container.querySelector("p.means")?.textContent).toBe(
      "Runs a program on this computer, inside the agent's working copy. It can read and change files there and reach the network.",
    );
    expect(screen.getByRole("article", { name: "Decision: run npm test" })).toBeTruthy();
  });

  it("makes hidden characters in its label visible", () => {
    const { container } = render(<DecisionCard action={{ ...action, summary: "run a\u202eb" }} onDecide={vi.fn()} />);
    expect(container.querySelector("article")!.getAttribute("aria-label")).toBe("Decision: run a\\u202eb");
  });

  it("phrases other kinds from their input", () => {
    const read = { ...action, kind: "file_read" as const, tool: "Read", summary: "Read: a.md", input: { file_path: "docs/a.md" } };
    const { container } = render(<DecisionCard action={read} onDecide={vi.fn()} />);
    expect(screen.getByRole("heading", { level: 3 }).textContent).toBe("Agent wants to read docs/a.md");
    expect(container.querySelector("p.means")?.textContent).toBe("Reads a file inside the agent's working copy of the project. Nothing changes.");
  });

  it("allows", async () => {
    const onDecide = vi.fn().mockResolvedValue(undefined);
    render(<DecisionCard action={action} onDecide={onDecide} />);
    await userEvent.click(screen.getByRole("button", { name: "Allow" }));
    expect(onDecide).toHaveBeenCalledWith("act1", "allow");
  });

  it("denies with a reason", async () => {
    const onDecide = vi.fn().mockResolvedValue(undefined);
    render(<DecisionCard action={action} onDecide={onDecide} />);
    await userEvent.click(screen.getByRole("button", { name: "Deny" }));
    await userEvent.type(screen.getByLabelText("Reason (optional)"), "too risky");
    await userEvent.click(screen.getByRole("button", { name: "Confirm deny" }));
    expect(onDecide).toHaveBeenCalledWith("act1", "deny", "too risky");
  });

  it("shows Already decided on 409", async () => {
    const onDecide = vi.fn().mockRejectedValue(new ApiError(409, "already_decided"));
    render(<DecisionCard action={action} onDecide={onDecide} />);
    await userEvent.click(screen.getByRole("button", { name: "Allow" }));
    expect(await screen.findByText("Already decided")).toBeTruthy();
  });

  it("sends one decision when Allow is double-clicked", async () => {
    let resolve!: () => void;
    const onDecide = vi.fn().mockReturnValue(new Promise<void>((r) => (resolve = r)));
    render(<DecisionCard action={action} onDecide={onDecide} />);
    const allow = screen.getByRole("button", { name: "Allow" });
    await userEvent.dblClick(allow);
    expect(onDecide).toHaveBeenCalledTimes(1);
    expect((screen.getByRole("button", { name: "Deny" }) as HTMLButtonElement).disabled).toBe(true);
    resolve();
  });

  it("sends one decision when Confirm deny is double-clicked", async () => {
    const onDecide = vi.fn().mockReturnValue(new Promise<void>(() => {}));
    render(<DecisionCard action={action} onDecide={onDecide} />);
    await userEvent.click(screen.getByRole("button", { name: "Deny" }));
    await userEvent.dblClick(screen.getByRole("button", { name: "Confirm deny" }));
    expect(onDecide).toHaveBeenCalledTimes(1);
  });

  it("shows a shell action's full command in the card body, not only the capped title", () => {
    const command = `npm run build -- ${"--flag ".repeat(60)}&& rm -rf ./out`;
    const long = { ...action, summary: `Run: ${command.slice(0, 150)}`, input: { command, description: "build" } };
    const { container } = render(<DecisionCard action={long} onDecide={vi.fn()} />);
    const pre = container.querySelector("pre.command");
    expect(pre?.textContent).toBe(command);
    expect(pre?.closest("details")).toBeNull();
  });

  it("shows the text to be typed, not the running command, for input to a running command", () => {
    const stdin = {
      ...action,
      tool: "codex.stdin",
      summary: "Type into python3 repl.py: rm -rf /\\n",
      input: { command: "python3 repl.py", cwd: "/w", kind: "writeStdin", reason: "rm -rf /\n" },
    };
    const { container } = render(<DecisionCard action={stdin} onDecide={vi.fn()} />);
    expect(container.querySelector("pre.command")?.textContent).toBe("rm -rf /\n");
  });

  it("makes control characters in the text to be typed visible, keeping line breaks and tabs", () => {
    const stdin = {
      ...action,
      tool: "codex.stdin",
      summary: "Type into bash: ...",
      input: { command: "bash", kind: "writeStdin", reason: "echo hi\r\n\u0003\ttab\u007f\u001b[2Jend\n" },
    };
    const { container } = render(<DecisionCard action={stdin} onDecide={vi.fn()} />);
    expect(container.querySelector("pre.command")?.textContent).toBe("echo hi\\r\n\\u0003\ttab\\u007f\\u001b[2Jend\n");
  });

  it("makes C1 controls and bidi and zero-width characters in the text to be typed visible", () => {
    const typed = "a\u0085b\u009bc\u200Bd\u200Fe\u202Af\u202Eg\u2066h\u2069i j";
    const stdin = { ...action, tool: "codex.stdin", summary: "Type into bash: ...", input: { command: "bash", kind: "writeStdin", reason: typed } };
    const { container } = render(<DecisionCard action={stdin} onDecide={vi.fn()} />);
    expect(container.querySelector("pre.command")?.textContent).toBe(
      "a\\u0085b\\u009bc\\u200bd\\u200fe\\u202af\\u202eg\\u2066h\\u2069i j",
    );
  });

  it("makes hidden characters in the project name visible", () => {
    const { container } = render(<DecisionCard action={action} projectName={"Book\u202EClub"} onDecide={vi.fn()} />);
    expect(container.querySelector("p.project-name")?.textContent).toBe("Book\\u202eClub");
  });

  it("makes hidden characters in a shell command visible", () => {
    const sneaky = { ...action, input: { command: "echo safe\u202e; rm -rf ./out" } };
    const { container } = render(<DecisionCard action={sneaky} onDecide={vi.fn()} />);
    expect(container.querySelector("pre.command")?.textContent).toBe("echo safe\\u202e; rm -rf ./out");
    expect(container.querySelector("details pre")?.textContent).toContain("echo safe\\u202e;");
  });

  it("shows no command block for other kinds of action", () => {
    const edit = { ...action, kind: "file_edit" as const, input: { command: "not a shell action" } };
    const { container } = render(<DecisionCard action={edit} onDecide={vi.fn()} />);
    expect(container.querySelector("pre.command")).toBeNull();
  });

  it("says how much of a truncated input is hidden", () => {
    const preview = `{"command":"echo ${"z".repeat(3970)}…[truncated]`;
    const truncated = { ...action, input: { truncated: true, sha256: "ab".repeat(32), totalChars: 25000, preview } };
    render(<DecisionCard action={truncated} onDecide={vi.fn()} />);
    expect(screen.getByText(`${25000 - (preview.length - "…[truncated]".length)} characters hidden — full input not shown`)).toBeTruthy();
  });

  it("does not show a hidden-characters note for a complete input", () => {
    render(<DecisionCard action={action} onDecide={vi.fn()} />);
    expect(screen.queryByText(/characters hidden/)).toBeNull();
  });

  it("renders hostile summary and input as inert text", () => {
    const evil = { ...action, summary: '<img src=x onerror="window.__pwned=1">', input: { x: "<script>window.__pwned=1</script>" } };
    const { container } = render(<DecisionCard action={evil} onDecide={vi.fn()} />);
    expect(container.querySelector("img, script")).toBeNull();
    // Shown as literal text (narration escapes the quotes inside a command).
    expect(container.textContent).toContain("<img src=x onerror=");
    expect(container.querySelector("pre")?.textContent).toContain("<script>");
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it("links to the Learn topic for its kind of action", async () => {
    const nav = shellNav();
    render(
      <ShellContext.Provider value={{ model: {} as WorkbenchModel, dock: () => fakeDock(), ...nav } satisfies ShellContextValue}>
        <DecisionCard action={action} onDecide={vi.fn()} />
      </ShellContext.Provider>,
    );
    const learn = screen.getByRole("button", { name: "Learn more" });
    expect(document.getElementById(learn.getAttribute("aria-describedby")!)!.textContent).toBe('Agent wants to run the command "npm test"');
    await userEvent.click(learn);
    expect(nav.openLearn).toHaveBeenCalledWith("action_kinds");
  });

  it("offers More context only when asked to, described by the card's heading", async () => {
    const onMore = vi.fn();
    const { rerender } = render(<DecisionCard action={action} onDecide={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "More context" })).toBeNull();
    rerender(<DecisionCard action={action} onDecide={vi.fn()} onMore={onMore} />);
    const more = screen.getByRole("button", { name: "More context" });
    expect(document.getElementById(more.getAttribute("aria-describedby")!)!.textContent).toBe('Agent wants to run the command "npm test"');
    await userEvent.click(more);
    expect(onMore).toHaveBeenCalledTimes(1);
  });

  it("shows a read-only copy that points to the strip instead of deciding", () => {
    render(<DecisionCard action={action} onDecide={vi.fn()} readOnly />);
    expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Deny" })).toBeNull();
    expect(screen.getByText("Decide in the strip above")).toBeTruthy();
    expect(screen.getByText("Details")).toBeTruthy();
  });

  it("a remote action says where it runs and that the decision is sent there; unreachable is fixed text", async () => {
    const onDecide = vi.fn().mockRejectedValue(new ApiError(502, "machine_unreachable"));
    render(<DecisionCard action={action} machineName="GPU box" onDecide={onDecide} />);
    expect(screen.getByText("This agent runs on GPU box. Your decision is sent there.")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /Allow/ }));
    expect(await screen.findByText("Could not reach GPU box. Your decision was not sent.")).toBeTruthy();
  });

  it("a remote refusal never shows the machine's own message, and a local action names no machine", async () => {
    const onDecide = vi.fn().mockRejectedValue(new ApiError(400, "remote_refused", { code: "invalid_input", machine: "GPU box", message: "<b>rm -rf</b>" }));
    const { container, rerender } = render(<DecisionCard action={action} machineName="GPU box" onDecide={onDecide} />);
    await userEvent.click(screen.getByRole("button", { name: /Allow/ }));
    expect(await screen.findByText("Something went wrong")).toBeTruthy();
    expect(container.textContent).not.toContain("rm -rf");
    rerender(<DecisionCard action={action} onDecide={vi.fn()} />);
    expect(container.textContent).not.toContain("This agent runs on");
  });
});
