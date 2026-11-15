import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { LedgerEntry } from "@theterminal/shared";
import { ShellContext } from "../src/shell/model";
import type { WorkbenchModel } from "../src/shell/model";
import { TerminalPanel, terminalItems } from "../src/views/TerminalPanel";
import { fakeDock, shellNav } from "./connections-harness";
import { completed, decided, ev, feedRun, message, overrideCommand, overrideCompleted, requested } from "./feed-fixtures";

const view = (entries: LedgerEntry[], runId: string | null = null) => terminalItems(entries, runId).map(({ kind, text }) => [kind, text]);

describe("terminalItems", () => {
  it("shows a shell request as a command, its denial and its output", () => {
    const entries = [
      requested(1, "run1", "a1", "nvidia-smi"),
      decided(2, "run1", "a1", "allow"),
      completed(3, "run1", "a1", "GPU 0: Test Card"),
      requested(4, "run1", "a2", "rm -rf build"),
      decided(5, "run1", "a2", "deny", "not now"),
    ];
    expect(view(entries)).toEqual([
      ["command", "$ nvidia-smi"],
      ["output", "GPU 0: Test Card"],
      ["command", "$ rm -rf build"],
      ["denied", "denied: not now"],
    ]);
    expect(terminalItems(entries, null)[1]!.ok).toBe(true);
  });

  it("marks a failed output, and leaves out what is not a shell action", () => {
    const entries = [
      ev(1, "agent.action.requested", { runId: "run1", actionId: "f1", kind: "file_read", tool: "Read", summary: "Read a.ts", input: { path: "a.ts" } }),
      completed(2, "run1", "f1", "file text"),
      message(3, "run1", "Looking"),
      requested(4, "run1", "a1", "false"),
      completed(5, "run1", "a1", "boom", false),
    ];
    const items = terminalItems(entries, null);
    expect(items.map((i) => i.text)).toEqual(["$ false", "boom"]);
    expect(items[1]!.ok).toBe(false);
  });

  it("shows text typed into a running command", () => {
    expect(view([requested(1, "run1", "a1", "yes", "codex.stdin")])).toEqual([["typed", "> yes"]]);
  });

  it("shows an override and its output", () => {
    expect(view([overrideCommand(1, "run1", "git", ["status", "--short"]), overrideCompleted(2, "run1", "M notes.txt")])).toEqual([
      ["override", "# OVERRIDE git status --short"],
      ["override_output", "M notes.txt"],
    ]);
  });

  it("strips terminal codes, makes hidden characters visible and keeps a redaction marker as is", () => {
    const entries = [
      requested(1, "run1", "a1", "echo key=[REDACTED]"),
      completed(2, "run1", "a1", "\u001b[32mOK\u001b[0m"),
      requested(3, "run1", "a2", "echo ok\u202Eko"),
      overrideCommand(4, "run1", "node", ["-e", "\u001b[1mx\u001b[0m\u2066"]),
      overrideCompleted(5, "run1", "\u001b[31m<b>bad</b>\u202Eok\u001b[0m key=[REDACTED]", false),
    ];
    expect(view(entries).map(([, t]) => t)).toEqual([
      "$ echo key=[REDACTED]",
      "OK",
      "$ echo ok\\u202eko",
      "# OVERRIDE node -e x\\u2066",
      "<b>bad</b>\\u202eok key=[REDACTED]",
    ]);
  });

  it("follows one run, or every run", () => {
    const entries = [requested(1, "run1", "a1", "one"), requested(2, "run2", "b1", "two"), overrideCommand(3, "run2", "ls", [])];
    expect(view(entries, "run1")).toEqual([["command", "$ one"]]);
    expect(view(entries, "run2").map(([, t]) => t)).toEqual(["$ two", "# OVERRIDE ls"]);
    expect(view(entries)).toHaveLength(3);
  });

  it("keeps the newest 500 items, oldest first", () => {
    const entries = Array.from({ length: 600 }, (_, i) => requested(i + 1, "run1", `a${i}`, `cmd${i + 1}`));
    const items = terminalItems(entries, null);
    expect(items).toHaveLength(500);
    expect(items[0]!.text).toBe("$ cmd101");
    expect(items[499]!.text).toBe("$ cmd600");
  });
});

function renderTerminal(over: Partial<WorkbenchModel> = {}) {
  const model = {
    runs: [feedRun("run1"), feedRun("run2", { adapter: "claude", prompt: "Fix the login page so that it remembers the user" })],
    projectEntries: [],
    feedRunId: null,
    onFollowRun: vi.fn(),
    narration: {},
    ...over,
  } as unknown as WorkbenchModel;
  const dock = fakeDock();
  render(
    <ShellContext.Provider value={{ model, dock: () => dock, ...shellNav() }}>
      <TerminalPanel />
    </ShellContext.Provider>,
  );
  return model;
}

describe("TerminalPanel", () => {
  const panel = () => screen.getByRole("region", { name: "Terminal" });

  it("labels an override's output as an override too, and paints it red", () => {
    renderTerminal({ projectEntries: [overrideCommand(1, "run1", "git", ["status"]), overrideCompleted(2, "run1", "M notes.txt")] });
    const out = within(panel()).getAllByRole("listitem")[1]!;
    expect(out.textContent).toBe("OVERRIDE M notes.txt");
    expect(out.querySelector(".override-tag")?.textContent).toBe("OVERRIDE");
    expect(out.classList.contains("override")).toBe(true);
  });

  it("is a log the keyboard can reach and scroll, that does not read every line aloud", () => {
    renderTerminal({ projectEntries: [requested(1, "run1", "a1", "ls")] });
    const log = within(panel()).getByRole("log", { name: "Terminal output" });
    expect(log.tabIndex).toBe(0);
    expect(log.getAttribute("aria-live")).toBe("off");
  });

  it("shows the commands, paints overrides red and says it is read-only", () => {
    renderTerminal({ projectEntries: [requested(1, "run1", "a1", "nvidia-smi"), overrideCommand(2, "run1", "git", ["status"])] });
    const lines = within(panel()).getAllByRole("listitem");
    expect(lines.map((l) => l.textContent)).toEqual(["$ nvidia-smi", "# OVERRIDE git status"]);
    expect(lines[1]!.classList.contains("override")).toBe(true);
    expect(lines[0]!.classList.contains("override")).toBe(false);
    expect(panel().textContent).toContain(
      "Read-only. Agents run commands and you approve them. To run something yourself, use the emergency override in the Changes view.",
    );
  });

  it("follows the run chosen in its Follow select", () => {
    const model = renderTerminal({ projectEntries: [requested(1, "run1", "a1", "one"), requested(2, "run2", "b1", "two")], feedRunId: "run2" });
    expect(within(panel()).getAllByRole("listitem").map((l) => l.textContent)).toEqual(["$ two"]);
    const follow = within(panel()).getByRole("combobox", { name: "Follow" }) as HTMLSelectElement;
    expect(follow.value).toBe("run2");
    fireEvent.change(follow, { target: { value: "" } });
    expect(model.onFollowRun).toHaveBeenCalledWith(null);
  });
});
