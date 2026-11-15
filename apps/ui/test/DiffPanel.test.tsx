import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { FileDiff, LedgerEntry } from "@theterminal/shared";
import { ApiError } from "../src/api";
import type { DockApi } from "../src/shell/Dock";
import { ShellContext } from "../src/shell/model";
import type { WorkbenchModel } from "../src/shell/model";
import { DiffPanel } from "../src/views/DiffPanel";
import { changes, fileDiff, runEntry } from "./changes-fixtures";
import { shellNav } from "./connections-harness";

const ID = "diff:run1:notes.txt";

function setup(load: () => Promise<FileDiff>, over: Partial<WorkbenchModel> = {}) {
  const listeners = new Set<(e: LedgerEntry) => void>();
  const model = {
    diff: vi.fn(load),
    runChanges: vi.fn(async () => changes()),
    onOpenFile: vi.fn(),
    runExists: vi.fn(async () => true),
    subscribeEntries: (cb: (e: LedgerEntry) => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    ...over,
  } as unknown as WorkbenchModel;
  const dock = { closeQuietly: vi.fn() } as unknown as DockApi;
  render(
    <ShellContext.Provider value={{ model, dock: () => dock, ...shellNav() }}>
      <DiffPanel id={ID} />
    </ShellContext.Provider>,
  );
  const emit = (e: LedgerEntry) => act(() => listeners.forEach((l) => l(e)));
  return { model, dock, emit };
}

const panel = () => screen.findByRole("region", { name: "Diff: notes.txt" });

describe("DiffPanel", () => {
  it("shows the diff with what it was compared with", async () => {
    const { model } = setup(async () => fileDiff());
    const p = await panel();
    expect(model.diff).toHaveBeenCalledWith("run1", "notes.txt");
    await waitFor(() => expect(p.textContent).toContain("Compared with 01234567 (this run's starting point)"));
    expect(p.textContent).toContain("notes.txt");
    expect(p.textContent).toContain("modified");
    expect(p.textContent).toContain("+1 −1");
    expect(p.querySelector("pre.diff .line.add")).not.toBeNull();
    expect(p.textContent).not.toContain("New file, not yet committed");
  });

  it("says when the file is new and not yet committed", async () => {
    setup(async () => fileDiff({ status: "untracked", added: null, deleted: null }));
    expect((await panel()).textContent).toContain("New file, not yet committed");
  });

  it("says a binary file has no text", async () => {
    setup(async () => fileDiff({ binary: true, added: null, deleted: null, text: null }));
    const p = await panel();
    expect(p.textContent).toContain("Binary file: no text to show");
    expect(p.querySelector("pre.diff")).toBeNull();
  });

  it("says a change too large to show is too large, and offers the file", async () => {
    const { model } = setup(async () => fileDiff({ tooLarge: true, added: 9000, deleted: 1200, text: null }));
    const p = await panel();
    expect(p.textContent).toContain(
      "This change is too large to show here (9000 added, 1200 deleted lines). Open the file instead, or ask an agent to summarise it.",
    );
    expect(p.querySelector("pre.diff")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open file" }));
    expect(model.onOpenFile).toHaveBeenCalledWith("run1", "notes.txt");
  });

  it("offers no file for a too-large change of a deleted file", async () => {
    setup(async () => fileDiff({ status: "deleted", tooLarge: true, added: 0, deleted: 9000, text: null }));
    const p = await panel();
    expect(p.textContent).toContain("This change is too large to show here (0 added, 9000 deleted lines).");
    expect(screen.queryByRole("button", { name: "Open file" })).toBeNull();
  });

  it("says when the file has not changed in this run", async () => {
    setup(async () => fileDiff({ status: "unchanged", added: 0, deleted: 0, text: "" }));
    const p = await panel();
    expect(p.textContent).toContain("This file has not changed in this run.");
    expect(p.querySelector("pre.diff")).toBeNull();
  });

  it("reloads when an agent or override entry names its run, and not for another run", async () => {
    const { model, emit } = setup(async () => fileDiff());
    await panel();
    await waitFor(() => expect(model.diff).toHaveBeenCalledTimes(1));
    emit(runEntry("agent.finished", "other"));
    emit(runEntry("card.created", "run1"));
    expect(model.diff).toHaveBeenCalledTimes(1);
    emit(runEntry("agent.finished", "run1"));
    await waitFor(() => expect(model.diff).toHaveBeenCalledTimes(2));
    emit(runEntry("override.completed", "run1"));
    await waitFor(() => expect(model.diff).toHaveBeenCalledTimes(3));
  });

  it("closes itself quietly when the server no longer knows its run", async () => {
    const { dock, model } = setup(() => Promise.reject(new ApiError(404, "not_found")), { runExists: vi.fn(async () => false) });
    await waitFor(() => expect(dock.closeQuietly).toHaveBeenCalledWith(ID));
    expect(model.runExists).toHaveBeenCalledWith("run1");
  });

  it("words other failures by their error and stays open", async () => {
    const { dock } = setup(() => Promise.reject(new ApiError(404, "worktree_missing")));
    expect(await screen.findByText("This run's working copy no longer exists on this computer")).toBeTruthy();
    expect(dock.closeQuietly).not.toHaveBeenCalled();
  });
});
