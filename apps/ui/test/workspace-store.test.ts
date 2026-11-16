import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, test } from "vitest";
import { WORKSPACE_KEY, loadWorkspace, saveWorkspace, useWorkspace } from "../src/shell/workspace-store";

beforeEach(() => {
  localStorage.clear();
  saveWorkspace({ showBoard: false });
  localStorage.clear();
});

describe("workspace store", () => {
  test("defaults to the Board hidden, also with corrupt JSON", () => {
    expect(loadWorkspace()).toEqual({ showBoard: false });
    localStorage.setItem(WORKSPACE_KEY, "{");
    expect(loadWorkspace()).toEqual({ showBoard: false });
  });

  test("save then load", () => {
    saveWorkspace({ showBoard: true });
    expect(loadWorkspace().showBoard).toBe(true);
  });

  test("every subscriber re-renders", () => {
    const a = renderHook(() => useWorkspace());
    const b = renderHook(() => useWorkspace());
    expect(a.result.current.showBoard).toBe(false);
    act(() => a.result.current.setShowBoard(true));
    expect(a.result.current.showBoard).toBe(true);
    expect(b.result.current.showBoard).toBe(true);
  });
});
