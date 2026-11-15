import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PendingAgentAction, RunChanges } from "@theterminal/shared";
import { DecisionContext, proposedChange } from "../src/components/DecisionContext";
import { message, requested } from "./feed-fixtures";

const action = (over: Partial<PendingAgentAction> = {}): PendingAgentAction => ({
  id: "a1", runId: "run1", kind: "file_write", tool: "Write", summary: "Write src/a.ts",
  input: { file_path: "src/a.ts", content: "one\ntwo\n" }, status: "pending", decidedBy: null, reason: "", output: null,
  requestedAt: "", decidedAt: null, projectId: "p1", projectName: "Demo", ...over,
});

const changes = (n: number): RunChanges => ({
  runId: "run1", base: "b".repeat(40), head: "h".repeat(40), truncated: false,
  files: Array.from({ length: n }, (_, i) => ({ path: `f${i}.txt`, status: "added" as const, added: 1, deleted: 0, binary: false })),
});

function renderContext(over: Partial<Parameters<typeof DecisionContext>[0]> = {}) {
  const onSeeChanges = vi.fn();
  const r = render(<DecisionContext action={action()} entries={null} changes={null} onSeeChanges={onSeeChanges} {...over} />);
  return { onSeeChanges, ...r };
}

describe("proposedChange", () => {
  it("reads Claude's file write as a whole-file replacement", () => {
    expect(proposedChange({ kind: "file_write", input: { file_path: "src/a.ts", content: "x" } })).toEqual({
      path: "src/a.ts", kind: "replace_file", content: "x",
    });
  });

  it("reads Claude's edit as old and new text", () => {
    expect(proposedChange({ kind: "file_edit", input: { file_path: "src/a.ts", old_string: "a", new_string: "b" } })).toEqual({
      path: "src/a.ts", kind: "edit", oldText: "a", newText: "b",
    });
  });

  it("keeps the path of a write without content (the fake's) but proposes nothing", () => {
    expect(proposedChange({ kind: "file_write", input: { path: "notes.txt" } })).toEqual({ path: "notes.txt", kind: "none" });
  });

  it("proposes nothing for a shell action or an input that is not an object", () => {
    expect(proposedChange({ kind: "shell", input: { command: "npm test" } })).toEqual({ path: null, kind: "none" });
    expect(proposedChange({ kind: "file_write", input: null })).toEqual({ path: null, kind: "none" });
  });
});

describe("DecisionContext", () => {
  it("paints an edit as -old then +new lines under the file's name", () => {
    const { container } = renderContext({
      action: action({ kind: "file_edit", input: { file_path: "src/a.ts", old_string: "let a = 1;", new_string: "let a = 2;\nlet b = 3;" } }),
    });
    expect(screen.getByRole("heading", { name: "Proposed change to src/a.ts" })).toBeTruthy();
    const lines = [...container.querySelectorAll("pre.proposed > span")].map((l) => l.textContent);
    expect(lines).toEqual(["-let a = 1;", "+let a = 2;", "+let b = 3;"]);
  });

  it("paints a replacement as +lines and cuts it at 200 lines with a note", () => {
    const content = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join("\n");
    const { container } = renderContext({ action: action({ input: { file_path: "big.txt", content } }) });
    const lines = container.querySelectorAll("pre.proposed > span");
    expect(lines).toHaveLength(200);
    expect(lines[0]!.textContent).toBe("+line 1");
    expect(lines[199]!.textContent).toBe("+line 200");
    expect(screen.getByText("… 100 more lines in Details")).toBeTruthy();
  });

  it("makes escape sequences and hidden characters in the text visible rather than acting on them", () => {
    const { container } = renderContext({ action: action({ input: { file_path: "a.txt", content: "\u001b[31mred\u001b[0m\u202Eevil" } }) });
    expect(container.querySelector("pre.proposed > span")!.textContent).toBe("+red\\u202eevil");
  });

  it("shows nothing proposed for an action without old or new text", () => {
    const { container } = renderContext({ action: action({ kind: "file_write", input: { path: "notes.txt" } }) });
    expect(container.querySelector("pre.proposed")).toBeNull();
    expect(screen.queryByText(/Proposed change/)).toBeNull();
  });

  it("shows the last two things the agent of this run said", () => {
    const entries = [
      message(1, "run1", "Reading the code"),
      message(2, "run2", "Another run speaking"),
      message(3, "run1", "Found the bug"),
      requested(4, "run1", "a0", "npm test"),
      message(5, "run1", "Writing the fix"),
    ];
    renderContext({ entries });
    expect(screen.getByText("Before this, the agent said:")).toBeTruthy();
    const said = screen.getAllByRole("listitem").map((li) => li.textContent);
    expect(said).toEqual(["Found the bug", "Writing the fix"]);
  });

  it("omits what the agent said when there are no entries or no messages", () => {
    const { rerender } = renderContext({ entries: null });
    expect(screen.queryByText("Before this, the agent said:")).toBeNull();
    rerender(<DecisionContext action={action()} entries={[requested(1, "run1", "a0", "ls")]} changes={null} onSeeChanges={vi.fn()} />);
    expect(screen.queryByText("Before this, the agent said:")).toBeNull();
  });

  it("says how many files the run has changed and opens them", async () => {
    const { onSeeChanges } = renderContext({ changes: changes(2) });
    expect(screen.getByText("This run has changed 2 files so far")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "See changes" }));
    expect(onSeeChanges).toHaveBeenCalledWith("run1");
  });

  it("says nothing changed yet for none", () => {
    renderContext({ changes: changes(0) });
    expect(screen.getByText("Nothing changed yet")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "See changes" })).toBeNull();
  });

  it("shows a note in place of the changes, plainly and not as an error", () => {
    renderContext({ changesNote: "Changes show when the run is stopped or finished." });
    const note = screen.getByText("Changes show when the run is stopped or finished.");
    expect(note.getAttribute("role")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: "See changes" })).toBeNull();
  });
});
