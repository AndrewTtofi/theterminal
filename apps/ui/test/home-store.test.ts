import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  DEFAULT_HOME,
  HOME_BLOCKS,
  HOME_BLOCK_LABELS,
  HOME_KEY,
  loadHome,
  moveBlock,
  normalizeHome,
  resetHome,
  saveHome,
  toggleBlock,
} from "../src/home/home-store";

beforeEach(() => localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

describe("home layout store", () => {
  test("defaults", () => {
    expect(DEFAULT_HOME).toEqual({ version: 1, order: [...HOME_BLOCKS], hidden: [], workingColumns: 2 });
    expect(HOME_BLOCK_LABELS.approvals).toBe("Needs your approval");
  });

  test("anything but a version 1 object gives the default", () => {
    expect(normalizeHome("{")).toEqual(DEFAULT_HOME);
    expect(normalizeHome({ version: 0 })).toEqual(DEFAULT_HOME);
    expect(normalizeHome(null)).toEqual(DEFAULT_HOME);
  });

  test("normalises ids, hidden and columns", () => {
    const l = normalizeHome({ version: 1, order: ["files", "x", "files"], hidden: ["approvals", "files"], workingColumns: 3 });
    expect(l.order[0]).toBe("files");
    expect([...l.order].sort()).toEqual([...HOME_BLOCKS].sort());
    expect(l.order).toHaveLength(6);
    expect(l.hidden).toEqual(["files"]);
    expect(l.workingColumns).toBe(2);
  });

  test("missing ids go back at their default position", () => {
    const l = normalizeHome({ version: 1, order: ["files", "ask"], hidden: [], workingColumns: 1 });
    expect(l.order).toEqual(["files", "ask", "approvals", "working", "overall", "finished"]);
    expect(l.workingColumns).toBe(1);
  });

  test("approvals cannot be hidden, and the first block cannot move up", () => {
    expect(toggleBlock(DEFAULT_HOME, "approvals")).toEqual(DEFAULT_HOME);
    expect(moveBlock(DEFAULT_HOME, "ask", -1)).toEqual(DEFAULT_HOME);
    expect(moveBlock(DEFAULT_HOME, "ask", 1).order.slice(0, 2)).toEqual(["approvals", "ask"]);
    expect(toggleBlock(DEFAULT_HOME, "files").hidden).toEqual(["files"]);
    expect(toggleBlock(toggleBlock(DEFAULT_HOME, "files"), "files").hidden).toEqual([]);
  });

  test("saves, loads and resets", () => {
    const l = toggleBlock(DEFAULT_HOME, "files");
    saveHome(l);
    expect(loadHome()).toEqual(l);
    expect(resetHome()).toEqual(DEFAULT_HOME);
    expect(localStorage.getItem(HOME_KEY)).toBeNull();
  });

  test("corrupt storage gives the default", () => {
    localStorage.setItem(HOME_KEY, "{");
    expect(loadHome()).toEqual(DEFAULT_HOME);
  });

  test("unavailable storage does not throw", () => {
    const boom = () => {
      throw new Error("blocked");
    };
    vi.stubGlobal("localStorage", { getItem: boom, setItem: boom, removeItem: boom });
    expect(loadHome()).toEqual(DEFAULT_HOME);
    expect(() => saveHome(DEFAULT_HOME)).not.toThrow();
    expect(() => resetHome()).not.toThrow();
  });
});
