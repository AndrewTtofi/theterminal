import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { NarrationTopic } from "@theterminal/shared";
import { ShellContext } from "../src/shell/model";
import type { LedgerScope, WorkbenchModel } from "../src/shell/model";
import { LedgerSideBar } from "../src/views/LedgerSideBar";
import { fakeDock } from "./connections-harness";

const ALL: NarrationTopic[] = ["board", "agent", "decision", "gate", "override", "intake", "connection", "settings", "other"];

function renderSideBar(over: { ledgerScope?: LedgerScope; selectedId?: string | null; ledgerTopics?: NarrationTopic[] } = {}) {
  const onLedgerTopicsChange = vi.fn();
  const model = {
    ledgerScope: "project",
    selectedId: "p 1",
    ledgerTopics: ALL,
    onLedgerScopeChange: vi.fn(),
    onLedgerTopicsChange,
    ...over,
  } as unknown as WorkbenchModel;
  const dock = fakeDock();
  render(
    <ShellContext.Provider value={{ model, dock: () => dock, selectView: vi.fn() }}>
      <LedgerSideBar />
    </ShellContext.Provider>,
  );
  return { onLedgerTopicsChange };
}

describe("LedgerSideBar", () => {
  it("offers one checkbox per topic under Show, all ticked by default", () => {
    renderSideBar();
    const show = screen.getByRole("group", { name: "Show" });
    const boxes = within(show).getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes.map((b) => b.labels?.[0]?.textContent)).toEqual([
      "Board", "Agents", "Decisions", "Gates", "Overrides", "Intake", "Connections", "Settings", "Other",
    ]);
    expect(boxes.every((b) => b.checked)).toBe(true);
  });

  it("always shows overrides: their box stays ticked and cannot be cleared", () => {
    renderSideBar({ ledgerTopics: ["board"] });
    const box = screen.getByRole("checkbox", { name: "Overrides" }) as HTMLInputElement;
    expect(box.checked).toBe(true);
    expect(box.disabled).toBe(true);
  });

  it("removes and adds a topic", async () => {
    const { onLedgerTopicsChange } = renderSideBar({ ledgerTopics: ["board", "gate"] });
    expect((screen.getByRole("checkbox", { name: "Agents" }) as HTMLInputElement).checked).toBe(false);
    await userEvent.click(screen.getByRole("checkbox", { name: "Gates" }));
    expect(onLedgerTopicsChange).toHaveBeenLastCalledWith(["board"]);
    await userEvent.click(screen.getByRole("checkbox", { name: "Agents" }));
    expect(onLedgerTopicsChange).toHaveBeenLastCalledWith(["board", "agent", "gate"]);
  });

  it("links the audit export for the selected project, as a download", () => {
    renderSideBar();
    const link = screen.getByRole("link", { name: "Export for audit" });
    expect(link.hasAttribute("download")).toBe(true);
    expect(link.getAttribute("href")).toBe("/api/ledger/export?projectId=p%201");
    expect(
      screen.getByText("Downloads every entry as one line of JSON with its hash chain and a plain-language headline."),
    ).toBeTruthy();
    const note = document.getElementById(link.getAttribute("aria-describedby")!)!;
    expect(note.textContent).toBe("Downloads every entry as one line of JSON with its hash chain and a plain-language headline.");
  });

  it("does not export when this project is chosen but none is selected", () => {
    renderSideBar({ selectedId: null });
    expect(screen.queryByRole("link", { name: "Export for audit" })).toBeNull();
    const button = screen.getByRole("button", { name: "Export for audit" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText("Select a project")).toBeTruthy();
    const described = button.getAttribute("aria-describedby")!.split(" ").map((id) => document.getElementById(id)!.textContent);
    expect(described).toEqual([
      "Select a project",
      "Downloads every entry as one line of JSON with its hash chain and a plain-language headline.",
    ]);
  });

  it("links the export of every project when all projects are shown", () => {
    renderSideBar({ ledgerScope: "all" });
    expect(screen.getByRole("link", { name: "Export for audit" }).getAttribute("href")).toBe("/api/ledger/export");
  });
});
