import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceSettings } from "../src/views/WorkspaceSettings";
import { WORKSPACE_KEY, loadWorkspace, saveWorkspace } from "../src/shell/workspace-store";

beforeEach(() => {
  localStorage.clear();
  saveWorkspace({ showBoard: false });
});

describe("WorkspaceSettings", () => {
  it("has a Workspace region with a Show the Board switch, off by default", () => {
    render(<WorkspaceSettings />);
    expect(screen.getByRole("region", { name: "Workspace" })).toBeTruthy();
    expect(screen.getByRole("switch", { name: "Show the Board" }).getAttribute("aria-checked")).toBe("false");
  });

  it("turns the Board on and keeps the choice", async () => {
    render(<WorkspaceSettings />);
    await userEvent.click(screen.getByRole("switch", { name: "Show the Board" }));
    expect(screen.getByRole("switch", { name: "Show the Board" }).getAttribute("aria-checked")).toBe("true");
    expect(JSON.parse(localStorage.getItem(WORKSPACE_KEY)!)).toEqual({ showBoard: true });
    expect(loadWorkspace().showBoard).toBe(true);
  });
});
