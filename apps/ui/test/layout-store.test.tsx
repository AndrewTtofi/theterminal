import { beforeEach, describe, expect, it } from "vitest";
import { LAYOUT_KEY, loadLayout, resetLayout, saveLayout } from "../src/shell/layout-store";

beforeEach(() => localStorage.clear());

describe("layout-store", () => {
  it("round-trips a saved layout", () => {
    const layout = { grid: { root: { type: "branch" } }, panels: { board: { id: "board" } } };
    saveLayout(layout);
    expect(JSON.parse(localStorage.getItem(LAYOUT_KEY)!)).toEqual(layout);
    expect(loadLayout()).toEqual(layout);
  });

  it("returns null when nothing is saved", () => {
    expect(loadLayout()).toBeNull();
  });

  it("returns null for corrupt JSON", () => {
    localStorage.setItem(LAYOUT_KEY, "{not json");
    expect(loadLayout()).toBeNull();
  });

  it("reset clears the saved layout", () => {
    saveLayout({ a: 1 });
    resetLayout();
    expect(localStorage.getItem(LAYOUT_KEY)).toBeNull();
    expect(loadLayout()).toBeNull();
  });

  it("uses a separate key when given one", () => {
    saveLayout({ a: 1 }, "other");
    expect(loadLayout()).toBeNull();
    expect(loadLayout("other")).toEqual({ a: 1 });
  });
});
