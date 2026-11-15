import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LAYOUTS_KEY, LAYOUT_KEY, LAYOUT_NAME_KEY, MAX_SAVED_LAYOUTS, currentLayoutName, listSavedLayouts, loadLayout, loadNamedLayout,
  removeNamedLayout, resetLayout, saveLayout, saveNamedLayout, setCurrentLayoutName,
} from "../src/shell/layout-store";

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

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

describe("named layouts", () => {
  it("saves, lists, loads and removes a named layout", () => {
    expect(listSavedLayouts()).toEqual([]);
    saveNamedLayout("Mine", { a: 1 });
    saveNamedLayout("Review", { b: 2 });
    expect(listSavedLayouts()).toEqual(["Mine", "Review"]);
    expect(loadNamedLayout("Mine")).toEqual({ a: 1 });
    expect(localStorage.getItem(LAYOUTS_KEY)).not.toBeNull();
    removeNamedLayout("Mine");
    expect(listSavedLayouts()).toEqual(["Review"]);
    expect(loadNamedLayout("Mine")).toBeNull();
  });

  it("replaces a layout saved under the same name, keeping its place", () => {
    saveNamedLayout("Mine", { a: 1 });
    saveNamedLayout("Other", { b: 1 });
    saveNamedLayout("Mine", { a: 2 });
    expect(listSavedLayouts()).toEqual(["Mine", "Other"]);
    expect(loadNamedLayout("Mine")).toEqual({ a: 2 });
  });

  it(`keeps at most ${MAX_SAVED_LAYOUTS}: an 11th save throws`, () => {
    for (let i = 1; i <= MAX_SAVED_LAYOUTS; i++) saveNamedLayout(`L${i}`, { i });
    expect(() => saveNamedLayout("L11", {})).toThrow(new RangeError("You can keep up to 10 layouts"));
    expect(listSavedLayouts()).toHaveLength(MAX_SAVED_LAYOUTS);
    // Replacing one of the ten is still allowed.
    expect(() => saveNamedLayout("L3", { i: 33 })).not.toThrow();
  });

  it("refuses a name outside 1 to 40 characters, and the names the select uses", () => {
    expect(() => saveNamedLayout("x".repeat(41), {})).toThrow(new RangeError("A layout name has 1 to 40 characters"));
    expect(() => saveNamedLayout("", {})).toThrow(RangeError);
    expect(() => saveNamedLayout("   ", {})).toThrow(RangeError);
    for (const taken of ["Guided", "operator", "Custom"]) {
      expect(() => saveNamedLayout(taken, {})).toThrow(new RangeError("That name is taken"));
    }
    saveNamedLayout("x".repeat(40), {});
    expect(listSavedLayouts()).toEqual(["x".repeat(40)]);
  });

  it("ignores a corrupt store", () => {
    localStorage.setItem(LAYOUTS_KEY, "{not json");
    expect(listSavedLayouts()).toEqual([]);
    localStorage.setItem(LAYOUTS_KEY, JSON.stringify([{ name: 3 }, "x", { name: "ok", layout: { a: 1 } }]));
    expect(listSavedLayouts()).toEqual(["ok"]);
  });

  it("refuses a layout over 200 KB, and skips one already stored", () => {
    const big = { blob: "x".repeat(200_001) };
    expect(() => saveNamedLayout("Big", big)).toThrow(new RangeError("That layout is too large to save"));
    expect(listSavedLayouts()).toEqual([]);
    localStorage.setItem(LAYOUTS_KEY, JSON.stringify([{ name: "Big", layout: big }, { name: "ok", layout: { a: 1 } }]));
    expect(listSavedLayouts()).toEqual(["ok"]);
    expect(loadNamedLayout("Big")).toBeNull();
  });

  it("skips stored names that a save would refuse", () => {
    const entries = ["", "   ", "x".repeat(41), "Guided", "custom", " padded ", "ok"].map((name) => ({ name, layout: {} }));
    localStorage.setItem(LAYOUTS_KEY, JSON.stringify(entries));
    expect(listSavedLayouts()).toEqual(["ok"]);
  });

  it("is Guided on a fresh store and remembers the name it is given", () => {
    expect(currentLayoutName()).toBe("Guided");
    setCurrentLayoutName("Mine");
    expect(currentLayoutName()).toBe("Mine");
    expect(localStorage.getItem(LAYOUT_NAME_KEY)).toBe("Mine");
  });

  it("keeps working when storage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(listSavedLayouts()).toEqual([]);
    expect(loadNamedLayout("Mine")).toBeNull();
    expect(currentLayoutName()).toBe("Guided");
    expect(() => saveNamedLayout("Mine", {})).toThrow(new RangeError("The layout could not be saved: browser storage is full or blocked"));
    expect(() => removeNamedLayout("Mine")).not.toThrow();
    expect(() => setCurrentLayoutName("Mine")).not.toThrow();
  });
});
