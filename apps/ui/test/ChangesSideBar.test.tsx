import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { AgentRun, DirListing, LedgerEntry, RunChanges } from "@theterminal/shared";
import { ApiError } from "../src/api";
import { ChangesSideBar } from "../src/views/ChangesSideBar";
import { ShellContext } from "../src/shell/model";
import type { ShellContextValue, WorkbenchModel } from "../src/shell/model";
import { changes, listing, run1, runEntry } from "./changes-fixtures";
import { shellNav } from "./connections-harness";

const run2: AgentRun = { ...run1, id: "run2", adapter: "claude", prompt: "Fix it", status: "running", startedAt: "2026-11-15T11:00:00.000Z" };

const tree: Record<string, DirListing> = {
  "": listing("", [
    { name: "src", kind: "dir", size: null },
    { name: "link", kind: "other", size: null },
    { name: "notes.txt", kind: "file", size: 40 },
  ]),
  src: listing("src", [{ name: "a.ts", kind: "file", size: 12 }]),
};

function setup(over: Partial<WorkbenchModel> = {}) {
  const listeners = new Set<(e: LedgerEntry) => void>();
  const model = {
    subscribeEntries: (cb: (e: LedgerEntry) => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    selectedId: "p1",
    entries: [],
    runs: [run1, run2],
    changesRunId: "run1",
    onSelectChangesRun: vi.fn(),
    changes: changes(),
    changesError: null,
    dir: vi.fn(async (_runId: string, path: string) => tree[path] ?? listing(path, [])),
    onOpenDiff: vi.fn(),
    onOpenFile: vi.fn(),
    ...over,
  } as unknown as WorkbenchModel;
  const shell: ShellContextValue = { model, dock: () => null, ...shellNav() };
  render(
    <ShellContext.Provider value={shell}>
      <ChangesSideBar />
    </ShellContext.Provider>,
  );
  const emit = (e: LedgerEntry) => act(() => listeners.forEach((l) => l(e)));
  return { model, shell, emit };
}

describe("ChangesSideBar", () => {
  it("picks among the project's runs, newest first", () => {
    const { model } = setup();
    const picker = screen.getByRole("combobox", { name: "Run" }) as HTMLSelectElement;
    const options = within(picker).getAllByRole("option").map((o) => o.textContent);
    expect(options).toEqual(["Claude · Fix it · running", "Fake · Write the release notes for the next ver… · completed"]);
    expect(picker.value).toBe("run1");
    fireEvent.change(picker, { target: { value: "run2" } });
    expect(model.onSelectChangesRun).toHaveBeenCalledWith("run2");
  });

  it("says when the project has no runs yet", () => {
    setup({ runs: [], changesRunId: null, changes: null });
    expect(within(screen.getByRole("combobox", { name: "Run" })).getByRole("option").textContent).toBe("(no runs yet)");
  });

  it("lists the changed files, and clicking one opens its diff", () => {
    const { model, shell } = setup({
      changes: changes({
        files: [
          { path: "notes.txt", status: "added", added: 1, deleted: 0, binary: false },
          { path: "img.png", status: "modified", added: null, deleted: null, binary: true },
          { path: "new.txt", status: "untracked", added: null, deleted: null, binary: false },
          { path: "old.txt", status: "deleted", added: 0, deleted: 3, binary: false },
        ],
      }),
    });
    expect(screen.getByText("4 files changed · +1 −3")).toBeTruthy();
    const readOnly = screen.getByText(/Read-only\. Agents change code; you review it\./);
    fireEvent.click(within(readOnly).getByRole("button", { name: "Learn more" }));
    expect(shell.openLearn).toHaveBeenCalledWith("reading_a_diff");

    const list = screen.getByRole("list", { name: "Changed files" });
    const rows = within(list).getAllByRole("button").map((b) => b.textContent);
    expect(rows).toEqual(["A notes.txt +1 −0", "M img.png binary", "U new.txt", "D old.txt +0 −3"]);
    fireEvent.click(within(list).getByRole("button", { name: /A notes\.txt/ }));
    expect(model.onOpenDiff).toHaveBeenCalledWith("run1", "notes.txt");
    expect(screen.queryByText("Showing 500 of more files")).toBeNull();
  });

  it("says one file in the singular", () => {
    setup();
    expect(screen.getByText("1 file changed · +1 −0")).toBeTruthy();
  });

  it("says when the list was cut at 500 files", () => {
    setup({ changes: changes({ truncated: true }) });
    expect(screen.getByText("Showing 500 of more files")).toBeTruthy();
  });

  it("shows why the changes could not load", () => {
    setup({ changes: null, changesError: "This run's working copy no longer exists on this computer" });
    expect(screen.getByText("This run's working copy no longer exists on this computer")).toBeTruthy();
  });

  it("opens directories lazily and opens files from the tree", async () => {
    const { model } = setup();
    const files = await screen.findByRole("list", { name: "Files" });
    await within(files).findByText("notes.txt");
    expect(model.dir).toHaveBeenCalledWith("run1", "");
    expect(model.dir).not.toHaveBeenCalledWith("run1", "src");

    const other = within(files).getByText("link");
    expect(other.closest("li")?.className).toContain("other");
    expect(other.closest("[title]")?.getAttribute("title")).toBe("Not followed");

    fireEvent.click(within(files).getByText("src"));
    await waitFor(() => expect(model.dir).toHaveBeenCalledWith("run1", "src"));
    fireEvent.click(await within(files).findByRole("button", { name: "a.ts" }));
    expect(model.onOpenFile).toHaveBeenCalledWith("run1", "src/a.ts");
  });

  it("says when a directory listing was cut at 2,000 entries", async () => {
    setup({ dir: vi.fn(async () => listing("", [{ name: "a", kind: "file", size: 1 }], true)) });
    expect(await screen.findByText("Showing 2,000 of more entries")).toBeTruthy();
  });

  it("words a failed listing by its error", async () => {
    setup({ dir: vi.fn(async () => Promise.reject(new ApiError(404, "worktree_missing"))) });
    expect(await screen.findByText("This run's working copy no longer exists on this computer")).toBeTruthy();
  });

  it("says plainly that a live run's tree shows once the run stops", async () => {
    setup({ dir: vi.fn(async () => Promise.reject(new ApiError(409, "run_active", { message: "x" }))) });
    expect(await screen.findByText("Changes show when the run is stopped or finished.")).toBeTruthy();
  });

  it("asks for a project first", () => {
    setup({ selectedId: null });
    expect(screen.getByText("Select a project to see what its agents changed.")).toBeTruthy();
  });

  it("says while the changes load", () => {
    setup({ changes: null as RunChanges | null });
    expect(screen.getByText("Loading changes…")).toBeTruthy();
  });

  it("clips a long prompt without splitting a character made of two code units", () => {
    const prompt = `${"a".repeat(39)}\u{1F600}\u{1F600}tail`;
    setup({ runs: [{ ...run1, prompt }] });
    const label = within(screen.getByRole("combobox", { name: "Run" })).getByRole("option").textContent!;
    expect(label).toBe(`Fake · ${"a".repeat(39)}\u{1F600}… · completed`);
  });

  it("says there are too many changes instead of listing or counting a partial list", () => {
    setup({ changes: changes({ tooMany: true, truncated: true }) });
    expect(screen.getByText("Too many changes to list here.")).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Changed files" })).toBeNull();
    expect(screen.queryByText(/files? changed/)).toBeNull();
    expect(screen.queryByText("Showing 500 of more files")).toBeNull();
  });

  it("shows a changed file whose name was hidden as text that opens nothing", () => {
    const { model } = setup({
      changes: changes({ files: [{ path: "[REDACTED]", status: "added", added: 1, deleted: 0, binary: false, cleaned: true }] }),
    });
    const list = screen.getByRole("list", { name: "Changed files" });
    expect(within(list).queryByRole("button")).toBeNull();
    const hidden = within(list).getByTitle("Name hidden because it looked like a secret or a private path");
    expect(hidden.textContent).toContain("[REDACTED]");
    fireEvent.click(hidden);
    expect(model.onOpenDiff).not.toHaveBeenCalled();
  });

  it("shows a tree entry whose name was hidden as text that opens nothing", async () => {
    const { model } = setup({
      dir: vi.fn(async () =>
        listing("", [
          { name: "[REDACTED]", kind: "dir", size: null, cleaned: true },
          { name: "[REDACTED].txt", kind: "file", size: 3, cleaned: true },
        ]),
      ),
    });
    const files = await screen.findByRole("list", { name: "Files" });
    await within(files).findByText("[REDACTED].txt");
    expect(within(files).queryByRole("button")).toBeNull();
    expect(files.querySelector("details")).toBeNull();
    const hidden = within(files).getAllByTitle("Name hidden because it looked like a secret or a private path");
    expect(hidden).toHaveLength(2);
    hidden.forEach((h) => fireEvent.click(h));
    expect(model.onOpenFile).not.toHaveBeenCalled();
    expect(model.dir).toHaveBeenCalledTimes(1);
  });

  it("reloads the tree's open listings on an entry naming the run, and not for another run", async () => {
    const { model, emit } = setup();
    const files = await screen.findByRole("list", { name: "Files" });
    await within(files).findByText("notes.txt");
    fireEvent.click(within(files).getByText("src"));
    await within(files).findByRole("button", { name: "a.ts" });
    expect(model.dir).toHaveBeenCalledTimes(2);
    emit(runEntry("agent.finished", "run2"));
    expect(model.dir).toHaveBeenCalledTimes(2);
    emit(runEntry("override.completed", "run1"));
    await waitFor(() => expect(model.dir).toHaveBeenCalledTimes(4));
    expect(within(files).getByRole("button", { name: "a.ts" })).toBeTruthy();
  });

  it("offers the emergency override for the run it shows", () => {
    const { model } = setup({ onOverrideDiscard: vi.fn(async () => ({ ok: true as const, files: 0 })), onOverrideCommand: vi.fn(async () => ({ ok: true as const })) });
    expect(screen.getByText("Emergency override").tagName).toBe("SUMMARY");
    expect(screen.queryByText("Stop the agent first.")).toBeNull();
    expect(model.onOverrideDiscard).not.toHaveBeenCalled();
  });

  it("disables the override while the run it shows is running", () => {
    setup({ changesRunId: "run2" });
    expect(screen.getByText("Stop the agent first.")).toBeTruthy();
  });

  it("shows no override when no run is picked", () => {
    setup({ runs: [], changesRunId: null, changes: null });
    expect(screen.queryByText("Emergency override")).toBeNull();
  });

  it("offers a retry when a listing fails", async () => {
    const dir = vi.fn().mockRejectedValueOnce(new ApiError(500, "internal")).mockResolvedValue(tree[""]);
    setup({ dir });
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    expect(await screen.findByText("notes.txt")).toBeTruthy();
    expect(dir).toHaveBeenCalledTimes(2);
  });
});
