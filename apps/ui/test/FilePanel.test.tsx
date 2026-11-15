import { describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import type { FileContent, LedgerEntry } from "@theterminal/shared";
import { ApiError } from "../src/api";
import type { DockApi } from "../src/shell/Dock";
import { ShellContext } from "../src/shell/model";
import type { WorkbenchModel } from "../src/shell/model";
import { FilePanel } from "../src/views/FilePanel";
import { fileContent, runEntry } from "./changes-fixtures";
import { shellNav } from "./connections-harness";

const ID = "file:run1:src%2Fa.ts";

function setup(load: () => Promise<FileContent>, over: Partial<WorkbenchModel> = {}) {
  const listeners = new Set<(e: LedgerEntry) => void>();
  const model = {
    file: vi.fn(load),
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
      <FilePanel id={ID} />
    </ShellContext.Provider>,
  );
  const emit = (e: LedgerEntry) => act(() => listeners.forEach((l) => l(e)));
  return { model, dock, emit };
}

const panel = () => screen.findByRole("region", { name: "File: src/a.ts" });
const lines = (p: HTMLElement) => p.querySelectorAll("pre.file > div.line");

describe("FilePanel", () => {
  it("shows the file's numbered lines, read-only, with its size", async () => {
    const { model } = setup(async () => fileContent({ size: 1234, text: "one\n\u001b[1mtwo\u001b[0m\n" }));
    const p = await panel();
    expect(model.file).toHaveBeenCalledWith("run1", "src/a.ts");
    expect(p.textContent).toContain("src/a.ts");
    expect(p.textContent).toContain("1,234 bytes");
    expect(p.textContent).toContain("Read-only");
    const painted = [...lines(p)].map((l) => [l.querySelector(".ln")?.textContent, l.querySelector(".text")?.textContent]);
    expect(painted).toEqual([
      ["1", "one"],
      ["2", "two"],
    ]);
    expect(p.querySelector("textarea, input, [contenteditable]")).toBeNull();
  });

  it("says a file over 1 MiB is not shown", async () => {
    setup(async () => fileContent({ size: 2_000_000, tooLarge: true, text: null }));
    const p = await panel();
    expect(p.textContent).toContain("This file is larger than 1 MiB and is not shown. Ask an agent about it.");
    expect(p.querySelector("pre.file")).toBeNull();
  });

  it("says a binary file has no text", async () => {
    setup(async () => fileContent({ binary: true, text: null }));
    const p = await panel();
    expect(p.textContent).toContain("Binary file: no text to show");
    expect(p.querySelector("pre.file")).toBeNull();
  });

  it("paints at most 20,000 lines and says how many there are", async () => {
    const text = Array.from({ length: 25_000 }, (_, i) => `line ${i + 1}`).join("\n");
    setup(async () => fileContent({ size: text.length, text }));
    const p = await panel();
    expect(lines(p)).toHaveLength(20_000);
    expect(p.textContent).toContain("Showing the first 20,000 lines of 25,000");
  });

  it("says nothing about a cap when the file fits", async () => {
    setup(async () => fileContent());
    expect((await panel()).textContent).not.toContain("Showing the first");
  });

  it("reloads when an entry names its run", async () => {
    const { model, emit } = setup(async () => fileContent());
    await panel();
    emit(runEntry("override.completed", "run1"));
    await waitFor(() => expect(model.file).toHaveBeenCalledTimes(2));
  });

  it("closes itself quietly when the server no longer knows its run", async () => {
    const { dock } = setup(() => Promise.reject(new ApiError(404, "not_found")), { runExists: vi.fn(async () => false) });
    await waitFor(() => expect(dock.closeQuietly).toHaveBeenCalledWith(ID));
  });

  it("says when the file is not there, while its run still is", async () => {
    const { dock } = setup(() => Promise.reject(new ApiError(404, "not_found")));
    expect(await screen.findByText("Not found")).toBeTruthy();
    expect(dock.closeQuietly).not.toHaveBeenCalled();
  });
});
